# gauntlet

Effect-v4-native, Pi-harnessed, model-agnostic code-review agent. ("Run the
gauntlet on medium.")

**Status: implementation.** The decision-complete spec is
[#15](https://github.com/JRGiardiniere/gauntlet/issues/15); implementation is
ticketed as [#16–#26](https://github.com/JRGiardiniere/gauntlet/issues?q=is%3Aissue+label%3Aready-for-agent).

## Commands

```
gauntlet review [recipe] [--pr N] [--destination local|pr] [--lenses a,b] [--resume [run-id]]
gauntlet deliver <run-id>
gauntlet config
gauntlet config init
gauntlet config set <key> <value...>
gauntlet config unset <key>
```

- `review` runs the pipeline to completion. The default target is the working
  tree's uncommitted changes; `--pr N` reviews that pull request's range. A
  positional recipe selects a named recipe from the catalog; omitting it
  selects the configured `default-recipe`. Nothing else selects a recipe —
  if neither resolves, the review fails and lists what is available.
  `--destination` defaults to `local` (run directory + bounded digest). `pr`
  keeps those local outputs and also posts `dossier.md`; it requires `--pr`.
- `deliver` posts an already-completed pull-request run's `dossier.md` as a
  single PR comment. A working-tree run has no PR destination and is refused.
  Re-delivering a Posted receipt is a no-op that returns the existing comment
  URL; a NotPosted attempt may be retried.
- `config` prints the settings path, the recipe catalog path, the effective
  runs root, and every recipe — favorites in configured order first, the rest
  alphabetically, invalid files marked with their Schema error. This is where
  agents discover the edit locations.
- `config init` seeds a fresh `~/.gauntlet` with ordinary `quick`, `low`,
  `medium`, and `high` recipes (default `medium`, all four favorites). The
  seeded files are user-owned; init is a no-op when the configuration is
  already valid and refuses a partial one with repair guidance.
- `config set` / `config unset` manage `~/.gauntlet/settings.json`:
  `default-recipe` (must name an available valid recipe; cannot be unset),
  `favorites` (ordered, distinct, replaced as a whole), and `runs-root`
  (absolute or `~/` path; unset restores `~/.gauntlet/runs`).

## Recipes

A recipe is one strict JSON file in `~/.gauntlet/recipes/`; the
lowercase-kebab-case filename is its only name. Editing files is the mutation
interface — inspect or copy a nearby recipe, write a new file, then run
`gauntlet config` to validate it. Admitted fields (anything else is invalid):

- `default` — required seat (`provider/model:effort`) for every seated stage
- `finders`, `deep-finders`, `pool`, `verification`, `judgment` — optional
  per-stage seat overrides

```json
{
  "default": "openai-codex/gpt-5.6-sol:high",
  "finders": "openai-codex/gpt-5.6-luna:low",
  "deep-finders": "openai-codex/gpt-5.6-sol:high",
  "judgment": "openai-codex/gpt-5.6-sol:xhigh"
}
```

Lenses never name models. A lens is standard by omission or declares
`finder-class: deep` in its frontmatter; the selected recipe resolves the
class to a seat — standard finders through `finders` then `default`, deep
finders through `deep-finders`, then `finders`, then `default`. Other seated
stages resolve through their named override then `default`. The ReviewPlan
freezes every resolved seat at submission, so recipe edits never change an
in-flight or resumed run.

## Toolchain

- pnpm + TypeScript 7 (tsgo), Node ≥ 23.6
- GitHub CLI (`gh`), installed and authenticated — required for `review --pr`,
  `--destination pr`, and `deliver`
- `effect` / `@effect/platform-node` / `@effect/vitest` pinned **exactly** to
  `4.0.0-beta.106` (enforced by `scripts/check-effect-pin.mjs`)
- `pnpm lint` — the house-style gate: oxlint baseline + the `gauntlet` custom
  rule pack (`scripts/lint-rules/`), a `Record<string, unknown>` early-warning
  scan, official type-aware Effect diagnostics (`@effect/tsgo`), the exact-pin
  check, and an import-cycle check
- `pnpm test` — vitest (`@effect/vitest`), covering the lint rules and Effect code
- `pnpm typecheck` — tsgo

## Docs

- `docs/effect-house-style.md`, `docs/effect-v4-patterns.md` — house style +
  patterns, imported from cloudflare-hub (see the provenance banners for
  beta.90 → beta.106 deltas)
- `docs/research/` — Wayfinder research findings (Effect batteries, durable
  execution, Pi harness surface)
