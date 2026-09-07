# Effect v4 house style for Gauntlet

Use this document with the `effect` skill when changing Effect code. Gauntlet's
ADRs, `CONTEXT.md`, and the rules below supply the project-specific decisions.
[The patterns guide](effect-v4-patterns.md) points to working examples in this
repository. Use plain Schema models. Gauntlet uses `Data.TaggedError` for typed
failures, overriding the skill's `Schema.TaggedError` default; the lint gate
rejects Schema class constructors.

This guide was checked for the rc.112 upgrade against the repository's usage,
lint diagnostics, and installed source for the APIs discussed below. It is not
an exhaustive verification of Effect. `package.json` owns the exact pin;
verify unfamiliar signatures in `node_modules/effect` before using them.

## Rules

Numbers remain stable because lint diagnostics and source comments cite them.
Hub-only constraints from the imported guide do not govern Gauntlet.

1. Pin `effect`, `@effect/platform-node`, and `@effect/vitest` to the same exact
   version. `scripts/check-effect-pin.ts` enforces the Effect release family;
   `@effect/tsgo` has an independent version. An upgrade must be in task scope.
   CLI switches use `Flag.boolean(...).pipe(Flag.withDefault(false))` when
   omission means false; use `Flag.optional` when absence has its own meaning.
2. Use `effect/unstable/http/*` and `effect/unstable/process/*` for HTTP and
   subprocess work. `@effect/platform-node` is the platform adapter;
   `NodeServices.layer` supplies filesystem, path, and subprocess services.
   Imports from `@effect/platform` and `@effect/platform-bun` are rejected.
3. Import Effect modules by namespace, such as
   `import * as Effect from "effect/Effect"`. Relative TypeScript imports have
   explicit `.ts` extensions. Read the package scripts for execution and build
   commands; Gauntlet supports source execution and compiled release binaries.
4. Prefer Effect `FileSystem` and `Path` services in application logic. Gauntlet
   has Node types and uses Node globals and imports at runtime and SDK adapter
   boundaries. The imported Hub restriction on `node:*`, `process`, and `Buffer`
   does not apply to this repository.
5. Run Effects at executable boundaries, such as `bin/gauntlet.ts`. Application
   orchestration stays Effect-native. Render typed failures in the CLI before
   leaving Effect; bridge Pi's Promise and callback contracts in its adapters.
6. Services use stock `Context.Service<Self, Contract>()("gauntlet/Name")` with
   explicitly constructed Layers. `Linear.Default` and `Linear.Fake` show one
   arrangement; `HarnessSessionFactory` has separate live and scripted Layers.
   Keep orchestration as Effect functions requiring those services through `R`.
7. Model recoverable failures with `Data.TaggedError` and the typed error channel.
   Use `Effect.catchTag`, `Effect.catchTags`, or `Predicate.isTagged` for error
   dispatch. Raw `throw new Error`, hand-written error tags, and `instanceof`
   checks for tagged errors are rejected in production. Expected invocation
   endings are `AgentOutcome.termination` data, as defined in `CONTEXT.md`.
8. Subprocess adapters own output capture and exit classification. Follow
   `src/target/git.ts` and `src/github/github.ts`, which consume stdout and stderr
   concurrently with the exit code. The imported Hub `CommandRunner` modes and
   its byte cap are not a Gauntlet abstraction or a Gauntlet-wide contract.
9. Enrichment may degrade only where the caller's contract permits it.
   `availableUpdateNotice` can return no notice; specification acquisition can
   return an explicit diagnostic. Preserve the difference between missing work
   and successful work. `Effect.catch` handles typed failures; it cannot catch
   a defect when the error channel is `never`. Do not use `orDie` to implement
   a path that promises degradation.
10. Use scoped finalizers for temporary worktrees, subscriptions, sessions, and
    other ephemeral resources. Keep durable Run artifacts and external delivery
    effects outside rollback-by-finalizer assumptions. See `run-record.ts`,
    `review-working-directory.ts`, and `delivery.ts` in their source directories.
11. Use the current v4 names: `Effect.catch`, `Effect.callback`, and
    `forkScoped`/`forkChild`/`forkDetach`. `Stream.runFold` takes a lazy initial
    value. Check the installed source when moving older code across these APIs.
12. `Effect.race` waits for the first success. Use `Effect.raceFirst` when the
    first completion, including failure, must win. Invocation watchdogs depend
    on this distinction.
13. Bound `HttpClient.retryTransient` with a numeric `times` option or a bounded
    schedule such as `Schedule.spaced(...).pipe(Schedule.upTo({ times: n }))`.
    Its default mode retries both transient errors and transient responses.
    Put per-attempt timeouts below retry; bound body reads separately when the
    operation requires a deadline. A fetch response only proves headers arrived.
14. Choose concurrency for the actual work and resource budget. Gauntlet's
    Finder partitions and downstream evaluation paths have explicit scheduling
    semantics. Preserve those decisions; the imported Cloudflare API cap is
    not a blanket ban on `concurrency: "unbounded"` in this pipeline. Partial
    work must still produce an explicit coverage gap or a typed failure.
15. The Effect filesystem service exposes `readLink` and `stat`, not `lstat`.
    When traversal must exclude symlinks, identify links before following their
    targets. Preserve the adapter's path policy and distinguish I/O failures
    from missing paths.
16. Decode untrusted data with Effect Schema. Keep each domain or tool contract
    authoritative for its TypeScript type, runtime decoder, and JSON Schema
    projection where needed. `Schema.optionalKey` models absent JSON fields;
    explicit `undefined` at a JavaScript SDK boundary needs a different schema.
    Document proof beside unavoidable SDK casts. Hub's Cloudflare-envelope and
    shared-Zod exceptions have no application here.
17. Read environment configuration through `Config` inside service construction.
    Production Effect function spans use static names of the form
    `gauntlet.<snake_case_module>.<snake_case_method>`. Fake/Test functions inside
    production files may use their existing `Service.Fake.*` / `Service.Test.*`
    naming. See `Linear` for optional credentials and injected HTTP dependencies.
18. Use `@effect/vitest` and `it.effect` for Effect tests. TestClock does not
    auto-advance: fork delayed work and drive `TestClock.adjust`. Use `it.live`
    when real elapsed time is the behavior under test. Direct `Effect.sleep`
    calls in test files are rejected by lint.
19. Replace external services with Layers or `Effect.provideService`. The
    scripted HarnessSession adapter records the same contract as Pi; HTTP tests
    supply a fake client. Use real temporary filesystems and fixture Git
    repositories for filesystem and target behavior. Ordinary tests do not pay
    for live model invocations; explicit live gates exercise the real adapter.
    Test a Stage through its interface and reserve CLI tests for CLI contracts
    and a few complete journeys, as specified in `CLAUDE.md`.
20. Assert typed failures with `Effect.flip` and concrete error assertions.
    Supply environment configuration through `ConfigProvider` test Layers;
    do not mutate `process.env` in tests. Filesystem-backed settings use fixture
    files and the injected home/configuration boundary.
21. Comments explain current behavior, constraints, and non-obvious rationale.
    Change history belongs in commit messages. Retain explanations of schema
    projections, retry ownership, and filesystem isolation when they justify
    code that otherwise looks unnecessary.
22. Preserve failure honesty at reads and existence checks. Treat `NotFound`
    as absence only where allowed; permission and other I/O errors remain
    failures. `readOptionalArtifactText` is the local example. A shorter list
    after a failed item must be represented as degraded work, not silent success.
    Disposable update-cache state is an explicit enrichment exception.
23. Idempotent HTTP operations use bounded transient retries. Do not auto-retry
    external mutations such as posting a delivery comment. Request semantics,
    rather than the HTTP verb alone, determine idempotence: Linear GraphQL reads
    use POST. See `linear.ts` and `delivery.ts` for the two cases.
24. Bound pagination and polling explicitly and report incomplete results
    honestly. Linear's page limits are an example.
    A truncated lookup cannot silently authorize an action that requires the
    complete result.
25. Public service operations use named `Effect.fn` with rule 17's vocabulary.
    `Effect.fnUntraced` is confined to `*.test.ts` files. Pure helpers and simple
    Effect combinator wrappers do not need an extra service or tracing layer.

## Review checks

Use the rules above with the repository's lint, typecheck, and test gates.
Pay particular attention to error-to-default conversions, resource lifetime,
changes to retry ownership, and casts that conceal schema drift. Review new
protections against Gauntlet's standing constraint in `CLAUDE.md`: each needs
measured or structural justification.
