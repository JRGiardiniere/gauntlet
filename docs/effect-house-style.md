> **Imported reference (cloudflare-hub).** This doc was written for cloudflare-hub
> against effect@4.0.0-beta.90; gauntlet pins **4.0.0-rc.110**, and every code
> snippet, import path, API name, and signature claim below has been **verified
> against the installed beta.106 source** (verified 2026-08-10; the beta.106→rc.110
> changesets touch no API this doc prescribes except the CLI boolean semantics
> recorded below, re-checked 2026-08-18). The substantive
> beta.90→106 renames folded in: `Schedule.take(n)` → `Schedule.upTo({ times: n })`
> and `Schema.TaggedErrorClass` → `Schema.TaggedError`. Read it as the house style's
> rationale and rule set, not as gauntlet gospel: hub-specific scopes
> (`platform/operations`, the zod wire boundary, Cloudflare Sandbox constraints) do
> not apply here, and the span prefix is `gauntlet.`, not `hub.`.
> Update this doc in place as gauntlet's own style decisions land.

# Effect v4 House Style — cloudflare-hub

Every agent writing or reviewing Effect code in `platform/operations` (or the future
MCP host) gets BOTH documents in its brief: this file, plus the `effect` skill (Kit
Langton's opinionated Effect v4 guide, installed at `~/.claude/skills/effect/` —
point agents without skill support at that path; its `SKILL.md` routes to per-topic
`references/` files). This file is the **project overlay** on that skill: the skill
and its `references/` files are the base layer
for general Effect guidance — schemas, services, config, scheduling, caching, streams,
HTTP clients, testing. This overlay carries only what the skill cannot know: hub's
litigated deviations, toolchain constraints, v4 traps at our exact pin, exemplars, and
the review checklist. **Where the two conflict, this overlay wins** — every deviation
below was litigated against a real failure, not a preference.

Deviations from the skill's defaults, for quick orientation: rule 6 (named service
classes with `static Default`/`static Fake`, not the module-namespace surface), rule 7
(`Data.TaggedError`, not `Schema.TaggedError`, except on the MCP wire), rule 8
(CommandRunner always-capture), rule 16 (loose Cloudflare envelope decoding — scoped to
Cloudflare API responses ONLY — and zod for cross-runtime wire contracts in `shared/`;
every other untrusted boundary uses Schema decoders per the skill). Everything else in
the skill applies as written.

**This sheet is the floor, not the ceiling.** It distills the gotchas we have already
hit — it does not cover every Effect mechanism you will need. When you face a mechanism
or API this sheet doesn't address, do NOT guess and do NOT assume silence here means
anything goes: read the matching skill reference file, search the local reference repos
and `node_modules/effect` (see "When unsure of an API" below), and consult
`docs/effect-v4-patterns.md` — the full per-concern steal/reference/avoid analysis these
rules were distilled from (decision record: `docs/effect-refactor-prd.md`).

**Golden rule: never trust memorized Effect knowledge.** We run effect v4 (developed in
`Effect-TS/effect-smol`) at the exact version pinned in `package.json`. Training data is
dominated by v3 and older betas; APIs moved. Before using any API you have not seen in
this repo, verify it against `node_modules/effect` (ground truth for our pin) or the
reference repos listed below.

## Non-negotiable rules

**Versions & imports**
1. `effect` and every `@effect/*` package are pinned **exactly** to one shared version
   (enforced by `scripts/check-effect-pin.mjs`) — no carets, no bumps unless the task
   explicitly says so.
   At rc.110, a bare CLI `Flag.boolean` is required when omitted. Ordinary switches
   need `Flag.withDefault(false)`; use `Flag.optional` only when absence is meaningful.
2. HTTP and subprocess are **in-core** in v4: `effect/unstable/http/*` (HttpClient,
   HttpClientRequest, HttpClientResponse, HttpClientError, FetchHttpClient) and
   `effect/unstable/process`. There is **no `@effect/platform`** package; never import
   `@effect/platform-bun`. Platform layer is `@effect/platform-node`
   (`NodeServices.layer` provides FileSystem + Path + ChildProcessSpawner together;
   `NodeRuntime.runMain` for entrypoints).
3. Import style: per-module namespace imports (`import * as Effect from "effect/Effect"`)
   and **explicit `.ts` extensions** on relative imports — Node ≥23.6 type-strips at
   runtime, there is no build step, and Node resolves the on-disk path.
4. The operations tsconfig has **no `@types/node`**: no `node:fs`/`node:path`/`node:url`
   imports, no bare `process`/`Buffer`. Use the Effect `FileSystem`/`Path` services, the
   casts in `platform/operations/node-globals.ts`, and `Stream.decodeText` for subprocess
   output. Fetch types come from the `WebWorker` lib (not `DOM`). `node:*` may appear
   only in the untypechecked `.mjs` boundary script.

**Architecture**
5. **One `runMain` boundary per executable edge**: the CLI's `scripts/hub.mjs` and the
   MCP host's `platform/mcp/server.mjs` (ADR 0014). Everything under `platform/operations` stays
   Effect-native — no `Effect.run*` calls inside the operations layer, ever. Render the
   typed error channel with `Effect.catchTags`/`Effect.match` **before** crossing into a
   Promise (the crossing erases types).
6. Services are the **stock two-param form**:
   `class S extends Context.Service<S, Shape>()("hub/S")` with explicit
   `static Default = Layer.effect(S, make)` and a `static Fake` for tests. Stock beta.106
   does NOT auto-generate `.Default` from a `{ make }` option (it only attaches a `.make`
   effect to the class) — that is the effect-app
   fork's extension; do not copy it. Orchestration entrypoints (publish/list/get) are
   top-level Effect **functions** requiring services via `R`, not services themselves.
7. Errors are `Data.TaggedError` per failure mode, prefer one coarse error per service
   with an `operation` literal-union discriminator plus `cause` over one class per verb.
   Reserve `Schema.TaggedError` (named `Schema.TaggedErrorClass` before beta.106) for
   errors that must serialize across the MCP wire.
   `Effect.fail` for anything recoverable — `Effect.die` only for genuinely impossible
   states. Never hand-roll `class X extends Error { readonly _tag = "X" }`.
8. `CommandRunner` is intentionally **always-capture** — one output path, piped and
   byte-capped, results in `CommandResult`. Do not add `inherit`/passthrough/live-TTY
   modes or TTY detection; this was litigated in PR #17 and reverted once already.
9. Live-status/enrichment paths **degrade, never fail**: fold failures into an
   `unavailable` value. When a method's declared error channel is `never` (failures
   already folded), a defensive net must be `Effect.catchCause` — `Effect.catch` is a
   no-op there and a defect would crash the caller. Never `.orDie` a path that must
   degrade. "Not checked" (field absent) ≠ "checked but unavailable" (field present).
10. Finalizers (`acquireRelease`/`addFinalizer` + `Effect.scoped`) are for **ephemeral**
    resources only: temp dirs, child processes, build contexts. Committed remote
    mutations (a half-succeeded `wrangler deploy`) get explicit compensating steps, not
    finalizers.

**v4 API traps (each of these bit us once)**
11. `Effect.catch` — there is no `catchAll`. `Effect.callback` — replaces `Effect.async`.
    `Cause.prettyErrors` — `makeFiberFailure` is gone. Fork names are
    `forkScoped`/`forkChild`/`forkDetach` (no `forkDaemon`).
    `Stream.runFold(stream, () => init, f)` takes a lazy initial value.
12. `Effect.race` prefers first *success* in v4, so a fast failure hangs waiting on the
    other branch — use `Effect.raceFirst` for first-to-settle.
13. `retryTransient`: the bound lives **in the schedule** (`Schedule.spaced(d).pipe(
    Schedule.upTo({ times: n }))` — `Schedule.take` no longer exists) or in `times: N`
    used alone (`times: N` caps whatever schedule is supplied — verified in beta.106's
    `buildFromOptions`); an unbounded schedule with no `times` bound retries forever. Its default mode also retries transient
    HTTP **responses** (408/429/5xx), so you do not need `filterStatusOk` to get 5xx
    retries. `FetchHttpClient` applies no timeout of its own — add per-attempt
    `Effect.timeout` under the retry, and bound body reads separately.
14. Bounded concurrency against the Cloudflare REST API — `{ concurrency: 4 }`-ish,
    never `"unbounded"`. Per-item bodies in a fan-out end with a catch so one failure
    can't abort the batch.
15. The Effect `FileSystem` service has no `lstat` and `stat` **follows symlinks** —
    probe with `fs.readLink` (success ⇒ symlink ⇒ skip) before `stat`-classifying.
16. Cloudflare API envelopes decode **loosely**: `Schema.optionalKey(Schema.Unknown)`
    per field (`optionalKey`, not `optional` — JSON never carries a literal
    `undefined`), hand-validate (only `success === false` is a failure). Strict schemas reject
    real 2xx responses (`result_info: null` etc.) and cause spurious degrades. This
    licenses the downstream hand-validated casts the loose envelope necessitates — but
    it is scoped to Cloudflare API responses only. Every OTHER untrusted boundary
    (uploaded manifests, tool arguments, third-party APIs) uses Schema decoders per the
    skill's defaults. Second carve-out (ADR 0032): **cross-runtime wire contracts in
    `shared/` are zod schemas** — both the Worker and the container must execute the
    same schema objects, and Effect Schema is too heavy for the Worker bundle. The
    container consumes them only through the boxed adapter in
    `platform/mcp/zod-schema.ts` (`schemaFromZod`); do not hand-mirror a shared zod
    contract as an Effect Schema, and keep Effect Schema the default for every
    container-internal boundary.
17. Read config via `Config`/`Config.option` inside `make` (unset env degrades the
    service, never fails the layer build). Spans: production operations are named
    `Effect.fn("hub.<snake_case_module>.<snake_case_method>")` — one `hub.` vocabulary
    so trace queries never chase per-service naming; static Fake/Test surfaces inside
    production files keep `Service.Fake.method` / `Service.Test.method` names (rule 19).
    The tracing layer collapses to `Layer.empty` when the OTLP endpoint config is unset.

**Testing**
18. `@effect/vitest` with `it.effect` + `Effect.gen`/`Effect.fnUntraced`. `it.effect`
    uses a TestClock that never auto-advances — a test exercising delays (retry
    schedules, timeouts) must either drive the clock per the skill's default (fork the
    sleeping effect, then `TestClock.adjust`) or use **`it.live`** when real elapsed
    time is itself the behavior under test (e.g. proving `retryTransient` genuinely
    waits). A delay test that does neither hangs.
19. Fakes are Layers. Stateless fakes: the service's `static Fake`
    (`Layer.succeed(S, S.of({...}))`). Stateful/controllable fakes (call recording,
    scripted failures): the skill's dual-tag pattern — `TestInterface extends
    Interface`, a separate `TestService` tag, one `Ref`-backed implementation behind
    both tags via `Layer.effectContext` (see the skill's `references/TESTING.md`).
    Fake HTTP via
    `Layer.succeed(HttpClient.HttpClient, HttpClient.make(...))` returning
    `HttpClientResponse.fromWeb`. Never touch real git/wrangler/network in tests.
20. Assert typed failures with `Effect.flip` + `expect(e).toBeInstanceOf(TheError)`.
    Drive config with a `ConfigProvider.layer(ConfigProvider.fromUnknown({...}))` merged
    into the test layer — never mutate `process.env`.

**Style**
21. Comments describe current behavior only — never change-history ("previously",
    "now uses", "fixed to"). That story belongs in commit messages.

**Failure honesty (added after the 2026-07-15 skill audit — these are the softening
patterns that had crept in)**
22. Never collapse an existence or read check into its absent-value default when the
    result drives control flow: no `fs.exists(...).pipe(Effect.orElseSucceed(() =>
    false))`, no blanket `Effect.catch(() => Effect.succeed(default))` around reads. A
    permission or I/O error must not masquerade as "file missing" — it produces wrong
    typed errors (`AppNotFound` on an `EACCES`) and can reclassify failures (a
    `package.json` read error becoming a dependency-policy denial). Discriminate
    not-found from real failures; `committedPathIs` in `operations.ts` is the exemplar.
    The same rule covers collection results: a per-item failure inside a list/fan-out
    must never yield a silently shorter result — either fail the operation or return an
    explicitly structured degraded result that names what was dropped.
23. Idempotent HTTP operations get a bounded `retryTransient` by default —
    `live-status.ts` is the exemplar, including its per-attempt timeout placement.
    Non-idempotent operations (issue-creation POSTs, deploys) are never auto-retried;
    say so in a comment at the client, as `tracker.ts` does.
24. Pagination and polling loops are always explicitly bounded (`MAX_PAGES`-style cap,
    bounded `Schedule`, or `Stream.paginate` + `Stream.take`). "The API surely
    terminates" is not a bound. Hitting the bound must be truthful: surface truncation
    as a typed failure or an explicit truncated marker, or handle it conservatively —
    an incomplete result must never silently drive an action that assumes completeness
    (e.g. a dedup lookup double-filing because its scan was cut short).
25. Public service methods use `Effect.fn` with rule 17's span naming.
    `Effect.fnUntraced` is confined to `*.test.ts` files — the repo-wide purge
    (PR #168) removed every production use, and lint keeps it that way.

## Write it like the existing code

`platform/operations` is fully converted and review-hardened — it is the primary
exemplar. Before writing new code, open the closest match:

| Writing… | Imitate |
|---|---|
| A service over HttpClient (retry, pagination, degrade) | `platform/operations/live-status.ts` |
| A subprocess-backed service | `platform/operations/command-runner.ts`, `git-repo.ts`, `git-exec.ts` |
| A stateful test fake (recording, scripted failures) | `platform/operations/command-runner.fake.ts` |
| Top-level orchestration Effect fns | `platform/operations/registry.ts`, `operations.ts`, `publisher.ts` |
| Layer composition / AppLayer | `platform/operations/runtime.ts` |
| Tagged errors | `platform/operations/errors.ts` |
| Tests (service fakes, ConfigProvider, flip assertions) | `registry.test.ts`, `live-status.test.ts` |
| The runMain boundary | `scripts/hub.mjs` |

## When unsure of an API or mechanism — lookup ladder

Use this ladder for anything the rules above don't settle — an unfamiliar API, a design
question (how to shape a stream, cache a layer, structure a scheduler), or any "how do
real v4 codebases do X" question. This is expected, routine work, not a fallback.

1. **`node_modules/effect`** in this repo — the arbiter for the pinned version's
   signatures and import paths (`effect/unstable/*` subpaths move between releases).
2. **Reference repos** at `~/.btca/agent/sandbox/effect-v4-refs/` (grep them; each is a
   full checkout of a real v4 codebase). Search broadly — the table maps known strengths,
   but any of them may hold the pattern you need. Caveat: they span beta.31–.90, all
   older than our pin — patterns transfer, exact signatures may not.

| Question | Repo (under `effect-v4-refs/` unless noted) |
|---|---|
| Overall architecture, engine + Promise facade | `~/.btca/agent/sandbox/executor` |
| Subprocess service, NodeSdk tracing wiring | `sst__opencode` (`packages/core/src/process.ts`, `git.ts`, `observability/otlp.ts`) |
| Beta.90 (nearest our pin): MCP boundary, acquireRelease, fetch wrap | `kitlangton__motel` |
| Beta.90 (nearest our pin): CommandRunner, layerNoDeps/layer split, error unions | `kitlangton__ghui` |
| Service+Fake blueprint, @effect/vitest ergonomics, file locks | `effect-app__libs` (beware: their `Context` is a fork wrapper) |
| Maintainer-canonical API usage | `tim-smart__dfx` / `lalph` / `openapi-gen` / `effect-genserver` / `receipts` |
| Dispatch-namespace REST, degrade-by-tag | `alchemy-run__alchemy-effect` |
| Non-throwing subprocess wrapper, GIT_* env scrub | `timhanlon__arcwork` |
| Effect library source (beta.92 tarballs) | `~/.btca/agent/sandbox/effect-beta-packages` |

3. **`docs/effect-v4-patterns.md`** — the full steal/reference/avoid analysis per
   concern (boundary, errors, services, tracing, rollback, concurrency, external calls,
   testing, project setup), with exact file paths into the repos above.

## Review lens

Reviewers: check the diff against every rule above. The highest-yield drift smells,
roughly in order of how often they appear:

- Untagged errors, thrown `Error`s, or `Effect.die` on a recoverable path (rule 7, 11).
- `Effect.run*` anywhere below the boundary (rule 5).
- Hand-rolled `fetch`/`child_process` instead of the in-core HttpClient / CommandRunner
  (rule 2, 8); any new output mode or TTY branch on CommandRunner (rule 8).
- `node:*` imports or bare `process`/`Buffer` inside `platform/operations` (rule 4).
- `.orDie` / missing catch on a degrade path; `Effect.catch` where the error channel is
  `never` (rule 9).
- Unbounded concurrency or an unbounded retry schedule (rules 13–14).
- A new service missing `static Fake`, or tests hitting real git/network/env (18–20).
- Finalizer used to undo a committed remote mutation (rule 10).
- `orElseSucceed`/blanket-catch collapsing an existence or read check into a default
  on a control-flow path (rule 22).
- Hand-rolled `typeof` validation or `as` casts at an untrusted boundary that isn't a
  Cloudflare envelope — should be a Schema decoder, or the shared zod contract via
  `schemaFromZod` when the shape crosses the Worker↔container boundary (rule 16 scope
  note, skill SCHEMA.md); a hand-mirrored Effect Schema of a `shared/` zod contract is
  drift waiting to happen.
- Bare `client.execute` on an idempotent HTTP path with no `retryTransient` (rule 23);
  an unbounded pagination/polling loop (rule 24).
- `Effect.fnUntraced` outside a `*.test.ts` file (rule 25).
- Type-assertion casts on an Effect's error/requirement union (`as Effect.Effect<...>`)
  to force a union past inference.
- Caret or drifted version pins (rule 1); imports from paths not verified against
  the pinned version (golden rule).
- Change-history comments (rule 21).
