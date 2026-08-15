> **Imported reference (cloudflare-hub).** Written for cloudflare-hub against
> effect@4.0.0-beta.90; gauntlet pins **4.0.0-rc.109** and runs plain Node
> (no Cloudflare Sandbox). "For hub:" recommendations, hub service names, and
> "we pin beta.90" statements are historical context. Every API name, import
> path, and signature claim that speaks to our pin has been **verified against
> the installed beta.106 source** (verified 2026-08-10; the beta.106→rc.109
> changesets are patch-only and touch no API this doc prescribes, re-checked
> 2026-08-15); the substantive
> beta.90→106 renames folded in are `Schedule.take(n)` → `Schedule.upTo({ times: n })`
> and `Schema.TaggedErrorClass` → `Schema.TaggedError`. Code excerpts from the
> reference repos remain quotes of those repos at their own (older) pins.

# Effect v4 Patterns Guide for cloudflare-hub

This is the definitive, hub-specific guide to writing the `platform/operations` backend layer in TypeScript + Effect v4. It is synthesized from per-repo analyses of 15 reference codebases (the `executor` template plus 14 repos cloned under `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/`). Every repo is checked out locally, so every file path below is a real path you can open right now. We are pinned to **effect@4.0.0-beta.90** (and the whole `@effect/*` ecosystem at the same beta) running **Node inside a Cloudflare Sandbox** — so `@effect/platform-node` and `@effect/opentelemetry` NodeSdk are our platform/tracing path, not `@effect/platform-bun` or the in-core `effect/unstable/observability` OTLP layers that several references use.

The guide is organized one section per concern area. Each section leads with the single best example to copy, lists other examples worth comparing, gives a concrete "For hub:" recommendation that maps to our actual services (`AppLoader`, `GitVersionRecorder`, `GitMetadataReader`, `Publisher`, `LiveStatus`) and call paths (publish pipeline, registry list/get, live-status enrichment, MCP boundary), and flags version-drift gotchas.

## How to use this guide

- **STEAL** — copy the structure ~directly; it fits hub's shape with minimal change.
- **REFERENCE** — study the idea, then adapt; the shape is right but the runtime/wiring/scale differs.
- **AVOID** — seen in the wild but do not copy; it conflicts with one of hub's stated goals.

Two repos share our exact pin and our exact shape, so they are the spine of this guide:
- `sst/opencode` (beta.83) — the `packages/core` `process.ts` + `git.ts` + `observability/otlp.ts` trio is a near drop-in template for our subprocess + NodeSdk needs.
- `kitlangton/motel` (beta.90) — same pin, ships a stdio MCP boundary, the complete NodeSdk wiring, and `acquireRelease`-based lifecycle rollback.

`executor` (the brief's named template, beta.59) is the closest architectural analog (Effect-native engine + Promise facade), and `effect-app/libs` + `kitlangton/ghui` are also on/near beta.90.

---

## Top 5 things to steal first

These are the highest-leverage copies to bootstrap the spike, in order:

1. **The subprocess service** — copy `sst/opencode`'s `packages/core/src/process.ts` + `git.ts` pair (`/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/sst__opencode/packages/core/src/process.ts`). A reusable `AppProcess` service over `ChildProcess` with timeout/abort/byte-caps/`requireSuccess`, wrapped by per-tool services with a coarse tagged error carrying an `operation` discriminator + `cause`, and a `run()`-vs-`execute()` split (degrade vs surface). This is the backbone of `Publisher`/`GitVersionRecorder`/`GitMetadataReader`.

2. **The NodeSdk tracing layer** — copy `kitlangton/motel`'s `src/runtime.ts` (`/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/kitlangton__motel/src/runtime.ts`) or `sst/opencode`'s `packages/core/src/observability/otlp.ts`. `NodeSdk.layer(() => ({ spanProcessor, resource }))`, gated on an OTLP-endpoint config so it collapses to `Layer.empty` when unset, merged into the runtime once. This is the only repo pair that actually wires NodeSdk; everyone else avoids it.

3. **The service blueprint** — the stock beta.90 shape is the TWO-type-parameter form: `class S extends Context.Service<S, { readonly method: ... }>()("hub/S")` with `static Default = Layer.effect(S, make)` and a `static Fake` for tests (ghui `CommandRunner.ts`, motel `TelemetryStore.ts`, opencode `git.ts` all use it). **Correction:** the single-type-param `Context.Service<S>()("hub/S", { make })` form previously recommended here is NOT stock Effect — effect-app/libs' `CUPS.ts` imports `Context` from their own `effect-app/Context` wrapper, which adds that overload; stock beta.90's `{ make }` option only attaches a `.make` effect and generates no layer. Apply the stock two-param form to all five hub services.

4. **The boundary split** — copy `kitlangton/motel`'s two-boundary pattern (`src/mcp.ts` + `src/runtime.ts` + `src/cli.ts`): Effect-native `Layer.launch(...).pipe(NodeRuntime.runMain)` for long-lived processes and a `ManagedRuntime.make` + `runtime.runPromise` + `dispose()` Promise facade for the CLI. Render the typed E channel at the boundary with `Effect.match`/`catchTags` *before* crossing into a Promise.

5. **The `acquireRelease` rollback model** — copy `kitlangton/motel`'s `RegistryLayer` in `src/localServer.ts` and `effect-app/libs`' `withFileLock`/`tempFile_` in `packages/infra/src/fileUtil.ts`. Each reversible publish step registers a finalizer (or `acquireRelease`) that undoes it; the whole pipeline runs `Effect.scoped` so releases fire on failure and interruption. **But** model committed remote mutations (a half-succeeded `wrangler deploy`) as explicit compensating steps, not finalizers — see the cautions.

---

## 1. Boundary (runPromise / facade)

Hub has two consumers: the MCP host (Effect-composing — keep it Effect-native) and the thin `scripts/hub.mjs` CLI (needs a `runPromise` boundary that prints result/error).

### STEAL — `kitlangton/motel` (beta.90)

Files:
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/kitlangton__motel/src/mcp.ts`
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/kitlangton__motel/src/runtime.ts`
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/kitlangton__motel/src/cli.ts`

Motel shows both boundary styles that map exactly to hub's two consumers, on our exact pin:

```ts
// mcp.ts — Effect-native long-lived process (the MCP host model)
Layer.launch(ServerLayer).pipe(BunRuntime.runMain)   // hub: NodeRuntime.runMain

// runtime.ts — build the ManagedRuntime once, merge service + telemetry layers
export const queryRuntime = ManagedRuntime.make(QueryRuntimeLive)

// cli.ts — Promise facade for the thin CLI; dispose in finally
const runQuiet = (effect) => queryRuntime.runPromise(
  effect.pipe(Effect.provideService(References.MinimumLogLevel, "None")))
// ... finally { await queryRuntime.dispose() }
```

The MCP handler renders the typed error channel into a client-renderable result *before leaving Effect* (`src/mcp.ts`):

```ts
const asResult = <A>(effect: Effect.Effect<A, { readonly message: string }>) =>
  Effect.match(effect, {
    onFailure: (err) => ({ error: err.message }) as unknown,
    onSuccess: (value) => value as unknown,
  })
```

### REFERENCE

- **`executor` (beta.59)** — the canonical engine/facade split. `packages/core/execution/src/promise.ts` wraps each Effect method in `Effect.runPromise` for non-Effect callers, with a header comment instructing Effect-composing callers to import the Effect module directly to preserve trace context. `apps/cli/src/main.ts` ends with `.pipe(Effect.catchCause(renderCliError + exitCode=1), BunRuntime.runMain)`. Path: `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/executor/packages/core/execution/src/promise.ts`. **Gotcha**: the facade does `Effect.tryPromise(...).pipe(Effect.orDie)` — it *erases* the typed E channel into a defect, so do your typed-error rendering on the Effect side *before* the facade.
- **`sst/opencode` (beta.83)** — `packages/core/src/effect/runtime.ts` `makeRuntime(service, layer)` memoizes a single `ManagedRuntime` (lazy `rt ??= ManagedRuntime.make(...)`, shared `memoMap`) and exposes `runPromise`/`runPromiseExit`/`runFork` keyed on one service via `service.use(fn)`. The CLI entry uses `Runtime.run(...).pipe(Effect.provide(...), Effect.scoped, NodeRuntime.runMain)` — note `Effect.scoped` wrapping the whole program so finalizers run before exit. Near-verbatim steal for hub's facade.
- **`effect-app/libs` (beta.90)** — `packages/effect-app/src/runtime.ts` builds `makeRunPromise` over the beta.90 `Effect.runPromiseExitWith(services)` and turns a failure `Exit` into a thrown/rejected `CauseException` preserving the full Cause (uses `Cause.prettyErrors`); also attaches `Symbol.dispose`/`Symbol.asyncDispose` so the runtime works with `using`. The CLI goes Effect-native via `NodeRuntime.runMain(Effect.fn("effa-cli")(function*(){...}))`.
- **`timhanlon/arcwork` (beta.74)** — `src/main/runtime.ts` + `src/main/index.ts`: one long-lived `ManagedRuntime.make(AppLive)`; long-lived orchestration acquired into an explicit `Scope.makeUnsafe()` closed on quit *before* `runtime.dispose()` for deterministic finalizer-ordered shutdown.

### For hub

- Keep the operations layer purely Effect-composing (services + layers, no `run*` inside). Hand the fully-wired `AppLayer` to the MCP host's runtime.
- `scripts/hub.mjs` is one-shot, so it uses `NodeRuntime.runMain(program, { teardown })` over `publishCli(...).pipe(Effect.provide(AppLayer))` (the executor/opencode CLI shape) rather than a `ManagedRuntime` + `runPromise` facade (motel's `cli.ts` — right for a caller that runs *many* effects against one runtime). `runMain` interrupts the main fiber on SIGINT/SIGTERM, so scope finalizers (child-process teardown, layer disposal) run before exit; a custom `teardown` maps the rendered outcome to the exit code (`Runtime.defaultTeardown` handles interrupt=130 / defect=1).
- Render `PublishError`/`DirtyWorkingTree`/etc. into operator text with `Effect.catchTags` / `Effect.match` *before* the boundary, because the Exit/Promise crossing erases types.

**beta.90 gotcha**: use `NodeRuntime.runMain` from `@effect/platform-node` (every reference except `effect-app/libs`, motel-on-Node, and arcwork uses Bun's). `Effect.runPromiseExitWith(services)` / `runSyncExitWith` are the current names (`effect-app/libs`; both still present at beta.106); a `makeFiberFailure`-based approach is gone (their `errors.ts` carries a `// v4: makeFiberFailure removed` migration note — use `Cause.prettyErrors`).

---

## 2. Tagged Errors

Hub's #1 goal: a typed/tagged E channel the compiler proves is exhausted at the MCP boundary, with user-fault errors surfaced verbatim and infra defects kept opaque.

### STEAL — `executor` (beta.59)

Files:
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/executor/packages/kernel/core/src/effect-errors.ts`
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/executor/packages/core/execution/src/tool-invoker.ts`
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/executor/packages/kernel/runtime-deno-subprocess/src/index.ts`

The model error module: small `Data.TaggedError` classes with `readonly module/message/cause?` fields and doc-comments separating user-fault (rendered verbatim) from infra defects (opaque + correlation id + `logError(cause)`):

```ts
export class CodeExecutionError extends Data.TaggedError("CodeExecutionError")<{
  readonly runtime: string
  readonly message: string
  readonly cause?: unknown
}> {}
```

The gold boundary-rendering example (`tool-invoker.ts`): `catchTag` for known typed failures, then a `catchCause` fallback that finds the fail reason, renders expected failures as data, and collapses anything else into an opaque generic message + correlation id while logging the full cause — so URLs-with-tokens never leak through `Error.message`:

```ts
Executor.execute(...).pipe(
  Effect.catchTag("CredentialResolutionError", (err) => Effect.succeed(toolFailure(err))),
  Effect.catchCause((cause) => {
    const err = cause.reasons.find(Cause.isFailReason)?.error
    // expected -> data; else opaque generic + correlationId + logError(cause)
  }),
)
```

The `deno-subprocess` error overrides `get message()` to map `ENOENT` to an actionable install hint — perfect for hub's "git/wrangler/esbuild binary not found" errors.

### REFERENCE

- **`alchemy-run/alchemy-effect` (beta.84+)** — `packages/alchemy/src/Command/Command.ts`: `Data.TaggedError` with a nested `reason` union (`SystemError | BadArgument | UnexpectedExit | OutputNotFound`) and an overridden `get message()` rendering exit code + stderr. Exactly hub's subprocess error shape. `Effect.catchTag("DispatchNamespaceNotFound", () => Effect.succeed(undefined))` (`Cloudflare/WorkersForPlatforms/DispatchNamespace.ts`) is hub's LiveStatus degrade-to-unavailable, type-proven.
- **`sst/opencode` (beta.83)** — uses `Schema.TaggedErrorClass<T>()("Namespace.Name", {fields}, {annotations})` everywhere (zero `Data.TaggedError` in error defs). Three things to copy: namespaced tags (`Git.OperationError`); *coarse* errors with a discriminator field (`git.ts` has ONE `OperationError` carrying `operation: Schema.Literals([...])` + `cause: Schema.optional(Schema.Defect())` instead of one class per verb); boundary annotations (`{ httpApiStatus: 404 }`). Map domain → API errors by tag: `Effect.catchTag("Session.NotFoundError", e => Effect.fail(new SessionNotFoundError({...})))`.
- **`kitlangton/ghui` (beta.90)** — `src/services/GitHubService.ts` defines a UNION alias `export type GitHubError = CommandError | JsonParseError | Schema.SchemaError` stamped on every method signature so the compiler proves the full failure set at the call site. Errors are `Schema.TaggedErrorClass` with `cause: Schema.Defect()`.
- **`effect-app/libs` (beta.90)** — two tiers: plain `Data.TaggedError` for leaf/adapter errors (`CUPSError` carries `command/code/signal/killed/stdout/stderr/cause`), schema-backed `TaggedErrorClass` for cross-wire errors. `Store/SQL.ts` deliberately maps a driver error to a typed serializable `DatabaseError` (with a `transient` flag) *instead of* `.orDie`, with a comment on why orDie would make it an opaque non-serializable defect.

### For hub

- Use **`Data.TaggedError`** for in-process leaf errors (`PublishError` sub-tags, `GitDirtyTree`, `DeployFailed`, subprocess errors carrying `command/exitCode/stderr/cause`). Use **`Schema.TaggedError`** (the beta.106 name for what the references call `Schema.TaggedErrorClass`) only for errors that must serialize across the MCP wire.
- Follow opencode's **coarse-error-with-discriminator** style: one `OperationError` per service with an `operation` literal union, not one class per git verb. Keep `cause: Schema.optional(Schema.Defect())` to hold the original throwable.
- At the MCP boundary, prefer an explicit `Effect.catchTags({...})` switch (lalph's `root.ts`) so each tag maps to a deliberate user-facing message and the compiler enforces exhaustiveness, backed by a `catchCause` fallback for defects (executor's `tool-invoker.ts`).

**beta.90 gotcha**: `Schema.TaggedErrorClass`/`Schema.Defect()` are the beta.90 surface (ghui, motel, opencode all use them); at beta.106 the class is renamed **`Schema.TaggedError`** (same shape — `Schema.TaggedError<Self>()("Tag", fields, annotations?)`) and `Schema.Defect()` is unchanged. Do not cargo-cult schema-backed error classes everywhere — it carries heavier machinery (`effect-app/libs` shows `disableValidation`/manual `super(... as any)`); reserve it for the wire. **Avoid** the hand-rolled `class X extends Error { readonly _tag = "X" }` shortcut (motel's boundary services, dfx's `BadWebhookSignature`) and the Schema-struct-as-error `{ _tag: Literal("NotFound") }` (effect-http-starter) — both lose `catchTag`/exhaustiveness ergonomics.

---

## 3. Services & Layers

The five hub services: `AppLoader`, `GitVersionRecorder`, `GitMetadataReader`, `Publisher`, `LiveStatus`.

### STEAL — the stock beta.90 two-param form (ghui / motel / opencode)

> **Correction (verified against stock beta.90 `Context.d.ts`; re-verified at beta.106):** this section originally recommended effect-app/libs' single-type-param `Context.Service<S>()(id, { make })` form. That form is NOT stock Effect — `CUPS.ts` imports `Context` from effect-app's own `effect-app/Context` wrapper, which adds a bespoke overload (and a `toLayer` helper). Stock beta.90 requires BOTH type parameters (`<Self, Shape>`), and its `{ make }` option merely attaches a `.make` effect to the class — it does not generate a Default layer. The beta.90-pinned stock-effect references (ghui, motel) and opencode all use the two-param form below, and hub follows them.

The canonical stock-beta.90 service shape — explicit interface as the second type parameter, `make` reads deps/Config inside the gen and returns a plain record via `Service.of`, and the class statically exposes a real layer *and* a fake layer for tests:

```ts
// ghui src/services/CommandRunner.ts (beta.90) — same shape as hub's services
export class CommandRunner extends Context.Service<CommandRunner, {
  readonly run: (command: string, args: ReadonlyArray<string>) => Effect.Effect<Result, CommandError>
}>()("ghui/CommandRunner") {
  static readonly layer = Layer.effect(CommandRunner, Effect.gen(function* () {
    // ... yield* deps, build methods ...
    return CommandRunner.of({ run })
  }))
}
// effect-app/libs' static-Fake idea still transfers: add
//   static readonly Fake = Layer.succeed(S, S.of({ ...no-ops... }))
```

### REFERENCE

- **`kitlangton/ghui` (beta.90)** — the most copyable wiring convention. `src/services/GitHubService.ts`: `static layerNoDeps = Layer.effect(X, gen)` (assumes deps provided elsewhere) + `static layer = layerNoDeps.pipe(Layer.provide(Dep.layer))` (self-contained). `src/services/runtime.ts` composes the graph with `Layer.mergeAll(...services).pipe(Layer.provide(CommandRunner.layer), Layer.provideMerge(Observability.layer))` — one shared `CommandRunner` provided to all. The `layerNoDeps`/`layer` split is the single best structural idea here. Also shows the LiveStatus degrade pattern: a `disabledLayer = Layer.succeed(Service, Service.of({...no-ops...}))` plus `layerFromPath = liveLayer.pipe(Layer.catchCause(() => disabledLayer))`.
- **`executor` (beta.59)** — `packages/core/integrations-registry/src/registry.ts`: a config-taking `layer(config)` factory + a `defaultLayer(config)` that does `.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(NodeFileSystem.layer))` to bake in platform deps. `apps/local/src/executor.ts`: `Effect.acquireRelease` inside a `Layer.effect`, then a `ManagedRuntime`-backed Promise handle with `dispose()`.
- **`sst/opencode` (beta.83)** — `packages/core/src/git.ts`: hand-written `interface Interface { readonly method: (...) => Effect.Effect<A, TaggedError> }` (errors explicit in every signature), `Context.Service<Service, Interface>()("@opencode/Git")`, build with `Layer.effect`, then `defaultLayer = layer.pipe(Layer.provide(Dep.defaultLayer), Layer.provide(NodeFileSystem.layer))`.
- **`tim-smart/dfx` (beta.73)** — `src/RateLimit.ts` / `src/gateway.ts`: the maintainer house style — separate `interface FooService` + `class Foo extends Context.Service<...>()("dfx/Foo")` tag + standalone `const make = Effect.gen(...)` + `export const FooLive = Layer.effect(Foo, make)`. Compose with `Layer.mergeAll` / `Layer.provideMerge` (re-exposes the service) / `Layer.provide` (seals it), writing the full `Layer.Layer<Provides, never, Requires>` annotation.
- **`tim-smart/lalph` (beta.78)** — `src/Worktree.ts`: a service exposing a SECOND named layer for an alternate environment (`Worktree.layerLocal`) — directly applicable as a test/local layer. Swappable strategy implementations of one tag (`GitFlowPR` via `Layer.succeed`, `GitFlowCommit`/`GitFlowRalph` via `Layer.effect`).
- **`tim-smart/effect-genserver` (beta.85)** — maintainer-blessed minimal shape; note a service shape can be a bare function type, not only a record.

### For hub

- Define each of the five services as `class S extends Context.Service<S, Interface>()("hub/S")` with a `static Default = Layer.effect(S, make)` (the stock two-param form — see the correction above), optionally adding ghui's `layerNoDeps`/`layer` split if you want a shared `CommandRunner` underneath.
- Share **one** `CommandRunner`/subprocess service across `Publisher`/`GitVersionRecorder`/`GitMetadataReader` (ghui's `Layer.provide(CommandRunner.layer)` once). Effect memoizes singletons by reference, so define shared layers as constants (arcwork's `runtime.ts`).
- Give `LiveStatus` a `disabledLayer` fallback via `Layer.catchCause` (ghui) so a broken Cloudflare client collapses to a no-op service instead of failing the whole graph.
- Give every service a `static Fake`/`Default` (effect-app/libs) for tests.

**beta.90 gotcha**: avoid `sst/opencode`'s bespoke `LayerNode` DI graph (`packages/core/src/effect/layer-node.ts`, ~12KB of type machinery) — it's scale-justified for dozens of services and pure overhead for hub's five. Use plain `Layer.provide`/`provideMerge`. The curried `Layer.effect(this)(this.make)` form (sandromaglione, beta.66) and the un-curried `Layer.effect(this, this.make)` (effect-app/libs, beta.90) differ across betas — use the un-curried form (still current at beta.106).

---

## 4. Tracing (incl. NodeSdk wiring)

Hub's #2 goal: spans across the publish pipeline via `@effect/opentelemetry` NodeSdk (we run Node-in-Sandbox). **Critically, most references author spans well but avoid NodeSdk** (they run under workerd/Bun or use the in-core `effect/unstable/observability` OTLP layers). Only opencode and motel actually wire NodeSdk.

### STEAL — `sst/opencode` (beta.83) for the NodeSdk layer + `kitlangton/motel` (beta.90) for the same on our pin

Files:
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/sst__opencode/packages/core/src/observability/otlp.ts`
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/kitlangton__motel/src/runtime.ts`

opencode's `otlp.ts` is the single most directly-stealable file for hub's Node-in-Sandbox tracing — env-gated, zero-cost when unconfigured, with an `AsyncLocalStorageContextManager` so spans parent correctly across async:

```ts
export async function tracingLayer() {
  if (!endpoint) return Layer.empty
  const NodeSdk = await import("@effect/opentelemetry/NodeSdk")
  const OTLP = await import("@opentelemetry/exporter-trace-otlp-http")
  return NodeSdk.layer(() => ({
    resource: resource(),
    spanProcessor: new SdkBase.BatchSpanProcessor(
      new OTLP.OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers })),
  }))
}
```

motel shows the same on beta.90, gated by a config flag and merged into the `ManagedRuntime`:

```ts
// motel src/runtime.ts
const telemetryLayer = NodeSdk.layer(() => ({
  spanProcessor: new SimpleSpanProcessor(new OTLPTraceExporter({ url: config.otel.exporterUrl })),
  logRecordProcessor: new SimpleLogRecordProcessor(new OTLPLogExporter({ url: config.otel.logsExporterUrl })),
  resource: { serviceName: config.otel.serviceName, attributes: { "deployment.environment.name": "local" } },
}))
```

**Span-authoring convention** (steal this everywhere): every operation is `Effect.fn("Service.method")(function*(){...})` which auto-names a span; add `Effect.annotateCurrentSpan(...)` for attributes and `Effect.withSpan("child", { attributes })` for sub-steps. opencode uses `Effect.fn` 382 times and `Effect.fnUntraced` (61) for hot/internal helpers.

### REFERENCE

- **`alchemy-run/alchemy-effect`** — `Apply.ts` `instrumentLifecycle`: instrument tracing at ONE choke point (`Effect.withSpan('provider.<op>', {attributes})` + a metric `onExit` recorder at the single dispatch site, not in each provider). Gate the trace layer with `Layer.unwrap(Effect.gen(...))` returning `Layer.empty` when disabled. **But its exporter is `effect/unstable/observability/OtlpTracer.layer`, not NodeSdk** — copy the instrumentation, not the wiring.
- **`kitlangton/ghui` (beta.90)** — `src/services/CommandRunner.ts`: `Effect.tap` + `Effect.annotateCurrentSpan` for runtime attributes (`duration_ms`, `exit_code`) inside an `Effect.withSpan` block; a `commandTelemetryAttributes` helper centralizes span tags. Same `Layer.unwrap` → `Layer.empty` config gate. **Exporter is `effect/unstable/observability` OtlpTracer, not NodeSdk.**
- **`effect-app/libs` (beta.90)** — `packages/infra/src/otel.ts`: reusable semconv attribute helpers (`withDbSpan` builds low-cardinality `${op} ${collection}` names + OTel attributes, `captureStackTrace: false`), and `Effect.fn("Emailer.sendMail", { attributes })`. **No NodeSdk/exporter anywhere — span-authoring only.**
- **`timhanlon/arcwork` (beta.74)** — heavy `Effect.fn`/`withSpan` instrumentation, plus the wiring insight: `provideMerge` the tracing layers *under* the app layers so fibers forked during layer construction inherit the tracer. **Uses in-core OtlpTracer (vendored "Lensflare"), not NodeSdk.**

### For hub

- Copy opencode's `otlp.ts` (or motel's `runtime.ts`) **verbatim** as `observability.ts`: `NodeSdk.layer(() => ({ resource, spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter({ url })) }))`, gated on `OTEL_EXPORTER_OTLP_ENDPOINT` → `Layer.empty` when unset, with an `AsyncLocalStorageContextManager` for cross-async parenting. Merge it into the runtime via `provideMerge` *under* the app layers (arcwork).
- Name each publish step `Effect.fn("Publisher.loadManifest")`, `Effect.fn("Publisher.buildCss")`, `Effect.fn("Publisher.bundleClient")`, `Effect.fn("Publisher.wranglerDeploy")` to get a free span tree. Use `Effect.fnUntraced` only for genuinely-internal helpers.
- If hub ever traces calls that themselves carry telemetry egress, exclude those routes (motel's `HttpMiddleware.layerTracerDisabledForUrls` avoids a self-tracing feedback loop). On the Cloudflare REST calls hub probably wants trace propagation **ON** (the inverse of dfx/receipts, which set `TracerPropagationEnabled = false` to avoid leaking traceparent to a third party — know the knob exists).

**beta.90 gotcha**: the `@effect/opentelemetry` peer must be pinned to the same beta as `effect`. opencode is beta.83 — verify `NodeSdk.layer` signature against your installed pin (motel confirms it holds at beta.90; `@effect/opentelemetry` is not installed in gauntlet, so this one is unverified at beta.106). Do **not** copy any in-core `effect/unstable/observability/OtlpTracer.layer` wiring (alchemy/ghui/arcwork) — that is the workerd/Bun path and conflicts with our NodeSdk brief.

---

## 5. Resource Safety / rollback

Hub's #3 goal: a `wrangler deploy` that half-succeeds must roll back. The hard truth from the references: **finalizers cleanly handle ephemeral handles (temp dirs, child processes, esbuild contexts), but committed remote mutations need explicit compensation, not finalizers.**

### STEAL — `kitlangton/motel` (beta.90) for the acquire-then-undo layer + `effect-app/libs` (beta.90) for the lock/temp-file shapes

Files:
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/kitlangton__motel/src/localServer.ts`
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/effect-app__libs/packages/infra/src/fileUtil.ts`

motel's `RegistryLayer` is the model: publish external state on acquire, undo it on release, composed *after* the resource it depends on so a failed step never leaves zombie state:

```ts
const RegistryLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.sync(() => { writeRegistryEntry({ pid: process.pid, url, ... }) }),
    () => Effect.sync(() => removeRegistryEntry(process.pid)),
  ),
)
// composed via Layer.mergeAll(ApiLayer, StaticLayer, RegistryLayer) AFTER the server layer
// so release order = remove entry -> server.stop() -> db.close()
```

effect-app/libs' `fileUtil.ts` is the best file for hub's build scratch + deploy-slot lock — `withFileLock` = `tryPromise` acquire + `addFinalizer(release)` + `Effect.scoped`, and `tempFile_` = write-then-guaranteed-`unlink`:

```ts
export function withFileLock<A, E, R>(filePath: string, action: Effect.Effect<A, E, R>) {
  return Effect.gen(function*() {
    const release = yield* Effect.tryPromise(() => lockfile.lock(filePath, {...})).pipe(Effect.orDie)
    yield* Effect.addFinalizer(() => Effect.tryPromise(() => release()).pipe(Effect.orDie))
    return yield* action
  }).pipe(Effect.scoped)
}
```

### REFERENCE

- **`sst/opencode` (beta.83)** — `packages/core/src/cross-spawn-spawner.ts`: process lifecycle as `Effect.acquireRelease(spawn(...), release)` where release sends SIGTERM, awaits exit, escalates to SIGKILL after a timeout. Every command runs inside `Effect.scoped` so the spawn finalizer fires on success/failure/interruption. This is the guarantee hub wants: an interrupted publish never leaves a wrangler/esbuild process running.
- **`tim-smart/lalph` (beta.78)** — `src/Worktree.ts`: register `Effect.addFinalizer` steps *inside* the service `make()` as each acquire succeeds, wrapping cleanup-that-must-not-fail in `Effect.catchCause(Effect.logWarning)`. The directly-applicable model for hub's reverse-order unwind.
- **`timhanlon/arcwork` (beta.74)** — `src/main/ingest/providers/cursor.ts`: `Effect.acquireUseRelease(mkdtempSync -> copy+read -> rmSync)` for a temp-dir-scoped operation (steal for build scratch). **Contrast to STUDY, not copy**: `src/main/services/git/worktree.ts` implements multi-step rollback with hand-rolled imperative cleanup-on-failure, *not* finalizers — it works only because git steps are individually reversible.
- **`alchemy-run/alchemy-effect`** — `src/Apply.ts`: `acquireRelease` only for ephemeral handles (rolldown watcher); replacement/rollback is an explicit STATE MACHINE (create-new → mark 'replaced' → GC old), with a literal `TODO(sam): support roll back ... some UPDATEs may not be reversible`. Strong evidence that finalizer-based rollback of committed cloud mutations is the wrong tool.

### For hub

- Wrap ephemeral resources with `acquireRelease`/`acquireUseRelease`: the temp build dir, the tailwind/esbuild context, each child process. Run the whole publish pipeline `Effect.scoped` so these release on failure and interruption (opencode + effect-app/libs).
- Use a `withFileLock`-style deploy-slot lock (effect-app/libs) so two publishes can't half-deploy the same app concurrently.
- For the **committed `wrangler deploy`**, model rollback as an explicit compensating step (delete/rollback the dispatch deployment) gated on later-step failure + persisted status — **not** a finalizer (alchemy + arcwork both prove finalizers can't reliably undo committed remote state). lalph's `addFinalizer`-as-each-step-succeeds is fine for *reversible* steps; treat the deploy as the one that may not be cleanly reversible.

**beta.90 gotcha**: `Effect.addFinalizer`, `acquireRelease`, `acquireUseRelease` are stable. Note `tim-smart/dfx`/`opencode` use `acquireRelease`; `arcwork` notably has *no* `acquireUseRelease` and lalph uses `addFinalizer` rather than `acquireRelease` — both are valid beta.90 idioms.

---

## 6. Structured Concurrency

Hub's #4 goal: the registry list/get path enriches N records with live status concurrently, bounded, where one failed enrich degrades to "unavailable" rather than failing the batch.

### STEAL — `timhanlon/arcwork` (beta.74)

File: `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/timhanlon__arcwork/src/main/services/GitService.ts`

The exact shape for hub's registry path — bounded fan-out with per-item catch and `discard`:

```ts
yield* Effect.forEach(
  list.filter((w) => !seen.has(w.id)),
  (w) => { seen.add(w.id); return detectRepository(w.id).pipe(Effect.catch((e) => Effect.logWarning(...))) },
  { concurrency: 4, discard: true },
)
```

### REFERENCE

- **`sst/opencode` (beta.83)** — `packages/core/src/system-context/registry.ts`: `Effect.forEach(items, (item) => item.load, { concurrency: "unbounded" })` for registry-list fan-out; `Effect.all([...], { concurrency: "unbounded" })` to join independent reads. (For the subprocess wrapper, `Effect.all([collectStdout, collectStderr, exitCode], { concurrency: "unbounded" })` drains streams simultaneously to avoid pipe-buffer deadlock.)
- **`tim-smart/lalph` (beta.78)** — `src/Github.ts`: bounded `Effect.forEach(..., { concurrency: 10 })` for reads and `{ concurrency: 5, discard: true }` for fire-and-forget batches. (The `Semaphore` + `FiberSet` worker-loop in `commands/root.ts` is heavier than hub needs — reference only if publish ever needs a worker pool.)
- **`kitlangton/ghui` (beta.90)** — `src/ui/pullRequests/atoms.ts`: `Effect.forEach(repositories, fn, { concurrency: 4, discard: true })` with each body ending `.pipe(Effect.catch(() => Effect.void))` so one failure can't abort the batch — the directly-applicable degrade pattern on our pin. Also `FiberMap` + `{ onlyIfMissing: true }` for per-key single-flight if hub ever wants one-publish-per-app, and `Stream.paginate` if a future LiveStatus needs to page the dispatch namespace.
- **`kitlangton/motel` (beta.90)** — `src/services/TelemetryStore.ts`: the degrade-don't-fail loop — `Effect.forkScoped(Effect.repeat(effect, Schedule.spaced("10 seconds")))` with each pass wrapped in `Effect.catchCause(cause => logWarning(Cause.pretty(cause)))`. Note motel has *no* `Effect.all`/`forEach` fan-out, so hub designs the concurrent list path itself.
- **`alchemy-run/alchemy-effect`** — `src/Apply.ts`: the advanced `catchCause`-collect-then-`Cause.combine`-and-raise-once technique if any concurrent step must not abort its siblings but you still want to aggregate failures.

### For hub

- Registry list/get: `Effect.forEach(records, enrichWithLiveStatus, { concurrency: N })` where `enrichWithLiveStatus` ends in `Effect.catch(() => Effect.succeed(unavailable))` (arcwork/ghui). Use a **bounded** N (e.g. 4–5), never `"unbounded"`, against the Cloudflare REST API to avoid self-inflicted rate limiting (dfx caution).

**beta.90 gotcha**: `Effect.race` prefers the first *success* in v4, so a fast failure can hang waiting on the other branch — use `Effect.raceFirst` for first-to-settle (documented in executor's `engine.ts` and used in opencode's `process.ts` for timeout/abort). Fork names are v4-current: `forkDetach`/`forkChild`/`forkScoped` (not `forkDaemon`).

---

## 7. Wrapping External Calls (subprocess / fetch / fs)

Hub's three foreign surfaces: subprocess (git, wrangler, esbuild, tailwind), the Cloudflare REST API (LiveStatus), and fs (manifest reads). This is the richest, most directly-applicable concern.

### STEAL — `sst/opencode` (beta.83) for subprocess

Files:
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/sst__opencode/packages/core/src/process.ts`
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/sst__opencode/packages/core/src/git.ts`

`process.ts` (the `AppProcess` service) is a complete reusable subprocess runner over the v4 built-in `effect/unstable/process` `ChildProcess`: timeout, AbortSignal, stdin streaming, byte-capped output, `combineOutput`, plus `requireSuccess`/`requireExitIn` exit-code guards that fail with a tagged error. `git.ts` adds the **degrade-vs-fail split** hub needs — `execute()` surfaces errors, `run()` wraps it with `Effect.catch(() => Effect.succeed({exitCode:1,text:"",stderr:""}))` for best-effort reads (mirrors LiveStatus "unavailable"):

```ts
// git.ts — degrade-friendly read vs error-surfacing exec
function run(cwd, proc) {
  return (args) => execute(cwd, proc)(args).pipe(Effect.catch(() => Effect.succeed({ exitCode: 1, text: "", stderr: "" })))
}
```

Foreign promise APIs are wrapped with `Effect.tryPromise({ try, catch: cause => new InstallFailedError({cause,...}) })`.

### Also STEAL — `kitlangton/ghui` (beta.90) `CommandRunner` for the signal/timeout discipline

File: `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/kitlangton__ghui/src/services/CommandRunner.ts`

One service owns all spawning; non-zero exit becomes a *typed failure* (not a defect); the `try` registers a SIGKILL on abort so Effect interruption actually kills the child; `runSchema = runJson + Schema.decodeUnknownEffect` so callers get typed values:

```ts
const run = Effect.fn("CommandRunner.run")(function* (command, args, options?) {
  const result = yield* runProcess(command, args, options?.stdin)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
    return yield* new CommandError({ command, args: [...args], detail, cause: detail })
  }
  return result
})
```

### REFERENCE — fetch / REST (the LiveStatus adapter)

- **`kitlangton/motel` (beta.90)** — `src/motelClient.ts` is the canonical fetch wrapper: `Effect.tryPromise` with `AbortSignal.timeout(5000)` inside the `try` (hard ceiling so a hung Cloudflare call can't wedge a listing), throw a typed `MotelHttpError` on `!res.ok`, and `.pipe(Effect.tapError(err => err.status === 0 ? invalidate : Effect.void))` to distinguish transport failure from HTTP error.
- **`tim-smart/dfx` (beta.73)** — `src/DiscordREST.ts`: decorate the Effect `HttpClient` with `HttpClient.tapRequest` (rate-limit gate) + `HttpClient.transformResponse` (sleep-on-429 then recurse) + `mapRequestInputEffect` (base URL/auth), and a reusable `Schedule.exponential("1 seconds").pipe(Schedule.either(Schedule.spaced("20 seconds")))` via `Effect.retry`.
- **`tim-smart/lalph` (beta.78)** — `src/Linear/TokenManager.ts`: `(yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk, HttpClient.retryTransient({ schedule: Schedule.spaced(1000) }))` + `HttpClientResponse.schemaBodyJson(Schema)` + `Layer.provide(FetchHttpClient.layer)`. And the LiveStatus degrade-to-`Option.none` chain: `.pipe(spawner.string, Effect.option, Schema.decodeEffect(PrState))`.
- **`alchemy-run/alchemy-effect`** — `src/Cloudflare/WorkersForPlatforms/DispatchNamespace.ts` is the literal dispatch-namespace REST concept hub uses, with `Effect.catchTag("DispatchNamespaceNotFound", () => Effect.succeed(undefined))`.
- **`executor` (beta.59)** — `registry.ts`: Effect `HttpClient` + `Effect.timeout(Duration.seconds(10))` + `Effect.withSpan`, with the `HttpClient` pulled from context so tests swap it.

### REFERENCE — fs

- **`effect-app/libs`** `fileUtil.ts` and **`executor`** `registry.ts` use the Effect `FileSystem` service (`NodeFileSystem.layer`) for `stat`/`readFileString`/`writeFileString`. **`tim-smart/openapi-gen`** shows `FileSystem.use((fs) => fs.readFileString(...))` for mockable manifest reads.

### For hub

- **Subprocess**: build one subprocess service (opencode `process.ts` + ghui `CommandRunner`), wrap each tool in a per-tool service (`git.ts` style) that names spans `Effect.fn("Tool.op")`, maps non-zero exit → a coarse tagged error with an `operation` discriminator, and provides a `run()` (degrade) vs `execute()` (surface) split. Register SIGKILL-on-abort (ghui). Scrub inherited `GIT_*` env so a process launched inside a git context can't target the wrong repo, and bump `maxBuffer` (arcwork `git/exec.ts`).
- **REST/LiveStatus**: motel's `tryPromise` + `AbortSignal.timeout` + `tapError`-to-degrade is the simplest fit; add dfx's `retryTransient`/exponential schedule for flaky reads. The whole adapter must **never throw** — terminate every path in a status state via `Effect.catch` (lalph's `Effect.option`, ghui's per-item catch). Two `retryTransient` facts verified against stock source (re-verified at beta.106): (1) its default `retryOn: "errors-and-responses"` mode ALSO repeats on a transient-status **response** (408/429/500/502/503/504) via a success-channel `Effect.repeat` — so it retries HTTP-level 429/5xx even **without** `filterStatusOk` (which is why hub can skip `filterStatusOk` for its 404→missing branching and lose nothing); (2) the `times` option caps ANY schedule, including a plain unbounded `Schedule.spaced` (`buildFromOptions` wraps the schedule in an attempt-count `while`), so `times: N` and `Schedule.upTo({ times: N })` (the beta.106 replacement for the removed `Schedule.take(N)`) are equivalent bounds. Note that `FetchHttpClient` applies NO timeout of its own (re-verified at beta.106) (only the interruption-linked AbortSignal) — add a per-attempt `HttpClient.transformResponse(Effect.timeout(...))` UNDER `retryTransient` so a hung connection times out, is classified transient, and retries before degrading. That transform bounds only time-to-headers (fetch resolves when headers arrive); bound the body read (`schemaBodyJson` etc.) with its own `Effect.timeout` or a stalled body stream still hangs.
- **fs**: `AppLoader` reads the manifest via the Effect `FileSystem` service so it stays mockable.

**beta.90 gotcha — the biggest decision point**: references split between (a) the v4 built-in `effect/unstable/process` `ChildProcess`/`ChildProcessSpawner` (opencode, alchemy, lalph, effect-app/libs `os-command.ts`) and (b) raw `node:child_process` wrapped in `Effect.promise`/`tryPromise` (arcwork `git/exec.ts`, effect-app/libs `CUPS.ts`, motel `daemon.ts`). Both work on beta.90. The built-in gives typed exit-code/stderr and integrates with FileSystem/Path; the raw-node path gives full control of error shape and the non-throwing-wrapper idiom (arcwork resolves `{stdout,stderr,exitCode,spawnFailed}` and `Effect.promise`s it). **Note: nobody used `@effect/platform` `Command` directly** — `effect/unstable/process` is the in-core v4 location. Use `Effect.callback` (not the older `Effect.async`) to bridge callback-style SDKs (effect-app/libs `Sendgrid.ts`, receipts). `effect/unstable/process` and `effect/unstable/http` are *unstable* subpaths that can move between betas — verify against the installed pin (both locations, and `ChildProcess`/`ChildProcessSpawner` within them, hold at beta.106).

---

## 8. Testing

Hub should fake `AppLoader`/`GitMetadataReader`/`LiveStatus`/the subprocess service via Layers and assert on typed failures.

### STEAL — `executor` (beta.59) recording-layer pattern + `effect-app/libs` (beta.90) `@effect/vitest` ergonomics

Files:
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/executor/packages/core/integrations-registry/src/registry.test.ts`
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/effect-app__libs/packages/infra/test/auth.test.ts`

executor's `registry.test.ts` is copy-ready for hub's adapters: `import { describe, expect, it } from "@effect/vitest"`, write `it.effect("name", () => Effect.gen(...))`, and fake a dependency with a recording `Layer.succeed(HttpClient.HttpClient)(HttpClient.make(req => Effect.gen(...)))` that captures requests into a `Ref` so you assert URL + headers + request count without touching the network. Temp dirs via `Effect.acquireUseRelease(mkdtemp, body, rm)`.

effect-app/libs shows the beta.90 ergonomics: `it.effect("name", Effect.fnUntraced(function*(){...}))`, negative assertions via `yield* Effect.flip(failingEffect)` then `expect(error).toBeInstanceOf(SomeTaggedError)`, and fakes from the service's own `static Fake`/`Default` layer:

```ts
it.effect("fails on malformed authorization headers",
  Effect.fnUntraced(function*() {
    const error = yield* Effect.flip(checkJWTI({...})(HttpHeaders.fromRecordUnsafe({ authorization: "Basic abc" })))
    expect(error).toBeInstanceOf(InvalidRequestError)
    expect(error.status).toBe(400)
  }))
```

### REFERENCE

- **`kitlangton/ghui` (beta.90)** — `test/githubServiceComments.test.ts`: the framework-agnostic fake — `Layer.succeed(CommandRunner, CommandRunner.of({ run: () => Effect.succeed(cannedResult), runSchema: ... }))` with a `RecordedCall[]` recorder array to assert exact subprocess args, provided under the real higher service via `GitHubService.layerNoDeps.pipe(Layer.provide(fakeCommandRunner(...)))`. (It uses `bun:test` + `runPromise`-bridge; re-implement under `@effect/vitest`'s `it.effect` for hub.)
- **`alchemy-run/alchemy-effect`** — `src/Test/Core.ts`: a `Test.make({ providers, state })` factory mirroring the production layer stack, with fakes provided as Layers and a `ResourceFailure` tagged error injected to exercise rollback paths. Good if hub wants test-layer wiring to mirror production composition.
- **`timhanlon/arcwork` (beta.74)** — `tests/git-detect.test.ts`: a per-test `ManagedRuntime.make(Layer.mergeAll(realLayers, stubLayers))` + `runPromise` + `dispose()` in `finally`; fakes via `Service.of({...})` or `Layer.succeed(Service, {...} as never)`. `tests/setup.ts` scrubs `GIT_*` env so a test run from a git hook doesn't operate on the real repo — **must-copy** for any hub test that shells to git.

### For hub

- Use the real `@effect/vitest` package (`it.effect`/`it.live`/`it.layer`; `it.scoped` no longer exists at beta.106 — `it.effect` already provides a `Scope`) — pinned to the same beta as `effect`.
- Give each service a `static Fake` layer (effect-app/libs). Test `Publisher`/`GitVersionRecorder` by providing a fake subprocess service with a recorder (ghui) — never touch real git/wrangler. Test `LiveStatus` with a recording `HttpClient` (executor).
- Assert typed failures with `Effect.flip` + `toBeInstanceOf` (effect-app/libs).
- Scrub `GIT_*` env in test setup (arcwork).

**beta.90 gotcha**: many references (ghui, motel, arcwork, opencode) use `bun:test` or a hand-rolled `testEffect` helper rather than `@effect/vitest` — their *faking technique* transfers but their *harness* does not. **Avoid** the `?test=${Date.now()}` cache-busting module re-import (motel) and real-Live-layer integration tests as the default — prefer fake Layers + `it.effect`. effect-app/libs is the cleanest beta.90 `@effect/vitest` example.

---

## 9. Project & Build Setup

We pin **effect@4.0.0-beta.90 exactly** (no caret) and co-pin the whole `@effect/*` ecosystem at beta.90.

### STEAL — `effect-app/libs` (beta.90) + `kitlangton/motel` (beta.90)

Files:
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/effect-app__libs/package.json`
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/effect-app__libs/tsconfig.base.json`
- `/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/kitlangton__motel/tsconfig.json`

effect-app/libs confirms hub's exact toolchain on our pin:

```jsonc
// package.json — exact pins, no caret
"effect": "4.0.0-beta.90",
"@effect/platform-node": "4.0.0-beta.90",
"@effect/vitest": "4.0.0-beta.90",
"@effect/language-service": "0.86.2",
"@typescript/native-preview": "7.0.0-dev..."   // "check": "tsgo --build"
```

motel's `tsconfig.json` is a clean, copyable strict baseline with the language-service plugin:

```jsonc
"plugins": [{ "name": "@effect/language-service" }]
// + NodeNext resolution, verbatimModuleSyntax, strict, isolatedModules, noEmit
```

### REFERENCE

- **`executor` (beta.59)** — the catalog single-source-of-truth pin (good even though hub is single-package), `tsconfig` with `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + the `@effect/language-service` plugin (`ignoreEffectSuggestions`/`WarningsInTscExitCode`), `tsgo --noEmit` fast path with `tsc --noEmit` as `typecheck:slow`, and `effect-language-service patch && effect-tsgo patch` in `prepare`.
- **`kitlangton/ghui` (beta.90)** — `tsconfig.json`: NodeNext+force, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions` (source imports use `.js`/`.ts` and still compile), `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`, and the language-service plugin. (Its runtime is Bun — swap for `@effect/platform-node`.)
- **`tim-smart/effect-genserver` (beta.85)** — the maintainer-blessed `tsconfig` with `namespaceImportPackages: ["effect", "@effect/platform-node", ...]` so `import * as Effect from "effect/Effect"` gets autocompletion, plus `allowImportingTsExtensions`/`rewriteRelativeImportExtensions`.
- **`get-tmonier/effract` (beta.88)** — pnpm `catalog:` exact pins, hexagonal layering enforced by dependency-cruiser, subpath aliases via package.json `imports` (`#domain/*`) **not** tsconfig `paths` (its `CLAUDE.md` explains paths mis-resolve across packages).

### For hub

- Pin `effect`, `@effect/platform-node`, `@effect/opentelemetry`, `@effect/vitest`, `@effect/language-service` **exactly** at the beta.90 line (no caret). Single-package, so no catalog needed — just lock the versions.
- `tsconfig`: `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`, `NodeNext` module/resolution (hub is Node-in-Sandbox), and the `@effect/language-service` plugin in `plugins[]` for inline error/layer diagnostics. Adopt the per-module `import * as Effect from "effect/Effect"` style.
- Typecheck with `tsgo` (`@typescript/native-preview`); keep `tsc --noEmit` as a slow fallback. Run `effect-language-service patch` in `prepare`.
- Use `@effect/platform-node` throughout (`NodeRuntime.runMain`, `NodeFileSystem.layer`, `NodePath.layer`) and `@effect/opentelemetry` NodeSdk — **not** the `@effect/platform-bun` or in-core `effect/unstable/observability` choices most references make.

**beta.90 gotcha**: caret ranges on betas invite breaking drift between builds — keep exact pins (alchemy uses a loose `>=4.0.0-beta.84` range and effect-http-starter uses `^beta.60`; both are the wrong call for hub). v4 pulls submodules from deep/unstable paths (`effect/unstable/http`, `effect/unstable/process`, `effect/unstable/cli`, `effect/References`, `effect/Logger`) that can move between betas — verify import locations against the installed pin (all five still exist at beta.106).

---

## Anti-patterns / cautions

Aggregated from across the references:

- **Tracing**: do NOT copy any in-core `effect/unstable/observability/OtlpTracer.layer` exporter wiring (alchemy, ghui, arcwork "Lensflare", motel's logger half). It's the workerd/Bun path; hub needs `@effect/opentelemetry` NodeSdk (opencode `otlp.ts`, motel `runtime.ts`). executor deliberately avoids NodeSdk because it crashes under workerd (async_hooks) — that reasoning does NOT apply to hub on Node.
- **Promise facade erases types**: `Effect.tryPromise(...).pipe(Effect.orDie)` at the facade (executor `promise.ts`) turns typed failures into defects. Do all typed-error rendering on the Effect side *before* crossing into a Promise.
- **`Effect.race` hangs on fast failure**: v4 `race` prefers first *success*. Use `Effect.raceFirst` for first-to-settle (executor `engine.ts`, opencode `process.ts`).
- **Rollback of committed remote state can't be a finalizer**: alchemy's `Apply.ts` carries `TODO(sam): support roll back ... some UPDATEs may not be reversible`; arcwork hand-rolls imperative git-worktree rollback. Use finalizers for ephemeral handles only; model the half-succeeded `wrangler deploy` as explicit compensation + persisted status.
- **`Effect.die` for recoverable conditions** (openapi-gen funnels failures to `Effect.die`, giving `Effect<string, never>`; effect-genserver dies on unknown tags; sandromaglione dies on missing refs) defeats hub's typed-error goal. Always `Effect.fail` a `Data.TaggedError`. Reserve `die` for genuinely-impossible states.
- **Hand-rolled error shapes**: `class X extends Error { readonly _tag = "X" }` (motel boundary, dfx `BadWebhookSignature`) and Schema-struct errors `{ _tag: Literal("NotFound") }` (effect-http-starter) lose `catchTag`/`Equal`/exhaustiveness. Use real `Data.TaggedError`/`Schema.TaggedErrorClass`.
- **`concurrency: "unbounded"` against a rate-limited API** (dfx uses it freely) invites self-inflicted rate limiting. Cap concurrency for Cloudflare REST reads and publish fan-out.
- **`.orDie` on a path that must degrade**: the LiveStatus listing must `catch`→"unavailable", not `.orDie` (follow effect-app/libs `Store/SQL.ts` map-to-typed-error, then catch).
- **Bun-isms**: most references run on Bun (`BunRuntime`, `BunHttpServer`, `Bun.spawn`, `@effect/sql-sqlite-bun`, `bun:test`, cross-spawn for Windows). Hub is Node-in-Sandbox on Linux — swap to `@effect/platform-node` defaults and drop the Bun branches.
- **Over-heavy machinery**: skip opencode's `LayerNode` DI graph, alchemy's resource-graph/DAG scheduler, lalph's `Semaphore`+`FiberSet` worker loop, arcwork's `NotificationStatusFix` MCP middleware — all scale- or client-specific overhead for hub's five flat services and linear pipeline.
- **`*Unsafe` escape hatches** (`Context.makeUnsafe`, `Semaphore.makeUnsafe`, `PubSub.publishUnsafe`) and `as any` (effect-genserver internals) are library-building tools — keep hub's application services in the typed, non-Unsafe surface.
- **Browser/React boundaries**: receipts/effract/ghui/arcwork drive Effects through `@effect/atom-react` `Atom.runtime` or xstate — do NOT copy for hub's MCP/CLI boundary.
- **`effect/unstable/*` churn**: unstable subpaths and `Effect.callback` (replaces `Effect.async`), `Cause.prettyErrors` (replaces `makeFiberFailure`) shifted across betas — pin exactly and verify against the installed pin (all of these hold at beta.106).

---

## Reference Index

| Repo | effect | Local path (`/Users/johngiardiniere/.btca/agent/sandbox/effect-v4-refs/…`) | Best example of | Tier |
|---|---|---|---|---|
| executor | 4.0.0-beta.59 | `executor` | Boundary (engine/facade split), Tagged errors (boundary rendering), Services, Testing (recording layer) | TOP |
| sst/opencode | 4.0.0-beta.83 | `sst__opencode` | Subprocess (`process.ts`/`git.ts`), NodeSdk tracing (`otlp.ts`), resource safety (spawn kill), services | TOP |
| kitlangton/motel | 4.0.0-beta.90 | `kitlangton__motel` | NodeSdk wiring (`runtime.ts`), MCP boundary, acquireRelease rollback (`localServer.ts`), fetch wrap (`motelClient.ts`) | TOP |
| effect-app/libs | 4.0.0-beta.90 | `effect-app__libs` | Service+Fake blueprint (`CUPS.ts`), resource lock/temp (`fileUtil.ts`), `@effect/vitest`, runtime/`CauseException`, project setup | TOP |
| alchemy-run/alchemy-effect | 4.0.0-beta.84+ | `alchemy-run__alchemy-effect` | Dispatch-namespace REST + degrade-by-tag, subprocess (`Command.ts`), one-choke-point tracing, rollback-as-state-machine | HIGH |
| timhanlon/arcwork | 4.0.0-beta.74 | `timhanlon__arcwork` | Subprocess non-throwing wrapper (`git/exec.ts`), MCP host wiring, runtime/Scope shutdown, concurrency, GIT_* scrub | HIGH |
| tim-smart/lalph | 4.0.0-beta.78 | `tim-smart__lalph` | `addFinalizer` rollback (`Worktree.ts`), subprocess + REST (`HttpClient`), tagged errors + `catchTags`, services | HIGH |
| tim-smart/dfx | 4.0.0-beta.73 | `tim-smart__dfx` | REST client decoration + retry `Schedule` (`DiscordREST.ts`), service house-style, acquireRelease, bounded concurrency | HIGH |
| kitlangton/ghui | 4.0.0-beta.90 | `kitlangton__ghui` | `CommandRunner` (subprocess + SIGKILL), `layerNoDeps`/`layer` split, LiveStatus degrade layer, error unions, fake+recorder tests | HIGH |
| tim-smart/effect-genserver | 4.0.0-beta.85 | `tim-smart__effect-genserver` | `Context.Service` shape, project/tsconfig + language-service, `Effect.fn` vs `fnUntraced` | MED |
| tim-smart/openapi-gen | 4.0.0-beta.75 | `tim-smart__openapi-gen` | Boundary (runMain + runPromise split), `Effect.callback` foreign wrap, `FileSystem.use`, project skeleton | MED |
| timhanlon/receipts | 4.0.0-beta.59 | `timhanlon__receipts` | Service `static layer` convention, HTTP client (`retryTransient` + `schemaBodyJson`), bounded `forEach`/`FiberMap` | MED |
| sandromaglione/getting-started-xstate-and-effect | 4.0.0-beta.66/.64 | `sandromaglione__getting-started-xstate-and-effect` | ManagedRuntime-at-edge, `Data.TaggedError` + `catchTag` basics (syntax sanity-check only) | LOW |
| rxssula/effect-http-starter | 4.0.0-beta.60 | `rxssula__effect-http-starter` | Project setup (language-service + tsgo patch), `Context.Service` shape (anti-pattern errors) | LOW |
| get-tmonier/effract | 4.0.0-beta.88 | `get-tmonier__effract` | Boundary-as-port pattern, hexagonal layering + catalog exact-pin (negative control for the four priorities) | LOW |
