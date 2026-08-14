# Code review — candidate finding pass

You are reviewing one change. The complete diff is below, with 50 lines of
context per hunk. It is already in your context: do NOT run `git diff`,
`git show`, or `git log` to fetch what is already here.

Repo root: {{REPO_ROOT}}

Changed files:
{{CHANGED_FILES}}

{{DIFF_SECTION}}

## How to work

The diff above covers the changed files. It does not cover the files this change
does NOT touch — unchanged callers, neighbouring modules, shared helpers,
convention docs. Reading those is real work that cannot be pre-supplied, so:

- Use `read` to open unchanged files, and `bash` (rg / grep / find / sed / awk /
  jq, with pipes, redirects, loops, and globs) to find callers, definitions, and
  prior art.
- Your tools see the repository only through a confined workspace rooted at
  {{REPO_ROOT}}. There is no network, no `git`, and no host toolchain: tests,
  builds, typechecks, and package managers are unavailable, so ground every
  claim in code you have actually read. The shell is simulated: a repository
  script may run in it, but its output proves nothing about what real tooling
  would do, and an occasional bash construct may be unsupported and return an
  error — rephrase the command and move on.
- The workspace is writable only as disposable scratch space: your writes are
  visible to your own later tool calls, never reach the real repository, and
  are discarded when you finish.
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
