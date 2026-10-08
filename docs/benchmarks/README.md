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
