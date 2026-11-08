# effect

The official Effect diagnostics from [`@effect/tsgo`](https://github.com/Effect-TS/tsgo), run inside the project's normal type-aware Oxlint pass as the `effecttsgo/*` rules, with our house severities.

- `oxlintrc.json` extends the `recommended` preset of the project's installed tsgo (`node_modules/@effect/tsgo/oxlint-presets/recommended.json`), which turns on type-aware linting, and makes the house choices: 22 rules at `error`, with `strict-effect-provide` off in `**/*.test.ts`, `**/*.integration.ts`, `**/*.fixture.ts` and `scripts/**`, which provide their own layers. It also turns off oxlint's `require-yield`, which misfires on Effect generators.
- It adds 7 rules at `error` that are outside the `recommended` preset: `map-map-error-to-map-both`, `provide-merge-all-to-array`, `type-union-to-schema-union`, `yield-in-call-argument`, `effect-try-without-catch`, `global-json` and `global-json-in-effect`. It turns off `prefer-schema-over-json`, which tsgo 0.64.1 deprecates in favour of `global-json-in-effect` and `global-json`, so the same JSON call isn't reported twice.
  - It also turns on 18 of tsgo's optional rules at `error`. The line: a rule is on when it protects behaviour or testability, or gives the code one canonical form, however many edits that takes.
    - Behaviour and testability: `global-random`, `crypto-random-uuid` and `-in-effect` (randomness Effect's services can't make deterministic in tests), `global-console` and `-in-effect` (logs that skip Effect's logger and its spans), `schema-sync` (decoding that throws instead of failing with a typed error), `prefer-schema-tagged-error` (the `effect` skill's error rule), `missing-effect-service-dependency` and `nested-effect-gen-yield`.
    - One canonical form: `prefer-effect-array`, `-string` and `-record` (absence as `Option`, non-empty arrays in the types), `new-schema-class` (`X.make`, which validates exactly as `new X` does), `missed-pipeable-opportunity`, `effect-do-notation`, `schema-union-of-literals`, `service-not-as-class` and `unnecessary-arrow-block`.
    - `schema-sync` and `global-console` are off in tests, fixtures and `scripts/**`, where throwing and printing are the point. Non-Effect code (a React client, deploy scripts) turns rules off in the project's own config.
    - Left off: `missing-pipeable-signature` and `api-stability-leak`, which are for library authors (Effect's own example apps don't follow them); `prefer-barrel-import`, which contradicts importing from leaf modules; `deterministic-keys` and `prefer-namespace-import`, whose settings (key pattern, package list) oxlint can't pass, so one ties keys to file paths and the other does nothing; `strict-boolean-expressions`, whose TypeScript equivalent in the `typescript` pack takes options; and `prefer-schema-over-json`, deprecated as above.

**Convoy manages these files.** They're copied from `config/packs/effect/` in the convoy repo into `.convoy/packs/effect/` of every project whose `convoy.toml` lists `effect`, as uncommitted changes that go in with the project's next commit. An edit here shows in Convoy's Review, to promote to every project or discard.

## Three layers

| Layer | What it is | Where it lives |
|---|---|---|
| Default | which rules exist, and their normal severities | the project's installed tsgo, whose preset the pack extends |
| House custom | our shared choices, the same in every project: 47 rules at `error` (22 from the preset's set, 7 outside it and 18 optional ones) | this pack's `oxlintrc.json` |
| Project custom | one project's own changes, which win over the pack's | the project's `.oxlintrc.json` |

A choice every project shares goes here, not into each project's config; a project whose code doesn't pass a rule yet turns it off in its own config as tracked debt. The pack also sets each rule a project's `categories` would otherwise decide (such as `strict-effect-provide` and `any-unknown-in-error-context`), so every project runs the same Effect rules whatever its categories. The pack never restates defaults. Rules a newer tsgo adds come with the project's own upgrade, at upstream's severities, and nothing here changes.

## Versions

Each project keeps its own tool versions; the pack doesn't list or check them. An older tsgo's preset has fewer rules, so it runs fewer at their defaults; the rules this pack names must still exist in that tsgo, though not necessarily in its preset (below). What can go wrong fails lint loudly:

- **A rule this pack names that the project's tsgo lacks:** oxlint refuses the config (`Rule '…' not found in plugin 'effecttsgo'`). The rules here need tsgo 0.64.1 or later, which every project has. There are no per-version files: a house change to a rule only a newer tsgo has waits until every project has upgraded to it.
- **An oxlint the project's tsgo doesn't support:** the patch refuses to run. Check tsgo's release notes for the supported `oxlint` and `oxlint-tsgolint` versions before upgrading either.
- **A patch that hasn't run:** `Unknown plugin: 'effecttsgo'`. The patches (`prepare`: `effect-tsgo patch --oxlint`, which patches TypeScript too) have to run again after any upgrade of tsgo, TypeScript, Oxlint or `oxlint-tsgolint`. pnpm runs `prepare` on `pnpm install`, but not on `pnpm add` or `pnpm update`, so run `pnpm install` to fix it. Bun runs it on every `bun install`.

## Setting it up

`convoy project init --pack effect` brings `typescript`, `effect-house-rules` and `anti-slop` first, then runs upstream's installer, `effect-tsgo setup`: it pins `typescript`, `oxlint` and `oxlint-tsgolint` at versions tsgo supports together, and adds the `@effect/language-service` plugin to `tsconfig.json`, which the pack's setup then gives `"diagnostics": false`. Oxlint is the single diagnostics authority; the plugin still provides editor refactors, quick fixes, quickinfo and completions. Convoy sets the project's `.oxlintrc.json` `extends` and its `package.json` `prepare` script (`effect-tsgo patch --oxlint`).

Add narrow `allowedUnstableApis` entries to the plugin entry in `tsconfig.json` only for module families the project deliberately adopts, e.g. `"allowedUnstableApis": ["effect/http"]`.

Type-aware linting also turns on Oxlint's own type-aware rules (`typescript/*`, through tsgolint) in the categories the project enables; our choices for those are in the `typescript` pack. TSGO 0.48.0's recommended preset adds `experimental-api-usage` and `unstable-api-usage` at warning severity, so projects receive them automatically when they upgrade; the pack does not restate them.

Keep both Oxlint stability diagnostics enabled. When a project deliberately adopts an unstable Effect module family, add the narrow module path to the Effect language-service plugin's `allowedUnstableApis` in that project's `tsconfig.json` (for example, `effect/http`). The patched Oxlint integration honors that scoped allowlist even though language-service diagnostics are disabled. Do not blanket-disable the rule or add `allowedExperimentalApis` by default; a new unstable or experimental dependency should remain visible.

Two rules outside the preset are on deliberately. `instance-of-schema` catches `instanceof` on a `Schema.TaggedError`, replacing our retired `no-instanceof-tagged-error` (see `effect-house-rules`' README). `prefer-schema-type-property` rejects `Schema.Schema.Type<typeof X>` for `typeof X.Type`, the form the effect skill's records use; it doesn't flag the older `interface X extends Schema.Schema.Type<typeof X> {}`, so moving those records is done by hand.

Severities are read from the Oxlint config only; with language-service diagnostics disabled, a tsconfig `plugins` entry's severities don't apply. To change a rule for the project or for some files, do it in the project's own `.oxlintrc.json`, e.g. `"effecttsgo/async-function": "off"`. `// @effect-diagnostics newPromise:off` (a whole file) and `// @effect-diagnostics-next-line newPromise:off` comments still work. One that turns a check off or lowers it needs a reason after ` -- `, like any other disable comment (`effect-house-rules`' `directive-reason`); one that only raises checks to `error` doesn't.
