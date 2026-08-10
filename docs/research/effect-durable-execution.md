# Research: Effect durable-execution options for Gauntlet

- **Ticket:** [#3 — Research: Effect durable-execution options](https://github.com/JRGiardiniere/gauntlet/issues/3) (part of #1)
- **Status:** Research findings. Nothing here is approved architecture.
- **Date:** 2026-08-09
- **Primary ground truth:** installed sources of `effect@4.0.0-beta.90` at
  `/Users/johngiardiniere/projects/cloudflare-hub/node_modules/effect`, the
  `effect@4.0.0-beta.106` tarball from npm, the npm registry, and the existing
  reviewer at `/Users/johngiardiniere/Code Review Agent`.

## The question

Can Effect's durable-execution story give Gauntlet **step-resumable local runs** —
crash or interruption, then re-run resumes from persisted step results and never
repays a completed model call? Secondarily: does any option make **detached** runs
(surviving the invoking agent/terminal) cheap?

## TL;DR

Yes, a real durable-execution story exists in the v4 beta, and it is lighter-weight than
expected — no database server, no daemon, one SQLite file. But it is not ready, and the
answer for Gauntlet today is still "no".

1. **The packages you were told to investigate do not exist for v4.** `@effect/workflow`
   and `@effect/cluster` are v3-only. In v4 they are subpath exports of core `effect`.
2. **`effect/unstable/workflow` + `effect/unstable/cluster` + a local SQLite file is a
   real, working single-process durable-execution option.** `SingleRunner` is explicitly
   built for "local, embedded, or small single-node" use, SQLite is a first-class dialect
   throughout the cluster storage layer, and activity results are stored as `Exit` values
   keyed by `(execution, activityName, attempt)` — replayed on resume, never re-executed.
3. **But that exact path has open, unresolved SQLite-locking bugs**
   ([#6176](https://github.com/Effect-TS/effect/issues/6176), open), Effect's own stated
   position is *"v3 remains our recommended choice for now"*, and `effect/unstable/*` is
   explicitly excluded from semver protection. Betas ship every 2–4 days.
4. **It does not solve detachment.** Nothing in it starts or supervises a process.
   Detachment stays a separate problem with the same shape it has today.
5. **Recommendation: do not adopt it for v1.** Keep the hand-rolled artifact journal
   (with fixes), because the jank is real and the baseline already works. See
   [Recommendation](#recommendation).

---

## What actually exists in the v4 beta

### The standalone packages are v3-only — verify before believing any tutorial

| Package | `latest` | peer `effect` | Verdict for Gauntlet |
| --- | --- | --- | --- |
| `@effect/workflow` | `0.19.1` | `^3.22.1` | **v3 only.** Unusable with v4. |
| `@effect/cluster` | `0.60.2` | `^3.22.1` | **v3 only.** Unusable with v4. |
| `@effect/sql` | `0.52.1` | (v3 line) | **v3 only.** Superseded by `effect/unstable/sql`. |
| `@effect/experimental` | `0.61.1` | (v3 line) | **v3 only.** Persistence moved into core. |

Verified with `npm view <pkg> dist-tags` / `peerDependencies`. Note the trap:
`@effect/cluster@0.60.2` depends on `@effect/workflow@^0.19.1` and `effect@^3.22.1`.
Installing it alongside `effect@4.0.0-beta.x` gets you two Effect runtimes.

**v4 restructured these into core `effect` subpath exports.** From
`effect@4.0.0-beta.90/package.json` `exports`:

```
effect/unstable/workflow      Workflow, Activity, WorkflowEngine, DurableClock,
                              DurableDeferred, DurableQueue, WorkflowProxy(+Server)
effect/unstable/cluster       Sharding, SingleRunner, ClusterWorkflowEngine,
                              MessageStorage, SqlMessageStorage, SqlRunnerStorage,
                              Entity, Singleton, ClusterCron, HttpRunner, ...
effect/unstable/persistence   Persistence, PersistedCache, PersistedQueue,
                              KeyValueStore, Persistable, Redis, RateLimiter
effect/unstable/sql           SqlClient, Statement, Migrator, SqlModel, ...
effect/unstable/process       ChildProcess, ChildProcessSpawner
```

The **drivers** remain separate packages but ship a `beta` dist-tag versioned in
lockstep with core:

```
@effect/sql-sqlite-node   beta -> 4.0.0-beta.106   (also publishes 4.0.0-beta.90)
@effect/platform-node     beta -> 4.0.0-beta.106
```

`@effect/sql-sqlite-node@4.0.0-beta.90` declares `peerDependencies: { effect: "^4.0.0-beta.90" }`
and depends on `better-sqlite3@^12.9.0`. **The peer range is pinned to the exact beta**,
so every core bump forces a synchronized driver bump. That is a maintenance tax, not a
blocker, but it means you cannot upgrade `effect` alone.

### beta.90 vs latest beta (beta.106)

Raw file diffs look alarming — 30 of ~35 `cluster` files and all 8 `workflow` files
differ. But diffing the `.d.ts` files with comment lines stripped shows the **public API
is nearly unchanged** across 16 betas:

| Module | Signature-level change, beta.90 → beta.106 |
| --- | --- |
| `workflow/Workflow` | `import * as Option` → `import type * as Option`. Nothing else. |
| `workflow/Activity` | Type-parameter renaming inside `raceAll`'s conditional type. No behavior change. |
| `workflow/WorkflowEngine` | `WorkflowInstance.initial()` gains an optional `scope?: Scope.Closeable` param. |
| `cluster/ClusterWorkflowEngine` | Requirement set reordered only. |
| `cluster/SingleRunner` | **Breaking:** layer now additionally requires `Crypto.Crypto`. |
| `persistence/*`, `sql/*` | No signature changes in the modules examined. |

New in beta.106: `cluster/internal/shardLock` (internal). The rest of the churn is
docstrings and internals.

**Read carefully — this is a narrower result than it looks.** The *TypeScript surface* is
more stable than the `unstable/` path name implies. The *behavior underneath it is not*.
The published CHANGELOG for the same beta.90 → beta.106 window contains dozens of fixes to
`workflow`, `cluster`, `persistence`, and `sql`, including:

- **PR #7032** — "Fix a `@effect/cluster` shutdown deadlock on **single-runner topologies**
  (e.g. single-node deployments and `TestRunner`), where `Sharding.sendOutgoing` retried
  `EntityNotAssignedToRunner` forever during teardown." That is a hang, in exactly the
  topology Gauntlet would use, fixed inside the window.
- **PR #6618** — the `Crypto.Crypto` requirement above, plus a change flagged as breaking:
  *"This changes the advisory-lock protocol. PostgreSQL clusters using advisory locks
  require a full cluster stop before upgrading; a rolling deploy is unsafe…"*
- Ongoing dependency churn: the July recap records **Node's native SQLite replacing
  `better-sqlite3` in `@effect/sql-sqlite-node`**.

And the stated policy is unambiguous:

> "Modules under `effect/unstable/*` may receive breaking changes in minor releases."
> "Modules outside `unstable/` follow strict semver — no breaking changes until the next
> major version." "As unstable modules mature, they graduate into the top-level `effect/*`
> namespace."
> "**If you're running Effect in production, v3 remains our recommended choice for now.**"
> — [Effect v4 beta announcement](https://www.effect.website/blog/releases/effect/40-beta)

Release cadence in the recent window (GitHub releases): beta.99 2026-07-17 → beta.106
2026-08-08, i.e. **a release every 2–4 days**.

**Caveat that survives all of the above:** stability of the TypeScript surface is not
stability of the *on-disk SQL schema*, which has no versioning at all — see jank below.

---

## Option A — `effect/unstable/workflow` on the in-memory engine

`WorkflowEngine.layerMemory` is the only engine that ships without cluster.

Its own docstring:

> "Layer that provides an in-memory `WorkflowEngine`. **When to use:** Use to run tests
> and local development workflows where durability is not needed. **Gotchas:** This layer
> keeps state only in memory and is not suitable for production workflows that require
> durability."
> — `effect/unstable/workflow/WorkflowEngine.d.ts`

**Verdict: does not answer the question.** Zero resumability across process death. Useful
only as the test double for Option B. Listed here so nobody mistakes `layerMemory` for a
durability story.

---

## Option B — `effect/unstable/cluster` `SingleRunner` + `ClusterWorkflowEngine` + local SQLite

This is the real candidate.

### Shape

```ts
import * as SingleRunner from "effect/unstable/cluster/SingleRunner"
import * as ClusterWorkflowEngine from "effect/unstable/cluster/ClusterWorkflowEngine"
import * as Workflow from "effect/unstable/workflow/Workflow"
import * as Activity from "effect/unstable/workflow/Activity"
import { SqliteClient } from "@effect/sql-sqlite-node"
```

`SingleRunner.layer` is documented for exactly this use case:

> "Single-process cluster layer for durable entities and workflows. It wires `Sharding`
> with no-op runner communication, no-op runner health checks, SQL-backed message storage,
> environment-based sharding configuration, and either SQL-backed or in-memory runner
> storage. This layer is meant for **local, embedded, or small single-node setups** where
> the process handles all cluster work itself. It still requires a SQL client because
> mailbox messages and replies are stored in SQL."
> — `effect/unstable/cluster/SingleRunner.d.ts`

Signature (beta.90):

```ts
export declare const layer: (options?: {
  readonly shardingConfig?: Partial<ShardingConfig["Service"]>
  readonly runnerStorage?: "memory" | "sql"
}) => Layer.Layer<Sharding | Runners | MessageStorage, ConfigError, SqlClient>
// beta.106 adds Crypto.Crypto to the requirements
```

### Storage backend: SQLite is first-class, and DDL is automatic

`SqlMessageStorage.js` and `SqlRunnerStorage.js` both branch on dialect via
`sql.onDialectOrElse({ pg, mysql, orElse: /* sqlite */ })` at every non-portable point —
boolean encoding, `NOW()`, interval arithmetic, upserts, and notably:

```js
const forUpdate = sql.onDialectOrElse({
  sqlite: () => sql.literal(""),
  orElse: () => sql.literal("FOR UPDATE")
})
```

SQLite is not an afterthought; it is a named branch in every dialect switch. Both modules
issue `CREATE TABLE IF NOT EXISTS` (6 statements each) at layer construction, creating
`cluster_messages`, `cluster_replies`, `cluster_runners`, `cluster_locks`. **No separate
migration step is required**, and `runnerStorage: "memory"` drops the runner/lock tables
while keeping message storage in SQL.

**So: one `.sqlite` file in the run directory. No database server, no cluster runtime, no
container, no daemon.** This is the single most important finding in this document, and it
is the one most likely to be wrong in any blog post written against v3.

#### 🚨 …but SQLite + cluster has open, unresolved locking bugs

Two issues on `Effect-TS/effect`, both reported against the v3-line packages
(`effect@3.21.0`, `@effect/cluster@0.58.0`, `@effect/workflow@0.18.0`,
`@effect/sql-sqlite-node@0.52.0`) — but against the *same code*, since v4's cluster is that
code relocated:

- **[#6176](https://github.com/Effect-TS/effect/issues/6176) — OPEN, labelled `bug`:**
  "SQLite-backed workflow storage hits `PersistenceError` / database is locked under
  concurrent runner + client access." Reproduces `SqliteError: database is locked` once a
  separate control-plane process polls or signals the same SQLite-backed store the runner
  owns.
- **[#6179](https://github.com/Effect-TS/effect/issues/6179) — closed as a likely duplicate
  of #6176:** "SQLite-backed workflow runner storage becomes unhealthy under concurrent
  runner/control-plane access", using `SingleRunner.layer({ runnerStorage: "sql" })`
  explicitly for a single-node topology; many control-plane operations time out under
  contention.

*Provenance caveat:* both were filed by an AI assistant on behalf of a user, with public
repro repositories. Treat as credible-but-unconfirmed-by-maintainers; #6176 does carry a
`bug` label and remains open.

**Why this matters specifically for Gauntlet:** the failure mode is *two processes touching
one SQLite file* — which is precisely the shape of "CLI submits, detached worker executes,
CLI polls status". The single-process shape (one CLI process doing everything) is not
directly implicated, but the moment detachment is added, this is the first wall you hit.
Combined with PR #7032's single-runner shutdown deadlock, the local/embedded path is an
actively-buggy, actively-being-fixed code path rather than a settled one.

### What a "step" is, and how idempotency works

Three nested identity layers:

**1. Workflow execution identity — deterministic and caller-supplied.**

```ts
Workflow.make(tag, {
  payload,
  idempotencyKey: (payload) => string,   // required, not optional
  success, error, suspendedRetrySchedule, annotations
})
```

The execution ID is derived from `(tag, idempotencyKey(payload))`
(`Workflow.executionId(payload)`). Re-invoking `execute` with the same payload hits the
same execution — this is where Gauntlet's frozen `ReviewPlan` + reviewed commit + target
would go. Getting this key wrong is how you silently repay for everything.

**2. Activity = the unit of persisted, never-repeated work.**

```ts
Activity.make({ name, success, error, execute, interruptRetryPolicy, annotations })
```

An `Activity` is an `Effect` with a stable name and success/error schemas. The engine
stores its **`Exit`** — success *or* typed failure — not just its success value. There is
also `Activity.idempotencyKey(name, { includeAttempt })`, which derives a deterministic
string from the current execution ID for passing to a provider's own idempotency header.

**3. Storage key = `${activityName}/${attempt}`.**

From `ClusterWorkflowEngine.js`:

```js
const activityPrimaryKey = (activity, attempt) => `${activity}/${attempt}`
```

Each activity call is an RPC to a per-execution workflow entity, with that string as the
RPC's primary key. `MessageStorage` deduplicates on `(entityAddress, tag, primaryKey)`,
and `requestIdForPrimaryKey` → `repliesForUnfiltered` returns the stored `Exit` if one
exists. **A completed activity is answered from SQLite without re-running the effect.**
That is precisely the "never repay a completed model call" property.

Note the `attempt` in the key: retries are distinct rows, so a retried activity does not
collide with its earlier failure, and `Activity.retry` bumps `Activity.CurrentAttempt`.

### Resume semantics

- **Crash then re-run:** re-executing the same workflow with the same payload resolves to
  the same execution ID; completed activities replay from SQLite; execution continues from
  the first activity with no stored reply.
- **Explicit suspend/resume:** `Workflow.SuspendOnFailure` (a `Context.Reference`) makes a
  workflow suspend rather than fail on error. `Workflow.Result` is `Complete | Suspended`.
  `MyWorkflow.resume(executionId)` resets the suspended request and calls
  `sharding.pollStorage`. Combined with `suspendedRetrySchedule`, this gives
  "pause on provider outage, resume later" for free — Gauntlet does not have this today.
- **Poll / detach-in-process:** `execute(payload, { discard: true })` returns the execution
  ID immediately instead of the result; `poll(executionId)` returns
  `Option<Complete | Suspended>`. This is a genuinely nicer `DurableRuns.submit`/`inspect`
  than the `status.json`-polling loop in `gauntlet-run.ts`.
- **Compensation:** `Workflow.withCompensation` registers a finalizer that runs if the
  whole workflow later fails. **Gotcha, from its own docs:** "Compensation finalizers are
  only registered for top-level effects in the workflow and do not work for nested
  activities." For Gauntlet, delivery rollback would have to be a top-level step.
- **Other durable primitives available:** `DurableDeferred` (external completion signal),
  `DurableClock` (durable sleep/wakeup), `DurableQueue`.

### Detachment

**Not solved.** `SingleRunner` runs the workflow entity **in the calling process**. A
`discard: true` execute returns immediately, but if that process exits, nothing advances
the workflow. Effect ships no supervisor.

Two shapes are possible, neither cheap:

- **Long-lived worker process** sharing the same SQLite file. `Sharding` polls storage
  (`entityMessagePollInterval`, default **10 s**) and would pick up unprocessed messages.
  Architecturally the cleanest detachment story in the document — but it requires a daemon,
  the exact operational mess to be avoided, **and this is the precise configuration that
  issue [#6176](https://github.com/Effect-TS/effect/issues/6176) reports as broken**
  (`database is locked` when a control-plane process accesses the runner's SQLite store).
  Not merely expensive: currently not known to work.
- **Self-spawned detached child.** `effect/unstable/process/ChildProcess` exposes
  `detached?: boolean` (documented as mapping to Node's
  `child_process` `detached` option) and `ChildProcessHandle.unref`. This is a
  **launchd-free** detachment primitive and is available *independently of workflows*.

**Conclusion for the secondary question: no Effect durable-execution option makes detached
runs cheap.** The one relevant improvement — `ChildProcess` with `detached`/`unref` as a
cross-platform replacement for `launchctl submit` — is orthogonal to durable execution and
can be adopted on its own.

### Maturity

**In favour:**

- Every module carries `@since 4.0.0` — this is the v4-native rewrite, not a port with a
  compat shim.
- Docstrings are unusually complete (When to use / Details / Gotchas / @see) — deliberate
  API work, not a code dump.
- The public *type surface* barely moved across 16 betas (see table above).
- `SingleRunner` exists as a documented, first-class single-node layer. Local/embedded use
  is a supported pattern, not a hack.

**Against:**

- Path is literally `unstable/`, and the policy explicitly says those modules **may receive
  breaking changes in minor releases**. Vendor guidance is *"v3 remains our recommended
  choice"* for production.
- `latest` on npm is still `3.22.1`. There is no published v4 GA date.
- Releases every 2–4 days, with substantial ongoing churn in `workflow`/`cluster`/
  `persistence`/`sql` (PRs #7032, #7000, #7134, #7016, #6972, #7005, #7119, #7044, … in the
  beta.90→106 window alone).
- **The local single-node + SQLite path specifically has an open locking bug (#6176) and had
  a shutdown-deadlock fix land mid-window (#7032).**
- **No narrative documentation exists.** effect.website/docs is v3-only and has no Workflow,
  Activity, durable-execution, or Cluster page at all. No README in
  `packages/effect/src/unstable/workflow` or `.../cluster`. Your documentation is the
  docstrings and the source. No evidence was found of anyone using Effect workflows to
  power a local CLI tool — Gauntlet would be the first case study it has.
- The v4 sources moved repositories mid-beta: `Effect-TS/effect-smol` is now **archived and
  read-only**, with v4 merged into `Effect-TS/effect`'s `main`. Any link, issue, or search
  result predating that migration points at a dead repo.

### JANK ASSESSMENT — Option B

**Verdict: HIGH.** Not launchd-flavoured jank — no daemons or plists — but heavy,
opaque, and currently buggy on exactly the local/SQLite path Gauntlet would use.

Good news first, because the usual objections are wrong:

- ✅ **No database server.** One SQLite file. No Postgres, no Docker, no service.
- ✅ **No cluster runtime, no Kubernetes, no network ports.** `SingleRunner` uses no-op
  runner communication and no-op health checks.
- ✅ **No migration step.** Tables are created on layer construction.
- ✅ **No launchd.** Nothing here requires an OS supervisor. (It also does not *give* you
  detachment — see above.)

Now the real jank:

1. 🚨 **Known-buggy on the exact path you'd use.** Open SQLite `database is locked` issue
   under concurrent access ([#6176](https://github.com/Effect-TS/effect/issues/6176)) and a
   single-runner shutdown deadlock fixed mid-beta (#7032). A hang during teardown of a paid
   run is the worst possible failure mode for this tool.

2. 🚨 **You are pulling in a cluster runtime to run a CLI.** `SingleRunner` still stands up
   `Sharding` with **300 shards per group** (`shardsPerGroup: 300`), a 4096-message entity
   mailbox, snowflake ID generation, shard-lock acquisition, entity registration/idle
   timeouts, and background polling fibers. For a tool whose entire job is "run five agents,
   write some JSON", this is a large amount of machinery whose failure modes are not
   yours. When it hangs, you will be debugging shard assignment.

3. 🚨 **~24 `ShardingConfig` knobs leak into your operational surface**, several of which
   have latency consequences for an interactive CLI. `entityMessagePollInterval` defaults
   to **10 seconds**; `entityMaxIdleTime` to 1 minute. Expect to tune these and expect the
   tuning to be non-obvious.

4. 🚨 **`SingleRunner` loads `ShardingConfig` from environment variables by default**
   (`ShardingConfig.layerFromEnv`, overlaid by the `shardingConfig` option). Ambient env
   affecting a paid run's behavior is the same class of hazard the current reviewer
   deliberately closed by *freezing* configuration into `job.json`. Pass an explicit
   `shardingConfig` and treat env-derived config as a bug.

5. 🚨 **The SQLite file is an opaque internal format with no schema versioning.** Tables are
   `CREATE TABLE IF NOT EXISTS` only — there is no migration path if the cluster schema
   changes between betas. Your persisted paid work is stored in a format owned by an
   unstable module. Contrast with the current reviewer, where every artifact is your own
   schema, decodable and inspectable with `cat`. **This is the single strongest argument
   against Option B for a tool whose durability exists to protect money already spent.**
   Mitigation: keep writing your own semantic artifacts *in addition*, which erodes the
   reason to adopt the framework.

6. ⚠️ **Lockstep version pinning + moving driver target.** `@effect/sql-sqlite-node`
   peer-pins `^4.0.0-beta.90`; bumping `effect` requires bumping the driver in the same
   commit. It currently pulls `better-sqlite3` (a native module), and the July recap records
   that dependency being **swapped for Node's native SQLite** — so the driver's own
   foundation is in motion.

6. ⚠️ **No narrative docs, no prior art.** effect.website has no Workflow/Cluster guide
   pages; the `unstable/workflow` and `unstable/cluster` source directories have no README.
   You would be reading `.d.ts` files. No public example was found of Effect workflows
   powering a local CLI.

7. ⚠️ **Debuggability drops.** Today a failed run is a directory you can `ls` and `cat`.
   Under Option B it is rows in a SQL table keyed by snowflake IDs, entity addresses, and
   `activityName/attempt` primary keys, with `Exit` values stored as encoded JSON.

8. ⚠️ **Compensation does not cover nested activities** (documented gotcha). Delivery
   rollback must be structured as a top-level workflow step.

9. ⚠️ **Two SQLite writers if you ever add the worker process.** Not a problem in the
   pure-CLI shape, a real one the moment detachment is layered on.

**Not jank, contrary to expectation:** launchd-class operational mess. Option B adds no
daemons, no plists, no OS supervisor, and nothing that survives your process. Its jank is
*conceptual weight and opacity*, not *system administration*.

---

## Option C — `effect/unstable/persistence` `PersistedCache` (the "middle" option)

Not on the ticket's list, but it is the closest framework analogue to the null baseline and
deserves a row in the comparison.

`PersistedCache`:

> "A `PersistedCache` checks a process-local `Cache`, then a named `Persistence` store,
> before running the supplied lookup. **It stores the lookup `Exit`**, so expensive or
> idempotent results can be reused across fibers, process restarts, or workers that share
> the same backing store."
> — `effect/unstable/persistence/PersistedCache.d.ts`

A step becomes a `Persistable` request: a value with a primary key and success/error
schemas. `PersistedCache.get(key)` runs the lookup only on miss. Backends available as
layers:

```
Persistence.layerMemory
Persistence.layerKvs           <- KeyValueStore.layerFileSystem(directory)
Persistence.layerSql           /  layerSqlMultiTable   (SqlClient)
Persistence.layerRedis
```

`KeyValueStore.layerFileSystem(directory)` requires only `FileSystem` + `Path` — so:
**schema-validated, `Exit`-preserving, filesystem-backed step memoization with no SQL, no
cluster, and no sharding.** For "never repay a completed model call", this delivers ~90% of
the value of Option B at a fraction of the weight.

What you do **not** get: suspend/resume, durable clocks/deferreds, execution-level
orchestration, poll/inspect, compensation. Control flow stays your own code — a crash
re-runs your pipeline function from the top, and each already-completed step returns
instantly from disk. For a linear pipeline like Gauntlet's, that is almost exactly the
desired semantics.

### JANK ASSESSMENT — Option C

**Verdict: LOW.** No server, no daemon, no sharding, no env-derived config, no cluster
tables. Two real warnings:

1. 🚨 **`KeyValueStore.layerFileSystem` writes are NOT atomic.** Verified in
   `persistence/KeyValueStore.js`: `set` calls `fs.writeFileString(keyPath(key), value)`
   directly — no temp file, no rename. A crash mid-write leaves a truncated file at the
   canonical path. The existing reviewer's `.part` + `renameSync` is *strictly better* here.
   Mitigation: the stored value is schema-decoded on read, so a truncated file fails to
   decode → treated as a miss → step re-runs. That converts corruption into a *repaid model
   call*, which is the exact failure this project exists to prevent. **Use the SQL backing
   store, or wrap your own atomic KVS, if you adopt this.**
2. ⚠️ `timeToLive` is mandatory on `PersistedCache.make`. A review run's artifacts want
   effectively infinite TTL; you must say so explicitly.

Also inherits the "unstable/ path, beta churn, `Exit` encoding is a framework-owned format"
caveats — but the persisted values are *your* schemas, so a plain-file backing store stays
human-inspectable.

---

## Option D — the null baseline: hand-rolled artifact journal

The existing reviewer at `/Users/johngiardiniere/Code Review Agent` implements this today.
Skimmed read-only. What the baseline actually costs:

**Layout.** `~/.claude/code-reviews/runs/<run-id>/` with `job.json`, `status.json`,
`request.json`, `scope.json`, `scope.diff`, `candidates.json`, `result.json`, `handoff.json`,
`presentation.json`, `delivery.json`, `frozen-preset.json`, plus per-stage logs. Run ID is
`<timestamp>-<repo-slug>-<8 hex>`, with a `latest-run` pointer.

**Atomicity.** `.part` write + `renameSync`, in three places:
`gauntlet-run.ts:78-88` (`atomicJson`/`atomicText`), a near-duplicate in
`render-review.ts:30-37`, and the shared sub-CLI contract in
`completion-output.ts:73-91` (`beginCompletionOutput`), which *deletes* the target before
work so a file's existence is a truthful completion signal.

**Validation.** Every read goes through `decodeJson` (`contracts.ts:145-153`) and
`validJsonFile` (`gauntlet-run.ts:413-421`), which returns `false` — not throws — on
missing/corrupt/schema-mismatched files, so corruption degrades to "not done yet".

**Resume rule.** Purely *file exists AND decodes*, checked stage-by-stage
(`gauntlet-run.ts:593-649`). Plus identity cross-checks: `assertHandoffForRun` and
`presentationIsComplete` verify `runId`/`handoff`/`report` agree with the run directory,
so an artifact from another run cannot be adopted. Config staleness is handled by
*freezing* seats/finders/destination into `job.json` at submit time rather than by hashing.

**Cost.** ≈ **1,060 lines** of persistence/resume machinery
(`gauntlet-run.ts` 817, `completion-output.ts` 115, `review-handoff.ts` 128), excluding
`contracts.ts` (shared) and most of `render-review.ts`.

**Known defects in the baseline** (worth fixing regardless of this decision):

- `scope.ts:369-399` writes `request.json`, `scope.json`, `scope.diff` with plain
  `writeFileSync` — the one non-atomic stage. `scope.diff` has no schema check either, so a
  truncated diff passes the `existsSync` gate.
- Crash between the `log.jsonl`/`subjective-corpus.jsonl` appends and the
  `presentation.json` write causes resume to re-append → duplicate journal entries with no
  read-side dedup.
- `atomicJson` is duplicated rather than shared.
- Back-compat resume branches for pre-freeze jobs are live duplicated logic.

**Detachment.** macOS `launchctl submit` only (`gauntlet-run.ts:112-138`), with
`launchctl remove` on completion because submit leaves a stopped-job record and launchd
retries non-zero exits — hence the controller records failures as data and always exits 0.
No systemd, no `nohup`, no cross-platform path. **This is the burn the user is warning
about.**

### JANK ASSESSMENT — Option D

**Verdict: LOW framework jank, MODERATE maintenance jank, HIGH detachment jank (today).**

- ✅ Zero dependencies, zero servers, zero unstable APIs. Artifacts are `cat`-able and are
  *your* schemas.
- ✅ Failure semantics are exactly what you chose them to be. ~1,060 lines is not trivial
  but it is fully owned and already load-bearing, with behavioral tests around the exact
  stale/partial-output cases (`test-offline.ts` ~5681-5818).
- ⚠️ It is 1,060 lines you maintain, with two known correctness gaps and duplicated
  helpers.
- ⚠️ No suspend/resume, no durable timers, no built-in poll/inspect — all hand-rolled.
- 🚨 **The launchd dependency is the actual operational mess**, and note it is *not* caused
  by the journal design. It can be replaced independently — `effect/unstable/process`
  `ChildProcess` with `detached: true` + `unref` is a cross-platform primitive that removes
  `launchctl` without adopting any durable-execution framework.

---

## Comparison

| | A: `layerMemory` | B: cluster + SQLite | C: `PersistedCache` | D: artifact journal |
| --- | --- | --- | --- | --- |
| Survives crash | ❌ | ✅ | ✅ | ✅ |
| Never repays completed model call | ❌ | ✅ | ✅ | ✅ |
| Storage requirement | none | 1 SQLite file (+ native `better-sqlite3`) | 1 directory, or SQL | 1 directory |
| Needs DB server / cluster / daemon | no | **no** | no | no |
| Step unit | activity | activity | `Persistable` request | pipeline stage |
| Idempotency key | `Workflow.idempotencyKey` + `name/attempt` | same | request primary key | canonical file path + identity assertions |
| Suspend / resume / durable timers | ❌ | ✅ | ❌ | ❌ |
| Poll / inspect API | in-proc | ✅ built-in | ❌ | hand-rolled `status.json` |
| Atomic writes | n/a | SQL transactions | **❌ not atomic on FS backend** | ✅ `.part` + rename |
| Artifacts human-inspectable | n/a | ❌ opaque SQL | ✅ (FS backend) | ✅ |
| Makes detachment cheap | ❌ | ❌ | ❌ | ❌ (launchd today) |
| Maturity | `unstable/`, beta | `unstable/`, beta, **open bug #6176** | `unstable/`, beta | yours, shipped |
| Narrative docs exist | no | **no** | no | n/a |
| Code you own | ~0 | ~0 | small wrapper | ~1,060 lines |
| **Jank** | n/a | **HIGH** | **LOW** | **LOW/MOD (+ launchd)** |

---

## Recommendation

### Resumability: keep the hand-rolled artifact journal (Option D) for v1. Prototype Option C. Do not adopt Option B yet.

**Use Option D (artifact journal) because:**

- It already delivers the exact property the ticket asks for — decode-and-reuse valid
  artifacts, never repay a completed model call — and it is proven under real paid runs.
- Its persisted values are *your* schemas in *your* files. For a system whose entire
  durability rationale is protecting money already spent, storing that evidence in an
  `unstable/`-namespaced framework's private SQL schema — with `CREATE TABLE IF NOT EXISTS`
  as its only migration story — is a bad trade. This is the decisive argument.
- ~1,060 lines is real cost, but ~200 of it is duplicated helpers and pre-freeze back-compat
  that the planned cleanup already removes. The residual is smaller than it looks.
- Fix the two known defects first: make `scope.ts` writes atomic (and schema- or
  length-check `scope.diff`), and move the `log.jsonl`/`subjective-corpus.jsonl` appends
  after the `presentation.json` receipt (or make them idempotent on run ID).

**Prototype Option C (`PersistedCache` + `Persistence.layerKvs`) as the incremental step,
because** it is the only option that reduces hand-written durability code without importing
a cluster. It gives schema-validated, `Exit`-preserving step memoization over a plain
directory. Two conditions before adopting: (1) confirm the non-atomic
`KeyValueStore.layerFileSystem` write is acceptable or supply an atomic KVS — the current
reviewer's `.part`+rename is strictly better than what ships; (2) confirm that losing
stage-level *identity assertions* (`assertHandoffForRun`) doesn't matter, or reimplement
them in the `Persistable` key.

**Do not adopt Option B (cluster + SQLite) yet, because:**

- The weight is disproportionate to a five-stage local CLI — 300 shards, a 4096-slot
  mailbox, snowflake IDs, shard locks, ~24 config knobs, 10-second default poll intervals,
  env-derived configuration, and an opaque unversioned on-disk schema.
- **The local SQLite path has an open `database is locked` bug (#6176) and had a
  single-runner shutdown deadlock fixed mid-beta (#7032).** A teardown hang after paid model
  calls is the worst failure this tool can have.
- Effect's own guidance is *"v3 remains our recommended choice for now"*, and
  `effect/unstable/*` is explicitly exempt from semver, with releases every 2–4 days.
- There is **no narrative documentation and no public prior art** for this use case.
- Its two genuinely unique features (suspend/resume-on-provider-failure, durable clocks)
  are not on the v1 requirement list.

**Revisit Option B when** any of these become true: (a) `effect` v4 goes stable and
`workflow`/`cluster` leave `unstable/` — and #6176 is closed; (b) Gauntlet needs true suspend-and-resume-later
semantics (e.g. pause on rate limit, resume tomorrow) rather than crash recovery; (c) a
long-lived worker process is wanted for other reasons, at which point `SingleRunner`'s
shared-SQLite model becomes the natural fit instead of overhead. **When you do revisit,
adopt Option B's *vocabulary* immediately regardless:** `Workflow.idempotencyKey`,
`Activity` as the named unit of paid work, and storing the **`Exit`** rather than the
success value are all better-factored than the current file-existence model, and can be
retrofitted onto Option D at low cost.

### Detachment: NOT cheap under any option, but launchd can go.

No Effect durable-execution option makes detached runs cheap. Options A–C run entirely
in-process; Option B's `discard: true` returns a handle immediately but the work still dies
with the process. The only "real" detachment story in the whole Effect stack — a long-lived
`SingleRunner` worker sharing the SQLite file — trades launchd for a daemon plus
multi-writer SQLite, which is strictly *more* operational mess, not less, **and is the exact
configuration reported broken in the open issue #6176.**

**However:** `effect/unstable/process/ChildProcess` supports `detached?: boolean`
(documented as Node's `child_process` `detached` option) and `ChildProcessHandle.unref`.
That is a **cross-platform, plist-free, launchctl-free** replacement for
`launchctl submit`/`launchctl remove` — and it is completely independent of the durability
decision. **Recommended: treat "replace launchd" as its own ticket, solve it with
`ChildProcess` + `detached`/`unref` + the existing status-file protocol, and do not let it
influence the resumability choice.** Reproduce launchd's one genuinely useful property
(recording terminal failures as data and exiting 0 so a paid failure is never auto-retried)
explicitly in the child — that behavior currently exists to *defend against* launchd, and
becomes free once launchd is gone.

---

## Sources

**Installed sources (primary), `effect@4.0.0-beta.90` at
`/Users/johngiardiniere/projects/cloudflare-hub/node_modules/effect/dist/unstable/`:**

- `workflow/Workflow.d.ts` — `make`, `idempotencyKey`, `Result` (`Complete`/`Suspended`),
  `execute`/`poll`/`resume`/`interrupt`, `withCompensation`, `SuspendOnFailure`,
  `CaptureDefects`
- `workflow/Activity.d.ts` — `make`, `retry`, `CurrentAttempt`, `idempotencyKey`, `raceAll`
- `workflow/WorkflowEngine.d.ts` — `Encoded` contract, `makeUnsafe`, `layerMemory`
- `cluster/SingleRunner.d.ts` — single-process layer, options, requirements
- `cluster/ClusterWorkflowEngine.d.ts` / `.js` — `activityPrimaryKey`, `requestIdFor`,
  `replyForRequestId`, `resume`, `resetActivityAttempt`
- `cluster/SqlMessageStorage.js`, `cluster/SqlRunnerStorage.js` — `onDialectOrElse` sqlite
  branches, `CREATE TABLE IF NOT EXISTS`
- `cluster/ShardingConfig.d.ts` / `.js` — defaults (`shardsPerGroup: 300`,
  `entityMailboxCapacity: 4096`, `entityMaxIdleTime: 1m`, `entityMessagePollInterval: 10s`)
- `persistence/PersistedCache.d.ts`, `persistence/Persistence.d.ts`,
  `persistence/KeyValueStore.d.ts` / `.js` (non-atomic `set`), `persistence/Persistable.d.ts`
- `process/ChildProcess.d.ts` (`detached`, `cwd`, `env`), `process/ChildProcessSpawner.d.ts`
  (`unref`/`Reref`)
- `package.json` `exports` map

**npm registry (verified via `npm view`):**

- `effect` — `latest: 3.22.1`, `beta: 4.0.0-beta.106`
- `@effect/workflow` — `latest: 0.19.1`, peer `effect: ^3.22.1`
- `@effect/cluster` — `latest: 0.60.2`, peer `effect: ^3.22.1`, `@effect/workflow: ^0.19.1`
- `@effect/sql-sqlite-node@4.0.0-beta.90` — peer `effect: ^4.0.0-beta.90`, deps
  `better-sqlite3: ^12.9.0`; `beta: 4.0.0-beta.106`
- `@effect/platform-node` — `beta: 4.0.0-beta.106`

**Diff evidence:** `effect@4.0.0-beta.106` tarball unpacked and `.d.ts` files diffed against
beta.90 with comment lines stripped.

**Official docs, blog, and repositories:**

- [Effect v4 beta announcement](https://www.effect.website/blog/releases/effect/40-beta) —
  `unstable/*` stability policy; "v3 remains our recommended choice for now"; "beta releases
  may include breaking changes".
- [`Effect-TS/effect-smol`](https://github.com/Effect-TS/effect-smol) — **archived and
  read-only**; README directs to the canonical repo. `effect@4.0.0-beta.90`'s
  `package.json` still points here, which is now stale.
- [`Effect-TS/effect`](https://github.com/Effect-TS/effect) — canonical repo for both lines.
  v4 sources at `packages/effect/src/unstable/workflow` and `.../unstable/cluster`; no
  README in either. CHANGELOG at `packages/effect/CHANGELOG.md` (PRs #7032, #6618, #6618's
  advisory-lock note, #6618 `Crypto.Crypto`, SQLite dedup-key hashing #6618/#6317).
- [Issue #6176](https://github.com/Effect-TS/effect/issues/6176) (OPEN, `bug`) — SQLite
  `database is locked` / `PersistenceError` under concurrent runner + client access.
- [Issue #6179](https://github.com/Effect-TS/effect/issues/6179) (closed, likely dup) —
  `SingleRunner.layer({ runnerStorage: "sql" })` unhealthy under concurrent access.
- [v4 beta launch→May recap](https://www.effect.website/blog/effect-v4beta-launch-to-may-recap)
  and [July recap](https://www.effect.website/blog/effect-v4beta-july-recap) — workflow/
  durable-execution fixes, `DurableQueue` port, the repo migration, and Node native SQLite
  replacing `better-sqlite3`.
- [effect.website/docs](https://effect.website/docs/) — v3-only (`/docs/v3/...`); **no
  Workflow, Activity, durable-execution, or Cluster pages**. Treat any
  `@effect/workflow` / `@effect/cluster` import example anywhere as v3 unless it uses an
  `effect/unstable/*` path.
- Release dates via `gh api repos/Effect-TS/effect/releases`: beta.99 (2026-07-17) through
  beta.106 (2026-08-08).

**Baseline reference (read-only skim):** `/Users/johngiardiniere/Code Review Agent` —
`gauntlet-run.ts`, `completion-output.ts`, `review-handoff.ts`, `render-review.ts`,
`contracts.ts`, `scope.ts`, `review-delivery.ts`, `test-offline.ts`.
