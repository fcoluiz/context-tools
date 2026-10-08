# Contributing

The plugin's whole thesis is that a tool which answers confidently and points at the wrong line is
**worse than no tool**. Everything below follows from that.

## License of contributions

This project is released under the [MIT License](LICENSE). By submitting a pull request you agree
that your contribution is licensed under the same terms, and you confirm that it is your own work
and does not include code you are not free to license that way.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) before taking part, and report security issues
privately as described in [SECURITY.md](SECURITY.md) — never in a public issue.

## Running it

```bash
npm test
```

No dependencies, no build, no setup. Tests use `node --test` and need Node 18+. CI runs them on
Linux, macOS and Windows × Node 18 and 22 — path separators and `mtime` granularity differ between
them, and two design decisions depend on exactly that.

To try the tools against this repository itself:

```bash
node scripts/symbols.mjs buildIndex
```

## Three rules that are not style preferences

**1. Fail visibly.** No code path may return empty dressed up as an answer. If a tool did not find
something, it says so and points at Grep. If it *could not look* — git failed, shallow clone — it
says that instead, because the remedy is different. The one exception is hooks, which must never
crash or delay a session: there, any failure becomes a silent exit 0.

**2. Never write `file:line` in documentation.** In a real audit, none of the 13 checked
`symbol @ file:line` references was still correct; the worst was off by 2,861 lines. Cite the symbol.

**3. Any list describing the same fact in two places is a bug waiting for a date.** Four of them
drifted in a single day, and all four failed silently. Derive from a single source, and **prove the
derivation with a test** — a test that repeats the list is just the fifth copy.

## Measuring, and the oracle problem

Numbers in this repository are measured, and each one says where it came from. If you change
something that has a number attached, re-measure it; if you cannot, say so in the text rather than
leaving the old figure standing.

The oracle matters more than the measurement, and picking a weak one has cost this project real
time:

- **For parsers, the reliable oracle is a set diff before × after.** A parallel counter written to
  check the parser tends to contain the same bug it is measuring — that happened, and it reported
  959 ghosts where the real number was 168.
- **For cost, simulate over real transcripts** rather than trusting a theoretical ceiling, and
  always compute **where the gain inverts**, not only where it exists.
- **After writing a test, verify it fails without your fix**, citing the right reason. Several
  changes here were only trustworthy because the reverted-code run failed for the expected cause —
  and one assertion turned out to be wrong that way.

## Adding a language

Four steps, in this order:

1. write the parser in `scripts/outline.mjs` and register the extension in `parserForExt`;
2. add the extension to `EXTENSOES_CODIGO` in `scripts/lib/roots.mjs` — the single source `CODE_RE`
   derives from;
3. teach the new labels to `bareName` in `scripts/symbols.mjs`;
4. change the example extension in the two "unsupported language" tests.

Step 3 is the one that bites: without it the symbol enters the index by its label but a query for the
bare name does not find it — invisible to any parser test, only failing end to end. Step 4 has broken
CI twice.

**A new parser only lands with a real corpus.** Not examples written to pass: production code from a
project that is not yours, with every reported line read raw from the file and verified to contain
the declaration. That is how the Pascal comment bug, Python's docstrings, and Go's grouped blocks
were all found.

## Context maps and operational docs

The tool is developed with its own features turned on: the hooks in `.claude/settings.json` and
`.codex/hooks.json` run from `scripts/`. The context maps (`.claude/context/`) and operational docs
(`ai-context/`) they read are **personal working notes** and are ignored by git in this repository —
create your own if they help you. When you rely on one, remember the rule the tool enforces for
everyone: "up to date" means *has not changed since it was verified*, never *is correct*, and
nothing bumps `verified_at` automatically.

## Pull requests

- Keep each pull request focused on one change, and explain *why* in the description.
- Run `npm test` locally; CI must be green on all three operating systems.
- If behavior visible to users changes, update both READMEs and add an entry to
  [CHANGELOG.md](CHANGELOG.md) under *Unreleased*.
- Do not add dependencies: the project is deliberately built on `node:` builtins only, and CI
  rejects a `package.json` that gains any.
- Never commit measurements, paths or names taken from private codebases. Benchmark gold sets
  live in `*.local.json` files, which git ignores.

## Reporting a bug

The most useful report contains the command you ran, the output you got, and what you expected.
Beyond that, two things are worth more than a description:

- **your OS and Node version** — several bugs here were platform-specific, and one lived only inside
  git worktrees;
- **whether the tool stayed silent or said something wrong.** They are different defects: silence
  usually means a swallowed failure, a wrong answer usually means a parser or a path assumption.

If it involves a language parser, a small file that reproduces it is worth more than everything
else — it becomes the regression test.
