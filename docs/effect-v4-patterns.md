# Effect v4 patterns in Gauntlet

Read [the house style](effect-house-style.md) for the rules. This guide identifies
where Gauntlet implements them and which behavior an edit must preserve.
The examples were inspected for the rc.112 upgrade; unfamiliar upstream APIs
still need verification against the installed package. `package.json` owns the
version, and the repository gates establish compatibility for exercised code.

## Start with the owning module

| Work | Read |
|---|---|
| CLI parsing, errors, and runtime Layers | `src/cli/main.ts`, `bin/gauntlet.ts` |
| HTTP service and typed failures | `src/linear/linear.ts`, `src/linear/linear.test.ts` |
| Git subprocesses and environment handling | `src/target/git.ts`, `src/test-support/git.fixture.ts` |
| Domain data and tool schemas | `src/domain/agent-outcome.ts`, `src/harness/output-contract.ts` |
| Promise/callback adapter | `src/harness/pi-live.ts`, `src/harness/harness-session.ts` |
| Invocation lifetime and cancellation | `src/harness/invoke.ts`, `src/harness/invoke.test.ts` |
| Concurrency and cache partitions | `src/run/finder-execution.ts`, `src/run/finder-partitions.ts` |
| Persistent artifacts and resume | `src/run/artifact.ts`, `src/run/run-record.ts` |
| Frozen repository view | `src/run/review-working-directory.ts`, `src/workspace/just-bash-workspace.ts` |
| Scripted tests at the adapter boundary | `src/harness/scripted.ts`, `src/cli/main.test.ts` |

Paths in this guide are relative to the repository root. Open the relevant
implementation and its tests before introducing a parallel helper or service.

## Services and executable boundaries

`Linear` declares a `Context.Service<Linear, LinearContract>` and builds its live
implementation with `Layer.effect`. Optional credentials come from `Config`,
and `FetchHttpClient.layer` supplies HTTP. Tests replace the contract or client.
A service does not need generated accessors, a second runtime, or a new wrapper
library. `HarnessSessionFactory` uses separately exported live and scripted
Layers because its Promise/callback contract is shared by both adapters.

`bin/gauntlet.ts` supplies dependencies and calls `NodeRuntime.runMain`.
`runGauntlet` renders typed failures as CLI messages and exit codes. Submission,
execution, and delivery remain composable Effect functions below that boundary.

## Schemas own domain contracts

`AgentOutcome` derives persisted output from the same schema used by its
`OutputContract`. The invocation adapter projects that contract with
`Schema.toJsonSchemaDocument`; the invocation boundary decodes captured output.
Keep those relationships when modifying tool arguments or checkpoint formats.
A separately maintained interface and validator would permit silent drift.

`Schema.optionalKey` allows a key to be absent without accepting a present
`undefined` value. Pi events can contain explicit `undefined`, so their adapter
schemas account for that JavaScript behavior. Persisted JSON contracts need
only JSON values. See `pi-live.ts` and `review-plan.ts` for both cases.

Expected provider endings, timeouts, and missing emits belong in
`AgentOutcome.termination`. Configuration and adapter-contract failures belong
in the typed error channel. `invoke.ts` retains usage and available output
beside an unsuccessful termination; changes must not turn those into lost work.

## Lifetime and concurrency

`invoke.ts` owns session acquisition, event subscriptions, scoped fibers,
watchdogs, and teardown. It uses `Effect.raceFirst` where the first settled
branch must win. `Effect.race` would wait past a failure for another success.
The caller's interruption and an explicit invocation cancellation have distinct
contracts, covered in `invoke.test.ts`.

The callback reducer records evidence synchronously while Queue and Deferred
connect it to Effect fibers. These mutable cells belong to the Pi adapter
contract; replacing them with a new state framework is not an upgrade task.
Usage is swept before disposal, and an abort that never resolves must not block
teardown. Preserve those ordering guarantees.

Finder scheduling groups invocations by Seat and shared prompt context. The
first response coordinates cache reuse within each partition. Evaluation of
BugClaims and Observations proceeds independently until Assembly joins it.
Read these scheduling decisions before adding concurrency limits or retries;
Pi already owns provider retry behavior under ADR-0002.

## External I/O and persistence

`runGit` consumes stdout, stderr, and exit code concurrently inside a scope.
It scrubs Git environment variables that could override the requested working
directory. Tests use real fixture repositories because Git semantics are part
of the contract being tested.

`Linear` decodes GraphQL envelopes, caps response bodies and page traversal,
and distinguishes missing credentials from unreachable or invalid responses.
Its client bounds each HTTP attempt below transient retry; the complete GraphQL
operation also bounds body handling. Fetch completion alone does not bound the
body read. Read-only GraphQL POST requests are safe to retry, whereas delivery
comment creation is not.

`readOptionalArtifactText` treats only `NotFound` as absence. Artifact writes
use a sibling temporary file and rename, avoiding cross-filesystem moves.
Submission writes the working-tree overlay before the plan; a persisted plan
therefore implies the overlay exists. Resume consumes those frozen inputs.
The ReviewWorkspace adapter exposes invocation-local scratch writes while
leaving the Run's snapshot untouched.

## Tests and upgrades

Use `it.effect` with a driven TestClock for time-dependent behavior. The
scripted adapter exercises first-response stalls, corrective turns, usage drift,
and disposal without paid provider calls. Real temporary filesystems and Git
fixtures establish target and resume semantics. CLI tests assert exit codes,
output, and artifact layout; Stage tests cover their own resolution contracts.

For an Effect upgrade, inspect the installed APIs touched by the change and
run the repository gates. Compilation and scripted tests cannot prove live Pi
provider compatibility or a deployed binary's identity. The explicit live and
compiled gates cover those boundaries when they are in the task's scope.
