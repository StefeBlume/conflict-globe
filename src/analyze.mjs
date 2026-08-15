// Zuordnung, Bewertung und Deduplizierung der Artikel je Konflikt.

/** Eskalations-/Deeskalationssignale fuer die Statuszeile. */
export const SIGNALS = [
  { key: 'offensive', label: 'Offensive', dir: 'up', rx: /\b(offensive|advance[sd]?|captur\w+|seiz\w+|storm\w+|breakthrough|push(?:ed|es)? into|overrun)\b/i },
  { key: 'airstrike', label: 'Luftschläge', dir: 'up', rx: /\b(air ?strike|airstrikes|bomb(?:ing|ed)|shell(?:ing|ed)|missile|drone strike|artillery)\b/i },
  { key: 'casualties', label: 'Opfer', dir: 'up', rx: /\b(killed|dead|death toll|casualt\w+|massacre|fatalities)\b/i },
  { key: 'escalation', label: 'Eskalation', dir: 'up', rx: /\b(escalat\w+|mobiliz\w+|reinforce\w+|deploy\w+ troops|declare[sd]? war|state of emergency)\b/i },
  { key: 'displacement', label: 'Vertreibung', dir: 'up', rx: /\b(displac\w+|refugee[s]?|fle\w+|evacuat\w+|famine|starvation)\b/i },
  { key: 'ceasefire', label: 'Waffenruhe', dir: 'down', rx: /\b(cease ?fire|truce|peace (?:deal|talks|agreement|process)|withdraw\w+|de-?escalat\w+|prisoner (?:swap|exchange))\b/i },
  { key: 'talks', label: 'Verhandlungen', dir: 'down', rx: /\b(negotiat\w+|talks|summit|mediat\w+|diplomat\w+|accord|memorandum)\b/i },
  { key: 'sanctions', label: 'Sanktionen', dir: 'up', rx: /\b(sanction\w+|embargo|blacklist\w+|asset freeze)\b/i },
];

const STOP_DOMAINS = /(?:^|\.)(pinterest|facebook|twitter|x)\.com$/i;

// Starke Konfliktbegriffe: einer davon genuegt, damit ein Artikel als Konfliktthema gilt.
const STRONG_TERMS =
  /\b(war|warfare|combat|battle|fight\w*|clash\w*|attack\w*|strike[sd]?|airstrike\w*|shell\w+|bomb\w*|missile\w*|drone\w*|artillery|offensive|assault|ambush|raid\w*|siege|besieg\w+|front ?line|troops?|soldiers?|army|armed forces|military|militia\w*|insurgen\w+|rebel\w*|jihad\w+|terror\w+|extremist\w*|gunmen|militant\w*|killed|death toll|casualt\w+|massacre|atroc\w+|war crime\w*|genocide|ceasefire|truce|peace (?:talks|deal|process|agreement|plan)|sanction\w+|embargo|coup|junta|mobiliz\w+|occupation|occupied|annex\w+|hostage\w*|abduct\w+|kidnap\w+|weapons?|warhead|nuclear|security forces|violence|unrest|incursion|blockade|warship|peacekeep\w+|belliger\w+|paramilitar\w+)\b/i;

// Schwache Begriffe: nur in Kombination mit humanitaeren/analytischen Quellen tragfaehig.
const WEAK_TERMS =
  /\b(crisis|emergency|humanitarian|aid|displac\w+|refugee\w*|evacuat\w+|famine|starvation|malnutrition|protest\w*|riot\w*|detain\w+|prisoner\w*|negotiat\w+|mediat\w+|diplomat\w+|conflict)\b/i;

/**
 * Die ReliefWeb-Laenderfeeds liefern fuer Lateinamerika spanische und fuer den
 * Sahel franzoesische Meldungen. Ohne diese Begriffe fielen Ecuador, Haiti, Mali
 * oder Kamerun durch den rein englischen Filter und blieben ohne Abdeckung.
 */
const STRONG_TERMS_ML = new RegExp(
  [
    // Französisch
    'guerre|conflit\\w*|attaque\\w*|combat\\w*|affrontement\\w*|violence\\w*|tués?|morts?',
    'bless[ée]s?|militaire\\w*|arm[ée]e|rebelle\\w*|djihadiste\\w*|otages?|enl[èe]vement\\w*',
    'cessez-le-feu|offensive|bombardement\\w*|frappe\\w*|s[ée]curitaire|massacre\\w*|coup d.[ée]tat',
    // Spanisch / Portugiesisch
    'guerra|conflicto|conflito|ataque\\w*|combate\\w*|enfrentamiento\\w*|violencia|viol[êe]ncia',
    'muertos?|heridos?|mortos?|feridos?|militar\\w*|ej[ée]rcito|ex[ée]rcito|rebelde\\w*',
    'rehenes?|secuestro\\w*|alto el fuego|cessar-fogo|masacre\\w*|golpe de estado',
    'desplazamiento\\w*|desplazad[oa]s?|deslocad[oa]s?|refugiad[oa]s?',
  ].join('|'),
  'i',
);

const WEAK_TERMS_ML =
  /(humanitari[ao]\w*|crisis|crise|emergencia|urgence|hambruna|fome|inseguridad|ins[ée]curit[ée]|protesta\w*|manifestation\w*|desplaz\w+|d[ée]plac[ée]\w*|r[ée]fugi[ée]\w*)/i;

// Harte Ausschluesse: Sport, Kultur, Unterhaltung.
const OFF_TOPIC =
  /\b(athletic\w*|football|soccer|world cup|olympic\w*|tournament|championship|fifa|uefa|cricket|tennis|formula 1|grand prix|eurovision|film festival|movie|box office|celebrity|fashion week|recipe|horoscope|dating app|video game|gaming|album|concert tour|netflix|oscar\w*|grammy)\b/i;

// Reine Gesundheits-/Katastrophenmeldungen sind kein Konfliktgeschehen,
// solange kein starker Konfliktbegriff dazukommt (z.B. Ebola-Ausbruch in der DR Kongo).
const NON_CONFLICT_TOPIC =
  /\b(ebola|cholera|measles|polio|malaria|dengue|mpox|epidemic|pandemic|outbreak|vaccinat\w+|earthquake|cyclone|hurricane|typhoon|flooding|floods|wildfire|drought|landslide|volcano)\b/i;

/**
 * Rueckblicke und Jahrestage sind kein aktuelles Lagebild.
 * Bewusst nur eindeutige Formulierungen: eine blosse Jahreszahl reicht nicht,
 * sonst faellt auch aktuelle Berichterstattung heraus ("Minen toeten 73 in
 * Aserbaidschan seit dem Krieg von 2020").
 */
const RETROSPECTIVE = new RegExp(
  [
    '\\b(anniversary|years ago|decades ago|looking back|retrospectiv\\w+)\\b',
    '\\b(in memoriam|obituary|on this day|flashback|remembering)\\b',
    '\\b(history of|a look back at|revisit\\w+)\\b',
    '\\b(coup|war|genocide|massacre|revolution|uprising) of (?:19|20)\\d{2}\\b',
  ].join('|'),
  'i',
);

/** Sport, Kultur, Rueckblicke - fliegt immer raus. */
export function isOffTopic(article) {
  const title = article.title || '';
  return OFF_TOPIC.test(title) || RETROSPECTIVE.test(title);
}

/**
 * Ist der Artikel ueberhaupt ein Konflikt-/Krisenthema?
 * Nur fuer RSS-Artikel sinnvoll: dort matchen wir breit ueber Laendernamen.
 * GDELT-Treffer stammen bereits aus konfliktspezifischen Queries und werden
 * nur gegen OFF_TOPIC geprueft (GDELT liefert keinen Textauszug).
 */
export function isConflictRelevant(article) {
  if (isOffTopic(article)) return false;
  const title = article.title || '';
  const text = `${title} ${article.summary || ''}`;
  const strong = STRONG_TERMS.test(text) || STRONG_TERMS_ML.test(text);

  // Seuchen- und Naturkatastrophenmeldungen brauchen einen Konfliktbegriff
  // in der Ueberschrift selbst - sonst zieht ein "killed 11,000 people"
  // aus dem Fliesstext eine Ebola-Meldung in den Konflikt-Feed.
  if (NON_CONFLICT_TOPIC.test(title)) return STRONG_TERMS.test(title) || STRONG_TERMS_ML.test(title);
  if (strong) return true;

  // Humanitaere und analytische Quellen duerfen auch ueber schwache Begriffe rein.
  const trusted = article.sourceType === 'humanitarian' || article.sourceType === 'analysis';
  return trusted && (WEAK_TERMS.test(text) || WEAK_TERMS_ML.test(text));
}

export function normUrl(u = '') {
  try {
    const url = new URL(u);
    url.hash = '';
    url.search = '';
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
}

export function normTitle(t = '') {
  return t.toLowerCase().replace(/[^a-z0-9äöüß ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
}

/** Wie gut passt ein Artikel zu einem Konflikt? 0 = kein Treffer. */
export function matchScore(article, conflict) {
  const title = (article.title || '').toLowerCase();
  const body = `${title} ${(article.summary || '').toLowerCase()}`;
  let score = 0;
  let hits = 0;
  for (const kw of conflict.keywords) {
    const k = kw.toLowerCase();
    if (title.includes(k)) {
      score += 3;
      hits++;
    } else if (body.includes(k)) {
      score += 1;
      hits++;
    }
  }
  // Ein einzelner generischer Treffer reicht nicht (z.B. nur "china").
  if (hits === 0) return 0;
  if (score < 3) return 0;
  return score;
}

function hoursAgo(iso) {
  if (!iso) return 999;
  return (Date.now() - new Date(iso).getTime()) / 36e5;
}

// Turnusmaessige Berichtsformate (Lagebulletins, Dashboards, Bedarfsanalysen).
// Inhaltlich wertvoll, aber keine Ereignismeldung - sie sollen nicht oben stehen.
const ROUTINE_DOC =
  /\b(bulletin|tableau de bord|dashboard|situation report|sitrep|fact ?sheet|snapshot|flash update|meeting (?:notes|minutes)|compte rendu|appeal|DREF|operational update|3W|matrix|infographic|periodic monitoring|(?:annual|monthly|weekly|quarterly) report|needs assessment|assessment report|response plan|funding|cluster|profiles and vulnerabilities|lessons learned|terms of reference|update \d{2,})\b/i;

// Konkrete Ereignismeldung - genau das, was oben im Panel stehen soll.
const EVENT_TERM =
  /\b(strike[sd]?|airstrike\w*|attack\w*|offensive|advance[sd]?|captur\w+|seiz\w+|shell\w+|bomb\w*|missile\w*|drone\w*|clash\w*|fighting|battle|raid\w*|ambush|siege|killed|dead|death toll|casualt\w+|massacre|wounded|ceasefire|truce|peace (?:deal|talks|agreement)|withdraw\w+|coup|assassinat\w+|abduct\w+|kidnap\w+|hostage\w*|explosion|blast|shooting|troops|invasion|incursion)\b/i;

/** Gesamtrang eines Artikels innerhalb eines Konflikts. */
export function rankArticle(article, matchPoints) {
  const title = article.title || '';
  const age = hoursAgo(article.date);
  const recency = age <= 6 ? 12 : age <= 24 ? 9 : age <= 72 ? 5 : age <= 168 ? 2 : 0;
  const trust = (article.weight || 1) * 2;
  // Analysehaeuser bleiben hoch gewichtet; humanitaere Quellen liefern viel
  // Dokumentmaterial und werden nur leicht bevorzugt.
  const kind = article.sourceType === 'analysis' ? 4 : article.sourceType === 'humanitarian' ? 1 : 0;
  const event = EVENT_TERM.test(title) ? 7 : 0;
  const routine = ROUTINE_DOC.test(title) ? -9 : 0;
  return recency + trust + kind + event + routine + Math.min(matchPoints, 12);
}

export function detectSignals(articles) {
  const found = new Map();
  for (const a of articles) {
    const text = `${a.title} ${a.summary || ''}`;
    for (const s of SIGNALS) {
      if (s.rx.test(text)) {
        const cur = found.get(s.key) || { key: s.key, label: s.label, dir: s.dir, count: 0 };
        cur.count++;
        found.set(s.key, cur);
      }
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count).slice(0, 5);
}

export function dedupe(articles) {
  const seenUrl = new Set();
  const seenTitle = new Set();
  const out = [];
  for (const a of articles) {
    if (!a.url || !a.title) continue;
    let host = '';
    try {
      host = new URL(a.url).hostname;
    } catch {
      /* relative/ungueltige URL */
    }
    if (host && STOP_DOMAINS.test(host)) continue;
    const nu = normUrl(a.url);
    const nt = normTitle(a.title);
    if (seenUrl.has(nu) || (nt.length > 25 && seenTitle.has(nt))) continue;
    seenUrl.add(nu);
    seenTitle.add(nt);
    out.push(a);
  }
  return out;
}

/**
 * Aktivitaetsindex 0-100: gewichtete Artikelzahl der letzten 24h/72h.
 * Dient als Groesse/Pulsstaerke des Markers auf dem Globus.
 */
export function activityIndex(articles) {
  let s = 0;
  for (const a of articles) {
    const age = hoursAgo(a.date);
    if (age <= 24) s += 3;
    else if (age <= 72) s += 1.5;
    else if (age <= 168) s += 0.5;
  }
  return Math.max(0, Math.min(100, Math.round(s * 1.6)));
}

const TIER_BASE = { war: 78, high: 55, medium: 32, low: 15 };

/** Kombiniert Grundintensitaet des Konflikts mit aktueller Nachrichtenaktivitaet. */
export function severity(conflict, activity) {
  const base = TIER_BASE[conflict.tier] ?? 25;
  return Math.round(base * 0.7 + activity * 0.3);
}
