// Quellenbewertung fuer GDELT-Treffer.
//
// Die kuratierten RSS-Feeds sind gesetzt. GDELT dagegen indexiert praktisch das
// gesamte Web - darunter Aggregatoren ohne eigene Redaktion, Content-Farmen und
// Ausreisser mit ausgepraegter Agenda. Fuer ein Lagebild taugt das nicht, also
// filtern wir hier und gewichten den Rest nach Redaktionsqualitaet.

/** Etablierte Nachrichtenagenturen, Qualitaetspresse und Forschungsinstitute. */
const TRUSTED = new Set([
  // Agenturen und internationale Qualitaetspresse
  'reuters.com', 'apnews.com', 'afp.com', 'bbc.com', 'bbc.co.uk', 'theguardian.com',
  'nytimes.com', 'washingtonpost.com', 'wsj.com', 'ft.com', 'economist.com',
  'aljazeera.com', 'dw.com', 'france24.com', 'rfi.fr', 'npr.org', 'pbs.org',
  'cnn.com', 'nbcnews.com', 'cbsnews.com', 'abcnews.go.com', 'bloomberg.com',
  'politico.eu', 'politico.com', 'lemonde.fr', 'spiegel.de', 'zeit.de', 'faz.net',
  'sueddeutsche.de', 'tagesschau.de', 'nzz.ch', 'elpais.com', 'corriere.it',
  'independent.co.uk', 'telegraph.co.uk', 'thetimes.co.uk', 'newsweek.com',
  'time.com', 'theatlantic.com', 'foreignpolicy.com', 'foreignaffairs.com',

  // Forschung, Thinktanks, Beobachtungsstellen
  'understandingwar.org', 'acleddata.com', 'crisisgroup.org', 'iiss.org', 'sipri.org',
  'chathamhouse.org', 'csis.org', 'rusi.org', 'carnegieendowment.org', 'brookings.edu',
  'atlanticcouncil.org', 'fpri.org', 'ecfr.eu', 'swp-berlin.org', 'clingendael.org',
  'iss.europa.eu', 'issafrica.org', 'sipri.se', 'prio.org', 'ucdp.uu.se',
  '38north.org', 'longwarjournal.org', 'bellingcat.com', 'airwars.org',

  // UN, humanitaere Organisationen, Menschenrechte
  'reliefweb.int', 'un.org', 'unhcr.org', 'unicef.org', 'wfp.org', 'who.int',
  'ochaopt.org', 'icrc.org', 'hrw.org', 'amnesty.org', 'msf.org', 'nrc.no',
  'thenewhumanitarian.org', 'iom.int', 'ipcinfo.org', 'fews.net',

  // Etablierte Regionalquellen
  'scmp.com', 'straitstimes.com', 'japantimes.co.jp', 'koreaherald.com',
  'thehindu.com', 'indianexpress.com', 'dawn.com', 'thenews.com.pk',
  'timesofisrael.com', 'haaretz.com', 'jpost.com', 'middleeasteye.net',
  'al-monitor.com', 'arabnews.com', 'thenationalnews.com', 'dailysabah.com',
  'kyivindependent.com', 'pravda.com.ua', 'meduza.io', 'novayagazeta.eu',
  'oc-media.org', 'balkaninsight.com', 'rferl.org', 'svoboda.org',
  'allafrica.com', 'premiumtimesng.com', 'dailymaverick.co.za', 'mg.co.za',
  'nation.africa', 'theeastafrican.co.ke', 'sudantribune.com', 'radiodabanga.org',
  'irrawaddy.com', 'bnionline.net', 'frontiermyanmar.net', 'tolonews.com',
  'insightcrime.org', 'infobae.com', 'eltiempo.com', 'elfaro.net',
  'thepeninsulaqatar.com', 'gulfnews.com', 'lemonde.fr', 'liberation.fr',
]);

/**
 * Ausgeschlossen: Aggregatoren ohne eigene Redaktion, Content-Farmen,
 * Staatsmedien mit Propagandaauftrag und Ausreisser mit starker Agenda.
 * Die Liste ist bewusst kurz und nennt nur klare Faelle.
 */
const BLOCKED = [
  // Content-Farmen und Aggregatoren ohne Redaktion
  /(^|\.)hngn\.com$/i, /(^|\.)africaleader\.com$/i, /(^|\.)medafricatimes\.com$/i,
  /(^|\.)silverbirdtv\.com$/i, /(^|\.)newsbreak\.com$/i, /(^|\.)msn\.com$/i,
  /(^|\.)yahoo\.com$/i, /(^|\.)news18\.com$/i, /(^|\.)opindia\.com$/i,
  /(^|\.)zerohedge\.com$/i, /(^|\.)beforeitsnews\.com$/i, /(^|\.)dailymail\.co\.uk$/i,
  /(^|\.)express\.co\.uk$/i, /(^|\.)the-sun\.com$/i, /(^|\.)mirror\.co\.uk$/i,
  /star(sandstripes)?\.com\.ng$/i, /(^|\.)wn\.com$/i, /(^|\.)einnews\.com$/i,
  /(^|\.)menafn\.com$/i, /(^|\.)prnewswire\.com$/i, /(^|\.)globenewswire\.com$/i,

  // Bekannt agendagetriebene bzw. staatlich gelenkte Auslandsdienste
  /(^|\.)theepochtimes\.com$/i, /(^|\.)ntd\.com$/i, /(^|\.)rt\.com$/i,
  /(^|\.)sputnik\w*\.\w+$/i, /(^|\.)tass\.(com|ru)$/i, /(^|\.)pravda\.ru$/i,
  /(^|\.)presstv\.\w+$/i, /(^|\.)globaltimes\.cn$/i, /(^|\.)xinhuanet\.com$/i,
  /(^|\.)cgtn\.com$/i, /(^|\.)telesurenglish\.net$/i, /(^|\.)almasdarnews\.com$/i,

  // Fachfremd (Kunst, Religion, Unterhaltung) - keine Konfliktberichterstattung
  /(^|\.)hyperallergic\.com$/i, /(^|\.)indcatholicnews\.com$/i,
  /(^|\.)christianpost\.com$/i, /(^|\.)patheos\.com$/i,
];

function hostOf(article) {
  const raw = article.domain || article.url || '';
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(raw).replace(/^www\./, '').toLowerCase();
  }
}

/** Soll dieser GDELT-Treffer ueberhaupt aufgenommen werden? */
export function isAcceptableSource(article) {
  const host = hostOf(article);
  if (!host) return false;
  return !BLOCKED.some((rx) => rx.test(host));
}

/**
 * Vertrauensgewicht: 4 = Forschung/UN, 3 = etablierte Presse, 1 = unbekannt.
 * Unbekannte Quellen fliegen nicht raus - GDELT findet auch gute Lokalmedien -
 * landen aber im Ranking hinter den belegten.
 */
export function sourceWeight(article) {
  const host = hostOf(article);
  if (TRUSTED.has(host)) return 3;
  // Auch Subdomains etablierter Häuser anerkennen (news.un.org, edition.cnn.com)
  for (const t of TRUSTED) if (host.endsWith(`.${t}`)) return 3;
  if (/\.(gov|int)$/i.test(host) || /(^|\.)un\.org$/i.test(host)) return 4;
  return 1;
}

export function isTrusted(article) {
  return sourceWeight(article) >= 3;
}
