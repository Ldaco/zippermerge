#!/usr/bin/env bash
# Supervisor for the zippermerge dashboard (Git Bash on Windows).
# Usage (run in the background):
#   bash dashboard/start-dashboard.sh
# Runs `node server.mjs` from this script's directory and restarts it when it exits.
# Stops when: <chatDir>/state/dashboard.stop exists (removed on exit), the server exits with
# EADDRINUSE (port already taken), or more than 20 restarts happen within one hour.
# Restart events are appended to <chatDir>/state/dashboard-restarts.log.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAT_DIR_PATH="${CHAT_DIR:-$(cd "$DIR/.." && pwd)}"
STATE_DIR="$CHAT_DIR_PATH/state"
LOG_FILE="$STATE_DIR/dashboard-restarts.log"
STOP_FILE="$STATE_DIR/dashboard.stop"
SERVER_FILE="${DASHBOARD_SERVER:-server.mjs}"
MAX_RESTARTS_PER_HOUR=20
WAIT_SECONDS=5

mkdir -p "$STATE_DIR"
OUT_FILE="$STATE_DIR/dashboard-last-output.txt"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG_FILE"; }
cleanup() { rm -f "$STOP_FILE"; }
trap cleanup EXIT

restart_times=()
cd "$DIR" || exit 1

while true; do
  if [ -f "$STOP_FILE" ]; then
    log "stop file found before start: supervisor exiting"
    exit 0
  fi

  node "$SERVER_FILE" 2>&1 | tee "$OUT_FILE"
  code=${PIPESTATUS[0]}
  log "server exited with code $code"

  if [ -f "$STOP_FILE" ]; then
    log "stop file found: supervisor exiting"
    exit 0
  fi
  out_text="$(cat "$OUT_FILE" 2>/dev/null)"
  if [[ "$out_text" == *EADDRINUSE* ]]; then
    log "EADDRINUSE: port already in use, supervisor exiting (not restarting)"
    exit 1
  fi

  now=$(date +%s)
  kept=()
  for t in "${restart_times[@]}"; do
    if [ $((now - t)) -lt 3600 ]; then kept+=("$t"); fi
  done
  restart_times=("${kept[@]}" "$now")
  if [ "${#restart_times[@]}" -gt "$MAX_RESTARTS_PER_HOUR" ]; then
    log "more than $MAX_RESTARTS_PER_HOUR restarts in one hour: giving up"
    exit 1
  fi

  sleep "$WAIT_SECONDS"
done
