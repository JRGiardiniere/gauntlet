# Durability uses completed semantic checkpoints; no conversation resume or detachment

Gauntlet's durability requirement is narrow: a crashed or interrupted Run,
re-run while the ReviewTarget is byte-identical, may continue only from a
completed semantic checkpoint. An active model conversation cannot be resumed,
and completed siblings from a partial fan-out are not a coherent stage result.
A changed target is the staleness detector: resume reports that it is
unavailable and starts a new review; the abandoned run directory stays under
existing retention. Shared prompts, schemas, tools, deadlines, and pipeline
code come from the currently installed application.

The first checkpoint is `finder-stage.json`: one ordered, schema-validated
record of every Finder outcome plus the preload outcomes from the Finder-stage
attempt that produced them. It is written atomically by temp file plus rename
only after the complete fan-out returns. Missing, corrupt, foreign-run, or
incomplete stage state reruns every Finder from scratch; resume never combines
individual Finder outcomes or provider conversations across attempts. Because
every downstream result depends on the exact Finder output, rejecting the
Finder checkpoint also clears the transitional downstream journal before the
replacement fan-out begins.

Pool, Verification, and Judgment retain the existing per-invocation journal
temporarily. A follow-up decision will apply the same completed-stage rule to
those downstream paths without presuming that each warrants its own durable
checkpoint. Deterministic Assembly and presentation remain free to rerun.

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
  the atomic checkpoint reruns every Finder and every eligible preload, and
  cannot reuse downstream artifacts derived from another Finder attempt.
- Dossier accounting includes the completed Finder-stage attempt whose outputs
  it consumes. It is not a provider billing ledger for abandoned processes;
  an in-flight process can die before final usage exists at all.
- An adapter-contract violation (including undecodable usage) cannot produce
  an honest metered `AgentOutcome`; it fails the attempt before a completed
  Finder checkpoint exists instead of inventing cost or termination data.
- Downstream per-invocation journal reuse is transitional pending its own
  bounded simplification task.
- Artifacts are Gauntlet's own schemas, human-readable with `cat`; invalid
  checkpoint content degrades to "stage not completed," never adopted output.
- Revisit Effect workflows only if v4's workflow stack stabilizes and a
  long-lived worker or suspend-and-resume-later requirement actually appears.
- The persisted Finder checkpoint retains each full AgentOutcome (the
  Exit-as-data shape from ADR 0001), never just success payloads.
