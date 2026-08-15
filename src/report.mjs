#!/usr/bin/env node
// Kompakter Lagebericht für den stuendlichen Loop: was hat sich seit dem
// letzten Lauf geaendert, wo lohnt sich ein neues Briefing?
//
//   node src/report.mjs             nur Konflikte mit neuen Meldungen
//   node src/report.mjs --all       alle Konflikte
//   node src/report.mjs --top 12    die N aktivsten Konflikte
//   node src/report.mjs --id sudan  ein bestimmter Konflikt, mit allen Meldungen

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const opt = (f, d = null) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const state = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'state.json'), 'utf8'));
const briefings = await fs
  .readFile(path.join(ROOT, 'data', 'briefings.json'), 'utf8')
  .then((t) => JSON.parse(t).briefings || {})
  .catch(() => ({}));

const age = (iso) => (iso ? `${((Date.now() - new Date(iso)) / 36e5).toFixed(1)}h` : '—');

console.log(`Stand: ${state.generatedAt} (vor ${age(state.generatedAt)})`);
console.log(
  `${state.totals.conflicts} Konflikte · ${state.totals.articles} Meldungen · ${state.totals.newArticles} neu seit letztem Lauf\n`,
);

const single = opt('id');
let list = state.conflicts;

if (single) {
  list = list.filter((c) => c.id === single);
} else if (has('top')) {
  list = [...list].sort((a, b) => b.activity - a.activity).slice(0, Number(opt('top', 12)));
} else if (!has('all')) {
  list = list.filter((c) => c.newCount > 0);
}

if (!list.length) {
  console.log('Keine Konflikte mit neuen Meldungen in diesem Lauf.');
  process.exit(0);
}

for (const c of list) {
  const b = briefings[c.id];
  const briefAge = b ? `Briefing vor ${age(b.updatedAt)}` : 'KEIN BRIEFING';
  console.log(`=== ${c.id} · ${c.name} [${c.tier}] ===`);
  console.log(
    `Intensität ${c.severity} · Aktivität ${c.activity} · ${c.itemCount} Meldungen (${c.newCount} neu) · ${briefAge}`,
  );
  if (c.signals?.length) console.log(`Signale: ${c.signals.map((s) => `${s.label}(${s.count})`).join(', ')}`);
  if (c.acled && !c.acled.error) console.log(`ACLED 7d: ${c.acled.events} Ereignisse, ${c.acled.fatalities} Tote`);

  const items = single ? c.items : c.items.filter((i) => i.isNew).slice(0, 8);
  for (const i of items) {
    console.log(`  ${i.isNew ? '[NEU] ' : '      '}(${i.source}, vor ${age(i.date)}) ${i.title}`);
    if (single) console.log(`        ${i.url}`);
  }
  if (b) console.log(`  Bisheriges Briefing: ${b.headline || '(ohne Überschrift)'}`);
  console.log();
}
