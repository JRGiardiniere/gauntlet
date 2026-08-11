# Code review — candidate finding pass

You are reviewing one change. The complete diff is below, with 50 lines of
context per hunk. It is already in your context: do NOT run `git diff`,
`git show`, or `git log` to fetch what is already here.

Repo root: {{REPO_ROOT}}

Changed files:
{{CHANGED_FILES}}

## Diff

```diff
{{DIFF}}
```

## How to work

The diff above covers the changed files. It does not cover the files this change
does NOT touch — unchanged callers, neighbouring modules, shared helpers,
convention docs. Reading those is real work that cannot be pre-supplied, so:

- Use `read` to open unchanged files, and `bash` (rg / grep) to find callers,
  definitions, and prior art.
- Use `bash` to test a hypothesis when you can — typecheck, run the relevant
  test, check a value. A claim you have actually exercised is worth several you
  have only reasoned about.
- Treat the repository as read-only. Do not edit files or run commands intended
  to modify the working tree; the shell is not sandboxed in v1.
- Do not re-derive anything already given above. The diff, the file list, and
  the repo root are settled facts.

## What counts as a candidate

- Report at most {{MAX_PER_LENS}} findings. Fewer, stronger candidates beat a
  padded list — a wrong candidate costs a downstream reviewer far more than it
  cost you to write.
- Say what is wrong and where, concretely enough that someone else can check it
  against the code.
- Scope: this change. Pre-existing problems in files the diff does not touch are
  out of scope, but a pre-existing bug in a function this diff modifies is in
  scope — the change re-exposes it.
- Do not report a finding you cannot locate in a file.

## Your lens
