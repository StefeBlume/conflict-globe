#!/usr/bin/env node
// Statischer Server + JSON-API. Ohne Abhaengigkeiten.
//   node src/serve.mjs [--port 4173]

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const gzip = promisify(zlib.gzip);
// Die Verwaltungsgrenzen sind 6,6 MB gross und komprimieren auf rund 1,4 MB.
const COMPRESSIBLE = /\.(json|js|css|html|svg)$/i;
const gzipCache = new Map();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const pIdx = argv.indexOf('--port');
const PORT = Number(process.env.PORT || (pIdx >= 0 ? argv[pIdx + 1] : 4173));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  try {
    // ---- API ----
    if (pathname === '/api/state') {
      const state = await readJsonSafe(path.join(DATA, 'state.json'), {
        generatedAt: null,
        totals: { conflicts: 0, articles: 0, newArticles: 0 },
        conflicts: [],
        error: 'Noch keine Daten. Bitte "npm run update" ausführen.',
      });

      // Briefings live einmischen: der stuendliche Loop schreibt sie unabhaengig
      // vom Fetcher, sie sollen ohne neuen Datenlauf sichtbar werden.
      const { briefings = {} } = await readJsonSafe(path.join(DATA, 'briefings.json'), { briefings: {} });
      for (const c of state.conflicts || []) c.briefing = briefings[c.id] || null;
      state.briefingCount = Object.keys(briefings).length;

      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(state));
    }

    if (pathname === '/api/history') {
      const dir = path.join(DATA, 'history');
      const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
      const recent = files.slice(-48);
      const snapshots = await Promise.all(
        recent.map((f) => readJsonSafe(path.join(dir, f), null)),
      );
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ snapshots: snapshots.filter(Boolean) }));
    }

    if (pathname === '/api/health') {
      const state = await readJsonSafe(path.join(DATA, 'state.json'), null);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      return res.end(
        JSON.stringify({
          ok: Boolean(state),
          generatedAt: state?.generatedAt || null,
          ageMinutes: state ? Math.round((Date.now() - new Date(state.generatedAt)) / 60000) : null,
          conflicts: state?.totals?.conflicts ?? 0,
        }),
      );
    }

    // ---- Statische Dateien ----
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.join(PUBLIC, pathname);
    if (!filePath.startsWith(PUBLIC)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let buf = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    // Nur die unveraenderlichen Vendor-Dateien (three.js, Geometrie) lange cachen -
    // App-Code und Styles muessen sofort durchschlagen.
    const cacheable = pathname.startsWith('/vendor/');
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-store',
    };

    const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (wantsGzip && COMPRESSIBLE.test(filePath) && buf.length > 4096) {
      const key = `${filePath}:${buf.length}`;
      let packed = gzipCache.get(key);
      if (!packed) {
        packed = await gzip(buf);
        if (cacheable) gzipCache.set(key, packed);
      }
      buf = packed;
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }

    headers['Content-Length'] = buf.length;
    res.writeHead(200, headers);
    res.end(buf);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 – nicht gefunden');
    } else {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 – Serverfehler');
    }
  }
});

server.listen(PORT, () => {
  console.log(`Conflict Globe läuft auf http://localhost:${PORT}`);
});
