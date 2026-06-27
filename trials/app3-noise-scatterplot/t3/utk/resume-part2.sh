#!/usr/bin/env bash
set -euo pipefail

# Resume the same session and apply a fix for the browser out-of-memory crash.
# Mirrors run_trials.sh, using --resume <session_id> and writing *.part2.*

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"   # .../t4/utk
TRIAL_DIR="$SCRIPT_DIR"
OUTPUT_DIR="$TRIAL_DIR/output"

SESSION_ID="3c95d7b6-4d71-4719-bd27-3c4a85590dec"
MODEL="${MODEL:-opus}"
MAX_TURNS="${MAX_TURNS:-150}"

# nvm (same as run_trials.sh)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
set +u
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
set -u

read -r -d '' PROMPT <<'EOF' || true
While loading the visualization, the browser tab crashes and shows its native "Out of Memory" error page (DevTools becomes unresponsive, so there is no stack trace). Diagnose the root cause and fix it in the code, then revalidate by rebuilding and serving as before.
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

echo "{\"app\": \"app3-noise-scatterplot\", \"trial\": \"t4\", \"variant\": \"utk\", \"part\": 2, \"resumed_session_id\": \"$SESSION_ID\", \"model\": \"$MODEL\", \"max_turns\": $MAX_TURNS, \"duration_seconds\": $ELAPSED, \"exit_code\": $CLAUDE_EXIT, \"status\": \"$STATUS\", \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$TRIAL_DIR/meta.part2.json"

echo ""
echo "==> part2 done (status=$STATUS, exit=$CLAUDE_EXIT, ${ELAPSED}s). Log: $TRIAL_DIR/log.part2.jsonl"
