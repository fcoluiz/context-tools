# context-tools

[![test](https://github.com/fcoluiz/context-tools/actions/workflows/test.yml/badge.svg)](https://github.com/fcoluiz/context-tools/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-339933)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**Code navigation and documentation hygiene for AI coding agents — Claude Code and Codex.**

Agents spend a large share of every session *finding where things are*: chained `grep`s, files read
window by window, the same exploration repeated session after session. context-tools gives the agent
a cross-file symbol index, outlines for large files, change coupling mined from git, and an audit
that tells when documentation has gone stale — all generated on the spot from your code, so it is
never out of date.

- **Zero dependencies.** Only `node:` builtins. Nothing to install besides Node 18+.
- **Zero configuration.** It discovers repositories, languages and documentation by itself.
- **Honest by design.** When it does not know, it says so — a confident wrong answer is treated as
  worse than no answer.
- **Measured, not estimated.** Every number in the docs says where it came from, including the ones
  that make the tool look worse.

*[Leia em português →](README.pt-BR.md)*

## What it answers

| question | command |
|---|---|
| where is X defined? | `symbols.mjs <name> [<name>…]` |
| how do I navigate this huge file? | `outline.mjs <file> [filter]` |
| what changes together with this file? | `coupling.mjs <file>` |
| is this documentation still true? | `audit-docs.mjs [--strict]` |
| why is this code like this? | `why.mjs <symbol>` |
| what does the next session need to know? | `handoff.mjs [--salvar]` |
| give me a bounded evidence pack for a symbol or file | `context-pack.mjs <symbol-or-file> [--budget=N]` |
| how healthy is the local setup? | `health.mjs [--days=30] [--audit] [--json]` |
| which tests cover this file, and how do I run them? | `verify.mjs <file> [<file>…]` |

The agent does not need to remember any of this. **Hooks** bring the tools in on their own: before a
`grep` for a symbol the index answers first, a session starts with a short list of the context maps
that went stale, and the end of a session flags files that historically change together but were
not edited together — and, once per session, code edited after the last test run. Each message is
delivered once, even when the plugin and a standalone copy are both installed.

## Install or update

One command installs context-tools for **every agent you have** (Claude Code and/or Codex), for
your user — every project, not just the current one. Run the same command again to update to the
latest release:

```bash
npx --yes --package github:fcoluiz/context-tools context-tools-setup-all --global --yes
```

On **Windows PowerShell**, use `npx.cmd` instead of `npx`. The default execution policy blocks the
`npx.ps1` shim that npm installs ("running scripts is disabled on this system"); `npx.cmd` runs the
same program without changing any security setting:

```powershell
npx.cmd --yes --package github:fcoluiz/context-tools context-tools-setup-all --global --yes
```

Requires Node.js 18+ and the CLI of at least one agent (`claude` or `codex`). It never changes the
folder you run it from, and never installs an agent CLI you do not already use. Open a new session
afterwards. On Codex, the first time, open `/hooks` and trust the context-tools hooks once.

The plugin brings the tools **and** the hooks. Use `--target=claude` or `--target=codex` to limit it
to one agent, and drop `--global` to set up only the current project instead.

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
| `.pas .dpr .dpk .inc` (Delphi/Pascal) | ✅ | ✅ |
| `.dfm .fmx` (Delphi forms) | — deliberately | ✅ |
| `.md` | — | ✅ (sections) |
| `.sql` (tables, columns, views, procedures…) | ✅ index only | ✅ |

`coupling` and `audit-docs` work with any language. Every parser is checked against third-party
production code — about **6,200 files and 147,000 symbols** across Python, Go, Delphi/Pascal, Rust
and TypeScript projects — with **zero symbols reported at the wrong line**.

## What it costs

- **Speed:** a 1,543-file workspace indexes in ~1.75 s from scratch and ~130 ms from cache. The cache
  is invalidated by file changes and by changes to the parser itself, and is refused when the
  filesystem clock is too coarse to trust.
- **Tokens:** the only cost you pay without asking is the `SessionStart` note, ~175 tokens. Other
  warnings cost nothing when there is nothing to say.
- **The honest part:** in real sessions, 89% of the cost is context being re-loaded, and tool output
  is a small share of it. Better navigation saves **1–3%** of tokens, not 20%. The real value is
  fewer wrong turns and less re-exploration — the
  [reference](docs/reference.md#the-token-saving-measured--and-it-is-small) shows how this was
  measured and where the bigger levers are.

## Security

Hooks inject text into the model's context, and much of that text comes from the repository being
analyzed — in a cloned or third-party repository, that is untrusted input. Every external command
runs without a shell, the index never follows links out of the project, repository-supplied text is
sanitized and size-limited, and the injected block states that names from the repository are data,
not instructions. The tools make no network calls and send no telemetry.

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).

## Documentation

- **[Full reference](docs/reference.md)** — every tool, hook and setting, the measurements behind
  each claim, known limitations and what is out of scope by design.
- [Benchmarks](docs/benchmarks/) — controlled benchmarks and how to reproduce them.
- [CHANGELOG](CHANGELOG.md) — what changed in each release.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it explains how
to run the tests (`npm test`, no setup), the three rules every change follows, and how to add a
language. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Luiz Nogueira
