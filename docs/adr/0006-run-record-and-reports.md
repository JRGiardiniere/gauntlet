# Run record & Dossier: the run directory is the history

Provenance on the old repo settled this ticket's biggest question before
design started: its two cross-run aggregate logs (`log.jsonl`,
`subjective-corpus.jsonl`) were appended on every run and **never read by any
script** — "how did model X do?" was answered by eyeballing files. And the
bench suite consumed exactly one thing from real runs: the per-invocation
usage records. The rewrite therefore keeps the data and deletes the
infrastructure.

## The run directory

```
~/.gauntlet/runs/<run-id>/
  plan.json          # frozen ReviewPlan: recipe seats, lens texts, target diff
  journal/*.json     # one per AgentInvocation: full AgentOutcome (ADR 0003)
  dossier.json       # complete machine-readable Dossier
  dossier.md         # human-readable Dossier
  receipt.json       # DeliveryReceipt, when delivery was attempted
  run.log            # in-flight Effect log
```

The old repo's 14-file zoo (`job/status/frozen-preset/request/scope/
candidates/result/handoff/presentation` + per-stage logs) dissolves into
plan + journal + dossier: most of it was inter-stage plumbing the journal
already replaces, and `status.json` existed only for launchd-era polling.
Plain JSON files, one per thing — **no JSONL anywhere**: the journal's
one-file-per-invocation atomic writes are what make resume skip-what-exists;
an append-format shared file would reintroduce the partial-write problem
ADR 0003 designed out.

## No aggregate store

No log.jsonl, no corpus file, no SQLite, no index. The run directories are
the history: each is schema-stable and self-contained, carrying strictly more
than the old aggregate lines did (seats, lens texts, per-invocation usage,
verdicts). "Bench later" means a ~20-line script that globs `runs/*/` and
decodes `plan.json` + `dossier.json` + `journal/*.json` — written the day a
reader actually exists.

## No cost governance

Cost is an output read afterward, never an input constrained proactively.
This amends ADR 0005 and CONTEXT.md: **a Recipe has no cost governance** — no
budget fields, no dollar ceilings, no token budgets, no spend warnings, and
"budgets" leaves the ReviewPlan's field list. Seat assignment and Lens
selection remain review policy, not cost governance. What survives is not cost
control: #7's per-lens candidate caps and corrective-turn limits are
output-volume and runaway protections and stay where #7 put them.

Accounting is modular by construction: each journal file carries the raw
usage exactly as the harness reports it — input/output tokens, cache
read/write, cost, duration — per invocation, unaggregated. Derived totals
live in two durable places: one Dossier-header line
(`cost $0.84 · 12 invocations · 6m 10s`) and the digest tally's cost + wall
time. Live stderr may echo duration and cost already present on an
AgentOutcome, plus stage wall time, as progress narration — not a third
accounting store. Any future cost model is a script over journal files.

## The human-readable Dossier

`dossier.md` is rendered from the machine-readable Dossier alone. Consumer
(#10): the agent opens it to act on a finding; the human reads it for the whole
story. Both files are representations of the same Dossier, not separate domain
objects.

- Header: target identity, recipe + seats, lens list with seats,
  the one cost/duration line, coverage gaps.
- Findings grouped by tier, each with evidence (confirmed BugClaims) or
  keep-reason (kept Observations).
- **Unverified and undecided render in the main findings section**, tagged
  `[unverified]` / `[undecided]`, after confirmed/kept within their tier —
  first-class per #6, not banished to an appendix; an unverified P1 is
  exactly what a human should glance at. The digest already counts them.
- Appendices for refuted claims and judge drops — kept because they cost
  nothing (the data is in the Dossier) and keep dismissed findings
  look-up-able without re-running.

## In-flight logging

`Effect.log*` → one `run.log` per run (`Logger.toFile`), plus the #10 stderr
progress lines. Stages are spans in one process — no per-stage log files, no
subprocess stderr capture. No agent transcript or prompt persistence (the old
repo never had it and the gap never bit); AgentOutcome diagnostics keep the
interesting failures. Tracing stays gated off by default (#2).

## Retention and size

None. The old tree measured ~4.7MB after ~100 runs, and the one fat file
(`request.json`, 391KB of diff text duplicated beside `scope.diff`) was
plumbing this design deletes — the diff is stored exactly once, frozen with
the plan. At ~50KB/run, a thousand runs is ~50MB; delete old run dirs by hand
if it ever annoys. No pruning code, no compression, no TTL.

## Consequences

- Jettisoned: aggregate JSONL logs, the subjective corpus, any SQLite/index,
  retention machinery, transcript persistence, per-stage log files, budget
  fields and all proactive cost constraints.
- ADR 0005 and CONTEXT.md (Recipe, ReviewPlan) amended: seats only, no
  budgets.
- Retrospective model assessment is a deferred reader over run dirs, never a
  live writer obligation.
