# Security Policy

## Supported versions

Only the latest release receives security fixes. Pin a tag when you install (`@vX.Y.Z` /
`--ref vX.Y.Z`) and update when a new release is published.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/fcoluiz/context-tools/security/advisories/new)
(*Security → Report a vulnerability*). Include:

- the version or commit you tested;
- the command or hook involved and the input that triggers the problem;
- what an attacker gains (file write, command execution, context injection, data leaving the
  repository, …).

You should receive an acknowledgement within 7 days. Fixes are released as a new version and
credited in the [CHANGELOG](CHANGELOG.md) unless you ask to stay anonymous.

## Threat model in short

context-tools runs locally, inside a coding agent's session, with your user's permissions. The
tools and hooks make no network calls and send no telemetry: usage metrics are kept only in a local
state file under `.claude/` or `.codex/` in the project. The only network access comes from the
guided setup, which calls `git ls-remote`, `npm` and the agent's own CLI to install or update the
plugin — and only when you run it.

The main attack surface is **text that comes from the repository being analyzed** (file names,
folder names, frontmatter, git output), which hooks inject into the model's context. In a cloned or
third-party repository that text is untrusted. In scope, for example:

- arbitrary file write or command execution triggered by repository content;
- reading files outside the project root (path traversal, followed links);
- repository content that escapes the "data, not instructions" framing of the injected block, or
  floods the context;
- control or ANSI characters reaching the terminal or the model.

See the *Security* section of the [README](README.md#security) for the classes of issues already
fixed and the defenses in place.
