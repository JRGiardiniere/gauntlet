# Durability uses one completed Finder-stage checkpoint; no conversation resume or detachment

Gauntlet's durability requirement is narrow: a crashed or interrupted Run,
re-run, may continue only from a completed semantic checkpoint. An active model
conversation cannot be resumed, and completed siblings from a partial fan-out
are not a coherent stage result.

A Run owns frozen inputs. `review --resume` continues that exact Run: it never
changes its target and never silently starts another review. The resumed Run
reads its target, diff, ReviewSpecification, Lens text, and Seats from
`plan.json` — the live repository, GitHub, and Linear are never consulted
again. Shared prompts, schemas, tools, deadlines, and pipeline code still come
from the currently installed application.

`/repo` is likewise reconstructed from frozen inputs: a detached worktree at
the saved head commit, plus — for a WorkingTree target — one
`workspace-overlay.patch` replayed with `git apply`. Git already retains every
committed byte under that commit, so the overlay persists only what Git cannot
reconstruct: the tracked edits and included untracked files present at
submission. It is captured beside the target and applied by the same code path
on a fresh review, so resume exercises nothing that ordinary runs do not. It is
a distinct artifact from `plan.target.diff`, which remains the single stored
copy of the review diff supplied to agents. Nothing else about the repository
is stored: no snapshot store, hidden refs, synthetic commits, bundles, or GC
protection.

A required frozen input that cannot be reconstructed — a head commit no longer
in the object store, a missing or corrupt overlay — fails the Run with a
message naming it, before any paid work. Gauntlet never fetches, re-resolves,
falls back to current state, or starts a replacement review.

The sole intermediate checkpoint is `finder-stage.json`: one ordered,
schema-validated record of every Finder outcome from the Finder-stage attempt
that produced them. It is written atomically by temp file plus rename only
after the complete fan-out returns. Missing, corrupt, foreign-run, or
incomplete stage state reruns every Finder from scratch; resume never combines
individual Finder outcomes or provider conversations across attempts.

Pool, Verification, and Judgment are never persisted as intermediate
checkpoints. After a valid Finder checkpoint they always rerun as whole stages,
followed by deterministic Assembly and presentation. A complete Dossier is
terminal: resume reads the existing artifacts and does not re-enter the
pipeline — no repository, target, prompt, or external-source work at all. No
active model conversation or partial fan-out is resumed.

Effect's durable-execution stack (`effect/unstable/workflow` + `cluster` +
SQLite) was researched (#3) and rejected: the local single-runner + SQLite path
has an open `database is locked` bug (Effect-TS/effect#6176), a shutdown
deadlock was fixed mid-beta, the on-disk schema is framework-private and
unversioned, and `unstable/*` is exempt from semver with releases every 2–4
days. For a tool whose durability exists to preserve completed semantic work,
storing checkpoints in an opaque, unstable format is the decisive argument
against. `PersistedCache` was also rejected: its filesystem backend is
non-atomic, which converts a crash mid-write into an ambiguous checkpoint.

Artifact validity is deliberately thin: schema decode, a matching `runId`, and
the exact planned Finder-key set. Run directories already isolate runs from
each other; checksums and content hashes are rejected as protection against
events that do not happen to a personal tool.

**Detachment is out entirely.** No launchd, no OS supervisor, no attached
waiter, no self-detached child process. The CLI process owns the Run start to
finish; a killed run is recovered by running it again. Callers that want
backgrounding use their own shell/harness.

## Consequences

- The Finder fan-out is all-or-nothing for resume. A process interrupted before
  the atomic checkpoint reruns every Finder and cannot reuse downstream
  artifacts derived from another Finder attempt.
- Dossier accounting includes the completed Finder-stage attempt whose outputs
  it consumes. It is not a provider billing ledger for abandoned processes;
  an in-flight process can die before final usage exists at all.
- An adapter-contract violation (including undecodable usage) cannot produce
  an honest metered `AgentOutcome`; it fails the attempt before a completed
  Finder checkpoint exists.
- Pool, Verification, and Judgment have no resume artifacts: each reruns as a
  whole stage after the Finder checkpoint.
- Resuming a Run whose repository has since moved on reviews the original
  change, not the current one. Reviewing newer work is a fresh `review`.
- The run directory holds the uncommitted bytes of a WorkingTree review for as
  long as it is retained.
- Artifacts are Gauntlet's own schemas, human-readable with `cat`; invalid
  checkpoint content degrades to "stage not completed," never adopted output.
- Revisit Effect workflows only if v4's workflow stack stabilizes and a
  long-lived worker or suspend-and-resume-later requirement actually appears.
- The persisted Finder checkpoint retains each full AgentOutcome (the
  Exit-as-data shape from ADR 0001), never just success payloads.
