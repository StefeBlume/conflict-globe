# Stündlicher Analyse-Loop

Der Loop hat eine Aufgabe, die das reine Abrufen der Quellen nicht leisten kann:
er **liest die neue Nachrichtenlage und schreibt daraus je Konflikt eine kurze
Lageeinschätzung** — also das, was im Dashboard unter „Aktuelle Lageeinschätzung"
erscheint.

## Ablauf je Durchlauf

1. **Daten holen**

   ```bash
   cd /Users/stefeblume/conflict-globe && ./scripts/update.sh
   ```

   Der Fetcher markiert jede Meldung, die seit dem letzten Lauf neu ist.

2. **Veränderungen ansehen**

   ```bash
   node src/report.mjs          # nur Konflikte mit neuen Meldungen
   node src/report.mjs --id ukraine-russia   # ein Konflikt im Detail, mit URLs
   ```

3. **Lageeinschätzungen aktualisieren** — nur dort, wo sich inhaltlich etwas bewegt hat:

   ```bash
   node src/briefing.mjs set ukraine-russia \
     --headline "Russische Offensive bei Pokrowsk" \
     --text "Russische Verbände haben ... (2–4 Sätze, deutsch, konkret)" \
     --sources "https://…,https://…"
   ```

   Kein Update, wenn nur dieselbe Meldung neu umgeschrieben wurde. Ein Briefing
   ohne neue Substanz ist schlechter als ein altes mit ehrlichem Zeitstempel.

4. **Aufräumen**, damit keine veralteten Einschätzungen stehen bleiben:

   ```bash
   node src/briefing.mjs prune --days 3
   ```

## Regeln für die Lageeinschätzungen

- **Deutsch**, 2–4 Sätze, konkret: Wer, wo, was, seit wann.
- **Nur belegte Aussagen.** Was in den Meldungen steht, nicht was plausibel klingt.
  Widersprechen sich Quellen, gehört das in den Text („nach ukrainischen Angaben …,
  russische Stellen melden …").
- **Keine Prognosen**, keine Wertungen, keine Spekulation über Absichten.
- **Quellen mitgeben** (`--sources`), damit die Aussage nachprüfbar bleibt.
- Meldungslage dünn? Dann das offen sagen statt zu füllen.

## Aktuelle Einrichtung

| Ebene | Takt | Läuft ab? | Verbrauch |
|---|---|---|---|
| **Datenabruf** (`scripts/update.sh` per System-cron) | stündlich um :07 | nein | **keiner** — reines Node.js |
| **Analyse-Loop** (geplante Aufgabe `conflict-globe-briefings`) | alle 6 Std. um :37 | nein | Tokens je Durchlauf |

Die beiden Ebenen sind unabhängig. **Die Nachrichten aktualisieren sich stündlich,
auch wenn der Analyse-Loop gelöscht ist** — nur die geschriebenen Lageeinschätzungen
altern dann.

## Warum geplante Aufgabe statt `/loop`

`/loop` legt einen Job im Sitzungsspeicher an: Er stirbt beim Schließen von Claude Code
und läuft nach 7 Tagen ohnehin aus — das lässt sich nicht verlängern.

Die geplante Aufgabe liegt dagegen auf der Festplatte unter
`~/.claude/scheduled-tasks/conflict-globe-briefings/SKILL.md`, hat **kein Ablaufdatum**
und übersteht Neustarts. War die Claude-App zum Fälligkeitszeitpunkt geschlossen, läuft
sie beim nächsten Start nach.

Zweiter Vorteil: Jeder Durchlauf startet mit **frischem Kontext**, statt den gesamten
Gesprächsverlauf mitzuschleppen. Das macht ihn deutlich billiger als ein `/loop` in einer
lang laufenden Sitzung — der Prompt der Aufgabe ist deshalb bewusst vollständig
selbsterklärend.

Verwalten: Seitenleiste → „Scheduled", oder die Datei oben direkt bearbeiten.

## Kostenbremse

Der Loop schiebt seinen Prompt in die laufende Sitzung und trägt damit deren Kontext mit
— jeder Durchlauf kostet mehr als die reine Berichtslänge vermuten lässt. Deshalb:

- Pro Durchlauf höchstens die 5 am stärksten veränderten Konflikte bearbeiten.
- Kein Briefing schreiben, wenn sich inhaltlich nichts bewegt hat.
- Den Datenabruf dem cron überlassen, nicht im Loop wiederholen.

Ein voller GDELT-Lauf dauert wegen der API-Drossel mehrere Minuten; `update.sh` rotiert
deshalb unter Zeitbudget über die Konflikte, statt jedes Mal alle abzufragen.
