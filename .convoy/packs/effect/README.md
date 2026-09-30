# effect

The official Effect diagnostics from [`@effect/tsgo`](https://github.com/Effect-TS/tsgo), run inside the project's normal type-aware Oxlint pass as the `effecttsgo/*` rules, with our house severities.

- `oxlintrc.json` extends the `recommended` preset of the project's installed tsgo (`node_modules/@effect/tsgo/oxlint-presets/recommended.json`), which turns on type-aware linting, and makes the house choices: 21 rules at `error`, with `strict-effect-provide` off in `**/*.test.ts`, `**/*.integration.ts`, `**/*.fixture.ts` and `scripts/**`, which provide their own layers.

**Convoy manages these files.** They're copied from `config/packs/effect/` in the convoy repo into `.convoy/packs/effect/` of every project whose `convoy.toml` lists `effect`, as uncommitted changes that go in with the project's next commit. An edit here shows in Convoy's Review, to promote to every project or discard.

## Three layers

| Layer | What it is | Where it lives |
|---|---|---|
| Default | which rules exist, and their normal severities | the project's installed tsgo, whose preset the pack extends |
| House custom | our shared choices, the same in every project: the 21 rules at `error` | this pack's `oxlintrc.json` |
| Project custom | one project's own changes, which win over the pack's | the project's `.oxlintrc.json` |

A choice every project shares goes here, not into each project's config; a project whose code doesn't pass a rule yet turns it off in its own config as tracked debt. The pack also sets each rule a project's `categories` would otherwise decide (such as `strict-effect-provide` and `any-unknown-in-error-context`), so every project runs the same Effect rules whatever its categories. The pack never restates defaults. Rules a newer tsgo adds come with the project's own upgrade, at upstream's severities, and nothing here changes.

## Versions

Each project keeps its own tool versions; the pack doesn't list or check them. An older tsgo just runs fewer rules. What can go wrong fails lint loudly:

- **A rule this pack names that the project's tsgo lacks:** oxlint refuses the config (`Rule '…' not found in plugin 'effecttsgo'`). The rules here exist in tsgo 0.39.1 and later (checked on 0.39.1 and 0.47.1), so only name rules every project's tsgo has. A house change to a newer-only rule would go in a version file here (such as `oxlintrc.tsgo-0.47.json`, extending this one) that projects on that version extend instead.
- **An oxlint the project's tsgo doesn't support:** the patch refuses to run. Check tsgo's release notes for the supported `oxlint` and `oxlint-tsgolint` versions before upgrading either.
- **A patch that hasn't run:** `Unknown plugin: 'effecttsgo'`. The patch has to run again after any upgrade of tsgo, oxlint or `oxlint-tsgolint`. pnpm runs `prepare` on `pnpm install`, but not on `pnpm add` or `pnpm update`, so run `pnpm install` to fix it. Bun runs it on every `bun install`.

## Hooking it up

1. Depend on `@effect/tsgo`, `oxlint` and `oxlint-tsgolint` in the project's root `package.json` (the pack reads the preset from the root `node_modules`), at versions tsgo supports together.
2. In `package.json`, add `"prepare": "effect-tsgo patch --no-typescript --oxlint"`. This patches oxlint, so the `effecttsgo` plugin exists; `tsc` isn't patched, so typechecking is unchanged.
3. In the project's `.oxlintrc.json`, extend the pack's config:

   ```json
   {
     "extends": ["./.convoy/packs/effect/oxlintrc.json"]
   }
   ```
4. If the project's formatter checks every file (such as `oxfmt --check .`), ignore `.convoy/**` there.

Type-aware linting also turns on Oxlint's own type-aware rules (`typescript/*`, through tsgolint) in the categories the project enables; those are the project's config, not this pack's. A project's `categories` can still turn on an `effecttsgo` rule this pack doesn't name: today only `experimental-api-usage` and `unstable-api-usage`, which tsgo 0.39.1 lacks, so the pack can't name them yet.

Severities are read from the Oxlint config only; a tsconfig `plugins` entry's severities don't apply here. To change a rule for the project or for some files, do it in the project's own `.oxlintrc.json`, e.g. `"effecttsgo/async-function": "off"`. `// @effect-diagnostics newPromise:off` (a whole file) and `// @effect-diagnostics-next-line newPromise:off` comments still work.
