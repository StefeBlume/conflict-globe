// Ordnet Meldungen einer konkreten Verwaltungsregion zu (Oblast, Provinz, Bundesstaat)
// und bestimmt das passende Ereignis-Symbol fuer die Kartendarstellung.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN1 = path.join(ROOT, 'public', 'vendor', 'admin1.geo.json');

// Regionsnamen, die als Wort zu haeufig vorkommen, um etwas zu beweisen.
const AMBIGUOUS = new Set([
  'central', 'north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western',
  'north east', 'north west', 'south east', 'south west', 'northeast', 'northwest',
  'southeast', 'southwest', 'capital', 'national', 'federal', 'district', 'region',
  'province', 'state', 'city', 'centre', 'center', 'coast', 'delta', 'plateau', 'river',
  'lake', 'island', 'islands', 'union', 'general', 'highland', 'highlands', 'valley',
  'mountain', 'border', 'east region', 'west region', 'north region', 'south region',
  'centre region', 'far north', 'upper', 'lower', 'middle', 'new', 'red sea', 'white nile',
  'blue nile', 'peace', 'unity', 'equatoria', 'northern state', 'western state',
  // Regionsnamen, die weit haeufiger als Personenname auftreten
  // ("Vladimir" Putin traf sonst das russische Gebiet Wladimir).
  'vladimir', 'victoria', 'george', 'charlotte', 'albert', 'alexandria', 'santiago',
  'sofia', 'valentina', 'maria', 'isabel', 'carlos', 'antonio', 'francisco',
]);

/**
 * Staatennamen. Ein Regionsname, der genauso heisst wie ein Staat, ist als
 * Beleg wertlos: "Niger" meint in den Meldungen fast immer das Land, nicht den
 * gleichnamigen nigerianischen Bundesstaat.
 */
const COUNTRY_LIKE = new Set([
  'niger', 'georgia', 'jordan', 'chad', 'sudan', 'guinea', 'congo', 'kongo', 'somalia',
  'ukraine', 'israel', 'india', 'china', 'mexico', 'colombia', 'ecuador', 'peru', 'brazil',
  'kuwait', 'oman', 'qatar', 'bahrain', 'lebanon', 'syria', 'iraq', 'iran', 'yemen',
  'armenia', 'serbia', 'kosovo', 'moldova', 'nigeria', 'cameroon', 'ethiopia', 'eritrea',
  'somaliland', 'punjab', 'kashmir', 'gaza', 'luxembourg', 'monaco', 'singapore',
]);

/**
 * Ereignistypen. Reihenfolge = Prioritaet: der erste Treffer im Titel gewinnt,
 * damit "Luftangriff mit Toten" als Luftangriff und nicht als Opfermeldung erscheint.
 */
export const EVENT_TYPES = [
  { type: 'offensive',    icon: '🪖', label: 'Bodenoffensive',      rx: /\b(offensive|ground assault|advanc\w+|captur\w+|seiz\w+|recaptur\w+|storm\w+|overr\w+|push\w+ into|took control|retook|fell to|frontline|front line|infantry|armou?red)\b/i },
  { type: 'airstrike',    icon: '✈️', label: 'Luftangriff',          rx: /\b(air ?strike\w*|air ?raid\w*|aerial|warplane\w*|jet\w*|bomb(?:ing|ed|er)|helicopter gunship)\b/i },
  { type: 'drone',        icon: '🛩️', label: 'Drohnenangriff',       rx: /\b(drone\w*|uav\w*|shahed|loitering munition|quadcopter)\b/i },
  { type: 'missile',      icon: '🚀', label: 'Raketenangriff',       rx: /\b(missile\w*|rocket\w*|ballistic|cruise missile|himars|iskander)\b/i },
  { type: 'shelling',     icon: '💥', label: 'Beschuss',             rx: /\b(shell\w+|artiller\w+|mortar\w*|barrage|bombard\w+)\b/i },
  { type: 'naval',        icon: '🚢', label: 'Seeangriff',           rx: /\b(ship\w*|vessel\w*|tanker\w*|naval|maritime|port strike|shipping lane|convoy at sea)\b/i },
  { type: 'siege',        icon: '🛡️', label: 'Belagerung',           rx: /\b(siege|besieg\w+|encircl\w+|blockad\w+|surround\w+|cut off)\b/i },
  { type: 'clash',        icon: '⚔️', label: 'Gefechte',             rx: /\b(clash\w*|fighting|battle\w*|firefight|gun ?battle|skirmish\w*|ambush\w*|raid\w*|attack\w*|assault\w*)\b/i },
  { type: 'explosion',    icon: '💣', label: 'Explosion/Anschlag',   rx: /\b(explosion\w*|blast\w*|bomb\w*|IED|car bomb|suicide bomb\w*|detonat\w+)\b/i },
  { type: 'casualties',   icon: '🚨', label: 'Opfer',                rx: /\b(killed|dead|death toll|casualt\w+|massacre|fatalities|wounded|injur\w+|victims)\b/i },
  { type: 'displacement', icon: '🚶', label: 'Vertreibung',          rx: /\b(displac\w+|refugee\w*|fle\w+|evacuat\w+|exodus|camp\w*|returnees)\b/i },
  { type: 'famine',       icon: '🍽️', label: 'Hunger/Versorgung',    rx: /\b(famine|starvation|hunger|malnutrition|food insecur\w+|IPC Phase)\b/i },
  { type: 'aid',          icon: '📦', label: 'Hilfslieferung',       rx: /\b(aid convoy|humanitarian (?:aid|convoy|assistance|access)|relief (?:supplies|operation)|food distribution)\b/i },
  { type: 'abduction',    icon: '🔗', label: 'Entführung/Geiseln',   rx: /\b(abduct\w+|kidnap\w+|hostage\w*|captiv\w+|prisoner (?:swap|exchange)|detain\w+)\b/i },
  { type: 'ceasefire',    icon: '🕊️', label: 'Waffenruhe',           rx: /\b(cease ?fire|truce|peace (?:deal|agreement|accord|plan)|withdraw\w+|de-?escalat\w+|disarm\w+)\b/i },
  { type: 'talks',        icon: '🤝', label: 'Verhandlungen',        rx: /\b(talks|negotiat\w+|summit|mediat\w+|delegation|dialogue|memorandum)\b/i },
  { type: 'protest',      icon: '📣', label: 'Proteste/Unruhen',     rx: /\b(protest\w*|demonstrat\w+|riot\w*|unrest|strike action|uprising)\b/i },
  { type: 'sanctions',    icon: '⚖️', label: 'Sanktionen/Recht',     rx: /\b(sanction\w+|embargo|tribunal|court|indict\w+|war crime\w*|investigat\w+)\b/i },
  { type: 'election',     icon: '🗳️', label: 'Politik/Wahl',         rx: /\b(election\w*|vote\w*|referendum|parliament|inaugurat\w+|sworn in|coup)\b/i },
];

const FALLBACK_EVENT = { type: 'report', icon: '📄', label: 'Bericht' };

/**
 * Ereignistyp einer Meldung - ausschliesslich aus der Ueberschrift.
 *
 * Der Textauszug wird bewusst nicht herangezogen: ein beilaeufiges Wort darin
 * setzte sonst ein Symbol, das der sichtbaren Ueberschrift widerspricht
 * (ein UNHCR-Bericht ueber Bargeldhilfen bekam so ein Luftangriff-Symbol).
 * Lieber ein neutrales "Bericht" als eine Kennzeichnung, die nicht traegt.
 */
export function classifyEvent(article) {
  const title = article.title || '';
  for (const t of EVENT_TYPES) {
    if (t.rx.test(title)) return { type: t.type, icon: t.icon, label: t.label };
  }
  return { ...FALLBACK_EVENT };
}

/**
 * Ereignistyp einschliesslich Textauszug - nur fuer die Zusammenfassung einer
 * ganzen Region gedacht, nie fuer das Symbol neben einer einzelnen Ueberschrift.
 * Als Aggregat darf hier der Meldungstext mitzaehlen: die Aussage lautet
 * "in dieser Region geht es um X" und nicht "diese Schlagzeile bedeutet X".
 */
export function classifyEventDeep(article) {
  const shallow = classifyEvent(article);
  if (shallow.type !== 'report') return shallow;
  const text = `${article.title || ''} ${article.summary || ''}`;
  for (const t of EVENT_TYPES) {
    if (t.rx.test(text)) return { type: t.type, icon: t.icon, label: t.label };
  }
  return { ...FALLBACK_EVENT };
}

/**
 * Welches Ereignis steht stellvertretend fuer eine Region?
 * Die Reihenfolge in EVENT_TYPES ist die Rangfolge: eine Bodenoffensive schlaegt
 * eine Verhandlungsmeldung. Reine Berichte nur, wenn es sonst nichts gibt.
 */
export function dominantEvent(events) {
  const rank = new Map(EVENT_TYPES.map((t, i) => [t.type, i]));
  let best = null;
  let bestRank = Infinity;
  for (const e of events) {
    if (!e || e.type === 'report') continue;
    const r = rank.has(e.type) ? rank.get(e.type) : 999;
    if (r < bestRank) {
      bestRank = r;
      best = e;
    }
  }
  return best || { ...FALLBACK_EVENT };
}

let cache = null;

/** Laedt die Admin-1-Geometrie und baut je Land eine Trefferliste auf. */
export function loadRegions() {
  if (cache) return cache;
  if (!fs.existsSync(ADMIN1)) {
    cache = { byCountry: new Map(), total: 0 };
    return cache;
  }
  const fc = JSON.parse(fs.readFileSync(ADMIN1, 'utf8'));
  const byCountry = new Map();

  for (const f of fc.features) {
    const p = f.properties;
    const patterns = [];
    for (const alias of p.aliases || []) {
      const a = alias.trim();
      if (a.length < 4) continue;
      const low = a.toLowerCase();
      if (AMBIGUOUS.has(low)) continue;
      // Staatsgleiche Namen nur zulassen, wenn ein Zusatz die Region ausweist
      // ("Niger State" ja, blosses "Niger" nein).
      if (COUNTRY_LIKE.has(low)) continue;
      // Nur lateinische Schreibweisen - kyrillische/arabische Namen kommen in
      // den englischsprachigen Meldungen nicht vor und kosten nur Rechenzeit.
      if (!/^[\p{Script=Latin}\d\s.'`’\-()]+$/u.test(a)) continue;
      patterns.push({
        alias: a,
        rx: new RegExp(`(?<![\\p{L}])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu'),
        len: a.length,
      });
    }
    if (!patterns.length) continue;
    if (!byCountry.has(p.country)) byCountry.set(p.country, []);
    byCountry.get(p.country).push({
      id: p.id,
      name: p.name,
      nameDe: p.nameDe,
      type: p.type,
      anchor: p.anchor,
      country: p.country,
      patterns,
    });
  }

  cache = { byCountry, total: fc.features.length };
  return cache;
}

/**
 * Findet die Region, um die es in einer Meldung geht.
 * Laengere Namenstreffer schlagen kuerzere ("North Kordofan" vor "Kordofan").
 */
export function detectRegion(article, regions) {
  const text = `${article.title || ''} ${article.summary || ''}`;
  let best = null;
  let bestLen = 0;
  for (const r of regions) {
    for (const p of r.patterns) {
      if (p.len > bestLen && p.rx.test(text)) {
        best = { id: r.id, name: r.name, nameDe: r.nameDe, type: r.type, anchor: r.anchor, matched: p.alias };
        bestLen = p.len;
      }
    }
  }
  return best;
}

/** Regionen aller Laender eines Konflikts (iso3 + zusaetzliche Beteiligte). */
export function regionsForConflict(conflict, index, extraCountries = []) {
  const codes = new Set();
  if (conflict.iso3) codes.add(conflict.iso3.toUpperCase());
  for (const c of extraCountries) codes.add(c.toUpperCase());
  const out = [];
  for (const code of codes) {
    const list = index.byCountry.get(code);
    if (list) out.push(...list);
  }
  return out;
}
