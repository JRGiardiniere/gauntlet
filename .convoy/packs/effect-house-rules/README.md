# effect-house-rules

Our own Oxlint rules for Effect code, shared by every Effect project, as the `house` plugin. They sit beside Effect's official diagnostics (the `effect` pack), oxlint's own rules (the `typescript` pack) and anti-slop's.

The bar for a rule here is high: the Effect team and the effect skill's author know Effect better than we do, so we start from their tools and guidance and add a rule only when it catches a problem we have actually hit and nothing official catches it. Two rules guard the fence itself rather than Effect code (`directive-reason`, `no-module-level-mutable-state`): they're cheap, have no false positives in our code, and close shortcuts the other rules can't see. When an official rule appears that covers one of these, the house rule goes.

## The rules, and why each is here

| Rule | What it catches | Why it's ours |
|---|---|---|
| `retry-schedule-bounded` | `HttpClient.retryTransient(...)` and `HttpClient.withRateLimiter(...)` without a bound | Both retry forever by default (`retryTransient` with no options also retries with no delay), the types don't say so, and no official rule checks it. |
| `no-effect-promise` | `Effect.promise(...)` outside tests (`*.test.ts`, `*.integration.ts`, `*.fixture.ts`) | A rejection inside `Effect.promise` becomes an untyped defect. At the API borders where Promises enter our code, `Effect.tryPromise` with a typed error keeps the failure visible. A Promise that truly can't reject gets a disable comment saying why. |
| `require-ts-extension-imports` | A relative import with no extension, or with `.js` where the file is TypeScript | Where Node runs TypeScript directly, `./x.js` that names `x.ts` type-checks but fails at runtime, and bundler-resolution projects don't check extensions at all. oxlint's `import/extensions` can't tell a `.js` that names a real JavaScript file from one that names TypeScript, and flags `@/` path aliases, so it isn't a substitute. |
| `directive-reason` | An `oxlint-disable`, `eslint-disable` or `@effect-diagnostics` comment with no reason after ` -- `. An `@effect-diagnostics` comment that only sets checks to `error` makes them stricter and needs none. | A disable comment is how a shortcut gets past every other rule here; the reason is what lets a reviewer tell an exception from a dodge. Ratstack's fence enforces the same; nothing in oxlint does. |
| `no-module-level-mutable-state` | A module-level `let` or `var` outside tests (`*.test.ts`, `*.integration.ts`, `*.fixture.ts`) and `scripts/**` | A server process or Worker isolate serves many requests with one module instance, so module state leaks from one request into the next. From Ratstack's fence; oxlint has no equivalent. |

## Retired rules

These were house rules until October 2026. Each either duplicated an official rule or enforced a preference of ours that didn't clear the bar. A project config or disable comment that still names one fails lint (`Rule '…' not found in plugin 'house'`), so delete the reference.

| Retired rule | Now |
|---|---|
| `no-instanceof-tagged-error` | Effect's `instance-of-schema`, on in the `effect` pack (errors are `Schema.TaggedError`, per the effect skill) |
| `no-raw-error-throw` | Effect's `extends-native-error`, `try-catch-in-effect-gen` and `global-error-in-effect-failure` |
| `no-sleep-in-tests` | the effect skill's testing guidance (`TestClock`, deterministic synchronization); not linted |
| `effect-fn-span-format` | the effect skill's `Effect.fn("Domain.operation")` naming; not linted |
| `no-schema-class` | the effect skill's guidance; `Schema.Class` is fine where nominal identity or methods are wanted |
| `no-import-from-barrel-package` | dropped: the barrel imports upstream and the effect skill use are allowed |
| `no-effect-platform-imports` | the type checker: `@effect/platform` isn't a v4 dependency, so its imports don't resolve |
| `no-fnuntraced-outside-tests` | dropped: the effect skill allows `Effect.fnUntraced` for internal helpers |

## The files

- `oxlintrc.json` loads the plugin and turns the five rules on at `error`. A rule added here is on in every project at the next sync.
- Each rule has its test beside it (`*.test.ts`, run with the project's test runner through `rule-tester.ts`).

**Convoy manages these files.** They're copied from `config/packs/effect-house-rules/` in the convoy repo into `.convoy/packs/effect-house-rules/` of every project whose `convoy.toml` lists `effect-house-rules`, as uncommitted changes that go in with the project's next commit. An edit here, such as a fix to a rule, shows in Convoy's Review: promote it and every other project on the pack has it within seconds.

## In a project

`convoy project init --pack effect-house-rules` adds `@oxlint/plugins` at exactly the project's `oxlint` version (the plugin imports it) and `vitest`, and Convoy adds the pack to the project's `.oxlintrc.json` `extends`. A project's own exceptions (a rule turned off for some files) go in its own config. Include `.convoy/packs/**/*.test.ts` in the project's Vitest run so the rules' tests run.
