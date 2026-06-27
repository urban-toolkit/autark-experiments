# Autark — Experiments

This repository contains the supplemental material for the paper *Autark: A
Serverless Toolkit for Prototyping Urban Visual Analytics Systems*. It accompanies
the agentic development evaluation reported in Section 5.3 of the paper, in which
an AI coding agent (Claude Code) was asked to implement five urban VA tasks of
increasing complexity under two conditions:

- **`autark`** — the agent was given Autark's documentation as its primary
  context and instructed to use only Autark's API.
- **`general`** — the agent was explicitly told *not* to use Autark, and could
  freely choose any general-purpose libraries available online.

Each task was run independently, with no conversation history carried between
trials. Both conditions shared the same model configuration, max-turns budget,
and stop criterion: the generated project had to compile, build, and serve
without errors before the trial could end.

The experiment was run for two model generations, tracked as **cohorts**:

- **`opus-4.6`** — the original baseline reported in the paper (March 2026).
- **`opus-4.8`** — a re-run of the same tasks with the newer model (June 2026).

A trial may also contain a `utk` condition; it is not part of this comparison and
is ignored by the profiler (only `autark` and `general` are profiled).

## Repository contents

```
.
├── README.md                # this file
├── run_trials.sh            # the experiment driver script
├── profiler.py              # the metrics tool (defines the cohorts, writes metrics.{json,csv})
├── metrics.csv              # per-trial code metrics + per-(cohort,app) and per-cohort averages
├── metrics.json             # full results + per-cohort summary
└── trials/                  # one folder per app, containing prompts and outputs
    ├── app1-subway-accessibility/
    │   ├── prompt-autark.md
    │   ├── prompt-general.md
    │   └── t<N>/
    │       ├── autark/{meta.json, log.jsonl, output/}
    │       └── general/{meta.json, log.jsonl, output/}
    ├── app2-noise-pollution/
    ├── app3-noise-scatterplot/
    ├── app4-street-network/
    └── app5-subway-picking/
```

## Running the experiment

The experiment is reproduced via `run_trials.sh`:

```bash
# all apps, both conditions
./run_trials.sh

# one app, both conditions
./run_trials.sh app1-subway-accessibility

# one app, one condition
./run_trials.sh app1-subway-accessibility autark
```

The script creates a fresh `tN` trial directory under each app, runs Claude Code
inside it, and writes a `log.jsonl` (full `stream-json` transcript) and a
`meta.json` (model, duration, timestamp). Every `prompt-{autark,general}.md` file
is concatenated with a shared appendix of common instructions (OSM querying
guidelines, console logging requirements, and the build/serve validation loop)
before being sent to the model. The full text of that appendix is in
`run_trials.sh`.

## Metrics

The metrics are produced by `profiler.py`, which statically analyzes the final
source tree the agent left in each trial's `output/` directory after passing the
validation loop. Run it with no arguments:

```bash
python3 profiler.py          # writes metrics.json and metrics.csv, prints a per-cohort report
```

The tool does not crawl every trial blindly. Because the `trials/` directory also
holds re-runs and other models, each cohort pins exactly one trial per app via the
`COHORTS` table at the top of `profiler.py`:

| Cohort | app1 | app2 | app3 | app4 | app5 |
|---|---|---|---|---|---|
| `opus-4.6` | t1 | t1 | t1 | t1 | t1 |
| `opus-4.8` | t3 | t3 | t3 | t2 | t3 |

To add a cohort or re-point a trial, edit `COHORTS` and re-run.

Outputs:

- **`metrics.csv`** — one row per trial, plus per-`(cohort, app, condition)`
  averages and per-`(cohort, condition)` averages. The cohort aggregates reported
  in the paper are the `ALL, avg` rows (one per cohort × condition).
- **`metrics.json`** — full per-trial results plus a `summary.per_cohort` block
  (overall and per-app, by condition).

A few metrics (cyclomatic, cognitive, max-nesting, magic-numbers, `any`-types) are
aggregated **per file** rather than over the concatenated source, to avoid a
regex-stripping artifact across file boundaries that affected multi-file `general`
outputs. See the note in `profile_trial` and the consolidated write-up in
`dissertasao/artigo/artigo-novo/code-metrics-analysis.md`.
