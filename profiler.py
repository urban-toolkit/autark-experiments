#!/usr/bin/env python3
"""
Code Quality Profiler for Autark Experiments
=============================================
Extracts code quality metrics from generated codebases across trials.
Compares Autark vs non-Autark (general) conditions.

Directory structure:
    trials/
        {app}/              e.g. app1-subway-accessibility
            {trial}/        e.g. t1
                autark/
                    meta.json
                    output/   ← generated code
                general/
                    meta.json
                    output/   ← generated code

Metrics are grouped into four categories:
  1. Size & Conciseness  – LOC, file count, dependency count
  2. Complexity           – cyclomatic, cognitive, nesting depth
  3. Maintainability      – function length, comment density, any-type usage
  4. Coupling & Readability – imports/exports, magic numbers, duplication, line length

Usage:
    python3 profiler.py [--trials-dir ./trials] [--output metrics.json] [--csv metrics.csv]
"""

import argparse
import json
import os
import re
import csv
import sys
from pathlib import Path
from collections import defaultdict
from typing import Any


# ── Source file extensions to analyze ─────────────────────────────────────────
SOURCE_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx"}
ALL_EXTENSIONS = SOURCE_EXTENSIONS | {".html", ".css"}

# Files to skip (config / boilerplate, not generated logic)
SKIP_FILES = {"vite.config.ts", "vite-env.d.ts", "tsconfig.json", "package.json", "package-lock.json"}
SKIP_DIRS = {"node_modules", "dist", ".vite"}


# ── Helpers ───────────────────────────────────────────────────────────────────

def iter_source_files(output_dir: str, extensions: set[str] = SOURCE_EXTENSIONS):
    """Yield absolute paths to source files under output_dir, skipping build artifacts."""
    for root, dirs, files in os.walk(output_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f in SKIP_FILES:
                continue
            if Path(f).suffix in extensions:
                yield os.path.join(root, f)


def read_file(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def classify_lines(lines: list[str]) -> dict:
    """Classify each line as code, comment, or blank."""
    stats = {"total": 0, "code": 0, "comment": 0, "blank": 0}
    in_block_comment = False

    for raw in lines:
        line = raw.strip()
        stats["total"] += 1

        if not line:
            stats["blank"] += 1
            continue

        if in_block_comment:
            stats["comment"] += 1
            if "*/" in line:
                in_block_comment = False
            continue

        if line.startswith("//"):
            stats["comment"] += 1
            continue

        if line.startswith("/*"):
            stats["comment"] += 1
            if "*/" not in line or line.endswith("/*"):
                in_block_comment = True
            continue

        # Inline block comment occupying the entire line
        if re.match(r"^\s*/\*.*\*/\s*$", raw):
            stats["comment"] += 1
            continue

        stats["code"] += 1

    return stats


# ── Metric extractors ────────────────────────────────────────────────────────

SKIP_APP_DIRS = {"_backup", "docs"}
CONDITION_DIRS = {"autark", "general"}


def count_dependencies(output_dir: str) -> int:
    """Count runtime dependencies from package.json."""
    pkg_path = os.path.join(output_dir, "package.json")
    if not os.path.exists(pkg_path):
        return 0
    try:
        pkg = json.loads(read_file(pkg_path))
        return len(pkg.get("dependencies", {}))
    except (json.JSONDecodeError, KeyError):
        return 0


def count_dev_dependencies(output_dir: str) -> int:
    """Count dev dependencies from package.json."""
    pkg_path = os.path.join(output_dir, "package.json")
    if not os.path.exists(pkg_path):
        return 0
    try:
        pkg = json.loads(read_file(pkg_path))
        return len(pkg.get("devDependencies", {}))
    except (json.JSONDecodeError, KeyError):
        return 0


def cyclomatic_complexity(source: str) -> int:
    """
    Estimate cyclomatic complexity by counting decision points.
    Each decision point adds 1 to a base of 1.
    """
    # Remove strings and comments to avoid false positives
    cleaned = _strip_strings_and_comments(source)

    patterns = [
        r"\bif\s*\(",           # if (
        r"\belse\s+if\s*\(",    # else if (
        r"\bwhile\s*\(",        # while (
        r"\bfor\s*\(",          # for (
        r"\bcase\s+",           # case
        r"\bcatch\s*\(",        # catch (
        r"\?\?",                # nullish coalescing
        r"[^=!<>]==[^=]",      # loose equality (rare in TS)
        r"\?\s*[^?:]",         # ternary ? (approximate)
        r"&&",                  # logical AND
        r"\|\|",                # logical OR
    ]

    count = 1  # base complexity
    for pat in patterns:
        count += len(re.findall(pat, cleaned))
    return count


def cognitive_complexity(source: str) -> int:
    """
    Simplified cognitive complexity: like cyclomatic but penalizes nesting.
    Each control structure adds (1 + current_nesting_depth).
    """
    cleaned = _strip_strings_and_comments(source)
    lines = cleaned.split("\n")
    score = 0
    nesting = 0

    control_re = re.compile(
        r"\b(if|else\s+if|for|while|switch|catch)\b\s*[\({]?"
    )
    logical_re = re.compile(r"(&&|\|\||\?\?)")

    for line in lines:
        stripped = line.strip()

        # Track nesting via braces
        nesting += line.count("{") - line.count("}")
        nesting = max(0, nesting)

        if control_re.search(stripped):
            score += 1 + nesting

        # Logical operators add 1 each (no nesting penalty)
        score += len(logical_re.findall(stripped))

    return score


def max_nesting_depth(source: str) -> int:
    """Find maximum brace nesting depth."""
    cleaned = _strip_strings_and_comments(source)
    depth = 0
    max_depth = 0
    for ch in cleaned:
        if ch == "{":
            depth += 1
            max_depth = max(max_depth, depth)
        elif ch == "}":
            depth -= 1
            depth = max(0, depth)
    return max_depth


def extract_functions(source: str) -> list[dict]:
    """
    Extract function boundaries (name, start_line, line_count).
    Handles: function declarations, arrow functions assigned to const/let/var,
    class methods, async variants.
    """
    lines = source.split("\n")
    functions: list[dict] = []

    # Patterns that start a function
    func_patterns = [
        # function foo(...) {
        re.compile(r"(?:export\s+)?(?:async\s+)?function\s+(\w+)"),
        # const foo = (...) => {  or  const foo = function
        re.compile(r"(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>"),
        re.compile(r"(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function"),
        # class method:  foo(...) {  or  async foo(...) {
        re.compile(r"^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\S+\s*)?{"),
    ]

    for i, line in enumerate(lines):
        for pat in func_patterns:
            m = pat.search(line)
            if m:
                name = m.group(1)
                # Count lines until braces balance
                start = i
                brace_count = 0
                started = False
                end = i
                for j in range(i, len(lines)):
                    brace_count += lines[j].count("{") - lines[j].count("}")
                    if lines[j].count("{") > 0:
                        started = True
                    if started and brace_count <= 0:
                        end = j
                        break
                length = end - start + 1
                functions.append({"name": name, "start": start + 1, "length": length})
                break

    return functions


def count_any_types(source: str) -> int:
    """Count occurrences of 'any' used as a TypeScript type annotation."""
    cleaned = _strip_strings_and_comments(source)
    # Match `: any`, `<any>`, `as any`, `any[]`, `any>`, etc.
    return len(re.findall(r"\bany\b", cleaned))


def count_imports(source: str) -> int:
    """Count import statements."""
    return len(re.findall(r"^\s*import\s+", source, re.MULTILINE))


def count_exports(source: str) -> int:
    """Count export statements."""
    return len(re.findall(r"^\s*export\s+", source, re.MULTILINE))


def count_magic_numbers(source: str) -> int:
    """
    Count numeric literals that are likely 'magic numbers'.
    Excludes: 0, 1, -1, 2, common array indices, and numbers in const declarations.
    """
    cleaned = _strip_strings_and_comments(source)
    # Find all numeric literals
    numbers = re.findall(r"(?<!\w)(-?\d+\.?\d*)", cleaned)
    trivial = {"0", "1", "-1", "2", "0.0", "1.0", "100"}
    count = 0
    for n in numbers:
        if n not in trivial:
            count += 1
    return count


def max_line_length(source: str) -> int:
    """Return the length of the longest line."""
    lines = source.split("\n")
    return max((len(l) for l in lines), default=0)


def avg_line_length(source: str) -> float:
    """Return the average line length (non-blank lines)."""
    lines = [l for l in source.split("\n") if l.strip()]
    if not lines:
        return 0.0
    return sum(len(l) for l in lines) / len(lines)


def duplicate_line_ratio(lines: list[str]) -> float:
    """
    Fraction of non-blank, non-trivial lines that appear more than once.
    Trivial lines (braces, returns, blanks) are excluded.
    """
    trivial = {"", "{", "}", "});", ");", "}", "},", "});", "return;", "break;"}
    meaningful = [l.strip() for l in lines if l.strip() not in trivial and len(l.strip()) > 5]
    if not meaningful:
        return 0.0
    from collections import Counter
    counts = Counter(meaningful)
    duplicated = sum(c - 1 for c in counts.values() if c > 1)
    return duplicated / len(meaningful)


def count_console_logs(source: str) -> int:
    """Count console.log/warn/error calls."""
    return len(re.findall(r"console\.(log|warn|error|info)\s*\(", source))


def _strip_strings_and_comments(source: str) -> str:
    """Remove string literals and comments to avoid false positives in pattern matching."""
    # Remove template literals (approximate)
    result = re.sub(r"`[^`]*`", '""', source)
    # Remove double-quoted strings
    result = re.sub(r'"[^"\\]*(?:\\.[^"\\]*)*"', '""', result)
    # Remove single-quoted strings
    result = re.sub(r"'[^'\\]*(?:\\.[^'\\]*)*'", "''", result)
    # Remove block comments
    result = re.sub(r"/\*[\s\S]*?\*/", "", result)
    # Remove line comments
    result = re.sub(r"//.*$", "", result, flags=re.MULTILINE)
    return result


# ── Per-trial profiler ────────────────────────────────────────────────────────

def profile_trial(condition_dir: str, app: str, trial: str, condition: str,
                  cohort: str = "", model: str = "") -> dict[str, Any]:
    """Compute all metrics for a single app/trial/condition output directory."""
    output_dir = os.path.join(condition_dir, "output")
    if not os.path.isdir(output_dir):
        return {"error": f"No output directory found at {output_dir}",
                "cohort": cohort, "app": app, "trial": trial, "condition": condition}

    # Gather source files
    source_files = list(iter_source_files(output_dir, SOURCE_EXTENSIONS))
    all_files = list(iter_source_files(output_dir, ALL_EXTENSIONS))

    if not source_files:
        return {"error": "No source files found"}

    # Read all source content
    file_contents: dict[str, str] = {}
    for fp in source_files:
        file_contents[fp] = read_file(fp)

    combined_source = "\n".join(file_contents.values())
    combined_lines = combined_source.split("\n")

    # ── Size & Conciseness ──
    line_stats = {"total": 0, "code": 0, "comment": 0, "blank": 0}
    per_file_stats: list[dict] = []
    for fp, content in file_contents.items():
        flines = content.split("\n")
        fstats = classify_lines(flines)
        fstats["file"] = os.path.relpath(fp, output_dir)
        per_file_stats.append(fstats)
        for k in ["total", "code", "comment", "blank"]:
            line_stats[k] += fstats[k]

    num_source_files = len(source_files)
    num_all_files = len(all_files)
    num_deps = count_dependencies(output_dir)
    num_dev_deps = count_dev_dependencies(output_dir)

    # ── Complexity ──
    # NOTE: these metrics are aggregated PER FILE rather than over the
    # concatenated source. Computing them on the joined text is fragile: the
    # string/comment-stripping regex can match across file boundaries when the
    # combined text has an unbalanced number of quote characters, wiping out
    # large spans of code and producing implausibly low values. Per-file
    # aggregation is robust and matches the intent of the original metrics.
    per_file_cc = {}
    for fp, content in file_contents.items():
        rel = os.path.relpath(fp, output_dir)
        per_file_cc[rel] = cyclomatic_complexity(content)

    cc = 1 + sum(v - 1 for v in per_file_cc.values())
    cog = sum(cognitive_complexity(c) for c in file_contents.values())
    max_nest = max((max_nesting_depth(c) for c in file_contents.values()), default=0)

    # ── Maintainability ──
    all_functions: list[dict] = []
    for fp, content in file_contents.items():
        fns = extract_functions(content)
        for fn in fns:
            fn["file"] = os.path.relpath(fp, output_dir)
        all_functions.extend(fns)

    num_functions = len(all_functions)
    func_lengths = [f["length"] for f in all_functions]
    avg_func_len = sum(func_lengths) / len(func_lengths) if func_lengths else 0
    max_func_len = max(func_lengths) if func_lengths else 0
    longest_func = next(
        (f for f in all_functions if f["length"] == max_func_len),
        None
    ) if all_functions else None

    comment_density = line_stats["comment"] / line_stats["code"] if line_stats["code"] > 0 else 0
    any_count = sum(count_any_types(c) for c in file_contents.values())  # per-file (see note above)

    # ── Coupling & Readability ──
    imports = count_imports(combined_source)
    exports = count_exports(combined_source)
    magic = sum(count_magic_numbers(c) for c in file_contents.values())  # per-file (see note above)
    max_ll = max_line_length(combined_source)
    avg_ll = avg_line_length(combined_source)
    dup_ratio = duplicate_line_ratio(combined_lines)
    console_logs = count_console_logs(combined_source)

    # ── Trial metadata ──
    meta_path = os.path.join(condition_dir, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        try:
            meta = json.loads(read_file(meta_path))
        except json.JSONDecodeError:
            pass

    return {
        "cohort": cohort,
        "model": model,
        "app": app,
        "trial": trial,
        "condition": condition,
        "meta": meta,
        # Size & Conciseness
        "size": {
            "total_lines": line_stats["total"],
            "code_lines": line_stats["code"],
            "comment_lines": line_stats["comment"],
            "blank_lines": line_stats["blank"],
            "source_files": num_source_files,
            "all_files": num_all_files,
            "dependencies": num_deps,
            "dev_dependencies": num_dev_deps,
        },
        # Complexity
        "complexity": {
            "cyclomatic": cc,
            "cognitive": cog,
            "max_nesting_depth": max_nest,
            "per_file_cyclomatic": per_file_cc,
        },
        # Maintainability
        "maintainability": {
            "num_functions": num_functions,
            "avg_function_length": round(avg_func_len, 1),
            "max_function_length": max_func_len,
            "longest_function": longest_func,
            "comment_density": round(comment_density, 3),
            "any_type_count": any_count,
            "console_log_count": console_logs,
        },
        # Coupling & Readability
        "readability": {
            "import_count": imports,
            "export_count": exports,
            "magic_number_count": magic,
            "max_line_length": max_ll,
            "avg_line_length": round(avg_ll, 1),
            "duplicate_line_ratio": round(dup_ratio, 3),
        },
        # Per-file breakdown
        "per_file": per_file_stats,
    }


# ── Aggregation & Comparison ─────────────────────────────────────────────────

def _summarize(trials: list[dict]) -> dict:
    def avg(vals):
        return round(sum(vals) / len(vals), 2) if vals else 0
    return {
        "num_trials": len(trials),
        "avg_code_lines": avg([t["size"]["code_lines"] for t in trials]),
        "avg_source_files": avg([t["size"]["source_files"] for t in trials]),
        "avg_dependencies": avg([t["size"]["dependencies"] for t in trials]),
        "avg_cyclomatic": avg([t["complexity"]["cyclomatic"] for t in trials]),
        "avg_cognitive": avg([t["complexity"]["cognitive"] for t in trials]),
        "avg_max_nesting": avg([t["complexity"]["max_nesting_depth"] for t in trials]),
        "avg_num_functions": avg([t["maintainability"]["num_functions"] for t in trials]),
        "avg_function_length": avg([t["maintainability"]["avg_function_length"] for t in trials]),
        "avg_comment_density": avg([t["maintainability"]["comment_density"] for t in trials]),
        "avg_any_types": avg([t["maintainability"]["any_type_count"] for t in trials]),
        "avg_imports": avg([t["readability"]["import_count"] for t in trials]),
        "avg_magic_numbers": avg([t["readability"]["magic_number_count"] for t in trials]),
        "avg_duplicate_ratio": avg([t["readability"]["duplicate_line_ratio"] for t in trials]),
    }


def _summarize_cohort(valid: list[dict]) -> dict:
    """Overall (by condition) and per-app (by condition) summary for one cohort."""
    by_condition: dict[str, list[dict]] = defaultdict(list)
    for r in valid:
        by_condition[r["condition"]].append(r)

    by_app: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for r in valid:
        by_app[r["app"]][r["condition"]].append(r)

    return {
        "overall": {cond: _summarize(trials) for cond, trials in by_condition.items()},
        "per_app": {
            app: {cond: _summarize(trials) for cond, trials in conds.items()}
            for app, conds in sorted(by_app.items())
        },
    }


def compute_summary(results: list[dict]) -> dict:
    """Compute per-cohort summaries comparing autark vs general."""
    valid = [r for r in results if "error" not in r]
    by_cohort: dict[str, list[dict]] = defaultdict(list)
    for r in valid:
        by_cohort[r.get("cohort", "")].append(r)
    return {"per_cohort": {c: _summarize_cohort(rs) for c, rs in by_cohort.items()}}


def flatten_for_csv(result: dict) -> dict:
    """Flatten a trial result dict into a single-level dict suitable for CSV."""
    flat = {
        "cohort": result.get("cohort", ""),
        "model": result.get("model", ""),
        "app": result["app"],
        "trial": result["trial"],
        "condition": result["condition"],
        "duration_seconds": result.get("meta", {}).get("duration_seconds", ""),
        # Size
        "total_lines": result["size"]["total_lines"],
        "code_lines": result["size"]["code_lines"],
        "comment_lines": result["size"]["comment_lines"],
        "blank_lines": result["size"]["blank_lines"],
        "source_files": result["size"]["source_files"],
        "dependencies": result["size"]["dependencies"],
        "dev_dependencies": result["size"]["dev_dependencies"],
        # Complexity
        "cyclomatic_complexity": result["complexity"]["cyclomatic"],
        "cognitive_complexity": result["complexity"]["cognitive"],
        "max_nesting_depth": result["complexity"]["max_nesting_depth"],
        # Maintainability
        "num_functions": result["maintainability"]["num_functions"],
        "avg_function_length": result["maintainability"]["avg_function_length"],
        "max_function_length": result["maintainability"]["max_function_length"],
        "comment_density": result["maintainability"]["comment_density"],
        "any_type_count": result["maintainability"]["any_type_count"],
        "console_log_count": result["maintainability"]["console_log_count"],
        # Readability
        "import_count": result["readability"]["import_count"],
        "export_count": result["readability"]["export_count"],
        "magic_number_count": result["readability"]["magic_number_count"],
        "max_line_length": result["readability"]["max_line_length"],
        "avg_line_length": result["readability"]["avg_line_length"],
        "duplicate_line_ratio": result["readability"]["duplicate_line_ratio"],
    }
    return flat


# ── Pretty printing ──────────────────────────────────────────────────────────

def print_report(results: list[dict], summary: dict):
    """Print a human-readable report to stdout."""
    print("=" * 72)
    print("  CODE QUALITY PROFILER — Autark Experiments")
    print("=" * 72)

    for r in results:
        if "error" in r:
            print(f"\n  {r.get('app', '?')}/{r.get('trial', '?')}/{r.get('condition', '?')}: ERROR — {r['error']}")
            continue

        print(f"\n{'─' * 72}")
        print(f"  [{r.get('cohort', '?')}]  App: {r['app']}  |  Trial: {r['trial']}  |  Condition: {r['condition'].upper()}")
        if r.get("meta", {}).get("duration_seconds"):
            dur = r["meta"]["duration_seconds"]
            print(f"  Generation time: {dur // 60}m {dur % 60}s")
        print(f"{'─' * 72}")

        s = r["size"]
        print(f"  SIZE & CONCISENESS")
        print(f"    Code lines:      {s['code_lines']:>6}    (+ {s['comment_lines']} comments, {s['blank_lines']} blank)")
        print(f"    Source files:     {s['source_files']:>6}")
        print(f"    Dependencies:    {s['dependencies']:>6}    (+ {s['dev_dependencies']} dev)")

        c = r["complexity"]
        print(f"  COMPLEXITY")
        print(f"    Cyclomatic:      {c['cyclomatic']:>6}")
        print(f"    Cognitive:       {c['cognitive']:>6}")
        print(f"    Max nesting:     {c['max_nesting_depth']:>6}")

        m = r["maintainability"]
        print(f"  MAINTAINABILITY")
        print(f"    Functions:       {m['num_functions']:>6}")
        print(f"    Avg func length: {m['avg_function_length']:>6} lines")
        print(f"    Max func length: {m['max_function_length']:>6} lines", end="")
        if m["longest_function"]:
            lf = m["longest_function"]
            print(f"  ({lf['name']} in {lf['file']})")
        else:
            print()
        print(f"    Comment density: {m['comment_density']:>6.1%}")
        print(f"    `any` types:     {m['any_type_count']:>6}")
        print(f"    console.log:     {m['console_log_count']:>6}")

        rd = r["readability"]
        print(f"  COUPLING & READABILITY")
        print(f"    Imports:         {rd['import_count']:>6}")
        print(f"    Exports:         {rd['export_count']:>6}")
        print(f"    Magic numbers:   {rd['magic_number_count']:>6}")
        print(f"    Max line length: {rd['max_line_length']:>6}")
        print(f"    Avg line length: {rd['avg_line_length']:>6.1f}")
        print(f"    Duplicate ratio: {rd['duplicate_line_ratio']:>6.1%}")

    # Summary comparison
    def _print_comparison(title: str, section: dict):
        if "general" not in section or "autark" not in section:
            return
        b = section["general"]
        a = section["autark"]

        print(f"\n  {title}")
        rows = [
            ("Code lines", b["avg_code_lines"], a["avg_code_lines"]),
            ("Source files", b["avg_source_files"], a["avg_source_files"]),
            ("Dependencies", b["avg_dependencies"], a["avg_dependencies"]),
            ("Cyclomatic complexity", b["avg_cyclomatic"], a["avg_cyclomatic"]),
            ("Cognitive complexity", b["avg_cognitive"], a["avg_cognitive"]),
            ("Max nesting depth", b["avg_max_nesting"], a["avg_max_nesting"]),
            ("Num functions", b["avg_num_functions"], a["avg_num_functions"]),
            ("Avg function length", b["avg_function_length"], a["avg_function_length"]),
            ("Comment density", b["avg_comment_density"], a["avg_comment_density"]),
            ("`any` type usage", b["avg_any_types"], a["avg_any_types"]),
            ("Imports", b["avg_imports"], a["avg_imports"]),
            ("Magic numbers", b["avg_magic_numbers"], a["avg_magic_numbers"]),
            ("Duplicate ratio", b["avg_duplicate_ratio"], a["avg_duplicate_ratio"]),
        ]

        print(f"  {'Metric':<26} {'General':>10} {'Autark':>10} {'Delta':>10}")
        print(f"  {'─' * 26} {'─' * 10} {'─' * 10} {'─' * 10}")
        for label, bv, av in rows:
            if bv != 0:
                delta = ((av - bv) / abs(bv)) * 100
                delta_str = f"{delta:+.0f}%"
            else:
                delta_str = "N/A"
            print(f"  {label:<26} {bv:>10} {av:>10} {delta_str:>10}")

    for cohort, csum in sorted(summary.get("per_cohort", {}).items()):
        print(f"\n{'=' * 72}")
        print(f"  COHORT: {cohort}  —  OVERALL SUMMARY")
        print(f"{'=' * 72}")
        _print_comparison("All apps (averaged)", csum.get("overall", {}))

        print(f"\n{'─' * 72}")
        print(f"  COHORT: {cohort}  —  PER-APP SUMMARY")
        print(f"{'─' * 72}")
        for app_name, app_section in sorted(csum.get("per_app", {}).items()):
            _print_comparison(app_name, app_section)

    print()


# ── Cohorts ───────────────────────────────────────────────────────────────────
# A cohort is a set of trials produced by one model generation. For each app we
# pin the exact trial that belongs to the cohort, so the comparison is clean and
# reproducible (the trials directory also holds re-runs and other models).
#
#   opus-4.6 — the original baseline reported in the paper (March 2026). Only the
#              `t1` trials were generated with Opus 4.6.
#   opus-4.8 — the re-run with the newer model (June 2026). app1/2/3/5 use `t3`;
#              app4 only has up to `t2`. (A `utk` condition exists in some of
#              these trials but is ignored: only `autark`/`general` are profiled.)
COHORTS: dict[str, dict[str, str]] = {
    "opus-4.6": {
        "app1-subway-accessibility": "t1",
        "app2-noise-pollution": "t1",
        "app3-noise-scatterplot": "t1",
        "app4-street-network": "t1",
        "app5-subway-picking": "t1",
    },
    "opus-4.8": {
        "app1-subway-accessibility": "t3",
        "app2-noise-pollution": "t3",
        "app3-noise-scatterplot": "t3",
        "app4-street-network": "t2",
        "app5-subway-picking": "t3",
    },
}


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="Code quality profiler for Autark experiments")
    parser.add_argument(
        "--trials-dir", default=os.path.join(here, "trials"),
        help="Path to the trials directory (default: ./trials)",
    )
    parser.add_argument(
        "--output", default=os.path.join(here, "metrics.json"),
        help="Write full JSON results to this file (default: ./metrics.json)",
    )
    parser.add_argument(
        "--csv", default=os.path.join(here, "metrics.csv"),
        help="Write flat CSV results to this file (default: ./metrics.csv)",
    )
    args = parser.parse_args()

    trials_dir = args.trials_dir
    if not os.path.isdir(trials_dir):
        print(f"Error: trials directory not found: {trials_dir}", file=sys.stderr)
        sys.exit(1)

    # Profile the pinned (cohort, app, trial, condition) cells
    results = []
    for cohort, app_trials in COHORTS.items():
        for app, trial in app_trials.items():
            trial_path = os.path.join(trials_dir, app, trial)
            for condition in CONDITION_DIRS:  # autark, general (utk is ignored)
                cond_path = os.path.join(trial_path, condition)
                if not os.path.isdir(cond_path):
                    continue
                results.append(profile_trial(cond_path, app, trial, condition, cohort, cohort))

    summary = compute_summary(results)
    print_report(results, summary)

    # JSON
    with open(args.output, "w") as f:
        json.dump({"cohorts": COHORTS, "trials": results, "summary": summary}, f, indent=2)
    print(f"  JSON results written to: {args.output}")

    # CSV: per-trial rows, then per-(cohort, app, condition) and per-(cohort, condition) averages
    valid = [r for r in results if "error" not in r]
    if valid:
        rows = [flatten_for_csv(r) for r in valid]
        fieldnames = list(rows[0].keys())
        key_fields = ("cohort", "model", "app", "trial", "condition")
        numeric_fields = [f for f in fieldnames if f not in key_fields]

        def _avg_row(group, cohort, app_label, trial_label, condition):
            row = {"cohort": cohort, "model": cohort, "app": app_label,
                   "trial": trial_label, "condition": condition}
            for f in numeric_fields:
                vals = [r[f] for r in group if r[f] != ""]
                row[f] = round(sum(vals) / len(vals), 2) if vals else ""
            return row

        from itertools import groupby
        avg_rows = []
        for (cohort, app, cond), grp in groupby(
                sorted(rows, key=lambda r: (r["cohort"], r["app"], r["condition"])),
                key=lambda r: (r["cohort"], r["app"], r["condition"])):
            avg_rows.append(_avg_row(list(grp), cohort, app, "avg", cond))
        for (cohort, cond), grp in groupby(
                sorted(rows, key=lambda r: (r["cohort"], r["condition"])),
                key=lambda r: (r["cohort"], r["condition"])):
            avg_rows.append(_avg_row(list(grp), cohort, "ALL", "avg", cond))

        with open(args.csv, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
            writer.writerows(avg_rows)
        print(f"  CSV results written to: {args.csv}")


if __name__ == "__main__":
    main()
