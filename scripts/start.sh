#!/usr/bin/env bash
# Start the mock upstream (8788) and Tripwire (8787) in the background. Logs in logs/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="${PY:-$ROOT/.venv/bin/python}"
TRIPWIRE_PORT="${TRIPWIRE_PORT:-8787}"
MOCK_PORT="${MOCK_PORT:-8788}"
export TRIPWIRE_UPSTREAM="${TRIPWIRE_UPSTREAM:-http://127.0.0.1:$MOCK_PORT}"
export TRIPWIRE_PAUSE_TIMEOUT="${TRIPWIRE_PAUSE_TIMEOUT:-45}"
export TRIPWIRE_PORT
mkdir -p logs

"$ROOT/scripts/stop.sh" >/dev/null 2>&1 || true
sleep 0.3
for port in "$MOCK_PORT" "$TRIPWIRE_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use (another server running?). Stop it or set TRIPWIRE_PORT/MOCK_PORT." >&2
    exit 1
  fi
done

nohup "$PY" -m uvicorn demo.mock_upstream:app --host 127.0.0.1 --port "$MOCK_PORT" > logs/mock.log 2>&1 &
echo $! > logs/mock.pid
nohup "$PY" -m uvicorn server.app:app --host 127.0.0.1 --port "$TRIPWIRE_PORT" --timeout-graceful-shutdown 2 > logs/tripwire.log 2>&1 &
echo $! > logs/tripwire.pid

wait_for() {  # url name pidfile
  for _ in $(seq 1 50); do
    if ! kill -0 "$(cat "$3")" 2>/dev/null; then echo "  $2 exited; see logs/" >&2; return 1; fi
    if curl -fsS -o /dev/null "$1" 2>/dev/null; then echo "  $2 up"; return 0; fi
    sleep 0.2
  done
  echo "  $2 failed to start; see logs/" >&2; return 1
}
echo "Starting (pause timeout ${TRIPWIRE_PAUSE_TIMEOUT}s, upstream $TRIPWIRE_UPSTREAM)..."
wait_for "http://127.0.0.1:$MOCK_PORT/health" "mock upstream :$MOCK_PORT" logs/mock.pid
wait_for "http://127.0.0.1:$TRIPWIRE_PORT/api/stats" "tripwire :$TRIPWIRE_PORT" logs/tripwire.pid
echo
echo "Dashboard: http://localhost:$TRIPWIRE_PORT/"
echo "Logs:      logs/tripwire.log, logs/mock.log   Stop: scripts/stop.sh"
