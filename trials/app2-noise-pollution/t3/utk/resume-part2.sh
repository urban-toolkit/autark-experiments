#!/usr/bin/env bash
set -euo pipefail

# Retoma a sessão que gerou este output e aplica um fix a partir do erro do browser.
# Espelha o run_trials.sh, mas usando --resume <session_id> e gravando *.part2.*

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"   # .../t4/utk
TRIAL_DIR="$SCRIPT_DIR"
OUTPUT_DIR="$TRIAL_DIR/output"

SESSION_ID="8d09b0f1-7be9-4a00-8adf-a621ee0d7c7b"
MODEL="${MODEL:-opus}"
MAX_TURNS="${MAX_TURNS:-150}"

# nvm (igual ao run_trials.sh)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
set +u
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
set -u

read -r -d '' PROMPT <<'EOF' || true
O browser retornou o seguinte erro em runtime ao carregar a visualização. Diagnostique a causa raiz e corrija o código (não apenas contorne), depois revalide compilando/buildando como antes:

Uncaught (in promise) Error: The shader picking needs an auxiliary shader. The auxiliary shader is the one right before (order matters) shader picking in renderStyle array. SMOOTH_COLOR_MAP can be used as an auxiliary array
    at Knot.value (main.js:2:648890)
    at e.value (main.js:2:675671)
    at e.<anonymous> (main.js:2:666778)
    at f (main.js:2:4110550)
    at Generator.<anonymous> (main.js:2:4111893)
    at Generator.next (main.js:2:4110913)
    at r (main.js:2:4104412)
    at s (main.js:2:4104615)
EOF

START_TIME=$(date +%s)
set +e
(cd "$OUTPUT_DIR" && nvm use 24.14 && NODE_OPTIONS="--max-old-space-size=8192" claude --print --verbose \
  --resume "$SESSION_ID" \
  --model "$MODEL" \
  --max-turns "$MAX_TURNS" \
  --dangerously-skip-permissions \
  --output-format stream-json \
  -p "$PROMPT" \
  2>&1 | tee "$TRIAL_DIR/log.part2.jsonl")
CLAUDE_EXIT=${PIPESTATUS[0]}
set -e
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

STATUS="ok"
[ "$CLAUDE_EXIT" -ne 0 ] && STATUS="failed"

echo "{\"app\": \"app2-noise-pollution\", \"trial\": \"t4\", \"variant\": \"utk\", \"part\": 2, \"resumed_session_id\": \"$SESSION_ID\", \"model\": \"$MODEL\", \"max_turns\": $MAX_TURNS, \"duration_seconds\": $ELAPSED, \"exit_code\": $CLAUDE_EXIT, \"status\": \"$STATUS\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$TRIAL_DIR/meta.part2.json"

echo ""
echo "==> part2 done (status=$STATUS, exit=$CLAUDE_EXIT, ${ELAPSED}s). Log: $TRIAL_DIR/log.part2.jsonl"
