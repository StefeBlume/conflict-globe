#!/usr/bin/env node
// Erzeugt public/data/state.json - denselben Datensatz, den der lokale Server unter
// /api/state ausliefert, nur als statische Datei. Damit laeuft das Dashboard auch
// auf reinem Static-Hosting (GitHub Pages) ohne Node-Prozess.
//
//   node src/build-static.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const state = await readJson(path.join(ROOT, 'data', 'state.json'), null);
if (!state) {
  console.error('data/state.json fehlt. Zuerst "npm run update" ausführen.');
  process.exit(1);
}

const { briefings = {} } = await readJson(path.join(ROOT, 'data', 'briefings.json'), { briefings: {} });
for (const c of state.conflicts || []) c.briefing = briefings[c.id] || null;
state.briefingCount = Object.keys(briefings).length;
state.builtAt = new Date().toISOString();

await fs.mkdir(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, 'state.json');
await fs.writeFile(out, JSON.stringify(state));

const kb = Math.round((await fs.stat(out)).size / 1024);
console.log(
  `public/data/state.json geschrieben: ${state.conflicts.length} Konflikte, ` +
    `${state.totals.articles} Meldungen, ${state.briefingCount} Lageeinschätzungen (${kb} KB)`,
);
