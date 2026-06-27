#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRIALS_DIR="$SCRIPT_DIR/trials"
MAX_TURNS="${MAX_TURNS:-150}"
MODEL="${MODEL:-opus}"

# ── Determine which apps and variants to run ──────────────────
# Usage: ./run_trials.sh [app] [variant]
#   ./run_trials.sh                              # all apps, both variants
#   ./run_trials.sh app1-subway-accessibility     # one app, both variants
#   ./run_trials.sh app1-subway-accessibility autark  # one app, one variant
FILTER_VARIANT=""
if [ $# -gt 0 ]; then
  APPS=("$1")
  [ $# -gt 1 ] && FILTER_VARIANT="$2"
else
  APPS=()
  for app_dir in "$TRIALS_DIR"/app*/; do
    APPS+=("$(basename "$app_dir")")
  done
fi

echo "==> Apps to run: ${APPS[*]}"
[ -n "$FILTER_VARIANT" ] && echo "==> Variant: $FILTER_VARIANT"
echo "==> Model: $MODEL"
echo "==> Max turns: $MAX_TURNS"
echo ""

# ── Run each app ─────────────────────────────────────────────
for app in "${APPS[@]}"; do
  APP_DIR="$TRIALS_DIR/$app"

  # Determine next trial number (t1, t2, t3, ...)
  LAST_TRIAL=$(ls -d "$APP_DIR"/t* 2>/dev/null | sed 's/.*\/t//' | sort -n | tail -1)
  NEXT_NUM=$(( ${LAST_TRIAL:-0} + 1 ))
  TRIAL_NUM="t${NEXT_NUM}"

  if [ -n "$FILTER_VARIANT" ]; then
    VARIANTS=("$FILTER_VARIANT")
  else
    VARIANTS=(autark general utk)
  fi

  for variant in "${VARIANTS[@]}"; do
    PROMPT_FILE="$APP_DIR/prompt-${variant}.md"

    if [ ! -f "$PROMPT_FILE" ]; then
      echo "WARNING: $PROMPT_FILE not found, skipping."
      continue
    fi

    TRIAL_DIR="$APP_DIR/$TRIAL_NUM/$variant"
    OUTPUT_DIR="$TRIAL_DIR/output"
    mkdir -p "$OUTPUT_DIR"

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Running: $app / $TRIAL_NUM / $variant"
    echo "  Prompt: $PROMPT_FILE"
    echo "  Output: $OUTPUT_DIR"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Run Claude Code in the output directory
    # --output-format stream-json: detailed JSON log of every tool call and response
    #   (the final `result` event carries the authoritative usage/cost totals)
    # --verbose: required for stream-json
    # stdout is written straight to log.jsonl (no pipe/tee) so the stream — and
    # especially the trailing `result` event — can't be truncated; nvm chatter
    # and claude's stderr are kept out of the JSON file.
    START_TIME=$(date +%s)
    # Don't let a crashed/non-zero `claude` abort the whole run (set -e + pipefail);
    # we capture the exit code so meta.json is always written, even on failure.
    set +e
    (cd "$OUTPUT_DIR" && nvm use 24.14 >/dev/null && NODE_OPTIONS="--max-old-space-size=8192" claude --print --verbose \
      --model "$MODEL" \
      --max-turns "$MAX_TURNS" \
      --dangerously-skip-permissions \
      --output-format stream-json \
      -p "$(cat "$PROMPT_FILE")

---

## IMPORTANT: OSM Querying Guidelines

- To query the whole Manhattan island, you should **only** use \`areas: ['Manhattan Island']\`. Do not use broader areas like 'New York' or 'Manhattan' alone, as they may return data outside the island boundary.
- Be careful with OSM / Overpass API requests — the API has strict rate limits and you can easily get **HTTP 429 (Too Many Requests)** errors. To avoid this:
  - Minimize the number of Overpass queries by combining multiple element types into a single query where possible.
  - Cache or reuse responses instead of re-fetching the same data.
  - Add appropriate delays between sequential requests if multiple queries are unavoidable.
  - If you receive a 429 error, wait before retrying (use exponential backoff).

---

## IMPORTANT: Console Logging

All major operations must be logged to the browser console using \`console.log\`. This includes but is not limited to:
- Data loading (e.g., \"Loading OSM layers...\", \"OSM buildings loaded: 12345 features\")
- API requests and responses (e.g., \"Fetching Overpass API...\", \"Overpass response received: 2.3 MB\")
- Data processing steps (e.g., \"Spatial join started...\", \"Spatial join complete: 8000 buildings matched\")
- Rendering milestones (e.g., \"Initializing renderer...\", \"Scene rendered with 5 layers\")
- Errors and warnings with relevant context

Each log message should be descriptive enough to trace the application's progress and diagnose issues from the console alone.

---

## IMPORTANT: Validation Requirements

After generating the project, you MUST validate that it fully works by following these steps:

1. Install all dependencies (npm install or equivalent). Fix any install errors.
2. Run the TypeScript compiler (npx tsc --noEmit) and fix ALL type errors.
3. Run the production build (npm run build or npx vite build). Fix any build errors.
4. Start the dev server in the background (e.g., npm run dev &).
5. Wait a few seconds, then use curl to fetch the main page (e.g., curl -s http://localhost:3005) and verify it returns valid HTML.
6. Use curl to check that the JavaScript bundle loads without errors (e.g., curl -s http://localhost:3005/src/main.ts or the built entry point).
7. Review the application code end-to-end: check that all imports resolve, all APIs are called correctly, and all data flows are connected.
8. If ANY step fails, debug the root cause, fix it, and repeat from step 2.
9. Kill the dev server when done. Kill it by port or by the specific PID you backgrounded (e.g. \`fuser -k 3005/tcp\` or \`kill \$!\`). Do NOT use broad patterns like \`pkill -f vite\`, \`pkill node\`, or \`killall node\` — the parent agent process is itself a node process and its command line contains \"vite\", so these patterns will kill the agent before it can finish.
10. Do NOT stop until you have a system that compiles, builds, serves, and has no obvious runtime errors. If you exhaust all reasonable fixes, document what remains broken." \
    > "$TRIAL_DIR/log.jsonl" 2> "$TRIAL_DIR/stderr.log")
    CLAUDE_EXIT=$?
    set -e
    END_TIME=$(date +%s)
    ELAPSED=$((END_TIME - START_TIME))
    MINUTES=$((ELAPSED / 60))
    SECONDS=$((ELAPSED % 60))

    STATUS="ok"
    [ "$CLAUDE_EXIT" -ne 0 ] && STATUS="failed"

    # The `result` event holds the authoritative usage/cost totals the evaluator
    # needs. Verify it was actually written; surface it loudly if it wasn't.
    RESULT_CAPTURED="true"
    if ! grep -q '"type":"result"' "$TRIAL_DIR/log.jsonl"; then
      RESULT_CAPTURED="false"
    fi

    echo "{\"app\": \"$app\", \"trial\": \"$TRIAL_NUM\", \"variant\": \"$variant\", \"model\": \"$MODEL\", \"max_turns\": $MAX_TURNS, \"duration_seconds\": $ELAPSED, \"exit_code\": $CLAUDE_EXIT, \"status\": \"$STATUS\", \"result_captured\": $RESULT_CAPTURED, \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$TRIAL_DIR/meta.json"

    echo ""
    if [ "$STATUS" = "failed" ]; then
      echo "==> WARNING: $app / $TRIAL_NUM / $variant FAILED (exit $CLAUDE_EXIT) after ${MINUTES}m ${SECONDS}s. See $TRIAL_DIR/log.jsonl"
    else
      echo "==> $app / $TRIAL_NUM / $variant complete in ${MINUTES}m ${SECONDS}s. Output in $OUTPUT_DIR"
    fi
    if [ "$RESULT_CAPTURED" = "false" ]; then
      echo "==> WARNING: no \`result\` event in $TRIAL_DIR/log.jsonl — usage/cost totals will be missing. See $TRIAL_DIR/stderr.log"
    fi
    echo ""
  done
done

echo "==> All trials finished."
