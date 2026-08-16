# Durability is a hand-rolled artifact journal of per-invocation files; no detachment

Gauntlet's durability requirement is narrow: a crashed or interrupted Run,
re-run while the ReviewTarget is byte-identical, must reuse completed paid
work and never repay a finished model call. Resume is crash recovery, not
time travel — "the process died minutes ago, pick it up." A changed target
is the staleness detector: resume reports that it is unavailable and starts
a new review; the abandoned run directory stays under existing retention.
Shared prompts, schemas, tools, deadlines, and pipeline code come from the
currently installed application. We decided the mechanism is a **hand-rolled
artifact journal**: every AgentInvocation writes its AgentOutcome as one
plain JSON file in the run directory (temp file + rename, so a write cannot
half-happen), and the journal doubles as the inter-stage protocol — the next
stage's input *is* the previous stage's files. Resume is one loop: for each
invocation the frozen ReviewPlan enumerates, a file that decodes and carries
this Run's `runId` is reused; anything else re-runs. Deterministic stages
(Assembly, presentation) are free to re-run and are never treated as paid
work.

Effect's durable-execution stack (`effect/unstable/workflow` + `cluster` +
SQLite) was researched (#3) and rejected: the local single-runner + SQLite path
has an open `database is locked` bug (Effect-TS/effect#6176), a shutdown
deadlock was fixed mid-beta, the on-disk schema is framework-private and
unversioned, and `unstable/*` is exempt from semver with releases every 2–4
days. For a tool whose durability exists to protect money already spent,
storing that evidence in an opaque, unstable format is the decisive argument
against. `PersistedCache` was also rejected: its filesystem backend is
non-atomic, which converts a crash mid-write into exactly the repaid call this
ADR exists to prevent.

Artifact validity is deliberately thin: schema decode + a `runId` field checked
on load. Run directories already isolate runs from each other; checksums,
content hashes, and cross-artifact consistency assertions are rejected as
protection against events that do not happen to a personal tool.

**Detachment is out entirely.** No launchd, no OS supervisor, no attached
waiter, no self-detached child process. The CLI process owns the Run start to
finish; a killed run is recovered by running it again (resume makes that
cheap). Callers that want backgrounding use their own shell/harness.

## Consequences

- One file per finder/verifier/judge invocation, not one per stage — a dead
  lens on resume repays only itself, never its siblings.
- Finder cache preloads also receive one file per paid attempt. Resume never
  reuses them as cache state and writes a new sequenced preload artifact, so
  rewarming preserves rather than overwrites the historical cost evidence;
  final accounting reads the full valid sequence.
- Artifacts are Gauntlet's own schemas, human-readable with `cat`; a corrupt or
  foreign file degrades to "not done yet", never to adopted output.
- The two known baseline defects are requirements on the port: the scope
  stage's writes become atomic, and journal appends land after (or idempotent
  with) the receipt they describe.
- Revisit Effect workflows only if: v4 goes stable with `workflow`/`cluster`
  out of `unstable/` and #6176 closed, suspend-and-resume-later becomes a real
  requirement, or a long-lived worker process is wanted for other reasons.
- The vocabulary graft stands regardless: the idempotency unit is the
  invocation with a stable key from the plan, and the persisted value is the
  full AgentOutcome (the Exit-as-data shape from ADR 0001), never just the
  success payload.
