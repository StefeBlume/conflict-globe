#!/usr/bin/env node
// Lageeinschätzungen ("Briefings") pflegen. Wird vom stuendlichen Loop benutzt,
// damit niemand data/briefings.json von Hand editieren muss.
//
//   node src/briefing.mjs set <konflikt-id> --headline "..." --text "..." [--sources "url1,url2"]
//   node src/briefing.mjs get <konflikt-id>
//   node src/briefing.mjs list
//   node src/briefing.mjs prune --days 3      alte Briefings entfernen

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'briefings.json');
const CONFIG = path.join(ROOT, 'config', 'conflicts.json');

const argv = process.argv.slice(2);
const cmd = argv[0];
const id = argv[1];
const opt = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};

async function load() {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    return { briefings: {} };
  }
}

async function save(data) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(data, null, 2));
}

async function validIds() {
  const cfg = JSON.parse(await fs.readFile(CONFIG, 'utf8'));
  return cfg.conflicts.map((c) => c.id);
}

const data = await load();

switch (cmd) {
  case 'set': {
    const ids = await validIds();
    if (!id || !ids.includes(id)) {
      console.error(`Unbekannte Konflikt-ID: ${id || '(fehlt)'}`);
      console.error(`Gültig: ${ids.join(', ')}`);
      process.exit(1);
    }
    const text = opt('text');
    if (!text) {
      console.error('--text fehlt');
      process.exit(1);
    }
    const sources = (opt('sources', '') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    data.briefings[id] = {
      headline: opt('headline', ''),
      text,
      sources,
      updatedAt: new Date().toISOString(),
    };
    await save(data);
    console.log(`Briefing gespeichert: ${id} (${text.length} Zeichen)`);
    break;
  }

  case 'get': {
    const b = data.briefings[id];
    console.log(b ? JSON.stringify(b, null, 2) : `Kein Briefing für ${id}`);
    break;
  }

  case 'list': {
    const rows = Object.entries(data.briefings)
      .map(([k, v]) => ({ id: k, alterStunden: ((Date.now() - new Date(v.updatedAt)) / 36e5).toFixed(1), headline: v.headline }))
      .sort((a, b) => a.alterStunden - b.alterStunden);
    if (!rows.length) console.log('Noch keine Briefings vorhanden.');
    for (const r of rows) console.log(`${r.id.padEnd(22)} vor ${String(r.alterStunden).padStart(5)}h  ${r.headline}`);
    break;
  }

  case 'prune': {
    const days = Number(opt('days', 3));
    const cutoff = Date.now() - days * 864e5;
    let n = 0;
    for (const [k, v] of Object.entries(data.briefings)) {
      if (new Date(v.updatedAt).getTime() < cutoff) {
        delete data.briefings[k];
        n++;
      }
    }
    await save(data);
    console.log(`${n} veraltete Briefings entfernt (älter als ${days} Tage).`);
    break;
  }

  default:
    console.log('Befehle: set <id> --headline "..." --text "..." [--sources a,b] | get <id> | list | prune --days 3');
}
