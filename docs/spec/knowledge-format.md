# Verifiable project knowledge — format v1

**Status:** stable, implemented by context-tools 2.7. **License:** MIT, like the rest of the repository.

This document specifies how a piece of written project knowledge — a *context map* or an *operational
document* — records **which version of which source files it was reviewed against**, so that any
tool, in any language, can tell whether the code under it has changed since. It is deliberately small:
a few fields, SHA-256, plain Markdown. Nothing here requires context-tools.

The format answers one question and only one: *"have the cited sources changed since a human or an
agent last checked this text against them?"* A matching fingerprint never means the text is correct.
Tools implementing this format must not present it as such.

## 1. Two kinds of documents

| kind | where | metadata block |
|---|---|---|
| **context map** | `<repo>/.claude/context/*.md` or `<repo>/.codex/context/*.md` | YAML-like frontmatter between `---` lines |
| **operational document** | `<root>/ai-context/**/*.md` (root configurable) | `key: value` lines anywhere in the body, optionally as list items (`- key: value`) |

Fenced code blocks are ignored when reading operational-document metadata.

## 2. Context map frontmatter

```markdown
---
area: orders
covers:
  - "src/orders/order.ts"
  - "src/orders/queue.ts"
verified_at: 3f2a9c1
verified_date: 2026-10-09
source_fingerprints: {"src/orders/order.ts":"sha256:…","src/orders/queue.ts":"sha256:…"}
source_digest: sha256:…
---
```

| field | required | meaning |
|---|---|---|
| `area` | yes | short name of the area the map describes |
| `covers` | yes | list of source paths, relative to the repository root, `/`-separated |
| `verified_at` | yes | a git commit-ish of the last review, or a date (`YYYY-MM-DD`) in a project without git |
| `verified_date` | no | date of the last review, informational |
| `source_fingerprints` | no | JSON object: covered path → fingerprint (§4). The portable proof of review |
| `source_digest` | no | aggregate fingerprint of all covered sources (§5) |

A map without `area`, `verified_at` or a non-empty `covers` is invalid and must be reported as such.

## 3. Operational document metadata

| key (case-insensitive; aliases) | meaning |
|---|---|
| `last_reviewed` (`Last reviewed`, `Última revisão`) | date of the last review, `YYYY-MM-DD` |
| `source_fingerprints` | JSON object: source id (§4) → fingerprint |
| `source_digest` | aggregate fingerprint (§5) |
| `maintenance` | `live` (default), `historical` (default for decisions) or `manual` — only `live` documents are expected to follow the code |
| `review_sources` | JSON array of paths that are the document's current references, replacing the paths found in its text |
| `review_dependencies` | JSON array of `{"source": path, "symbols": [names]}` narrowing a dependency to named symbols |
| `dependency_fingerprints` | fingerprints of those symbol-scoped dependencies, written by the reviewing tool |
| `confidence` (`Confiabilidade`) | free text, informational |
| `source` (`Primary source`, `Fonte principal`) | free text, informational |

Without `review_sources`, a document's sources are the code paths its text mentions. A document
describing a decision is `historical` unless it declares `maintenance: live`: mentioning code in an
incident report does not oblige anyone to rewrite history.

Placeholders `To map` / `A mapear` mark content that has **not** been confirmed and must never be
treated as knowledge.

## 4. Source fingerprint

```
fingerprint = "sha256:" + lowercase hex SHA-256 of the file's bytes
```

- If the file contains no NUL byte and contains `\r\n`, every `\r\n` is replaced by `\n` **before**
  hashing. The same file then has the same fingerprint on every operating system, whatever
  `core.autocrlf` did. A file with a NUL byte is hashed raw.
- A source that does not exist is recorded as the string `"missing"`.
- **Source id.** In a context map: the path relative to the repository root, `/`-separated. In an
  operational document: `<repository name>/<path>`, where the repository name is `.` for the project
  root (so the id starts with `./`) and the folder name for a sibling repository in a multi-repo
  workspace.

A reader decides, per source: **unchanged** if the recorded fingerprint equals the current one;
**changed** otherwise; **unrecorded** if the id has no entry. Writers should record only the sources
that were actually checked and keep existing entries for the others.

## 5. Aggregate digest

`source_digest` is a convenience: equal digests mean every source is unchanged. It is computed over
the hex hashes **without** the `sha256:` prefix (or `missing`):

```
entries  = [[id, hex-or-"missing"], …] sorted with JavaScript's default Array sort
digest   = "sha256:" + hex SHA-256 of UTF-8 JSON.stringify({ "sources": entries, "markers": [] })
```

Readers must not require the digest: per-source fingerprints are the contract. When both exist and
disagree, per-source fingerprints win.

## 6. Who writes what

- Fingerprints are written **only by a review step that a person or an agent explicitly invokes after
  checking the sources** (`ack` in context-tools). Nothing may update them automatically on a schedule
  or on save: that would turn "reviewed" into "touched".
- The text is written by people and agents. Tools may create structure and templates, never business
  rules.
- File-and-line pointers (a path followed by a colon and a line number) must not be written into
  knowledge documents: line numbers rot in weeks. Cite the symbol; resolve the line when reading.

## 7. Consumers

A conforming consumer can, with only this document:

- warn at the start of a session that a map's covered sources changed since its review;
- fail or annotate a pull request that changes a cited source without recording a new review
  (context-tools: `drift-check.mjs`, GitHub Action at the repository root);
- report the share of verifiable knowledge whose sources are unchanged (context-tools: `health.mjs`).

The JSON Schema for the context-map frontmatter, after parsing, is in
[`knowledge-format.schema.json`](knowledge-format.schema.json).
