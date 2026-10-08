# A Run is not resumable

Gauntlet used to continue an interrupted Run with `gauntlet review --resume
[run-id]`: it reread the frozen `plan.json`, reused a completed
`finder-stage.json`, and reran Pool, Verification, and Judgment. An
architecture review on 2026-10-08 (#158) dropped it. Resume shaped most of the
Run lifecycle's branches (a latest-incomplete lookup, an already-complete fast
path, checkpoint validation, six flag refusals, a foreign-Seat check), its CLI
wording leaked into the Mod, and it was the source of the "already complete"
bug, all for a feature that was rarely used.

**A Run that does not reach its Dossier is started again.** A crash, a
cancel, or a Mod reload ends the Run; the person runs the review again, which
is a new Run in its own directory. Nothing continues a Run, and the only
reader of a finished run directory is `gauntlet deliver`, which posts its
`dossier.md` to the pull request its `plan.json` names.

A Run still owns frozen inputs. Submission writes `plan.json` once, and every
stage reads the target, diff, ReviewSpecification, Lens text, and Seats from
it; the live repository, GitHub, and Linear are consulted only at Submission.
`/repo` is built from those inputs too: a detached worktree at the saved head
commit, plus — for a WorkingTree target — one `workspace-overlay.patch`
applied with `git apply`. Git already retains every committed byte under that
commit, so the overlay persists only the tracked edits and included untracked
files present at submission. It is a distinct artifact from
`plan.target.diff`, which remains the single stored copy of the review diff
supplied to agents. A frozen input that cannot be rebuilt fails the Run with
a message naming it, before any paid work.

`finder-stage.json` remains as a write-only record: one ordered,
schema-validated entry per Finder, each the full AgentOutcome (ADR 0001),
written once the whole fan-out returns. The run directory is the debugger
(ADR 0006, 0007), and a Finder's diagnostics live there rather than in
progress lines. Nothing reads it back. Every Run artifact but the in-flight
`run.log` is written to a sibling temporary file and renamed, never through a
system temp directory, because a cross-device rename fails.

Effect's durable-execution stack (`effect/unstable/workflow` + `cluster` +
SQLite) was researched (#3) and rejected for the old checkpoint: an open
`database is locked` bug on the local single-runner path, a framework-private
unversioned on-disk schema, and `unstable/*` releases every few days.

**Detachment is out entirely.** No launchd, no OS supervisor, no attached
waiter, no self-detached child process. The CLI process (or the Mod's
session) owns the Run start to finish. Callers that want backgrounding use
their own shell or harness.

## Consequences

- An interrupted Run re-pays its Finders and everything after them. A Mod
  reload mid-review loses the review: the Mod stops the orphaned agents,
  removes the snapshot worktree, and says to run `/gauntlet` again.
- Running a review again resolves its target again: if the repository moved
  on, the new Run reviews the newer work.
- An interrupted Run's directory stays behind without a `dossier.md`; there
  is no retention machinery (ADR 0006).
- Dossier accounting covers the Run's own invocations. It is not a billing
  ledger for abandoned Runs.
- The run directory holds the uncommitted bytes of a WorkingTree review for
  as long as it is retained.
- If resume is ever wanted back, it is rebuilt on #159's Run module as "rerun
  a saved plan, skipping Finders whose outcomes are saved": `plan.json` and
  `finder-stage.json` already hold what it would need.
