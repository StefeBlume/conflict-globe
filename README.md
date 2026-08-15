# Conflict Globe

3D-Globus-Dashboard zur weltweiten Konfliktlage. Klick auf ein Land oder einen Marker
öffnet den aktuellen Stand des Konflikts samt Nachrichtenlage aus seriösen Quellen.

![Stack](https://img.shields.io/badge/node-%E2%89%A518-informational) ![Deps](https://img.shields.io/badge/runtime--deps-0-success)

## Schnellstart

```bash
cd /Users/stefeblume/conflict-globe
npm run update:fast   # ~15 s, nur RSS-Quellen
npm start             # http://localhost:4173
```

Für den vollen Datenbestand inklusive GDELT (dauert wegen der API-Drossel ~5 Minuten):

```bash
npm run update
```

## Was das Dashboard zeigt

**Weltansicht** — Reliefglobus mit 44 aktiven Konflikten, von Vollkriegen (Ukraine, Gaza,
Sudan, DR Kongo, Myanmar, Sahel, Haiti) bis zu Konflikten geringer Intensität (Bosnien,
Moldau, Kosovo). Markergröße und Pulsfrequenz folgen der aktuellen Nachrichtenaktivität,
die Farbe der Intensitätsstufe (Krieg / hoch / mittel / gering).

Als Kartengrundlage dient **Natural Earth II mit Schummerung** (10 800 × 5 400, gemeinfrei).
Bewusst kein Satellitenfoto: Die verfügbaren NASA-Blue-Marble-Aufnahmen in hoher Auflösung
stammen aus dem Dezember und zeigen großflächig Schneedecke über der Ukraine, Russland und
Kanada — darunter verschwinden genau die Verwaltungsgrenzen, die in der Länderansicht
zählen. Das Relief ist bauartbedingt schnee- und wolkenfrei.

**Länderansicht** — ein Klick auf ein Land zoomt formatfüllend heran und zeigt:

- die **Verwaltungsgrenzen** des Landes (Oblaste, Bundesstaaten, Provinzen), abgestuft:
  Staatsgrenze rund 3 px, Regionsgrenzen rund 1 px. Beide sind Bandgeometrien statt
  Linien — WebGL ignoriert `linewidth` auf nahezu allen Plattformen, eine 1-px-Linie
  wäre also die einzige mögliche Stärke. Die Staatsgrenze wird dabei nicht aus einer
  separaten Länderdatei gezeichnet, sondern aus den Regionen selbst abgeleitet: Kanten,
  die nur zu einer Region gehören, bilden den Außenrand und liegen damit exakt auf den
  Regionsgrenzen.
- **Ereignis-Symbole an der betroffenen Region**: Wo etwas passiert, steht ein Symbol,
  das zur Lage passt — 🪖 Bodenoffensive, ✈️ Luftangriff, 🛩️ Drohnenangriff,
  💥 Beschuss, 🚢 Seeangriff, 🛡️ Belagerung, 🚶 Vertreibung, 🕊️ Waffenruhe,
  🤝 Verhandlungen und weitere (vollständig in `src/regions.mjs`).
- eine **Regionsleiste** unten: Klick auf eine Region filtert die Meldungsliste auf sie.

Beispiel Ukraine: Meldet eine Quelle einen Drohnenangriff bei Cherson, erscheint 🛩️ auf
dem Oblast Cherson — nicht irgendwo im Land.

Zurück zur Weltansicht per Knopf, `Esc` oder Herauszoomen.

**Detailpanel** — Intensität, Aktivität, erkannte Eskalations- und Deeskalationssignale,
betroffene Regionen, Hintergrund, Konfliktparteien, Brennpunkte und bis zu 80 Meldungen
je Konflikt mit Quelle, Alter, Ereignis-Symbol und `NEU`-Kennzeichnung. Dazu die
**Lageeinschätzung**, die der Analyse-Loop schreibt.

Das Klicken funktioniert über die echte Ländergeometrie (Natural Earth): ein Klick
irgendwo auf ukrainisches Staatsgebiet öffnet den Ukraine-Konflikt, nicht nur ein Treffer
auf den Marker.

### Wie die Regionszuordnung funktioniert

`src/regions.mjs` durchsucht Titel und Textauszug jeder Meldung nach Regionsnamen aus dem
Natural-Earth-Datensatz — inklusive aller Schreibweisen (Kherson, Cherson, Khersonska
Oblast). Der längste Treffer gewinnt, damit „Nord-Kordofan" nicht als „Kordofan" zählt.

Zwei Fallen sind bewusst entschärft: Regionsnamen, die häufiger Personennamen sind
(„Vladimir" → Wladimir), und solche, die genauso heißen wie ein Staat („Niger" meint fast
immer das Land, nicht den nigerianischen Bundesstaat). Rund 20 % der Meldungen lassen sich
regional zuordnen — Ereignismeldungen deutlich häufiger als Länderberichte.

## Datenquellen

Alle Quellen sind ohne Bezahlschranke und werden automatisiert abgefragt.

| Quelle | Art | Zugang |
|---|---|---|
| **ReliefWeb-Länderfeeds (UN OCHA)** | ein Feed je Konfliktland — die Grundabdeckung | RSS, 43 Feeds |
| **ReliefWeb global + Headlines** | humanitäre Lageberichte | RSS |
| **UN News – Peace & Security** | UN-Meldungen | RSS |
| **International Crisis Group, InSight Crime** | Konfliktanalyse | RSS |
| **Al Jazeera, BBC, Guardian, DW, France 24, Middle East Eye, Balkan Insight, OC Media, AllAfrica, Dawn, TOLOnews, Premium Times, Times of Israel** | Nachrichten, regional gestreut | RSS |
| **GDELT DOC 2.0 API** | weltweiter Nachrichtenindex, konfliktspezifische Queries | frei, aber stark gedrosselt |
| **ISW, ACLED, SIPRI, IISS, Chatham House, CSIS, HRW, ICRC u. a.** | Analyseinstitute | über GDELT-Domainfilter |
| **ACLED API** | harte Ereignis- und Opferzahlen | optional, kostenloser Key |

### Sprachen

Die ReliefWeb-Länderfeeds antworten in der Sprache des Landes: Spanisch für Ecuador,
Kolumbien und Venezuela, Französisch für Mali, Burkina Faso, Tschad, Kamerun und Haiti.
Der Relevanzfilter in `src/analyze.mjs` kennt deshalb neben den englischen auch
französische, spanische und portugiesische Konfliktbegriffe — ohne sie fielen genau die
Konflikte durch das Raster, die in weltweiten Feeds ohnehin kaum vorkommen.

### Quellenfilter

Die RSS-Feeds sind kuratiert. GDELT indexiert dagegen praktisch das gesamte Web, also
auch Aggregatoren ohne Redaktion, Content-Farmen und Kanäle mit Propagandaauftrag.
`src/sources/quality.mjs` sortiert diese aus (Sperrliste) und gewichtet den Rest:
Forschung und UN-Stellen am höchsten, etablierte Presse darunter, unbekannte Domains
werden behalten — GDELT findet auch gute Lokalmedien —, landen im Ranking aber hinten.

Ohne diesen Filter tauchten unter anderem `hngn.com`, `silverbirdtv.com` und
`theepochtimes.com` im Lagebild auf.

Tragende Säule sind die **ReliefWeb-Länderfeeds**: je Konflikt ein länderscharfer
UN-OCHA-Feed. Damit hat jeder der 44 Konflikte Abdeckung, auch die, die in weltweiten
Nachrichtenfeeds nie vorkommen.

ISW und ACLED sperren direkte Feed-Zugriffe. Ihre Veröffentlichungen kommen über den
Domainfilter der GDELT-Suche herein (`analysisDomains` in `config/conflicts.json`).

### Verhalten bei Quellenausfällen

Die Quellen sind unterschiedlich zuverlässig — GDELT drosselt hart, ReliefWeb antwortet
zeitweise mit HTTP 429. Darauf ist die Pipeline ausgelegt:

- **Läufe reichern an, statt zu ersetzen.** Fällt eine Quelle aus, bleibt der bisherige
  Bestand erhalten (Meldungen verfallen nach 7 Tagen). Ein gescheiterter Lauf kann das
  Dashboard nicht leeren.
- **GDELT rotiert unter Zeitbudget.** Statt alle 44 Konflikte pro Lauf abzufragen
  (>25 min) kommen pro Runde die dringendsten dran — schlechte Abdeckung, hohe
  Eskalationsstufe, längste Wartezeit. Steuerbar über `--gdelt-budget` und `--gdelt-max`.
- **Rückzug bei Drosselung**: meldet ReliefWeb 429, entfallen die 43 Länderfeeds in
  diesem Lauf, statt die Sperre zu verlängern.
- **curl-Fallback**: einige CDNs weisen den TLS-Fingerprint von Node dauerhaft ab und
  bedienen curl anstandslos. Schlägt `fetch` fehl, wird auf curl ausgewichen.

### ACLED optional aktivieren

ACLED liefert die belastbarsten Zahlen (Ereignisse, Todesopfer, betroffene Regionen).
Key kostenlos unter <https://developer.acleddata.com/> anfordern, dann:

```bash
export ACLED_KEY="dein-key"
export ACLED_EMAIL="deine@mail.de"
npm run update
```

Danach erscheint im Detailpanel zusätzlich ein ACLED-Block mit 7-Tage-Zahlen.

## Stündliches Update

Zwei Ebenen, die unabhängig voneinander laufen:

**1. Datenabruf** — rein maschinell, holt die Quellen und erkennt neue Meldungen.
Bereits als cron-Job eingerichtet, läuft stündlich um :07:

```bash
crontab -l    # 7 * * * * /Users/stefeblume/conflict-globe/scripts/update.sh
```

Manuell anstoßen: `./scripts/update.sh` · Log: `data/update.log`

> macOS: Sollte der cron-Job nichts schreiben, braucht `/usr/sbin/cron` unter
> Systemeinstellungen → Datenschutz & Sicherheit → Festplattenvollzugriff eine Freigabe.
> Prüfen mit `tail data/update.log` — dort steht nach jedem Lauf ein Zeitstempel.

**2. Analyse-Loop** — bewertet die neue Nachrichtenlage und schreibt je Konflikt eine
Lageeinschätzung, stündlich um :37 (versetzt, damit er frische Daten liest). Läuft als
Session-Job in Claude Code, solange die Sitzung offen ist (siehe `LOOP.md`).

Cloud-Routinen scheiden hier aus: sie laufen in Anthropics Cloud und haben keinen
Zugriff auf dieses lokale Projekt.

Die Lageeinschätzungen liegen in `data/briefings.json` und werden vom Server live in die
API gemischt — ein neues Briefing ist ohne erneuten Datenabruf sofort im Dashboard.

## Projektstruktur

```
config/conflicts.json     Konflikt-Registry: Koordinaten, Parteien, Keywords, GDELT-Queries
src/fetch.mjs             Orchestrator: Quellen holen, zuordnen, bewerten -> data/state.json
src/analyze.mjs           Relevanzfilter, Matching, Ranking, Signalerkennung
src/regions.mjs           Regionszuordnung der Meldungen + Ereignistypen/Symbole
src/sources/              HTTP-Helfer, RSS-Parser, GDELT- und ACLED-Client
src/serve.mjs             Server: statische Dateien (gzip) + /api/state, /api/history, /api/health
src/report.mjs            Lagebericht für den Analyse-Loop
src/briefing.mjs          Lageeinschätzungen pflegen
scripts/build-admin1.mjs  erzeugt die Verwaltungsgrenzen aus dem Natural-Earth-Datensatz
public/                   Dashboard (three.js-Globus, kein Build-Schritt)
public/vendor/earth.jpg   Natural Earth II mit Schummerung, 8192x4096 (gemeinfrei)
public/vendor/admin1.geo.json  1276 Verwaltungsregionen aus 47 Ländern
data/state.json           aktueller Datenstand
data/briefings.json       Lageeinschätzungen
data/history/             stündliche Snapshots für Verlaufsvergleiche
```

### Verwaltungsgrenzen neu bauen

Die Datei `public/vendor/admin1.geo.json` liegt fertig im Projekt. Neu erzeugen (etwa nach
dem Hinzufügen eines Konfliktlands):

```bash
curl -L -o /tmp/admin1.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
node scripts/build-admin1.mjs /tmp/admin1.geojson
```

## Befehle

```bash
npm start                          # Dashboard auf Port 4173
npm run update                     # voller Abruf (RSS + GDELT)
npm run update:fast                # nur RSS, ~15 s
node src/fetch.mjs --only sudan    # einzelnen Konflikt aktualisieren
node src/report.mjs                # was hat sich seit dem letzten Lauf geändert
node src/report.mjs --id sudan     # alle Meldungen zu einem Konflikt
node src/briefing.mjs list         # Alter aller Lageeinschätzungen
```

## Konflikt hinzufügen

Neuen Eintrag in `config/conflicts.json` unter `conflicts` ergänzen. Pflichtfelder:
`id`, `name`, `region`, `countries` (exakter Name aus `public/vendor/countries.geo.json`),
`lat`, `lon`, `tier`, `parties`, `background`, `hotspots`, `keywords`, `gdeltQuery`.

Prüfen, ob die Koordinate im richtigen Land liegt:

```bash
node -e "const g=require('./public/vendor/countries.geo.json');console.log(g.features.map(f=>f.properties.name).join(', '))"
```

## Einordnung

Die Kennzahlen sind Nachrichten-, keine Ereignismetriken:

- **Intensität** kombiniert die Grundeinstufung des Konflikts mit der aktuellen Aktivität.
- **Aktivität** misst Berichterstattungsdichte der letzten 24–72 Stunden.

Hohe Werte bedeuten viel Berichterstattung, nicht zwingend viel Gewalt — mediale
Aufmerksamkeit ist weltweit sehr ungleich verteilt. Für belastbare Gewaltzahlen ist der
optionale ACLED-Anschluss die richtige Quelle. Die Signalerkennung
("Offensive", "Waffenruhe" …) ist eine Stichwortheuristik über Überschriften und dient
der Orientierung, nicht als Faktenaussage.
