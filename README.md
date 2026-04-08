# Autark — Experiments

This repository contains the supplemental material for the paper *Autark: A
Serverless Toolkit for Prototyping Urban Visual Analytics Systems*. It accompanies
the agentic development evaluation reported in Section 5.3 of the paper, in which
an AI coding agent (Claude Code, Opus 4.6) was asked to implement five urban VA
tasks of increasing complexity under two conditions:

- **`autark`** — the agent was given Autark's documentation as its primary
  context and instructed to use only Autark's API.
- **`general`** — the agent was explicitly told *not* to use Autark, and could
  freely choose any general-purpose libraries available online.

Each task was run independently, with no conversation history carried between
trials. Both conditions shared the same model configuration, max-turns budget,
and stop criterion: the generated project had to compile, build, and serve
without errors before the trial could end.

## Repository contents

```
.
├── README.md                # this file
├── supplemental.pdf         # compiled supplemental document
├── run_trials.sh            # the experiment driver script
├── metrics.csv              # per-trial code metrics + per-app and global averages
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

`metrics.csv` contains one row per trial plus per-app averages (`trial=avg`) and
a global average row (`app=ALL, trial=avg`). All metrics were computed by static
analysis of the final source tree the agent left in each trial's `output/`
directory after passing the validation loop. The number of trials per
`(app, condition)` pair is uneven — some pairs were re-run while iterating on
prompt wording. The averages reported in Section 5.3 of the paper correspond to
the `ALL, avg` rows.
