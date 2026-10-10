# Changelog

Notable changes per release. Every claim of a measurement points at where it came from; when a
number is an estimate, it says so.

This project follows [Semantic Versioning](https://semver.org/). Entries before 1.3.1 were
reconstructed from git history.

## [Unreleased]

## [2.7.1] — 2026-10-10

What the first outcome benchmark showed, fixed
([report](docs/benchmarks/outcome-pilot-2026-10-09.pt-BR.md)): 22 runs, with the plugin 10/11 solved
and without it 11/11. In the traces, the agent never called the skill or `ct.mjs` — everything the
plugin delivered came through hooks — so the fixes are in the hooks.

### Added

- **Where each Grep match falls.** A `PostToolUse` hook (`grep-context.mjs`) follows a Grep, or a
  `grep`/`rg` command, that returned line numbers, and names the function, method or class each line
  falls in, with its range: `JsonReader.cs: 356-359 JsonReader.Push() (337-362)`. Grep shows
  `356: if (_maxDepth …` without the method around it, and in read-only questions the agent often
  answers after one Grep: the one failure of the benchmark named `SetToken` for a check that lives
  in `Push`. Reads only the files that matched (no index), at most 1,200 characters, silent without
  line numbers or a parser for the file.
- **The test command at session start.** `verify.mjs --session-start` adds one line (~30 tokens)
  with the project's test command, what `npm test` actually runs, and how to run one test file when
  the runner tells (`node --test <file>`, `npx vitest run <file>`, `pytest <file>::<test>`, …). In
  the benchmark's fix case, agents spent 3 to 8 turns finding this out. Silent when no command is
  detectable or `verify.enabled` is false.
- **The outcome benchmark records what the agent did.** `benchmark-outcome.mjs` now reads the CLI's
  `stream-json` output, stores each run's transcript next to `results.json`, and lists the tools each
  run called — without it, a wrong answer could not tell "did not look" from "looked and misread".

### Changed

- **No "read the index" for an empty index.** While `ai-context/` holds only its index, the
  `SessionStart` note says there is nothing to read yet instead of asking the agent to read it
  before exploring.
- **Evidence pack order.** Definitions come production code first, then tests (including a .NET
  `*.Tests` project), and exact names before partial ones. In index order, `MaxDepth` put test
  methods and a similarly named constant among the properties — the constant the benchmark's wrong
  answer named as the source of the default.

## [2.7.0] — 2026-10-09

Find, remember, verify: who uses a symbol and what is at stake before changing it, a first-minute
panorama, C#/Java/PHP, a drift check for pull requests, a knowledge-freshness score, an optional MCP
server, an open spec for verifiable knowledge and an outcome benchmark harness — with a skill 59%
shorter.

### Added

- **C#, Java and PHP in the index and the outline.** `symbols` and `outline` now read `.cs`, `.java`
  and `.php`: types, methods (labeled with their class, found by the bare name), constructors,
  properties, events, delegates and constants. The three share one engine that tracks braces, so
  declarations are only looked for directly inside a type — a call in a method body never becomes a
  definition — and a symbol ends at the brace that closes it. Checked against nine third-party
  projects (Newtonsoft.Json, serilog, Dapper, gson, commons-lang, jsoup, monolog, guzzle, Slim):
  2,907 files, 45,615 symbols, zero at the wrong line; the verification caught a C# verbatim string
  starting with `@"""` that hid every later method and Java type annotations that hid annotated
  methods. The three languages also count as code for maps, coupling and the verification note, which
  now knows `dotnet test`, `composer test` and `vendor/bin/phpunit`; `providers.mjs` suggests
  csharp-ls, jdtls and intelephense.
- **`refs.mjs`: who uses X, and from which function.** The uses of a name outside its definition,
  grouped by file, each labeled with the function or method that contains it. Comments and string
  literals are dropped with each language's own stripper and counted apart; Delphi forms are scanned
  for event wiring. By name, not by type, and the answer says so.
- **`impact.mjs`: what is at stake before a change.** For a symbol or a file, one budgeted briefing
  with its uses, what historically changes together with it (git, directional), the related tests and
  test command, and the context maps and `ai-context` documents that cite it, with whether the source
  they reviewed is still today's. On demand only: no hook calls it.
- **`ct.mjs`: one entry point, short verbs.** `ct.mjs find|refs|impact|outline|overview|pack|coupling|
  why|verify|docs|ack|check|health|handoff|…` runs the same script with the same arguments, in the
  same Node process. Every script keeps working on its own.
- **`overview.mjs`: the first-minute panorama.** Where the code is, the most changed files of the last
  six months (marked when a map or document covers them), files too large to read whole, the
  strongest co-changes, the test command and how much is written down — from the code and git only.
  The `SessionStart` note for an empty `ai-context/` points to it.

- **Knowledge drift check for pull requests.** `drift-check.mjs --base=<ref>` (or `ct.mjs drift`) lists
  every context map or live `ai-context` document whose cited source changed in the diff without a
  recorded review — the fingerprint `ack` writes into the file, the only proof that holds in CI. A
  composite GitHub Action (`uses: fcoluiz/context-tools@<tag>`) annotates the pull request and writes a
  job summary; `strict` fails the job. When the diff cannot be computed it exits with 2, never 0.
- **"Knowledge up to date" as a number.** `health.mjs` now opens with the share of verifiable maps and
  documents whose sources are unchanged since their review, and the trend of the maps' share over
  recent sessions (one local sample per `SessionStart`, no paths or names stored). Documents that are
  historical, manual or cite no source are counted apart instead of inflating the score.

- **Optional MCP server.** `mcp-server.mjs` (or `ct.mjs mcp`) speaks MCP over stdio with five read-only
  tools — `find_symbol`, `references`, `impact`, `outline`, `overview` — that return the same answers
  as the commands from a long-lived process. Off by default: its tool definitions add ~2,000
  characters to every request of a client that loads them (ceiling under test). `setup --mcp` copies
  the scripts to `~/.context-tools/runtime` and registers it with `claude mcp add` / `codex mcp add`;
  later updates refresh that copy, `--remove-mcp` unregisters it, and `status` reports it. Checked
  against the real Claude Code CLI (`claude mcp get` reports it connected).
- **An open spec for verifiable knowledge.** `docs/spec/knowledge-format.md` (with a JSON Schema)
  specifies, independently of this tool, how a context map or operational document records the
  per-source SHA-256 fingerprints it was reviewed against, how CRLF is normalized, how the aggregate
  digest is built and who may write them. Tests derive from the code: every field the readers parse
  must be in the schema, and a fingerprint computed by the written rule must equal the implementation's.
- **Outcome benchmark harness.** `benchmark-outcome.mjs` runs the same task with a real agent
  (`claude -p`) with and without the plugin, on clean copies, and checks the result objectively —
  solved or not, cost, turns, context tokens. Both arms exclude the user's plugins, hooks and MCP
  servers; per-run and total cost caps; it refuses to start without a logged-in CLI and stops at the
  first run that made no model call. A three-case pilot ships in `docs/benchmarks/outcome/`.

### Fixed

- **Arguments with quotes reached the agent CLIs with literal quotes on Windows.** The setup ran
  `cmd /s /c` without verbatim arguments, so Node re-escaped the quotes `quoteCmd` added; any path
  with a backslash or a space arrived as `"C:…"`. No argument needed quotes before the MCP path.
- **`isMain` compares real paths.** An npm bin on Linux/macOS is a symlink, so a script started
  through it did not recognize itself as the entry point.

### Changed

- **The skill is 59% shorter.** It now uses the `ct.mjs` verbs and drops internals the agent does not
  act on: 16,873 → ~6,900 characters, paid each time the skill loads; the description, paid on every
  prompt, went from 427 to 387. The test ceilings went down with it (7,600 and 420).
- **Positioning.** README and manifests now lead with what the tool is for: project knowledge that
  does not rot — find, remember, verify.

## [2.6.0] — 2026-10-09

A project can name its own throwaway folders with `ignoreDirs`, so copies and prototypes stop
coming back as definitions.

### Added

- **`ignoreDirs`: a project can name its own throwaway folders.** `"ignoreDirs": ["prototypes",
  "old-copies"]` in `context-tools.json` drops those folders, at any depth and case-insensitively,
  from the index, the answer before `grep`, the context pack, documentation checks and the read-only
  session suggestion. Prototypes and copies of a unit used to come back as exact definitions next to
  the real one, contradicting projects whose own workflow excludes them. Folder names only; nothing is
  guessed. A workspace folder listed there is also no longer treated as a repository.

## [2.5.0] — 2026-10-09

Investigations that only read code can now be saved by saying "save this to context", installs say
when a newer release is out, reviews are recorded with `ack.mjs`, and every `Stop` note has a ceiling.

### Added

- **`ack.mjs`: record a review without copying hashes.** `ack.mjs <map-or-doc.md>` computes and writes
  `source_fingerprints`, `source_digest` and the review date after the agent checked the content,
  reusing the byte-preserving writer of the Codex review queue (it revalidates the sources right
  before saving and refuses if the document changed meanwhile).
- **Context budget under test** (`tests/orcamento.test.mjs`): the skill description and the
  CLAUDE.md/AGENTS.md block (paid on every prompt), the skill body, and the `SessionStart` notes of a
  typical project each have a ceiling slightly above today's size, so growing them is a decision.
- **Suggestion to record read-only investigations.** A session that answered a question by reading
  code — no code edits, at least 3 files in 2+ folders with no context map or `ai-context` document —
  now gets one line at `Stop` suggesting the user ask for the flow to be recorded. Before, the Stop
  review only looked at edits, so the next session redid the whole investigation. It works the same
  for Claude and Codex, offline, from the transcript the host already writes; it reads only the bytes
  added since the previous `Stop`, shows at most once per session and never writes maps or documents.
  Turn it off with `"documentation": { "captureHint": false }`.
- **"Save this to context" ("registre no contexto").** The user no longer needs to name a folder or a
  document type. The skill now tells the agent to pick the type from what the conversation
  investigated (flow → feature, screen, database, integration, decision), update an existing
  document before creating one, add it to the index and show what was recorded. The `Stop`
  suggestion asks for exactly that phrase.
- **New-release notice.** A session start now tells the user — not the agent — when a newer release
  is out, with the exact update command (global for the plugin, per project for standalone
  installs). Installations fell behind silently: a Claude marketplace added with a pinned `ref`
  never sees a new tag, so the host's own update could not help. The hook never waits for the
  network: it reads `~/.context-tools/update-check.json`, and when that is older than 24 h a
  detached `git ls-remote --tags` refreshes it for the next session. Shown once per new version and
  again after 7 days if still not updated. Installs older than this release cannot show it; update
  them once by hand.

### Changed

- **Stale map/doc notes on Claude no longer carry SHA-256 JSON.** The largest part of the note was
  64-hex hashes for the model to paste into frontmatter — pure transcription, where it errs. The note
  now names the document, the changed sources and the `ack.mjs` command. Codex keeps the format its
  automatic review queue consumes.
- **Every `Stop` note has a ceiling (900 characters).** Overflow is cut at a line end with a pointer
  to `health.mjs`, where the backlog belongs; the handoff resume prompt is exempt.
- **One network call.** The README and SECURITY.md no longer say the hooks make no network calls:
  the release check above is the exception. It sends nothing about the project, runs at most once a
  day per machine, is skipped in CI, and is turned off with `"updateCheck": false` or
  `CONTEXT_TOOLS_UPDATE_CHECK=0`.

### Fixed

- **Delphi IDE backup copies showed up as definitions.** Files under `__history/` and
  `__recovery/` were indexed, so a symbol lookup returned the backup next to the real unit as an
  exact definition (seen in the Delphi benchmark of 2026-08-07 and again in real use). Both folders
  are now ignored, like `node_modules`.

## [2.4.0] — 2026-10-08

Searches typed in Claude's terminal reach the index, end-of-session notes are shorter, hooks no
longer run twice after moving to the plugin, and health reports whether index answers were used.

### Added

- **`grep`/`rg` typed in Claude's Bash reach the index.** The symbol answer already preceded the
  Grep tool and Codex shell searches; Claude agents that search through Bash bypassed it. A
  `PreToolUse` Bash group now runs `pre-tool.mjs` only for `Bash(grep *)` and `Bash(rg *)` (the
  hook `if` filter), so other Bash commands pay nothing.
- **Did the agent use the answer?** The `PreToolUse` hook notes which files it pointed to; on
  Claude, the `Stop` hook checks the transcript for a Read or edit of one of them within the next 6
  tool calls and records only the verdict. `health.mjs` shows "answers used: X/Y" — correlation,
  not cause; Codex answers expire unjudged.

### Changed

- **Shorter `Stop` notes.** On Claude every `Stop` note makes the model take one more turn, so its
  length is paid again in every following message. The session-cost notice and its handoff request
  went from ~800 to ~330 characters, the verification note from four lines to three, and the
  "code with no map" header was trimmed — same facts, same actions.

### Fixed

- **Hooks running twice on Claude after moving from standalone to the plugin.** The guided setup
  now removes the hooks a previous `install.mjs` wrote into `.claude/settings.json` (only those —
  user hooks stay), as it already did for Codex, and `status`/`doctor` report the duplication.
- **The standalone installer kept one hook group per event.** A second `PreToolUse` group would
  have silently replaced the first; groups and their `if` filters are now copied as declared.

## [2.3.0] — 2026-10-08

Each hook message reaches the agent once, the end of a session notes code left untested, and SQL
schemas are searchable like code.

### Added

- **Each hook message is delivered once.** When the plugin and a standalone copy (or two
  registrations of the same hook) are active together, every `SessionStart`/`Stop` note reached
  the agent twice — double tokens on every session and a repeated notice in the chat. Hook output now
  goes through `lib/hook-output.mjs`, which claims each (event, session, text) atomically for 90 s;
  the parallel copy stays silent. A legitimate repeat after `/compact` or `/clear` still arrives.
  `CONTEXT_TOOLS_HOOK_DEDUPE=0` turns it off.
- **Verification loop: `verify.mjs`.** `verify.mjs <file>…` lists the tests related to a file (same
  name or importing it, always labelled as a hint, not proof of coverage) and the project's test
  command (`package.json`, pytest, Go, Cargo, Maven, Gradle, or `"verify": {"command": "…"}`). On
  Claude, a `Stop` hook reads the session transcript and, **once per session**, notes code edited
  after the last test run. It never runs tests, never blocks, and stays silent in projects without a
  detectable test setup, for documentation-only edits, and on Codex (whose rollout format is not
  stable enough to read the edit → command order). `"verify": {"enabled": false}` disables it.
- **SQL in the symbol index.** `.sql` files now yield tables, columns (`CREATE TABLE` and
  `ALTER TABLE … ADD`), views, procedures, functions, triggers, indexes, sequences/generators and
  domains — the "database column" blind spot, for schemas kept in scripts or migrations. SQL is
  **index-only**: editing a migration does not count as code for context maps, coupling or the Codex
  automatic review, so it adds no warnings and no model calls. Files above 8 MB (data dumps) are
  skipped.
- **Latency budget under test.** The `PreToolUse` hook, which runs on every search, may only import
  `roots` and `hook-output` at the top; anything heavier must stay behind the lazy `import()`.

### Fixed

- **Windows paths in model-facing text lost every `\s`.** `sanitizeModelText` collapsed whitespace
  with `/\\s+/`, which matches the literal text `\s` instead of whitespace: `C:\proj\scripts\a.mjs`
  reached the agent as `C:\proj cripts\a.mjs` in handoffs and resume prompts, and tabs/newlines were
  never collapsed.

## [2.2.0] — 2026-10-08

One command installs or updates context-tools for every agent you use, and updating the Claude
plugin through the setup actually updates it.

### Added

- **One command to install or update globally:** `context-tools-setup-all --global --yes`. It
  covers every agent whose CLI is installed (Claude Code in the `user` scope, Codex globally),
  never installs a CLI you do not use, and writes nothing into the folder it runs from.

### Fixed

- **The guided setup never updated the Claude plugin.** `claude plugin install` on an installed
  plugin only answers "already installed"; the setup now runs `claude plugin update` in that case.
- **The setup could not see an installed Claude plugin.** `claude plugin list --json` returns a
  top-level array and the parser only looked for an object, so every run reinstalled from scratch.
- **Windows with the native Claude Code installer.** The setup called `claude.cmd`, which only the
  npm install provides; it now lets `cmd.exe` resolve `claude.exe` or `claude.cmd`.

## [2.1.0] — 2026-10-08

The guided setup now speaks your language, maps stay fresh across operating systems, and git
projects reached through a path alias are recognized again.

### Added

- **Cross-file invariants under test** (`tests/invariantes.test.mjs`): the version declared in the
  four places that declare it; key parity across the language catalogs (the `makeT` fallback would
  otherwise hide a missing key by answering in English); every tool the Claude hooks run having a
  Codex counterpart, with the plugin and standalone Codex manifests identical; and the deliberate
  `PreToolUse` matcher split (`Grep` on Claude, `Bash` on Codex, which exposes no Grep tool).

### Changed

- **The guided setup speaks the configured language.** Its messages were hardcoded in Portuguese;
  they now follow the same chain as every other tool — `CONTEXT_TOOLS_LANG`, then `lang` in
  `context-tools.json`, then the system locale, defaulting to English. Only the wording changed; no
  flag, command, or exit code did. The launchers' own messages are in English.

### Removed

- **Eight redundant launchers.** `setup-claude.{bat,ps1,sh,command}` and
  `setup-codex.{bat,ps1,sh,command}` differed from the `setup.*` family by two tokens each. Every
  launcher forwards its arguments, so `setup.bat --target=codex` does what `setup-codex.bat` did;
  without `--target` it asks, or detects the agent from the project. The `setup-claude.mjs` /
  `setup-codex.mjs` utilities and the `context-tools-setup` / `context-tools-setup-claude` npx entry
  points are unchanged.

### Fixed

- **A git repository reached through a path alias is no longer treated as "no git".** `isGitRepo`
  compared `git rev-parse --show-toplevel` (which Git returns fully resolved) with the raw directory
  string. When the project path went through a symlink, junction or 8.3 short name — macOS
  `/var/...` vs `/private/var/...`, Windows `C:\Users\RUNNER~1\...` — the comparison failed, the
  project was taken as having no repository, and hooks stayed silent or fell back to mtime. Both
  sides are now canonicalized with `fs.realpathSync.native`. This is what kept the macOS and Windows
  CI jobs red (21 failing tests); reproduced locally by pointing `TEMP` at a junction. Regression
  test in `tests/comportamento.test.mjs`.
- **Context maps and documents no longer look stale on another operating system.** Source
  fingerprints hashed the bytes on disk, so with `core.autocrlf` the same file hashed differently on
  Windows (CRLF) and on Linux/macOS (LF): a map reviewed on one system showed as stale on the other.
  Text is now normalized to LF before hashing (files containing a NUL byte are treated as binary
  and hashed as is). Fingerprints and digests written by earlier versions keep matching as long as
  the content is the same, so upgrading does not mark anything stale. The local fingerprint cache
  (`.source-fingerprints.json`) moves to format 2; the old one is discarded and rebuilt.

## [2.0.0] — 2026-10-08

First public release. The code is the same as 1.23.0; what changes is where it lives and under what
terms.

### Changed

- **Open source under the MIT License.** The previous proprietary license is gone.
- **New repository: `fcoluiz/context-tools`.** The name no longer implies a single agent. The setup
  utility, launchers and both marketplaces point at the new address.
- **Marketplaces renamed.** Claude: `context-tools` (was `luiz-context-tools`); Codex:
  `context-tools-codex` (was `context-tools-team`). The plugin is now installed as
  `context-tools@context-tools` on Claude.
- **The documented Claude marketplace command works.** It used `--ref vX.Y.Z`, which the Claude CLI
  rejects; the tag now goes in the source, `fcoluiz/context-tools@vX.Y.Z`, as the setup utility
  already did.
- **The README is a short front page**; the complete reference moved to `docs/reference.md` and
  `docs/reference.pt-BR.md`. Benchmarks moved to `docs/benchmarks/`, anonymized.
- **The controlled benchmark reads its gold set from a file** (`--cases=<file>`, default
  `docs/benchmarks/cases.local.json`, ignored by git) instead of carrying it in the source. An
  example that runs against this repository is in `docs/benchmarks/cases.example.json`.

### Fixed

- **State files that could end up in `git status`.** `.claude/.gitignore`, which the installer
  replicates into every project, did not cover `.context-maps-session-notice.json`,
  `.documentation-session-notice.json`, `.codex-auto-review-state.json`, `.session-write-journal/`,
  or the `*.tmp`/`*.lock` files written during atomic updates.
- **The `.sh` and `.command` launchers were not executable** in the repository, so a macOS
  double-click on `setup.command` failed.

### Added

- `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and pull request templates, and Dependabot for the
  GitHub Actions versions.
- The guided setup warns when the pre-2.0 marketplace is still configured, with the exact command
  to remove it, so hooks do not run twice.

### Migrating from 1.x

Remove the old marketplace and install from the new one:

```bash
claude plugin marketplace remove luiz-context-tools --scope project
claude plugin marketplace add fcoluiz/context-tools@v2.0.0 --scope project
claude plugin install context-tools@context-tools --scope project

codex plugin marketplace remove context-tools-team
codex plugin marketplace add fcoluiz/context-tools --ref v2.0.0
```

Earlier entries mention commit hashes from the private development history; those commits are not
part of this repository.

## [1.23.0] — 2026-10-07

### Changed

- Diário do Codex por último autor confirmado, turno e época de abertura. Sessões antigas e
  reverts não recuperam autoria; edições sobrepostas ficam sem atribuição presumida.
- Fila por documento e revisão exata, independente de prompt, ordem e tamanho dos lotes.
  Conclusão exige evidência; silêncio não resolve itens e pendências incompletas ficam adiadas.
- `review.mjs` consulta, confirma por revisão, adia e permite nova tentativa solicitada.
  Helper preserva encoding e revalida fontes, referências e documento antes da gravação mecânica.
- Digest com fingerprints completos é sincronizado offline. Prompts usam itens completos e
  referência CLI para manifestos extensos, sem cortar JSON.
- Políticas live/historical/manual, fontes explícitas e dependências por rótulos exatos do outline.
  Escopos inválidos ou sem suporte voltam à verificação do arquivo e aparecem na saúde.
- Stop sem fontes atribuídas termina antes da varredura; coletores compartilham cache de hash.
  Telemetria, candidatos, fingerprints e fila serializam alterações de estado.
- Bash pode declarar alvos com `tracked-edit.mjs`, inclusive extraRepos configurados.
- Setup global não recria standalone. Diagnóstico mostra fila, falhas, ausência de diário e
  confiança de hooks não verificada; habilitação não é prova de confiança.

### Verification

- Cenários de 20 chats, reverts, sobreposição, revisão parcial, escrita ANSI declarada,
  UTF-8/BOM/UTF-16, manifestos extensos e reivindicação concorrente.
  Verificação local Windows não substitui a matriz CI Linux/macOS e Node 18/22.

## [1.22.0] — 2026-10-07

### Changed

- A revisão automática do Codex agora reivindica cada conjunto de achados uma vez por projeto,
  mesmo quando hashes de fontes mudam entre sessões. A reivindicação usa lock atômico, expira após
  90 dias sem recorrência e é removida quando a continuação que a originou conclui sem pendências.

## [1.21.1] — 2026-10-06

### Fixed

- Sincronizada a versão do manifesto `.codex-plugin/plugin.json` com a versão do pacote para que a
  instalação global do Codex anuncie a release correta.

## [1.21.0] — 2026-10-06

### Changed

- O `Stop` Codex agora atribui mapas/documentos aos arquivos observados nos eventos explícitos de
  edição da própria sessão e valida o hash atual antes de revisar. Escritas sem caminho explícito
  seguem no relatório global/manual; o hook não usa o diff compartilhado para adivinhar autoria.
- O `coupling` sem Git no Codex usa a mesma cesta de arquivos atribuídos à sessão.
- Em projetos Codex sem Git, `SessionStart` deixa de enumerar o workspace inteiro para montar um
  snapshot que o `Stop` não usa; o relatório de saúde mostra contagens e limites do diário local.

## [1.20.1] — 2026-10-05

### Fixed

- Corrigida a referência de versão no catálogo do marketplace Codex para que uma instalação pela
  release use a mesma versão indicada pelo plugin.

## [1.20.0] — 2026-10-05

### Added

- Diagnóstico local de por que um arquivo aciona ou não a revisão automática e sugestões de
  cobertura de mapas com base em arquivos que costumam mudar juntos.
- Métricas locais de resultado e tamanho estimado dos prompts de revisão automática, sem registrar
  conteúdo de prompts ou caminhos dos arquivos.

### Changed

- Arquivos sem mapa só entram na revisão automática com evidência de co-mudança ou recorrência entre
  sessões, reduzindo chamadas de modelo sem esconder o backlog da auditoria de saúde.

## [1.19.1] — 2026-10-05

### Fixed

- Atualizado o manifesto de compatibilidade do Codex junto com os demais números de versão; o
  registro global agora acompanha o conteúdo do plugin.

## [1.19.0] — 2026-10-05

### Changed

- Stop automático agora filtra também fontes stale dentro do mesmo mapa ou documento, mantendo
  pendências antigas no relatório global de saúde.
- Preflight do Codex valida o arquivo citado individualmente. Metadados por fonte tornam a revisão
  portátil entre máquinas; mapas legados continuam compatíveis com digest agregado, Git ou mtime.

### Added

- Diagnóstico de baseline de sessão incompleto no `SessionStart` e no relatório local de saúde.
- Benchmark opcional do `UserPromptSubmit`, com p50/p95 para prompts sintéticos, sem salvar prompts,
  caminhos do projeto ou métricas por mensagem.

## [1.18.0] — 2026-10-05

### Changed

- Revisão automática limitada à sessão. Stop revisa somente mapas e documentos ligados aos arquivos alterados desde o início da sessão; o relatório de saúde continua mostrando o backlog global.

### Added

- Preflight offline de mapas no Codex. UserPromptSubmit verifica caminhos ou nomes de arquivos explicitamente citados e só acrescenta contexto quando encontra mapa desatualizado, sem cobertura ou impossível de verificar. Não chama modelo ou rede nem persiste o prompt.
- Baseline sem Git com exclusões. A sessão guarda os caminhos iniciais para detectar arquivos removidos; snapshots acima do limite ficam inconclusivos e não geram revisão automática.

## [1.17.0] — 2026-10-05

### Added

- **Relatório local de saúde.** Resume sinais de uso, respostas emitidas, resultados de consultas
  diretas a `symbols`, pendências documentais e demanda por extensões sem parser, sem guardar termos,
  comandos ou conteúdo dos arquivos.
- **Medição do PreToolUse Bash.** O relatório mede o handler nas buscas por símbolo; um benchmark
  sob demanda compara o processo completo para comando ignorado, regex textual e busca de símbolo.
- **Indicação de seção para revisão documental.** Avisos apontam para seções que citam a fonte
  alterada, sem ocultar pendências quando não existe associação inequívoca.

## [1.16.0] — 2026-10-03

### Changed

- **Revisão offline por conteúdo.** Mapas e documentos passam a comparar SHA-256 das fontes depois
  de um baseline limpo, ignorando `mtime` falso positivo e detectando mudanças que preservam data.
  O aviso traz `source_digest`, gravado pelo agente só depois de conferir as fontes.
- **Menos revisões repetidas no Codex.** O `Stop` envia lotes curtos, prioriza documentação operacional
  e suprime a mesma assinatura por 24h; mudança de conteúdo abre uma nova revisão imediatamente.

## [1.15.1] — 2026-10-03

### Fixed

- **Referências em workspaces multi-repo.** A revisão de documentação agora resolve nomes de
  arquivo para fontes existentes e ignora caminhos candidatos inexistentes em cada `extraRepo`,
  evitando inflar a fila de revisão com falsos arquivos desatualizados.

## [1.15.0] — 2026-10-03

### Changed

- **Revisão automática no Codex.** O hook `Stop` consolida pendências dos mapas de contexto e da
  documentação operacional, inicia uma continuação limitada para revisar e atualizar os arquivos
  com evidência, e volta a sinalizar itens que permanecerem pendentes em tarefas futuras.
- **Detecção persistente de documentação desatualizada.** A auditoria considera referências a fontes
  atuais e compara a última revisão dos documentos com mudanças posteriores nos arquivos citados.

## [1.14.0] — 2026-08-11

### Added

- **Setup guiado unificado.** Novo `setup-claude.mjs` espelha `setup-codex.mjs` para o Claude
  Code, usando `.claude-plugin/marketplace.json` e os comandos `claude plugin marketplace`/
  `claude plugin install`. Novo `setup.mjs` deixa escolher Claude, Codex ou os dois
  (`--target=claude|codex|both`), com detecção automática por `.codex`/`.claude` quando nada é
  informado. Launchers `setup-claude.*` e `setup.*` (bat/ps1/sh/command) somam-se aos
  `setup-codex.*` existentes, que continuam inalterados. `install.mjs` agora grava
  `.claude/context-tools-install.json`, dando ao Claude o mesmo `status`/`doctor` que o Codex já
  tinha.

## [1.13.0] — 2026-08-10

### Added

- **Avisos acionáveis de contexto.** `SessionStart` sinaliza a primeira configuração, ausência
  de mapas, estrutura inicial do `ai-context` e mapas possivelmente desatualizados; `Stop` também
  considera um único arquivo sem cobertura e uma única documentação relacionada, com deduplicação.
- **Hooks Codex no manifesto do plugin.** O setup guiado evita a segunda cópia local dos hooks e
  preserva hooks personalizados do projeto.
- **Instalador observável.** Falhas de autenticação, instalação e dependências agora identificam a
  etapa, o resultado final é explícito, lançadores guiados permanecem abertos e `--dry-run` não
  aciona rede nem instalação.

## [1.12.4] — 2026-08-10

### Added

- **Idioma do `ai-context`.** A instalação guiada pergunta pelo idioma em projetos novos, usa
  português como padrão, preserva índices existentes e aceita `--lang=pt|en`.

## [1.12.3] — 2026-08-10

### Changed

- **Single cross-platform launcher.** The setup launcher now handles both first installation and
  updates, using the local utility when available and falling back to `npx` for a standalone launcher.
  The duplicate `install-context-tools` launchers were removed.

## [1.12.2] — 2026-08-10

### Fixed

- **Manual `extraRepos`.** The guided setup now accepts detected directory numbers and additional
  relative or absolute paths in the same prompt, while preserving existing entries.

## [1.12.1] — 2026-08-10

### Added

- **Guided launchers.** Added Windows `.bat`, PowerShell, Linux `.sh` and macOS `.command`
  launchers for first installation and local setup, all delegating to the same Node.js utility.

## [1.12.0] — 2026-08-10

### Added

- **Cross-platform Codex setup utility.** `setup-codex.mjs` detects the current project, installs or
  updates the Codex marketplace plugin, reports installed/latest versions, diagnoses missing pieces,
  bootstraps local hooks and configures `extraRepos` with confirmation.
- **Automatic project root.** `install-codex.mjs` now uses the current directory when no project path is
  supplied, and the plugin skill can request that bootstrap without asking the user for a filesystem path.
- **Installation marker.** Standalone Codex projects record their installed context-tools version in an
  ignored marker so `status` and `doctor` can identify stale project copies.

### Fixed

- **Windows command execution.** The setup utility invokes npm/Codex batch commands correctly on Windows
  while keeping direct Node, Git, Linux and macOS execution working.

## [1.11.1] — 2026-08-10

### Fixed

- **Codex plugin path selection.** The skill examples now invoke the plugin's `${PLUGIN_ROOT}` scripts
  instead of accidentally requiring a project-local `.codex/scripts/` copy.
- **Codex lifecycle installation.** The Codex manifest no longer advertises unsupported plugin hooks in
  current Codex builds. The standalone installer remains the authoritative project integration and now
  registers the `context-docs` `SessionStart` and `Stop` hooks consistently.
- **Codex documentation.** Installation guidance now distinguishes the skill-only plugin from the
  per-project bootstrap required for automatic lifecycle hooks.

## [1.11.0] — 2026-08-08

### Added

- **Documentação operacional `ai-context`.** O plugin inicializa uma estrutura padrão em
  projetos novos, respeita layouts fixos em português ou inglês, consulta os documentos como
  evidência no `context-pack` e sugere revisão/criação no hook `Stop`, sem inventar conteúdo ou
  sobrescrever documentos existentes.
- **CLI `context-docs`.** Adicionados comandos para inicializar, criar esqueletos, consultar status
  e auditar a documentação operacional, com `documentation.enabled` e `autoInit` opcionais.

## [1.10.0] — 2026-08-08

### Added

- **Codex repo marketplace.** The plugin can now be discovered through `codex plugin marketplace
  add` and installed from `/plugins`, including from a private Git repository with a tag-pinned
  source.
- **Codex plugin hooks packaging.** The Codex manifest explicitly loads its own lifecycle hooks;
  Claude's marketplace and hook manifest remain unchanged.

## [1.9.0] — 2026-08-07

### Added

- **Adaptive pre-tool evidence routing.** Symbol-like searches still try `symbols` first; when
  definitions are ambiguous or span multiple files, the hook adds a bounded `context-pack` with
  budget 800 and escalates to 2.000 only when no definition evidence is returned.
- **Index reuse in evidence packs.** The pre-tool hook reuses the index it already built instead of
  scanning the project a second time before assembling the pack.

## [1.8.0] — 2026-08-07

### Added

- **Bounded evidence packs.** `context-pack.mjs` composes definitions, outlines, context-map
  coverage, textual matches, optional history, and explicit limitations under a caller-supplied
  budget.
- **Unified evidence and local metrics contracts.** Results carry evidence kind, confidence, and
  freshness; bounded local telemetry records outcomes without prompts, file contents, or commands.
- **Optional semantic-provider discovery.** `providers.mjs` detects common language-server
  executables and prints an explicit install plan, but never installs anything automatically.
- **Shared repository snapshots and factual handoff facts.** Index metadata can be reused across
  tools, and handoffs include mechanical transcript facts without inventing interpretation.

### Changed

- **Codex Stop behavior.** Codex no longer receives a context- or time-based Stop warning. Its
  normalized usage metrics remain available in the handoff for analysis.
- **Language capabilities and sanitization.** Parser support is catalogued centrally, historical
  code extensions remain available to coupling/audit scans, and repository-derived display text is
  bounded and sanitized consistently.

## [1.7.4] — 2026-08-07

### Fixed

- **Standalone installations remain rooted in their own project without Git.** A stale or invalid
  `.git` no longer makes the resolver climb into a larger workspace just because another child
  repository is valid.

## [1.7.3] — 2026-08-07

### Fixed

- **Git detection now validates the repository instead of trusting `.git` alone.** Empty or
  corrupted `.git` metadata, and projects where Git is unavailable, now use the no-Git fallback
  instead of being classified as broken Git repositories. This keeps file-based scans working in
  projects such as AppServer with stale `.git` metadata.

## [1.7.2] — 2026-08-07

### Fixed

- **Codex hooks now honor the event workspace.** The adapter passes the event's `cwd` as the
  explicit project root, preventing a git-less project nested in a larger workspace from writing
  baselines and scanning maps in the parent directory. Claude's existing `CLAUDE_PROJECT_DIR`
  behavior is unchanged.

## [1.7.1] — 2026-08-07

### Fixed

- **The project root is retained with explicit `extraRepos`.** A git-less root could disappear
  from `symbols`, `audit-docs`, and other file-based scans when sibling repositories were configured;
  only the siblings remained indexed. The root is now kept automatically for both Claude and Codex,
  while mixed workspaces with Git repositories below the root keep their existing scope behavior.

## [1.7.0] — 2026-08-06

### Added

- **Codex session metrics adapter.** Codex transcripts are normalized without applying Claude's
  measured context-cost curve. Input, cached input, output, model window, rate-limit data, and
  compactions remain available for future reporting.

### Changed

- **Codex long-session behavior.** The `Stop` hook suggests a fresh session after six hours and
  prepares the same two-phase handoff/prompt flow. It does not issue the Claude-specific 200k
  context warning or claim a fixed Codex cost multiplier. Claude behavior is unchanged.
- **Instruction-file hints are now host- and project-aware.** `AGENTS.md` and `CLAUDE.md` hints
  observe the document language when no explicit language is configured, state that the project's
  existing rules remain authoritative, use host-correct navigation paths, and preserve the file's
  original encoding and line endings when appending the one-time block.

## [1.6.1] — 2026-08-06

### Fixed

- **The source repository no longer versions standalone installer copies.** Generated `.claude/`,
  `.codex/`, and `.agents/` paths are ignored at the repository root, while the source remains in
  `scripts/` and `skills/`.
- **Claude and Codex markdown hints now share one implementation.** Their host-specific wrappers
  keep the target file, marker, text, and opt-out behavior; idempotency and state writes live in
  `scripts/lib/md-hint.mjs`.

## [1.6.0] — 2026-08-06

### Added

- **Codex support alongside Claude Code.** The shared core now has a Codex plugin manifest,
  project hooks, a portable hook adapter, and a standalone installer. Installing both hosts keeps
  their hook adapters, configuration, and generated runtime state isolated.
- **Cross-platform standalone hooks.** Codex project hooks use a relative Node command and no
  shell-specific or Git-specific path discovery. The installer also migrates older Codex hook paths
  without duplicating entries.

### Fixed

- **Windows path handling in the test and runtime boundary.** Filesystem paths are converted from
  file URLs before use, preventing encoded spaces and false failures on Windows.
- **Host-specific state and configuration.** Claude keeps its existing `.claude/` behavior while
  Codex uses `.codex/`, without one host overwriting the other's generated state or config.
- **Context-map documentation.** Maps now describe both host layouts and the shared `.claude/context/`
  documentation directory; the release also revalidates all maps against the code.

## [1.5.2] — 2026-08-06

### Fixed

- **Qualified symbol search (`Class.Method`) now matches the index.** `bareName` already stripped
  the class prefix when indexing Pascal (`procedure TExporter.RegistroABC` → indexed as
  `RegistroABC`), but the query side tested the regex against the original, prefixed query —
  which never appears in any indexed name, so a qualified search silently returned no hits even
  when the definition existed. The strip is now a single shared constant (`QUALIFICADOR_RE`)
  applied on both the indexing and the query side, so they can't drift apart again. No change for
  unqualified searches.

## [1.5.1] — 2026-08-05

### Added

- **`extraRepos` derives itself from a VS Code `.code-workspace` file** (in the root or its
  parent) when nothing is configured by hand. Anyone already using a multi-root VS Code workspace
  has already curated exactly this list once; repeating that decision in a second, hand-edited
  config file was pure friction and one more place to go stale. An explicit `extraRepos: []`
  turns the auto-detection off.

## [1.5.0] — 2026-08-05

### Added

- **`extraRepos`** declares a sibling repo explicitly in `.claude/context-tools.json`, for when
  neither the mixed-workspace fallback above nor reopening the session at the parent folder is an
  option — real case: the session has to stay rooted at one specific project because the parent
  folder holds dozens of unrelated ones, but a git-less sibling dependency still needs to be
  indexed. The opposite of `sourceDirs`, which always refuses to leave the project: here, leaving
  is the point, bounded to the subtree of the root's own parent folder (`../neighbor` is accepted,
  `../../deeper` is refused). Wired into every `requireGit: false` consumer (`symbols`, `coupling`,
  `audit-docs`, `context-maps`); left out of `why`/`handoff`, which only make sense with real git
  history that `extraRepos` doesn't promise.

## [1.4.0] — 2026-08-05

Every change below traces back to a real usage report from a third-party project (a large Delphi
codebase), not a synthetic test case.

### Added

- **No-git fallback across the plugin.** Projects with no `.git` anywhere were nearly inert —
  `coupling`, `why`, and the context-map hooks depended entirely on git history. `context-maps.mjs`
  now uses file mtime as a weaker but real signal (`mtimeChangedSince`, `listTouchedSourceFilesMtime`,
  `sessionStartedAt`), and every message it emits says explicitly that mtime is weaker than git and
  suggests a local `git init`. `coupling.mjs` also learns without git: the co-change "basket" becomes
  the whole session (every file touched between `SessionStart` and `Stop`) instead of a commit,
  persisted in `.claude/.coupling-sessions.json` and pruned by age (~400 days) and count (1000). A
  new `minSessions` threshold (default 5) distinguishes "not enough data yet" from "measured, no
  coupling found" — they are different claims and only one has real measurement behind it. `why.mjs`
  still refuses outright: there is no substitute for git history when the question is "why is this
  line the way it is."
- **`verified_at` migrates itself from a date to a commit SHA** the moment a no-git project gains
  `.git`. Without this, a context map verified before `git init` stayed "not verifiable" forever, even
  with zero real change — the migration only fires when the same mtime check that applied before
  `git init` confirms nothing changed since that date; it never rewrites just because the repo now has
  git.
- **Every `symbols.mjs`/`PreToolUse` response names the repo(s) actually scanned** (`— scope: ...`),
  including on a miss. `findRepos` never climbs from the working root to a sibling folder — the same
  boundary that closed the `sourceDirs: "../neighbor"` path-traversal bug — so a hit from the wrong
  module used to look exactly like the right answer, with no way to tell from the response alone. This
  does not widen the index; it makes the existing boundary visible.
- **A same-file "similar name" hint rides along with every symbol hit**, based on longest shared
  name prefix. Measured across two unrelated real codebases before shipping (this plugin's own
  Node/JS, and an unrelated React/TS project) to check the signal generalizes rather than fitting one
  naming convention: a 4-5 character prefix floor caught up to 62% of symbols with 9-23 "siblings" on
  average — noise, not signal; 6+ characters settles into small, coherent groups (`analyze` /
  `analyzeSessions`, `Accordion` / `AccordionTrigger` / `AccordionContent`) with zero language-specific
  logic. Capped at 5, with the remainder counted.
- **`claude-md-hint`** appends a short, one-time note to an existing project `CLAUDE.md` suggesting
  `context-tools` be tried before spawning a broad exploration subagent for "where is X defined"
  questions. It exists because an agent tends to delegate open-ended search to a subagent by default,
  and a subagent's synthesis can drop information even though `PreToolUse` fires inside subagents too
  — the project's own instructions are the only lever that changes the decision before it's made. Only
  appends to a `CLAUDE.md` that already exists, never creates one; opt out with `claudeMdHint: false`.

### Fixed

- **`findRepos` silently dropped a folder without its own `.git`** whenever any other folder in the
  same git-less workspace had one. The fallback that treats an entire git-less tree as one project only
  fired when *no* subfolder anywhere had `.git` — so a single git-tracked project sitting next to
  several un-versioned sibling folders erased every sibling from the scan. Real case: one Delphi
  project with `.git` and three sibling dependency folders without, all invisible to the symbol index
  even after pointing the session root at their common parent.
- **`outline.mjs`'s filter rejected `(?i)`/`(?-i)`** (Python/PCRE inline-flag syntax, invalid in a JS
  `RegExp`) as "invalid pattern," even though the filter is already case-insensitive by default and the
  prefix was always redundant when present. It's stripped before the pattern reaches `RegExp` now.

## [1.3.1] — 2026-08-04

Patch release. No new tools; it restores behavior the manifest always intended to ship and closes
four instances of the same defect.

### Fixed

- **Installing as a plugin delivered only half the hooks.** `hooks/hooks.json` was missing
  `handoff.mjs --stop-report` and the entire `PreToolUse` entry, so the recommended installation
  path silently shipped without the expensive-session warning, without a generated handoff, and
  without the plugin's only push point. `install.mjs` now derives the hook list from the manifest
  instead of repeating it.
- **The "unmapped code" warning was inert in Python and Go projects.** The extension list was
  hand-copied in `context-maps.mjs` and had drifted from the index's single source. It was the
  second time the same copy caused the same failure — Delphi and Rust had been blind before. The
  copy was deleted rather than patched.
- **Inside a git worktree, the entire session-cost block was dead.** The transcript folder encoding
  did not convert `.`, and every worktree path contains `.claude/worktrees/`, so the split verdict,
  the `Stop` warning, and the handoff metrics all failed silently.
- **The installed `.gitignore` was missing three state files**, so a generated handoff could be
  committed by accident. The list now derives from this repository's own `.claude/.gitignore`.
- **The default map filter was blind to `.test.mjs`** — the ESM convention, including this
  repository's own — so test files were reported as unmapped every session.
- **The first session after installing accused the plugin's own scripts** of having no context map:
  11 of the 12 files listed were the plugin's. Found by the first cold install anyone had run.
- **Symbol attribution in the handoff was noisy.** Labels called every `const X = someCall(…)` a
  function, and a top-level helper followed by unindexed statements absorbed hundreds of lines,
  causing the wrong symbol to be reported as touched.
- **`comandoDoPlugin` guessed between two layouts** and printed a path that did not exist in a
  repository whose hooks point at its own `scripts/`.

### Added

- **The `Stop` hook hands over the paste-ready resume prompt by itself**, once the handoff's
  volatile block has been filled in. It cannot do so alongside the warning: at that moment the block
  has just been generated empty, and that block is what makes the prompt worth pasting.
- **Context maps are now audited** by `audit-docs`. They were the only documents in the project
  nobody checked; turning it on immediately found a map citing a guard that had been renamed.
- **Test cases are indexed** (`test`/`it`/`describe` at column 0) as a second-class symbol kind,
  which also shrinks the absorbed line ranges that caused the attribution bug above.
- Three new context maps covering the session-cost area, the Grep pre-emption hook, and `why`.

### Changed

- CI actions bumped to `@v5` (Node 20 runtime deprecation). The Node 18/22 matrix is unchanged.
- Measurement provenance is anonymized throughout; every number is preserved.

### Documentation

- The README is now canonical in English; the Portuguese version is a dated translation.
- **Hypothesis tested and discarded:** prefix rewrites are *not* auto-compaction events — 243
  rewrites across 57 sessions against 4 declared compactions across 2. Comparing the *cost* of
  splitting versus compacting remains inconclusive, and says so.

## [1.3.0] — 2026-08-04

### Added

- **`handoff`** — the largest measured cost lever is not a tool at all: cost per message grows 3.4×
  with session size. A `Stop` hook warns once when context crosses 200k and leaves the handoff ready
  on disk, with the volatile block deliberately blank.
- **Split verdict at `SessionStart`** — says whether the previous session split won, tied, or lost.
- **`--prompt`** returns the handoff as text to paste into a fresh session, preferring the saved file
  so a just-filled volatile block is never erased.
- **`why`** — the only tool that asks about decisions rather than state, using `git log -L` over the
  symbol's line range.
- **`PreToolUse` on Grep** — the plugin's only push point, validated retroactively against 649
  historical Greps.
- **First-level configuration keys** enter the index, ranked below real symbols.

### Fixed

- The handoff attributed pre-existing working-tree dirt to the current session.
- The session baseline was never written in a project without a `.claude/` folder.
- Plugin and package versions had diverged (1.2.0 × 1.1.0).

### Documentation

- The token saving was **corrected from "20%" to 1–3%** — the original figure was an
  order-of-magnitude denominator error, and the correction is kept on the record.

## [1.2.0]

Released only in `plugin.json`; the version numbers had drifted apart and were reconciled in 1.3.0.

## [1.1.0]

### Added

- **i18n**, defaulting to English, with detection from `LC_ALL`/`LANG`.
- **Two-phase documentation audit**, cutting a real corpus from 12.9 s to 6.9 s at the same result.
- **Filesystem clock probe** — the cache is refused when mtime granularity is too coarse to trust.
- **Rust and Delphi/Pascal parsers**; per-repository automatic cache tiering; operation without git.
- CI across 3 operating systems × Node 18–24.

### Fixed

- **Security:** arbitrary file write via a hostile `verified_at`, path traversal via `sourceDirs`,
  context flooding, and control/ANSI characters reaching the model's context.
- **Pascal block comments became ghost symbols** — 168 of them in a 1,164-file corpus, with 84 names
  that existed only inside comments.
- Index coverage bugs found by running against third-party repositories.

## [1.0.0]

First release: `symbols`, `outline`, `coupling`, `audit-docs`, the context-map system with
`verified_at`, and the `SessionStart`/`Stop` hooks.
