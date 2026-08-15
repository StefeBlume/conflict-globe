// GDELT DOC 2.0 API. Kein Key noetig, aber eigenwillig:
//   - jede Abfrage braucht serverseitig 12-20 s
//   - die Drossel greift unabhaengig vom Abstand, Erfolgsquote ~50 %
// Deshalb: serialisiert, mit Mindestabstand, Drossel-Erkennung und einem Retry.
import { fetchText, sleep } from './http.mjs';

const MIN_GAP_MS = 8000;
const THROTTLE_WAIT_MS = 20000;

let chain = Promise.resolve();
let lastCall = 0;

function serialize(fn) {
  const run = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastCall = Date.now();
    }
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

export class ThrottledError extends Error {
  constructor() {
    super('GDELT gedrosselt');
    this.throttled = true;
  }
}

function buildUrl(query, { timespan, maxrecords, lang }) {
  const q = lang ? `${query} sourcelang:${lang}` : query;
  return (
    `${BASE}?query=${encodeURIComponent(q)}` +
    `&mode=artlist&format=json&sort=datedesc` +
    `&maxrecords=${maxrecords}&timespan=${timespan}`
  );
}

function parse(text) {
  const trimmed = text.trimStart();
  // Die Drossel antwortet mit HTTP 200 und Klartext statt JSON.
  if (!trimmed.startsWith('{')) throw new ThrottledError();
  const data = JSON.parse(trimmed);
  const arts = Array.isArray(data.articles) ? data.articles : [];
  return arts.map((a) => ({
    title: a.title || '',
    url: a.url || '',
    date: gdeltDate(a.seendate),
    source: a.domain || 'GDELT',
    sourceId: 'gdelt',
    sourceType: 'news',
    domain: a.domain || '',
    language: a.language || '',
    country: a.sourcecountry || '',
    weight: 1,
    summary: '',
  }));
}

/**
 * @param {string} query  GDELT-Query (Leerzeichen = UND, OR in Klammern)
 * @param {object} opts   { timespan, maxrecords, lang, retry }
 */
export async function gdeltSearch(query, { timespan = '24h', maxrecords = 25, lang = 'english', retry = true } = {}) {
  const url = buildUrl(query, { timespan, maxrecords, lang });

  return serialize(async () => {
    try {
      return parse(await fetchText(url, { timeout: 60000, retries: 0 }));
    } catch (err) {
      if (!retry || !err.throttled) throw err;
      // Einmal laenger warten und erneut versuchen.
      await sleep(THROTTLE_WAIT_MS);
      return parse(await fetchText(url, { timeout: 60000, retries: 0 }));
    }
  });
}

// "20260814T191500Z" -> ISO
function gdeltDate(s) {
  if (!s || s.length < 15) return null;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Gezielte Abfrage der Analyse-Institute (ISW, ACLED, Crisis Group ...). */
export async function gdeltAnalysis(domains, keywords = [], { timespan = '7d', maxrecords = 200 } = {}) {
  const dom = `(${domains.map((d) => `domain:${d}`).join(' OR ')})`;
  const kw = keywords.length ? ` (${keywords.join(' OR ')})` : '';
  return gdeltSearch(`${dom}${kw}`, { timespan, maxrecords, lang: null });
}
