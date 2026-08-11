# Effect runtime gap audit

- **Status:** Research only; no implementation is approved here.
- **Date:** 2026-08-10
- **Baseline:** current `issue-17-pi-adapter-seam` working tree
- **Bar:** recommend only substitutions that remove custom code or add one
  small declarative option. Effect availability alone is not a reason to adopt.

## Conclusion

Gauntlet has already adopted nearly all of the useful Effect runtime batteries:
the native CLI, `Config`, Schema, platform filesystem/path/stdio, scoped file
logging, supervised child processes, bounded concurrency, queues, scopes,
native deadlines, scoped fibers, `@effect/vitest`, and `TestClock`.

Only two unconditional changes survive the simplicity bar:

1. **Set `forceKillAfter` on Git child processes.** One option activates
   Effect's existing SIGTERM-to-SIGKILL escalation.
2. **Use `Effect.forEach` for `finalizeCapture`'s usage-row decode.** It removes
   a mutable accumulator and manual loop with identical semantics.

Two opportunistic cleanups are also reasonable: remove the unobservable outer
Pi interruption sentinel only if the edit is net-subtractive, and use scoped
temp directories in the small artifact tests that are already Effect-native.

The tempting larger substitutions do **not** pass: `Effect.cached` retains the
wrong failures/interruption for `ModelRuntime`; `Cache.makeWith` can emulate the
policy but adds a cache/key/layer for one value; and
`FileSystem.makeTempFileScoped({ directory })` creates a temporary
**subdirectory**, making the atomic writer more elaborate rather than less.

## Sources and prior decision

The repo pins `effect`, `@effect/platform-node`, and `@effect/vitest` exactly to
beta.106 ([`package.json:19-27`](../../package.json#L19-L27)). This audit read
the installed beta.106 TypeScript source, the matching
[official tagged source](https://github.com/Effect-TS/effect/tree/effect%404.0.0-beta.106/packages),
the [Effect v4 docs](https://effect.plants.sh/), and the earlier
[batteries inventory](effect-batteries.md) from
[issue #2](https://github.com/JRGiardiniere/gauntlet/issues/2). The earlier
inventory was an API map; this is the stricter comparison against code that now
exists.

## Recommendations, in order

### 1. Keep: activate built-in forced process termination

`runGit` correctly uses Effect's `ChildProcess`, captures stdout/stderr/exit
concurrently, and maps `PlatformError`
([`src/target/git.ts:29-66`](../../src/target/git.ts#L29-L66)). Its command omits
`forceKillAfter` ([lines 35-41](../../src/target/git.ts#L35-L41)).

Effect already exposes [`forceKillAfter`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/effect/src/unstable/process/ChildProcess.ts#L247-L254).
The Node spawner only escalates to `SIGKILL` when that option is present
([source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/platform-node-shared/src/NodeChildProcessSpawner.ts#L405-L423));
its scoped release already kills the process group and awaits exit
([source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/platform-node-shared/src/NodeChildProcessSpawner.ts#L473-L505)).
Without the option, an uncooperative process can hold the finalizer indefinitely.

**Verdict: KEEP.** Add one grace-duration option. No timer, watchdog, `Schedule`,
or `AbortController`.

Do not replace `runGit` with `ChildProcessSpawner.string`: that helper collects
an output stream but does not pair it with `handle.exitCode` or preserve stderr
separately
([source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/effect/src/unstable/process/ChildProcessSpawner.ts#L217-L243)).
Git's stderr belongs in `GitCommandError`, so the current three-way capture is
the simpler truthful implementation.

### 2. Keep: use `Effect.forEach` for effectful decoding

`finalizeCapture` allocates an array, loops over `state.usageRows`, effectfully
decodes each row, and pushes each success
([`src/harness/session-bridge.ts:227-238`](../../src/harness/session-bridge.ts#L227-L238)).

`Effect.forEach` preserves order, is sequential by default, and short-circuits
on the first failure
([source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/effect/src/Effect.ts#L1035-L1108)).
Those are exactly the loop's current semantics.

**Verdict: KEEP.** Replace the allocation/loop/push with one
`yield* Effect.forEach(state.usageRows, decode-and-map-error)`. Do not add
concurrency; these are tiny ordered terminal rows.

### 3. Conditional keep: remove only the outer interruption sentinel

Pi construction returns `HarnessSession | "interrupted"`; after
`createAgentSession`, it disposes the new session when the signal is aborted
([`src/harness/pi-live.ts:213-317`](../../src/harness/pi-live.ts#L213-L317)), then
an outer branch maps the sentinel to `SessionOpenError`
([lines 325-333](../../src/harness/pi-live.ts#L325-L333)).

`Effect.tryPromise` supplies that signal
([API](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/effect/src/Effect.ts#L1372-L1380)).
On interruption, Effect marks the async registration resumed, aborts the
controller, and ignores later Promise resolution
([runtime source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/effect/src/internal/effect.ts#L1092-L1129)).
The sentinel therefore cannot reach the outer success branch.

**Verdict: KEEP ONLY IF NET-SUBTRACTIVE.** The inner post-construction signal
check and `dispose()` must remain because Pi's Promise does not accept the
signal and may finish after interruption. Remove only the unobservable
union/outer branch, and only without adding state or cancellation machinery.

### 4. Opportunistic keep: scoped temp dirs in the small artifact tests

The two artifact tests use `mkdtempSync` and leave their directories behind
([`src/run/artifact.test.ts:16-44`](../../src/run/artifact.test.ts#L16-L44)).
They already run under `it.effect`, provide `NodeServices.layer`, and acquire
`FileSystem`. `makeTempDirectoryScoped` removes the directory at scope close
([API](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/effect/src/FileSystem.ts#L181-L191));
the live gate shows the local shape
([`src/harness/live-gate.ts:141-149`](../../src/harness/live-gate.ts#L141-L149)).

**Verdict: KEEP WHEN TOUCHING THIS TEST.** It removes the `node:fs`/`node:os`
imports and adds cleanup. Do not force this through `src/cli/main.test.ts`; its
synchronous Git fixture would need a broader effectful rewrite for no product
benefit.

## Borderline substitutions rejected

### Manual `ModelRuntime` Promise cache

The current closure cache deduplicates concurrent opens, retains success, and
evicts rejection; the shared creation intentionally has no caller signal
([`src/harness/pi-live.ts:145-177`](../../src/harness/pi-live.ts#L145-L177)).

`Effect.cached` memoizes the entire `Exit` forever
([API](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/effect/src/Effect.ts#L13735-L13769),
[implementation](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/effect/src/internal/effect.ts#L4193-L4256)).
It would retain a transient failure or first caller's interruption, poisoning
later opens. `Cache.makeWith` can give failures zero TTL and successes infinite
TTL ([source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/effect/src/Cache.ts#L145-L217)),
but adds a cache handle, dummy key, exit policy, and effectful/layer construction
for one value.

**Verdict: SKIP.** The ten-line Promise cache is smaller and has the exact
semantics. Revisit only if lookup becomes keyed or needs real TTL/refresh policy.

### Atomic sibling temp path

`writeArtifactText` creates a random sibling path, writes, renames atomically,
and removes it on ordinary failure
([`src/run/artifact.ts:15-29`](../../src/run/artifact.ts#L15-L29)). This is the
intentional durability primitive from ADR 0003.

Although `makeTempFileScoped` accepts `directory`
([API](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/effect/src/FileSystem.ts#L193-L214)),
Node first creates a temp **directory** there and a random file within it
([source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/platform-node-shared/src/NodeFileSystem.ts#L392-L402));
the scoped finalizer recursively removes that directory
([source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/packages/platform-node-shared/src/NodeFileSystem.ts#L406-L415)).
Using it would require target-directory derivation, a scope per write, an extra
directory create/remove, and still a rename. A crash could leave a directory
rather than one ignored temp file.

**Verdict: SKIP.** Effect does not ship Gauntlet's exact atomic-write primitive;
the existing code is simpler.

### Callback/Promise seam

`HarnessSession` intentionally mirrors Pi's literal callback/Promise API
([`src/harness/harness-session.ts:8-14`](../../src/harness/harness-session.ts#L8-L14)).
The bridge already uses `Queue` for cross-fiber signals, `acquireRelease` for
subscription ownership, and synchronous capture to avoid an end-of-run drain
race ([`src/harness/session-bridge.ts:15-27`](../../src/harness/session-bridge.ts#L15-L27),
[`140-183`](../../src/harness/session-bridge.ts#L140-L183)). The scripted adapter's
plain Promises implement the same external surface
([`src/harness/scripted.ts:15-22`](../../src/harness/scripted.ts#L15-L22)).

**Verdict: SKIP.** `Deferred`, `Ref`, or `Stream.callback` would require crossing
back to Promises and make the fake less representative. The current hybrid is
the simpler truthful design.

## Remaining inventory

| Area | Evidence | Verdict |
|---|---|---|
| Main CLI | Native command tree and `runWith` in [`src/cli/main.ts:91-108`](../../src/cli/main.ts#L91-L108) | **Adopted.** Live gate's two optional array positions are smaller than a second command tree. |
| Config | `Config` in [`src/run/run-record.ts:33-42`](../../src/run/run-record.ts#L33-L42), `ConfigProvider` in [`src/cli/main.test.ts:68-85`](../../src/cli/main.test.ts#L68-L85) | **Adopted.** No settings/config merge exists yet to replace. |
| Filesystem/path | Runtime code uses `FileSystem`/`Path`; live gate uses scoped temp dirs | **Adopted.** Keep the justified atomic writer. |
| Resources/interruption | Interruptible `acquireRelease` and LIFO cleanup in [`src/harness/session-bridge.ts:120-183`](../../src/harness/session-bridge.ts#L120-L183) | **Adopted.** Only sentinel cleanup remains. |
| Concurrency | Bounded `Effect.all` in [`src/target/git.ts:42-49`](../../src/target/git.ts#L42-L49) and [`src/target/working-tree.ts:47-58`](../../src/target/working-tree.ts#L47-L58) | **Adopted.** Use `Effect.partition` when finder fan-out actually lands, not before. |
| Time/retry | Native timeouts and TestClock; ADR 0002 assigns provider retries to Pi | **No gap.** Adding `Effect.retry` now would multiply attempts. Use a bounded `Schedule` only for the future first-response-stall retry. |
| Logging/metrics | `Logger.toFile` and `Effect.fn` in [`src/cli/main.ts:28-89`](../../src/cli/main.ts#L28-L89); direct accounting at lines 74-85 | **Logging adopted; metrics skipped.** A metric registry would duplicate ADR 0006's journal-derived accounting. |
| Tests | `@effect/vitest`, TestClock, Stdio test layer, ConfigProvider | **Adopted.** Only local scoped-temp cleanup is worth doing. |
| Build/lint scripts | Tiny `spawnSync` orchestration in [`scripts/lint-house-style.mjs:1-58`](../../scripts/lint-house-style.mjs#L1-L58) | **Skip.** Effectifying bootstrap scripts adds a runtime/layer boundary and more code. |

## Later-slice rule

Use `Effect.partition`, bounded `Schedule`, `Flag.fileSchema`,
`PartitionedSemaphore`, `RcMap`, or `ExecutionPlan` only when the corresponding
fan-out, retry, file flag, keyed rate limit, shared resource, or fallback policy
actually exists. Keep `Metric`, OTLP, devtools, persistence, workflow, and
Effect AI out until a concrete reader or requirement earns them.
