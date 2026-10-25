#!/usr/bin/env bash
# Stop servers started by scripts/start.sh
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for name in tripwire mock; do
  pidf="$ROOT/logs/$name.pid"
  if [ -f "$pidf" ]; then
    pid="$(cat "$pidf")"
    if kill "$pid" 2>/dev/null; then echo "stopped $name ($pid)"; fi
    rm -f "$pidf"
  fi
done
