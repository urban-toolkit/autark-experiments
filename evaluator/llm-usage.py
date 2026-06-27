#!/usr/bin/env python3
"""
llm-usage.py - Evaluate LLM cost (money + tokens) and duration of a Claude Code
run from its stream-json logs (log.jsonl).

Scope: Opus model only (the model the trials were mocked to use). Other models
(e.g. the Haiku sub-calls) are ignored.

Source of truth: the final `result` event. It carries authoritative per-model
usage (`modelUsage`) including the true output_tokens, so the cost is exact.
A `result` event is REQUIRED - if any log file lacks one, the evaluator errors
out and prints nothing. For a test split across files (part_1, part_2, ...),
each file must have its own `result`; their usage and durations are summed.

Usage:
    python llm-usage.py <test_path> [file1 file2 ...]

    <test_path>  base directory of the test (e.g. .../t3/autark)
    fileN        one or more jsonl logs to accumulate as ONE test. Relative
                 paths are resolved against <test_path>. Defaults to "log.jsonl".

Examples:
    python llm-usage.py trials/app1-subway-accessibility/t3/autark
    python llm-usage.py trials/app1-subway-accessibility/t3/utk log.jsonl part_2.jsonl
"""

import argparse
import json
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Price table - USD per 1 million tokens (MTok).
# Source: claude-api skill (official pricing). Opus 4.8 has a 1M context window
# with NO long-context premium, so there is no >200K tier. Edit here if it
# changes.
# ---------------------------------------------------------------------------
OPUS_MODEL = "claude-opus-4-8"
PRICING = {
    OPUS_MODEL: {
        "input": 5.00,
        "output": 25.00,
        "cache_write_5m": 6.25,   # 1.25x input
        "cache_write_1h": 10.00,  # 2.00x input
        "cache_read": 0.50,       # 0.10x input
    },
}

MTOK = 1_000_000


def new_acc() -> dict:
    return {
        "input": 0,
        "output": 0,
        "cache_write_5m": 0,
        "cache_write_1h": 0,
        "cache_read": 0,
        # global cache_creation split (across all models), used to split the
        # Opus cache-creation total into 5m vs 1h
        "global_cc_5m": 0,
        "global_cc_1h": 0,
        "opus_cc_total": 0,
    }


def find_result(path: Path) -> dict:
    """Return the last `result` event in the file, or None if absent."""
    result = None
    with path.open() as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                evt = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if evt.get("type") == "result":
                result = evt
    return result


def fold_result(result: dict, acc: dict) -> None:
    """Fold one `result` event's Opus usage into the accumulator."""
    opus = result.get("modelUsage", {}).get(OPUS_MODEL, {})
    acc["input"] += opus.get("inputTokens", 0) or 0
    acc["output"] += opus.get("outputTokens", 0) or 0
    acc["cache_read"] += opus.get("cacheReadInputTokens", 0) or 0
    acc["opus_cc_total"] += opus.get("cacheCreationInputTokens", 0) or 0

    # Global 5m/1h split lives on the top-level usage.cache_creation.
    cc = result.get("usage", {}).get("cache_creation", {})
    if isinstance(cc, dict):
        acc["global_cc_5m"] += cc.get("ephemeral_5m_input_tokens", 0) or 0
        acc["global_cc_1h"] += cc.get("ephemeral_1h_input_tokens", 0) or 0


def finalize_cache_split(acc: dict) -> None:
    """Split the Opus cache-creation total into 5m/1h using the global ratio."""
    total = acc["opus_cc_total"]
    g5, g1 = acc["global_cc_5m"], acc["global_cc_1h"]
    gtot = g5 + g1
    if total == 0:
        acc["cache_write_5m"] = acc["cache_write_1h"] = 0
    elif gtot == 0:
        # No split info: assume 5m (the more conservative cost).
        acc["cache_write_5m"], acc["cache_write_1h"] = total, 0
    else:
        acc["cache_write_5m"] = round(total * g5 / gtot)
        acc["cache_write_1h"] = total - acc["cache_write_5m"]


def cost_breakdown(acc: dict) -> dict:
    price = PRICING[OPUS_MODEL]
    return {
        "input": acc["input"] / MTOK * price["input"],
        "output": acc["output"] / MTOK * price["output"],
        "cache_write_5m": acc["cache_write_5m"] / MTOK * price["cache_write_5m"],
        "cache_write_1h": acc["cache_write_1h"] / MTOK * price["cache_write_1h"],
        "cache_read": acc["cache_read"] / MTOK * price["cache_read"],
    }


def fmt_int(n: int) -> str:
    return f"{n:,}"


def fmt_usd(v: float) -> str:
    return f"${v:,.4f}"


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Opus cost (USD + tokens) and duration from the result event.",
    )
    ap.add_argument("test_path", help="Base directory of the test")
    ap.add_argument("files", nargs="*", help="Logs to accumulate (default: log.jsonl)")
    args = ap.parse_args()

    base = Path(args.test_path)
    if not base.exists():
        print(f"error: path does not exist: {base}", file=sys.stderr)
        return 1

    names = args.files or ["log.jsonl"]
    paths = []
    for name in names:
        p = Path(name) if Path(name).is_absolute() else base / name
        if not p.exists():
            print(f"error: file not found: {p}", file=sys.stderr)
            return 1
        paths.append(p)

    # A result event is REQUIRED in every file. Collect them all first; if any
    # is missing, error out and print nothing.
    results = []
    for p in paths:
        result = find_result(p)
        if result is None:
            print(f"error: no `result` event in {p}", file=sys.stderr)
            return 1
        results.append((p, result))

    acc = new_acc()
    total_duration_ms = 0
    total_api_ms = 0
    for _, result in results:
        fold_result(result, acc)
        total_duration_ms += result.get("duration_ms", 0) or 0
        total_api_ms += result.get("duration_api_ms", 0) or 0
    finalize_cache_split(acc)

    # meta.json (wall-clock cross-check), if present in the base directory.
    meta = {}
    meta_path = base / "meta.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
        except json.JSONDecodeError:
            meta = {}

    costs = cost_breakdown(acc)
    total_cost = sum(costs.values())
    total_input = (
        acc["input"] + acc["cache_write_5m"] + acc["cache_write_1h"] + acc["cache_read"]
    )

    # ---- output ----
    label = meta.get("variant") or base.name
    app = meta.get("app", "")
    trial = meta.get("trial", "")
    header = f"=== {app} / {trial} / {label} ===" if app else f"=== {label} ==="
    print(header)
    print(f"model: {OPUS_MODEL}")
    print("files:")
    for p, _ in results:
        print(f"  - {p}")
    print()

    print(f"[{OPUS_MODEL}]")
    print(f"  input tokens (fresh)  : {fmt_int(acc['input']):>16}")
    print(f"  output tokens         : {fmt_int(acc['output']):>16}")
    print(f"  cache write 5m        : {fmt_int(acc['cache_write_5m']):>16}")
    print(f"  cache write 1h        : {fmt_int(acc['cache_write_1h']):>16}")
    print(f"  cache read            : {fmt_int(acc['cache_read']):>16}")
    print(f"  total input (w/ cache): {fmt_int(total_input):>16}")
    if total_input:
        print(f"  cache read ratio      : {acc['cache_read'] / total_input * 100:>15.1f}%")
    print()

    print("cost (USD)")
    print(f"  input                 : {fmt_usd(costs['input']):>16}")
    print(f"  output                : {fmt_usd(costs['output']):>16}")
    print(f"  cache write 5m        : {fmt_usd(costs['cache_write_5m']):>16}")
    print(f"  cache write 1h        : {fmt_usd(costs['cache_write_1h']):>16}")
    print(f"  cache read            : {fmt_usd(costs['cache_read']):>16}")
    print(f"  TOTAL                 : {fmt_usd(total_cost):>16}")
    print()

    print("duration")
    print(f"  total (result)        : {total_duration_ms / 1000:.0f}s "
          f"({total_duration_ms / 60000:.1f} min)")
    print(f"  api (result)          : {total_api_ms / 1000:.0f}s "
          f"({total_api_ms / 60000:.1f} min)")
    if meta.get("duration_seconds") is not None:
        wc = meta["duration_seconds"]
        print(f"  wall-clock (meta.json): {wc:.0f}s ({wc / 60:.1f} min)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
