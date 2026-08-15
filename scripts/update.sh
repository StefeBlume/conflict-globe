#!/bin/bash
# Stuendlicher Datenabruf. Kann direkt per cron/launchd laufen - unabhaengig vom Agenten.
#
#   crontab -e
#   7 * * * * /Users/stefeblume/conflict-globe/scripts/update.sh
#
# Log: data/update.log

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# cron startet mit minimaler Umgebung - Node explizit auffindbar machen.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
NODE="$(command -v node || echo /usr/local/bin/node)"

LOG="data/update.log"
mkdir -p data

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') ====="
  "$NODE" src/fetch.mjs --timespan 36h
  echo "Exit: $?"
} >> "$LOG" 2>&1

# Log auf die letzten 2000 Zeilen kuerzen
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
