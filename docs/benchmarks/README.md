# Benchmarks

Measurements taken while developing context-tools. The reports are written in Portuguese
(`*.pt-BR.md`); the numbers are the ones measured.

> **Anonymized.** These runs used private codebases (a multi-module Delphi workspace and a
> React/TypeScript frontend). Project, module, file and routine names were replaced with neutral
> pseudonyms before publication; counts, timings and scores were left untouched.

| report | question it answers |
|---|---|
| [pilot-v1.7.4](pilot-v1.7.4.pt-BR.md) | First pilot: `rg` vs. `symbols`/`outline`/`context-pack` over 8 projects, plus two agents doing the same tasks with and without the tools. |
| [controlled-2026-08-07](controlled-2026-08-07.pt-BR.md) | Controlled benchmark: a closed gold set of 25 definitions in 10 cases; precision/recall/F1 and output size for each strategy. |
| [adaptive-routing-2026-08-07](adaptive-routing-2026-08-07.pt-BR.md) | Is `context-pack` worth calling every time, or only when results are ambiguous? |
| [large-delphi-workspace-2026-08-07](large-delphi-workspace-2026-08-07.pt-BR.md) | Index and diagnostics on a 1,878-file Delphi workspace without git. |
| [outcome-pilot-2026-10-09](outcome-pilot-2026-10-09.pt-BR.md) | First outcome runs: does a real agent solve the same task with and without the plugin? 22 runs on public code; what the traces showed and what changed because of it. |
| [outcome-round2-2026-10-10](outcome-round2-2026-10-10.pt-BR.md) | Second outcome round, 60 runs on 6 cases including "who calls X" across 10 files and same-name overloads: 26/30 without the plugin, 28/30 with it, 15% cheaper; a silent cut in the Grep context found and fixed, then re-measured. |
| [outcome-round3-2026-10-10](outcome-round3-2026-10-10.pt-BR.md) | Held-out round: 5 new cases in TypeScript and Python (Sonnet 5: 21/25 without, 24/25 with, 24% cheaper) and all 11 cases on Haiku 4.5 (48/55 without, 50/55 with, 36% cheaper). |

## Outcome benchmark: does the task get solved, and at what cost?

The reports above compare tools with tools. `scripts/benchmark-outcome.mjs` measures what a user
pays for: a real agent (`claude -p`) does the same task twice on a clean copy of the target
repository — once as it is, once with this plugin loaded — and the result is checked objectively
(regular expressions over the final answer, or a command that exercises the fixed behavior). It
records whether the task was solved, the cost, turns, duration and context tokens.

- **Isolation.** Both arms run with `--setting-sources project --strict-mcp-config`, so no plugin, hook
  or MCP server from the user's configuration enters either one; the "with" arm adds only
  `--plugin-dir <this repository>`. Agent configuration shipped by the target repository is removed
  per case (`remove`). Variables of a host session are dropped.
- **Cost control.** `--per-run-cost` goes to the CLI's `--max-budget-usd`; `--max-cost` stops starting
  new runs once reached. `--dry-run` prints the plan and the exact command.
- **No fake results.** It refuses to start when the CLI is not logged in, and stops at the first run
  that made no model call — a zero-cost "answer" that is really an error message is not a measurement.

```bash
node scripts/benchmark-outcome.mjs --cases=docs/benchmarks/outcome/cases.pilot.json --dry-run
node scripts/benchmark-outcome.mjs --cases=docs/benchmarks/outcome/cases.pilot.json --per-run-cost=3 --max-cost=15
```

[`outcome/cases.pilot.json`](outcome/cases.pilot.json) has three cases: two read-only questions in
large third-party codebases (Newtonsoft.Json, C#; commons-lang, Java) and one bug fix in this
repository at the 2.6.0 tag. One repetition per arm is a pilot, not a statistic: it shows whether the
harness works and where the differences are worth a larger run.

`--model=haiku` (or any model the CLI accepts) runs a round on another model; each result records the
model that answered. `results.json` is written ready to publish: the temporary copy becomes `<copy>`
and the user's home `<home>`. A usage limit (HTTP 429) stops the round instead of counting as a wrong
answer, and `--resume` runs only what is missing from a previous `results.json` in the same `--out`.

Each run's transcript (`<case>.<arm>.<rep>.jsonl`) is saved next to `results.json`, and each result
lists the tools the agent called — a wrong answer then says whether the agent looked and misread, or
never looked.

## Reproducing the controlled benchmark

```bash
# example gold set: runs against this repository itself
node scripts/benchmark-controlled.mjs --cases=docs/benchmarks/cases.example.json

# your own gold set (cases.local.json is ignored by git)
cp docs/benchmarks/cases.example.json docs/benchmarks/cases.local.json
node scripts/benchmark-controlled.mjs          # or: npm run benchmark:controlled
```

Each case names a project `root`, a `query`, the file `globs` to search and the `expected`
definitions as `file:line` relative to the root. Add `--json` for machine-readable output and set
`CONTROLLED_BENCH_REPEATS` to change the number of repetitions (default 3). The benchmark only reads
the projects; the tool's state goes to a temporary folder that is removed at the end.

Keep real gold sets in `*.local.json`: they describe someone's codebase and must not be committed.
