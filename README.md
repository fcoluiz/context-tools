# context-tools

[![test](https://github.com/fcoluiz/context-tools/actions/workflows/test.yml/badge.svg)](https://github.com/fcoluiz/context-tools/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-339933)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**Project knowledge that does not rot — for AI coding agents (Claude Code and Codex).**

Every agent session rediscovers the same project: chained `grep`s, files read window by window, the
same investigation repeated, and whatever was learned thrown away when the session ends. Written
notes help until the code changes under them and they start lying quietly. context-tools does three
things about that:

1. **Find** — a cross-file symbol index, who-uses-what, outlines for huge files, change coupling mined
   from git and a pre-change impact briefing, all generated on the spot from your code.
2. **Remember** — what a session investigated becomes a short document in `ai-context/` or a context
   map, bound to the source files it describes by fingerprint.
3. **Verify** — when the code under a map or document changes, the next session (or CI) is told
   which one, and why. "Up to date" never claims more than it knows.

- **Zero dependencies.** Only `node:` builtins. Nothing to install besides Node 18+.
- **Zero configuration.** It discovers repositories, languages and documentation by itself.
- **Honest by design.** When it does not know, it says so — a confident wrong answer is treated as
  worse than no answer.
- **Measured, not estimated.** Every number in the docs says where it came from, including the ones
  that make the tool look worse.
- **Cheap on tokens.** Hooks stay silent when there is nothing to say, and every fixed cost has a
  ceiling enforced by a test.

*[Leia em português →](README.pt-BR.md)*

## What it answers

One entry point, short verbs: `node scripts/ct.mjs <verb>` (the plugin skill already knows the path).
The individual scripts keep working exactly as before.

| question | verb |
|---|---|
| where is X defined? | `ct find <name> [<name>…]` |
| who uses X, and from which function? | `ct refs <name> [--strings]` |
| where on screen is "Customer code", and what code reads it? (Delphi) | `ct ui <text on screen>` |
| what is at stake before I change X? | `ct impact <symbol-or-file>` |
| what does this project look like? | `ct overview` |
| how do I navigate this huge file? | `ct outline <file> [filter]` |
| what changes together with this file? | `ct coupling <file>` |
| why is this code like this? | `ct why <symbol>` |
| which tests cover this file, and how do I run them? | `ct verify <file> [<file>…]` |
| give me a bounded evidence pack for a symbol or file | `ct pack <symbol-or-file> [--budget=N]` |
| is this documentation still true? | `ct check [--strict]` |
| I reviewed this map/doc — record it | `ct ack <map-or-doc.md>` |
| what does the next session need to know? | `ct handoff [--salvar]` |
| how healthy is the local setup? | `ct health [--days=30] [--audit] [--json]` |
| the same as versioned JSON, for CI or a dashboard | `ct snapshot [--days=30] [--sessions=20]` |

The agent does not need to remember any of this. **Hooks** bring the tools in on their own: before a
`grep` for a symbol the index answers first, a session starts with a short list of the context maps
that went stale, and the end of a session flags files that historically change together but were
not edited together — and, once per session, code edited after the last test run. A session that only
read code to answer a question gets one line suggesting you say "save this to context"; the agent
then records it in `ai-context/`. Each message is delivered once, even when the plugin and a
standalone copy are both installed.

## Install or update

One command, nothing to answer. It installs context-tools for **every agent you have** (Claude Code
and/or Codex), for your user — every project, not just the current one. Run it again to update:

```bash
npx -y github:fcoluiz/context-tools
```

On **Windows PowerShell**, type `npx.cmd` instead of `npx` (the default execution policy blocks the
`npx.ps1` shim; `npx.cmd` is the same program and changes no security setting).

Then open a new session — that is all. The hooks work on their own: before a Grep they say where a
symbol is defined, after it which function each line falls in, and at the start of a session how to
run the tests and when a newer release is out (with this same command). On Codex, the first time,
open `/hooks` and trust the context-tools hooks once.

Requires Node.js 18+ and the CLI of at least one agent (`claude` or `codex`). It never changes the
folder you run it from, and never installs an agent CLI you do not already use.

| want | add to the command |
|---|---|
| only one agent | `--target=claude` or `--target=codex` |
| only the current project, not your user | `--project .` |
| the MCP server too (see below) | `--mcp` (and `--remove-mcp` to take it out) |
| to see what it would do, changing nothing | `--dry-run` |

### MCP server (optional, off by default)

For Claude Code and Codex the plugin is enough: in every measured round the value came from the
hooks, and agents never needed to call a tool for it. The MCP server is for **other MCP clients**, or
for whoever prefers typed tool calls: five read-only tools (`find_symbol`, `references`, `impact`,
`outline`, `overview`) with the same answers as the commands. It stays off by default because tool
definitions are paid on every request: about 2,000 characters (~500 tokens), a ceiling enforced by a
test. To turn it on:

```bash
npx -y github:fcoluiz/context-tools --mcp
```

That registers it with `claude mcp add` / `codex mcp add` and keeps it updated with every run. Any
other client can start it directly:

```json
{ "mcpServers": { "context-tools": { "command": "node", "args": ["<home>/.context-tools/runtime/scripts/mcp-server.mjs"] } } }
```

### With the agent's own CLI

Claude Code:

```bash
claude plugin marketplace add fcoluiz/context-tools
claude plugin install context-tools@context-tools
```

Codex:

```bash
codex plugin marketplace add fcoluiz/context-tools
codex plugin add context-tools@context-tools-codex
```

### Standalone, without a plugin

```bash
node /path/to/context-tools/install.mjs /path/to/project --target=both
```

Copies the scripts into the project and registers the hooks. Idempotent; `--dry-run` simulates and
`--no-hooks` installs only the scripts. It also adds a `.gitignore` inside `.claude/` so the tool's
local state never shows up in your `git status`.

## Try it

```bash
node scripts/symbols.mjs buildIndex
```

`symbols` answers with the file, the line where the **definition** starts and the line where it ends —
not dozens of textual matches — and says which repositories it searched. When nothing matches it
says so instead of returning empty. If the name is not a symbol but a file, it says so — labeled
as a file, never presented as a definition.

## Languages

| extension | `symbols` (cross-file) | `outline` (single file) |
|---|---|---|
| `.js .jsx .ts .tsx .mjs .cjs` | ✅ | ✅ |
| `.py .pyi` | ✅ | ✅ |
| `.go` | ✅ | ✅ |
| `.rs` | ✅ | ✅ |
| `.cs` (C#) | ✅ | ✅ |
| `.java` | ✅ | ✅ |
| `.php` | ✅ | ✅ |
| `.pas .dpr .dpk .inc` (Delphi/Pascal) | ✅ | ✅ |
| `.dfm .fmx` (Delphi forms) | — deliberately | ✅ |
| `.md` | — | ✅ (sections) |
| `.sql` (tables, columns, views, procedures…) | ✅ index only | ✅ |

`coupling` and `audit-docs` work with any language. Every parser is checked against third-party
production code — about **9,000 files and 192,000 symbols** across Python, Go, Delphi/Pascal, Rust,
TypeScript, C#, Java and PHP projects — with **zero symbols reported at the wrong line**.

## What is proven, what is a signal, what is still a hypothesis

The claims this project makes, sorted by how much evidence is behind them. "Proven" means measured
with the raw data published; "signal" means there is evidence pointing that way but not a
measurement that settles it; "hypothesis" means it is what the design is for, not yet measured.

**Proven** — an agent finishing the same task, on public repositories, with and without the plugin
([rounds 2–7](docs/benchmarks/)):

- **It never made the agent solve fewer tasks.** In every round and model, at least as many answers
  were right with the plugin as without it.
- **Questions about the code are cheaper and more often right**: 15–36% cheaper in every round. The
  gain is largest on "who uses X" and "where exactly": a hook tells which method or class each search
  hit falls in, which is what an agent answering from bare `grep` lines gets wrong.
- **It beat five tools with the same goal on questions** (round 7): the most accurate (21/22, tied with
  Serena) and the cheapest of those that got the answers right (−26%), in half the turns.
- **Hooks reach the agent; extra tools mostly do not.** In round 7 the agent called codebase-memory's
  and token-savior's MCP tools zero times in 34 runs each, and those tools made bug fixes 25–46% more
  expensive. That is why context-tools works through hooks and ships its MCP server off by default.
- **The fixed costs are bounded:** the `SessionStart` note is ~175 tokens, the index takes ~1.75 s
  from scratch and ~130 ms from its local cache, and each ceiling is enforced by a test
  ([reference](docs/reference.md#tokens)).
- **Token savings from navigation alone are small: 1–3%** of a real session's cost, because most of
  the cost is context being re-read ([how it was measured](docs/reference.md#the-token-saving-measured--and-it-is-small)).
  The value is in fewer wrong turns, not in fewer tokens per search.

**Signal** — evidence points that way, but it is not settled:

- **Bug fixes are cheaper, by an amount that varies.** Cheaper in 4 of 5 measurements (−11% to
  −36%), and 19% more expensive in one (round 5, Haiku), which led to fixes. The same cases gave −34%
  in round 6 and −11% in round 7: the effect is real in direction, unstable in size at 12 runs per arm.
- **Saying less at session start and one working rule help on bug fixes** (2.7.7). Taken from the
  round 7 traces, where the tool that told the agent "verify once, then stop" was the cheapest; not
  re-measured yet.
- **The same holds in Codex.** The hooks are the same and the Codex adapter is covered by end-to-end
  tests, but every outcome round ran Claude Code (`claude -p`). Codex's models may also use MCP tools
  more readily than Claude's did here.
- **Splitting a long session pays off.** Cost per message grows 3.4× with session length (measured);
  the "the split paid off, ~N%" note at session start counts real messages but takes the percentage
  from a simulated curve, and says so.

**Hypothesis** — what the design is for, not measured yet:

- **Knowledge that survives sessions.** Every benchmark starts from a fresh clone: cold index, no
  context maps, no `ai-context` documents, no handoff — the plugin's worst case. Whether a mapped area
  is re-entered faster in the next session, and how much the warnings about stale maps and documents
  prevent, has not been measured.
- **Larger and private codebases, other models.** The rounds use public repositories of a few hundred
  to a few thousand files, and Sonnet and Haiku. The design targets large multi-repository
  workspaces, where re-exploration costs most.
- **Teams.** The pull-request workflow that leaves knowledge behind for the next person is tested as
  code, not measured as an outcome.

## Does it help? Measured

A real agent (`claude -p`) does the same task on a clean copy of a public repository, once without
the plugin and once with it, and the answer is checked against a hand-verified ground truth (a fix
is checked by running the code). Four or five runs per arm per case:

| round | model | cases | without | with | cost with vs. without |
|---|---|---|---:|---:|---:|
| 2 | Sonnet 5 | 6 (C#, Java, a fix) | 26/30 | 28/30 | −15% |
| 3 — **held out** | Sonnet 5 | 5 new (TypeScript, Python) | 21/25 | 24/25 | −24% |
| 3 | Haiku 4.5 | 11 | 48/55 | 50/55 | −36% |
| 4 | Sonnet 5 | the 5 new ones | 21/25 ¹ | **25/25** | −30% |
| 4 | Haiku 4.5 | 11 | 48/55 ¹ | **53/55** | −18% |
| 5 — **held out** | Sonnet 5 | 3 bug fixes + 1 question (JavaScript) | 16/16 | 16/16 | −23% |
| 5 — **held out** | Haiku 4.5 | 3 bug fixes + 1 question (JavaScript) | 16/16 | 16/16 | **+19%** |
| 6 — **independent** ² | Sonnet 5 | 3 bug fixes, 2 new repositories (JavaScript) | 12/12 | 12/12 | −36% |
| 6 — **independent** ² | Haiku 4.5 | 3 bug fixes, 2 new repositories (JavaScript) | 12/12 | 12/12 | −34% |

¹ Round 4 measured only the arm with the plugin (2.7.3); the arm without it is round 3's.
² Cases written before the plugin was ever run on those repositories (js-yaml, commander.js), with the
plugin as released after round 5; both arms measured.

- **Never fewer tasks solved.** In every round the plugin solved at least as many as the agent alone.
- **Cheaper in 8 of 9 rows.** The gap is largest on "who uses X" and "where exactly" questions. The
  exception is round 5, Haiku fixing bugs: 19% more expensive. Logging what the hooks injected showed
  why (an evidence pack full of noise, turns spent on tests that could not run); both were fixed, and
  round 6 — new bugs in two repositories the plugin had never seen — measured Haiku 34% cheaper and
  Sonnet 36% cheaper on bug fixes, with every task solved in both arms. The round 5 row stays as it
  was measured.
- **Where the accuracy gain comes from:** Grep returns lines without the method around them, and an
  agent that answers from that alone names the wrong method or class. A hook says which symbol each
  matched line falls in, and warns when a qualified search (`Class\.method`) will miss the calls made
  from inside the class without the prefix.
- **What it does not show yet:** few runs per arm, public code, real multi-session work.

### Compared with other tools

Round 7 put five third-party tools with the same goal in the same harness, each set up the way its own
installer leaves Claude Code (Haiku 4.5, same cases):

| arm | reading and navigation (11 cases × 2) | bug fixes (3 cases × 4) |
|---|---|---|
| agent alone | 18/22 · $1.82 | 11/12 · $2.11 |
| **context-tools** | **21/22 · $1.34 (−26%)** | **12/12** · $1.87 (−11%) |
| [Serena](https://github.com/oraios/serena) (LSP, MCP) | 21/22 · $1.80 (−1%) | 11/12 · $2.96 (+40%) |
| [read-once](https://github.com/Bande-a-Bonnot/Boucle-framework/tree/main/tools/read-once) (re-read guard) | 20/22 · $1.67 (−8%) | 12/12 · $3.09 (+46%) |
| [token-savior](https://github.com/Mibayy/token-savior) (MCP + hooks) | 19/22 · $1.78 (−2%) | 12/12 · $3.07 (+45%) |
| [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (graph, MCP + hooks) | 18/22 · $1.66 (−9%) | 12/12 · $2.64 (+25%) |
| [context-os](https://github.com/sravan27/context-os) (graph before the prompt + CLAUDE.md rules) | 16/22 · $1.29 (−29%) | 11/12 · **$1.16 (−45%)** |

- **Reading and navigation:** context-tools was the most accurate and the cheapest of those that got
  the answers right, in less than half the turns of any other arm.
- **Bug fixes:** context-os was cheaper. Its edge comes from the CLAUDE.md its installer writes
  ("ultra-concise", "run tests once to verify, not to explore"), not from its graph — and the same
  rules cost it accuracy on questions (16/22, the lowest).
- **The MCP tools were barely used:** in 34 runs each, the agent called codebase-memory's and
  token-savior's tools zero times, Serena's 30. They pay for being there without the gain.

Setup of each arm, adjustments and per-case data: [round 7 report](docs/benchmarks/outcome-round7-2026-10-12.pt-BR.md).

Reports, cases and every run's raw data: [docs/benchmarks](docs/benchmarks/).

## What it costs

- **Speed:** a 1,543-file workspace indexes in ~1.75 s from scratch and ~130 ms from cache. The cache
  is invalidated by file changes and by changes to the parser itself, and is refused when the
  filesystem clock is too coarse to trust.
- **Tokens:** the only cost you pay without asking is the `SessionStart` note, ~175 tokens, plus ~30
  for the test-command line when the project has one. Other warnings cost nothing when there is
  nothing to say.
- **The honest part:** in real sessions, 89% of the cost is context being re-loaded, and tool output
  is a small share of it. Better navigation saves **1–3%** of tokens, not 20%. The real value is
  fewer wrong turns and less re-exploration — the
  [reference](docs/reference.md#the-token-saving-measured--and-it-is-small) shows how this was
  measured and where the bigger levers are.

## In a team: knowledge left behind in a pull request

Maps and `ai-context/` documents committed to the repository are shared knowledge — and they only
stay worth reading if whoever changes the code also checks what is written about it. The drift check
lists every map or live document whose cited source changed in a pull request **without a recorded
review** (`ack` writes the reviewed source fingerprint into the file itself, which is the only proof
that holds in CI):

```yaml
# .github/workflows/knowledge.yml
on: pull_request
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # the base branch is needed to compute the diff
      - uses: fcoluiz/context-tools@v2.9.2
        with:
          strict: 'false'         # 'true' fails the job instead of only annotating
```

Locally or in any other CI: `node scripts/ct.mjs drift --base=origin/main [--strict]`. It annotates
the pull request, writes a job summary, and exits with 2 — never 0 — when it could not compute the
diff. `ct health` shows the same thing as a number: the share of verifiable maps and documents whose
sources are unchanged since their review, and how the maps' share moved across recent sessions.

## Security

Hooks inject text into the model's context, and much of that text comes from the repository being
analyzed — in a cloned or third-party repository, that is untrusted input. Every external command
runs without a shell, the index never follows links out of the project, repository-supplied text is
sanitized and size-limited, and the injected block states that names from the repository are data,
not instructions. The tools send no telemetry. The only network call is the new-release check: at
most once a day, in the background, a `git ls-remote --tags` against this repository — nothing about
your project is sent. Turn it off with `"updateCheck": false` or `CONTEXT_TOOLS_UPDATE_CHECK=0`.

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).

## Documentation

- **[Full reference](docs/reference.md)** — every tool, hook and setting, the measurements behind
  each claim, known limitations and what is out of scope by design.
- [Benchmarks](docs/benchmarks/) — controlled benchmarks and how to reproduce them.
- [Verifiable knowledge format v1](docs/spec/knowledge-format.md) — the open, tool-independent spec of
  how a map or document records which source versions it was reviewed against (with a JSON Schema).
- [CHANGELOG](CHANGELOG.md) — what changed in each release.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it explains how
to run the tests (`npm test`, no setup), the three rules every change follows, and how to add a
language. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Luiz Nogueira
