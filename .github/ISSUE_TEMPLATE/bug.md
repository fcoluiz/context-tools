---
name: Bug report
about: A tool answered wrong, or stayed silent when it should have spoken
labels: bug
---

## What you ran

```
node scripts/... 
```

## What came out

```
(paste the output — including the case where nothing came out)
```

## What you expected

## Silent or wrong?

- [ ] It **stayed silent** when it should have said something
- [ ] It **said something wrong** (pointed at the wrong line, claimed something does not exist)

These are different defects: silence usually means a swallowed failure, a wrong answer usually means
a parser or a path assumption.

## Environment

- OS and version:
- Node version (`node -v`):
- Installed as: plugin (`--plugin-dir`) / standalone (`install.mjs`)
- Inside a git worktree, WSL, or a network filesystem? (several bugs here were specific to those)

## If it involves a language parser

A small file that reproduces it is worth more than any description — it becomes the regression test.

```
(the smallest snippet where the symbol is missed or misplaced)
```
