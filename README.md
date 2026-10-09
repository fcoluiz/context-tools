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
| who uses X, and from which function? | `ct refs <name>` |
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

The agent does not need to remember any of this. **Hooks** bring the tools in on their own: before a
`grep` for a symbol the index answers first, a session starts with a short list of the context maps
that went stale, and the end of a session flags files that historically change together but were
not edited together — and, once per session, code edited after the last test run. A session that only
read code to answer a question gets one line suggesting you say "save this to context"; the agent
then records it in `ai-context/`. Each message is delivered once, even when the plugin and a
standalone copy are both installed.

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
afterwards. On Codex, the first time, open `/hooks` and trust the context-tools hooks once. From then
on, a session start tells you when a newer release is out, with this same command.

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

### Optional: MCP server

The plugin (skill + hooks) is the recommended way to use context-tools in Claude Code and Codex. An
MCP server is also available for **other MCP clients** and for whoever prefers typed tool calls: five
read-only tools (`find_symbol`, `references`, `impact`, `outline`, `overview`) that return the same
answers as the commands, from a process that stays alive (no Node start-up per call).

It is **off by default**, because tool definitions have a cost: about 2,000 characters (~500 tokens)
added to every request of a client that loads them — a ceiling enforced by a test. Turn it on with
the same installer:

```bash
npx --yes --package github:fcoluiz/context-tools context-tools-setup-all --global --yes --mcp
```

The installer copies the scripts to `~/.context-tools/runtime` (a path that survives updates) and
runs `claude mcp add` / `codex mcp add` for you. Running the installer again keeps the server up to
date; `--remove-mcp` unregisters it. Any other client can start it directly:

```json
{ "mcpServers": { "context-tools": { "command": "node", "args": ["<home>/.context-tools/runtime/scripts/mcp-server.mjs"] } } }
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
      - uses: fcoluiz/context-tools@v2.7.0
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
- [CHANGELOG](CHANGELOG.md) — what changed in each release.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it explains how
to run the tests (`npm test`, no setup), the three rules every change follows, and how to add a
language. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Luiz Nogueira
