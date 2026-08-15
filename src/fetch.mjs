#!/usr/bin/env node
// Haupt-Updater: holt alle Quellen, ordnet sie den Konflikten zu und schreibt data/state.json.
//
//   node src/fetch.mjs                 vollstaendiger Lauf (RSS + GDELT + optional ACLED)
//   node src/fetch.mjs --no-gdelt      nur RSS (schnell, ~15s)
//   node src/fetch.mjs --only ukraine-russia,sudan
//   node src/fetch.mjs --timespan 12h

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFeed } from './sources/rss.mjs';
import { gdeltSearch, gdeltAnalysis } from './sources/gdelt.mjs';
import { acledEvents, acledConfigured } from './sources/acled.mjs';
import {
  matchScore, rankArticle, dedupe, detectSignals, activityIndex,
  severity, normUrl, isConflictRelevant, isOffTopic,
} from './analyze.mjs';
import { loadRegions, regionsForConflict, detectRegion, classifyEvent, classifyEventDeep, dominantEvent } from './regions.mjs';
import { isAcceptableSource, sourceWeight } from './sources/quality.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'config', 'conflicts.json');
const STATE = path.join(ROOT, 'data', 'state.json');
const HISTORY = path.join(ROOT, 'data', 'history');
const GDELT_STATE = path.join(ROOT, 'data', 'gdelt-rotation.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const USE_GDELT = !flag('no-gdelt');
const TIMESPAN = opt('timespan', '36h');
// GDELT braucht 12-20 s pro Abfrage und drosselt haeufig. Statt jeden Lauf alle
// 44 Konflikte abzufragen (>25 min), rotieren wir unter einem Zeitbudget.
const GDELT_BUDGET_MS = Number(opt('gdelt-budget', 240)) * 1000;
const GDELT_MAX = Number(opt('gdelt-max', 14));
// Wie lange eine Meldung im Bestand bleibt, wenn sie nicht mehr nachgeliefert wird.
const MAX_ITEM_AGE_DAYS = Number(opt('max-age-days', 7));
// Meldungen je Konflikt. Das Detailpanel blendet zunaechst einen Teil ein.
const MAX_ITEMS = Number(opt('max-items', 80));
const ONLY = opt('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/** Parallel mit Obergrenze - schont Hosts, die viele gleichzeitige Requests abweisen. */
async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await fn(item);
      } catch {
        /* einzelner Fehlschlag darf den Lauf nicht stoppen */
      }
    }
  });
  await Promise.all(workers);
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const t0 = Date.now();
  const cfg = await readJson(CONFIG);
  if (!cfg) throw new Error(`Konfiguration fehlt: ${CONFIG}`);

  const conflicts = ONLY.length ? cfg.conflicts.filter((c) => ONLY.includes(c.id)) : cfg.conflicts;
  const prev = await readJson(STATE, { conflicts: [] });
  const prevById = new Map((prev.conflicts || []).map((c) => [c.id, c]));

  // ---------- 1. RSS-Pool ----------
  log(`Lade ${cfg.feeds.length} Feeds ...`);
  const feedResults = await Promise.all(cfg.feeds.map(fetchFeed));
  const pool = [];
  const feedStatus = [];
  for (const r of feedResults) {
    feedStatus.push({ id: r.id, ok: r.ok, count: r.items.length, error: r.error || null });
    pool.push(...r.items);
    if (!r.ok) log(`  ! Feed ${r.id}: ${r.error}`);
  }
  log(`  ${pool.length} Artikel im RSS-Pool (${feedStatus.filter((f) => f.ok).length}/${feedStatus.length} Feeds ok)`);

  // ---------- 2. Zuordnung RSS -> Konflikte ----------
  const byConflict = new Map(conflicts.map((c) => [c.id, []]));
  let dropped = 0;
  for (const art of pool) {
    if (!isConflictRelevant(art)) {
      dropped++;
      continue;
    }
    for (const c of conflicts) {
      const m = matchScore(art, c);
      if (m > 0) byConflict.get(c.id).push({ ...art, _m: m });
    }
  }
  log(`  ${dropped} Artikel ohne Konfliktbezug verworfen`);

  // ---------- 2b. ReliefWeb-Laenderfeeds (UN OCHA) je Konflikt ----------
  // Zuverlaessig, schnell und laenderscharf - deckt genau die Konflikte ab,
  // die in den weltweiten Feeds untergehen.
  const tmpl = cfg.countryFeedTemplate;
  // Wenn die globalen ReliefWeb-Feeds gerade drosseln, gar nicht erst 43 weitere
  // Requests hinterherschicken - das verlaengert die Sperre nur.
  const reliefwebThrottled = feedStatus.some(
    (f) => f.id.startsWith('reliefweb') && !f.ok && /429/.test(f.error || ''),
  );
  if (tmpl && reliefwebThrottled) {
    log('  ReliefWeb-Länderfeeds übersprungen (Quelle drosselt gerade)');
  } else if (tmpl) {
    const byIso = new Map();
    for (const c of conflicts) {
      if (!c.iso3) continue;
      if (!byIso.has(c.iso3)) byIso.set(c.iso3, []);
      byIso.get(c.iso3).push(c);
    }

    const isos = [...byIso.keys()];
    let okCount = 0;
    let articleCount = 0;

    await mapLimit(isos, 2, async (iso) => {
      const res = await fetchFeed({
        id: `reliefweb-${iso}`,
        name: 'ReliefWeb (UN OCHA)',
        url: tmpl.replace('{iso3}', iso),
        weight: 3,
        type: 'humanitarian',
      });
      if (!res.ok) return;
      okCount++;
      const group = byIso.get(iso);
      for (const art of res.items) {
        if (!isConflictRelevant(art)) continue;
        if (group.length === 1) {
          // Laenderfeed eindeutig -> direkt zuordnen.
          byConflict.get(group[0].id).push({ ...art, _m: 5 });
          articleCount++;
        } else {
          // Mehrere Konflikte teilen sich ein Land (z.B. Gaza / Westjordanland).
          for (const c of group) {
            const m = matchScore(art, c);
            if (m > 0) {
              byConflict.get(c.id).push({ ...art, _m: m });
              articleCount++;
            }
          }
        }
      }
    });
    log(`  ReliefWeb-Länderfeeds: ${okCount}/${isos.length} ok, ${articleCount} Artikel zugeordnet`);
  }

  // ---------- 3. GDELT je Konflikt (gedrosselt) ----------
  const gdeltStatus = { ok: 0, failed: 0, skipped: 0, errors: [] };
  if (USE_GDELT) {
    const rotation = await readJson(GDELT_STATE, {});
    const queue = pickGdeltQueue(conflicts, byConflict, rotation);
    const t1 = Date.now();
    log(`GDELT: ${queue.length} von ${conflicts.length} Konflikten in dieser Runde (Budget ${GDELT_BUDGET_MS / 1000}s) ...`);

    for (const c of queue) {
      if (Date.now() - t1 > GDELT_BUDGET_MS) {
        gdeltStatus.skipped = queue.length - gdeltStatus.ok - gdeltStatus.failed;
        log(`  Zeitbudget erreicht, ${gdeltStatus.skipped} Konflikte auf die nächste Runde vertagt`);
        break;
      }
      try {
        const arts = await gdeltSearch(c.gdeltQuery, { timespan: TIMESPAN, maxrecords: 25 });
        let kept = 0;
        for (const a of arts) {
          // Content-Farmen, Aggregatoren und Propagandakanaele aussortieren.
          if (!isAcceptableSource(a)) continue;
          // GDELTs Boolean-Queries greifen zu weit: eine Anfrage zu Zentralafrika
          // liefert auch Ebola-Meldungen aus dem Kongo. Deshalb muss der Titel die
          // Stichworte des Konflikts wirklich treffen - keine Grundpunktzahl.
          const m = matchScore(a, c);
          if (m < 3 || !isConflictRelevant(a)) continue;
          byConflict.get(c.id).push({ ...a, _m: m, weight: sourceWeight(a) });
          kept++;
        }
        gdeltStatus.ok++;
        rotation[c.id] = new Date().toISOString();
        log(`  ${c.id}: ${kept}/${arts.length} GDELT-Artikel übernommen`);
      } catch (err) {
        gdeltStatus.failed++;
        gdeltStatus.errors.push({ id: c.id, error: String(err.message || err) });
        // Auch fehlgeschlagene Versuche vormerken, sonst blockiert ein
        // dauerhaft scheiternder Konflikt die Rotation.
        rotation[c.id] = new Date().toISOString();
        log(`  ! ${c.id}: ${err.message}`);
      }
    }
    await fs.mkdir(path.dirname(GDELT_STATE), { recursive: true });
    await fs.writeFile(GDELT_STATE, JSON.stringify(rotation, null, 2));

    // Analyse-Institute (ISW, ACLED, Crisis Group ...) gesammelt, 7-Tage-Fenster.
    try {
      const analysis = await gdeltAnalysis(cfg.analysisDomains, [], { timespan: '7d', maxrecords: 200 });
      let assigned = 0;
      for (const a of analysis) {
        if (isOffTopic(a) || !isAcceptableSource(a)) continue;
        a.sourceType = 'analysis';
        a.weight = 4;
        for (const c of conflicts) {
          const m = matchScore(a, c);
          if (m > 0) {
            byConflict.get(c.id).push({ ...a, _m: m });
            assigned++;
          }
        }
      }
      log(`  Analyse-Institute: ${analysis.length} Artikel, ${assigned} zugeordnet`);
    } catch (err) {
      log(`  ! Analyse-Abfrage: ${err.message}`);
    }
  } else {
    log('GDELT übersprungen (--no-gdelt)');
  }

  // ---------- 4. Aufbereiten je Konflikt ----------
  const briefings = await readJson(path.join(ROOT, 'data', 'briefings.json'), { briefings: {} });
  const regionIndex = loadRegions();
  log(`  Regionsindex: ${regionIndex.total} Verwaltungsregionen geladen`);
  const out = [];

  const cutoff = Date.now() - MAX_ITEM_AGE_DAYS * 864e5;

  for (const c of conflicts) {
    const fresh = byConflict.get(c.id) || [];
    const prevItems = prevById.get(c.id)?.items || [];
    const prevUrls = new Set(prevItems.map((i) => normUrl(i.url)));
    const hadPrev = prevUrls.size > 0;

    // Frueheren Bestand uebernehmen. Faellt eine Quelle zeitweise aus (Drossel,
    // Netzfehler), darf der Konflikt nicht leer werden - der Lauf reichert an,
    // statt zu ersetzen. Zu alte Meldungen fallen dabei heraus.
    const carried = prevItems
      .filter((i) => !i.date || new Date(i.date).getTime() >= cutoff)
      // Der Quellenfilter wird auch auf den Altbestand angewandt: sonst bleiben
      // einmal aufgenommene Ramschquellen bis zum Ablaufdatum stehen.
      .filter((i) => isAcceptableSource({ url: i.url }))
      .map((i) => ({ ...i, _m: 4, isNew: false }));

    const combined = [...fresh, ...carried].filter(
      (a) => !a.date || new Date(a.date).getTime() >= cutoff,
    );
    combined.sort((a, b) => rankArticle(b, b._m) - rankArticle(a, a._m));
    const items = dedupe(combined).slice(0, MAX_ITEMS);

    // Region und Ereignistyp je Meldung - Grundlage der Marker in der Länderansicht.
    const regions = regionsForConflict(c, regionIndex, c.extraCountries || []);

    let newCount = 0;
    const finalItems = items.map((a) => {
      const isNew = hadPrev && !prevUrls.has(normUrl(a.url));
      if (isNew) newCount++;
      const region = regions.length ? detectRegion(a, regions) : null;
      return {
        title: a.title,
        url: a.url,
        date: a.date,
        source: a.source,
        sourceType: a.sourceType || 'news',
        summary: a.summary || '',
        isNew,
        region,
        // Symbol neben der Ueberschrift: ausschliesslich aus der Ueberschrift.
        event: classifyEvent(a),
        // Nur fuer die Regionszusammenfassung, darf den Textauszug mitlesen.
        regionEvent: classifyEventDeep(a),
        score: Math.round(rankArticle(a, a._m)),
      };
    });

    // Regionen zusammenfassen: je Region das dringlichste Ereignis + Meldungszahl.
    const regionMap = new Map();
    for (const it of finalItems) {
      if (!it.region) continue;
      const cur = regionMap.get(it.region.id);
      if (cur) {
        cur.count++;
        if (it.isNew) cur.newCount++;
        cur.events.push(it.regionEvent);
      } else {
        regionMap.set(it.region.id, {
          id: it.region.id,
          name: it.region.name,
          nameDe: it.region.nameDe,
          type: it.region.type,
          anchor: it.region.anchor,
          events: [it.regionEvent],
          count: 1,
          newCount: it.isNew ? 1 : 0,
        });
      }
    }
    const regionSummary = [...regionMap.values()]
      .map(({ events, ...r }) => ({ ...r, event: dominantEvent(events) }))
      .sort((a, b) => b.count - a.count);

    const activity = activityIndex(items);
    const signals = detectSignals(items);
    const acled = acledConfigured() ? await acledEvents(c.countries[0], 7) : null;

    out.push({
      id: c.id,
      name: c.name,
      nameEn: c.nameEn,
      region: c.region,
      countries: c.countries,
      lat: c.lat,
      lon: c.lon,
      tier: c.tier,
      since: c.since,
      parties: c.parties,
      background: c.background,
      hotspots: c.hotspots,
      activity,
      severity: severity(c, activity),
      newCount,
      signals,
      acled,
      briefing: briefings.briefings?.[c.id] || null,
      iso3: (c.iso3 || '').toUpperCase(),
      extraCountries: c.extraCountries || [],
      regions: regionSummary,
      items: finalItems,
      itemCount: finalItems.length,
    });
  }

  out.sort((a, b) => b.severity - a.severity);

  const state = {
    generatedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - t0) / 1000),
    timespan: TIMESPAN,
    sources: {
      feeds: feedStatus,
      gdelt: USE_GDELT ? gdeltStatus : { skipped: true },
      acled: acledConfigured() ? 'aktiv' : 'kein Key (optional)',
    },
    totals: {
      conflicts: out.length,
      articles: out.reduce((s, c) => s + c.itemCount, 0),
      newArticles: out.reduce((s, c) => s + c.newCount, 0),
    },
    conflicts: out,
  };

  // Bei Teil-Laeufen (--only) den Rest des alten Stands behalten.
  if (ONLY.length && prev.conflicts?.length) {
    const merged = new Map(prev.conflicts.map((c) => [c.id, c]));
    for (const c of out) merged.set(c.id, c);
    state.conflicts = [...merged.values()].sort((a, b) => b.severity - a.severity);
    state.totals.conflicts = state.conflicts.length;
  }

  await fs.mkdir(path.dirname(STATE), { recursive: true });
  await fs.writeFile(STATE, JSON.stringify(state, null, 2));

  await fs.mkdir(HISTORY, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  await fs.writeFile(
    path.join(HISTORY, `${stamp}.json`),
    JSON.stringify(
      {
        generatedAt: state.generatedAt,
        conflicts: out.map((c) => ({
          id: c.id,
          activity: c.activity,
          severity: c.severity,
          newCount: c.newCount,
          signals: c.signals.map((s) => s.key),
          top: c.items[0]?.title || null,
        })),
      },
      null,
      2,
    ),
  );
  await pruneHistory();

  log(
    `Fertig in ${state.durationSec}s: ${state.totals.conflicts} Konflikte, ` +
      `${state.totals.articles} Artikel, ${state.totals.newArticles} neu`,
  );
}

/**
 * Welche Konflikte kommen in dieser Runde bei GDELT dran?
 * Vorrang haben: schlechte RSS-Abdeckung, hohe Eskalationsstufe, lange nicht abgefragt.
 */
function pickGdeltQueue(conflicts, byConflict, rotation) {
  const TIER_W = { war: 30, high: 20, medium: 10, low: 4 };
  const now = Date.now();

  const scored = conflicts.map((c) => {
    const rssCount = (byConflict.get(c.id) || []).length;
    const last = rotation[c.id] ? new Date(rotation[c.id]).getTime() : 0;
    const staleH = last ? (now - last) / 36e5 : 999;
    // Wer aus RSS kaum etwas abbekommt, braucht GDELT am dringendsten.
    const deficit = Math.max(0, 6 - rssCount) * 6;
    return { c, score: Math.min(staleH, 72) * 2 + deficit + (TIER_W[c.tier] ?? 5) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, GDELT_MAX).map((s) => s.c);
}

async function pruneHistory(keep = 240) {
  try {
    const files = (await fs.readdir(HISTORY)).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      await fs.unlink(path.join(HISTORY, f));
    }
  } catch {
    /* Verzeichnis existiert noch nicht */
  }
}

main().catch((err) => {
  console.error('FEHLER:', err);
  process.exit(1);
});
