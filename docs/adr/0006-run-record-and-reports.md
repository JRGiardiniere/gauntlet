# Run record & Dossier: the run directory is the history

Provenance on the old repo settled this ticket's biggest question before
design started: its two cross-run aggregate logs (`log.jsonl`,
`subjective-corpus.jsonl`) were appended on every run and **never read by any
script** — "how did model X do?" was answered by eyeballing files. And the
bench suite consumed exactly one thing from real runs: invocation usage
records. The rewrite therefore keeps the data and deletes the infrastructure.

## The run directory

```
~/.gauntlet/runs/<run-id>/
  plan.json          # frozen ReviewPlan: recipe seats, lens texts, target diff
  finder-stage.json  # every Finder outcome, write-only (ADR 0003)
  dossier.json       # machine-readable Dossier side artifact
  dossier.md         # human-readable Dossier
  receipt.json       # DeliveryReceipt, when delivery was attempted
  run.log            # in-flight Effect log; full transcripts at debug level
```

The old repo's 14-file zoo (`job/status/frozen-preset/request/scope/
candidates/result/handoff/presentation` + per-stage logs) dissolves into
plan + Finder-stage artifact + Dossier: most of it was inter-stage plumbing,
and `status.json` existed only for launchd-era polling. Plain JSON files, one
per thing — **no JSONL anywhere**, each written by sibling-temp-and-rename.
`finder-stage.json` records the completed Finder stage for whoever reads the
directory; nothing reads it back. Pool, Verification, and Judgment have no
intermediate files.

`dossier.md` is written last: a run directory without it is a Run that never
finished. `dossier.json` is an additive machine-readable artifact.

## No aggregate store

No log.jsonl, no corpus file, no SQLite, no index. The run directories are
the history: each is schema-stable and self-contained, carrying strictly more
than the old aggregate lines did (seats, lens texts, per-invocation usage,
verdicts). "Bench later" means a ~20-line script that globs `runs/*/` and
decodes `plan.json`, `finder-stage.json`, and `dossier.json` — written the day
a reader actually exists.

## No cost governance

Cost is an output read afterward, never an input constrained proactively.
This amends ADR 0005 and CONTEXT.md: **a Recipe has no cost governance** — no
budget fields, no dollar ceilings, no token budgets, no spend warnings, and
"budgets" leaves the ReviewPlan's field list. Seat assignment and Lens
selection remain review policy, not cost governance. What survives is not cost
control: #7's per-lens candidate caps and corrective-turn limits are
output-volume and runaway protections and stay where #7 put them.

Accounting is modular by construction: persisted Finder outcomes carry raw
usage exactly as the harness reports it — input/output tokens, cache
read/write, cost, duration — unaggregated. Accounting describes the Run's own
invocations, not an earlier Run that never finished. Derived totals live
durably in the Dossier header
(`cost $0.84 · 12 invocations · 6m 10s`). The run's stdout digest
repeats the wall time but not the cost (#146: the digest reaches agents and
people, and cost is a debugging figure), and is not another accounting store.
Live stderr may echo the duration already present on an AgentOutcome, plus
stage wall time, as progress narration. Any future cost model is a script over run
artifacts.

Finder cache health is another derived Run-accounting view over those completed
outcomes. It reconstructs the frozen Finder partitions only to exclude each
starter, then aggregates every eligible follower across the Run using only its
first raw usage row. Low reuse is a soft `dossier.md` note (out of the digest
since #138), never Dossier
semantics, coverage, a warning on the ReviewTarget, or another persisted
artifact.

Finder tool health is the same kind of view over each outcome's inspection
tool call counts (emit excluded). The Dossier records the counts whenever any
were made; the digest carries the line only for a cascade (half or more of
four-plus calls errored), since a dead tool degrades every finding silently.

## The human-readable Dossier

`dossier.md` is rendered deterministically from the machine-readable Dossier,
frozen ReviewPlan header facts, and derived Run accounting. Consumer
(#10): the agent opens it to act on a finding; the human reads it for the whole
story. Both files are representations of the same Dossier, not separate domain
objects.

- Header: target identity, recipe + seats, runnable lens list with seats,
  the one cost/duration line, coverage gaps, and one skipped line when the
  selected `spec-conformance` Lens had no ReviewSpecification.
- Optional Run notes: low run-wide Finder cache reuse (omitted when the
  soft-warning threshold is not met) and Finder tool call counts (omitted only
  when no Finder called a tool), both derived from completed Finder outcomes.
- Findings: one P1-to-P3 work queue of Confirmed BugClaims and kept
  Observations, tagged `[confirmed]` / `[judgment]`, with Confirmed first inside
  a priority.
- Unresolved: Plausible BugClaims and undecided Observations, retaining their
  `[plausible]` / `[undecided]` tags and evidence when available.
- Rejected: separate Refuted Claims and Dropped Observations subsections,
  retaining `[refuted]` / `[dropped]` tags, verifier evidence, and judge reasons.

## In-flight logging

`Effect.log*` → one `run.log` per run (`Logger.toFile`), plus the #10 stderr
progress lines. Stages are spans in one process — no per-stage log files, no
subprocess stderr capture. Ordinary runs do not read or persist agent
transcripts. With the existing global `--log-level debug` flag, invocation
teardown writes Pi's complete in-memory session entries to `run.log` before
disposing the session, including prompts, model messages, tool calls, and tool
results. This is an opt-in diagnostic view, not a second transcript artifact or
a new retention system. Contract failures also log the exact decoder issue and
raw validated emit payload. Tracing stays gated off by default (#2).

## Retention and size

None. The old tree measured ~4.7MB after ~100 runs, and the one fat file
(`request.json`, 391KB of diff text duplicated beside `scope.diff`) was
plumbing this design deletes — the diff is stored exactly once, frozen with
the plan. At ~50KB/run, a thousand runs is ~50MB; delete old run dirs by hand
if it ever annoys. No pruning code, no compression, no TTL.

## Consequences

- Jettisoned: aggregate JSONL logs, the subjective corpus, any SQLite/index,
  retention machinery, default or dedicated transcript persistence, per-stage
  log files, budget fields and all proactive cost constraints.
- ADR 0005 and CONTEXT.md (Recipe, ReviewPlan) amended: seats only, no
  budgets.
- Retrospective model assessment is a deferred reader over run dirs, never a
  live writer obligation.
