#!/usr/bin/env bash
# One real-Claude agent through Tripwire. Reads ANTHROPIC_API_KEY from .env (or the shell); needs scripts/start.sh running.
#   scripts/real.sh                                -> picks one of the scenarios below at random
#   SCENARIO=flaky_api scripts/real.sh             -> nudge -> recovers
#   SCENARIO=stubborn_deploy scripts/real.sh       -> nudge -> pause -> you decide -> stop
#   SCENARIO=log_audit scripts/real.sh             -> downgrade -> budget stop
# The key travels from the agent through Tripwire to api.anthropic.com as a normal x-api-key header.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${ANTHROPIC_API_KEY:?put ANTHROPIC_API_KEY in .env (see .env.example)}"

SCENARIOS=(flaky_api stubborn_deploy log_audit)
SCENARIO="${SCENARIO:-${SCENARIOS[RANDOM % ${#SCENARIOS[@]}]}}"
case "$SCENARIO" in
  flaky_api|stubborn_deploy|log_audit) ;;
  *) echo "Unknown real scenario '$SCENARIO' (use: ${SCENARIOS[*]})" >&2; exit 1 ;;
esac
# log_audit is meant to run out of budget, so it gets a smaller one.
if [ "$SCENARIO" = log_audit ]; then DEFAULT_BUDGET=0.20; else DEFAULT_BUDGET=0.50; fi
# A stopped run id stays stopped, so reusing one would end instantly: if the name is taken on
# Tripwire, pick the next free one (stubborn_deploy, stubborn_deploy-2, stubborn_deploy-3, ...).
TRIPWIRE_URL="${TRIPWIRE_URL:-http://localhost:8787}"
BASE_ID="${RUN_ID:-$SCENARIO}"
RUN_ID="$BASE_ID"
n=1
while [ "$(curl -s -o /dev/null -w '%{http_code}' "$TRIPWIRE_URL/api/runs/$RUN_ID")" = 200 ]; do
  n=$((n + 1)); RUN_ID="$BASE_ID-$n"
done
[ "$RUN_ID" != "$BASE_ID" ] && echo "'$BASE_ID' already exists on the dashboard, using '$RUN_ID'"

echo "Real Claude scenario: $SCENARIO  (run id: $RUN_ID, budget: \$${BUDGET:-$DEFAULT_BUDGET})"
exec .venv/bin/python -m demo.agent --scenario "$SCENARIO" --run-id "$RUN_ID" --budget "${BUDGET:-$DEFAULT_BUDGET}" "$@"
