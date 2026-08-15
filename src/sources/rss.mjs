// Minimaler RSS-/Atom-Parser ohne Abhaengigkeiten.
import { fetchText } from './http.mjs';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#8217': '’', '#8216': '‘', '#8220': '"', '#8221': '"',
  '#8211': '–', '#8212': '—', '#160': ' ',
};

function decode(str = '') {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (ENTITIES[e.toLowerCase()] !== undefined) return ENTITIES[e.toLowerCase()];
      if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (/^#/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return m;
    })
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}

function atomLink(block) {
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alt) return alt[1];
  const any = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return any ? any[1] : '';
}

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks) {
    const title = tag(block, 'title');
    let link = tag(block, 'link');
    if (!link || /^\s*$/.test(link)) link = atomLink(block);
    const date =
      parseDate(tag(block, 'pubDate')) ||
      parseDate(tag(block, 'published')) ||
      parseDate(tag(block, 'updated')) ||
      parseDate(tag(block, 'dc:date'));
    const summary =
      tag(block, 'description') || tag(block, 'summary') || tag(block, 'content');
    if (!title) continue;
    items.push({ title, url: link.trim(), date, summary: summary.slice(0, 400) });
  }
  return items;
}

export async function fetchFeed(feed) {
  try {
    const xml = await fetchText(feed.url, { timeout: 25000, retries: 1 });
    const items = parseFeed(xml).map((it) => ({
      ...it,
      source: feed.name,
      sourceId: feed.id,
      sourceType: feed.type,
      weight: feed.weight,
    }));
    return { ok: true, id: feed.id, items };
  } catch (err) {
    return { ok: false, id: feed.id, items: [], error: String(err.message || err) };
  }
}
