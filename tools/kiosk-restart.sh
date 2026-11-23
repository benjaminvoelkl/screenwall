#!/bin/bash
# Beendet den Kiosk-Chromium der Screenwall. ~/.local/bin/kiosk.sh startet
# ihn nach 2 s automatisch neu. Gedacht fuer einen naechtlichen Cron-Lauf,
# damit Renderer-Speicher und YouTube-Player nicht ueber Tage degradieren.
#
# Trifft nur die beim Start ermittelten Prozesse mit dem Kiosk-Profil; der
# vom Server gestartete Zweit-Chromium (.chrome-external/) und der von
# kiosk.sh frisch gestartete Nachfolger bleiben unberuehrt.
PATTERN='--user-data-dir=/home/ip3/kiosk-profil'

PIDS=$(pgrep -u ip3 -f -- "$PATTERN")
if [ -z "$PIDS" ]; then
  logger -t kiosk-restart "Kein Kiosk-Chromium gefunden, nichts zu tun"
  exit 0
fi

logger -t kiosk-restart "Chromium wird neu gestartet (PIDs: $(echo $PIDS | tr '\n' ' '))"
kill -TERM $PIDS 2>/dev/null

# Bis zu 10 s auf sauberes Ende der alten Prozesse warten
ALIVE=""
for _ in $(seq 1 20); do
  ALIVE=""
  for p in $PIDS; do kill -0 "$p" 2>/dev/null && ALIVE="$ALIVE $p"; done
  [ -z "$ALIVE" ] && break
  sleep 0.5
done

# Falls der Browser haengt (genau der Fehlerfall): hart beenden
if [ -n "$ALIVE" ]; then
  kill -KILL $ALIVE 2>/dev/null
  logger -t kiosk-restart "SIGKILL noetig fuer PIDs:$ALIVE"
fi
exit 0
