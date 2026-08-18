# gauntlet

Effect-v4-native, Pi-harnessed, model-agnostic code-review agent. ("Run the
gauntlet on medium.")

**Status: v1.** Spec is
[#15](https://github.com/JRGiardiniere/gauntlet/issues/15). Invoking-agent
skill: [`.agents/skills/gauntlet/`](.agents/skills/gauntlet/SKILL.md) — copy or
symlink that folder into `~/.agents/skills/` to invoke from other
repositories. The skill assumes `gauntlet` is on `PATH`; from this checkout
that is `node bin/gauntlet.mjs` until the package bin is linked. Claude Code
can symlink from `.claude/skills/` later.

## Commands

```
gauntlet review [recipe] [--pr N] [--spec <file>] [--destination local|pr] [--lenses a,b] [--resume [run-id]]
gauntlet deliver <run-id>
gauntlet config
gauntlet config init
gauntlet config set <key> <value...>
gauntlet config unset <key>
```

- `review` runs the pipeline to completion. The default target is the working
  tree's uncommitted changes; a new review on a branch containing one Linear
  issue ID resolves that issue as its current Slice, with one native parent,
  sibling titles/states, and human comments. Set `LINEAR_API_KEY` to a Linear
  personal API key. A detected Linear binding wins over GitHub; a missing or
  rejected key leaves the review running but prints and reports an actionable
  diagnostic. Resume keeps the frozen source unless the branch changed, which
  starts a fresh review. Without a Linear binding, `--pr N` resolves GitHub
  closing issues as the ReviewSpecification (native parent one level, admitted
  maintainer comments, 20k comment budget). GitHub unavailability or a PR with
  no closing issues stays quietly specification-less. `--spec <file>` freezes a Caller
  Addendum beside any fetched material. A positional recipe selects a named
  recipe from the catalog; omitting it selects the configured `default-recipe`.
  Nothing else selects a recipe — if neither resolves, the review fails and
  lists what is available. `--destination` defaults to `local` (run directory
  + bounded digest). `pr` keeps those local outputs and also posts `dossier.md`; it
  requires `--pr`. `--resume` continues from completed semantic checkpoints
  when the target is unchanged, under the currently installed code. The first
  such checkpoint is the complete Finder stage; an interrupted partial Finder
  fan-out reruns in full. A changed target starts a new review.
- `deliver` posts an already-completed pull-request run's `dossier.md` as a
  single PR comment. A working-tree run has no PR destination and is refused.
  Re-delivering a Posted receipt is a no-op that returns the existing comment
  URL; a NotPosted attempt may be retried.
- `config` prints the settings path, the effective Lens Catalog with Default
  Lenses annotated, the recipe catalog, the effective runs root, and every
  recipe. Lens content is validated fail-fast; recipes remain listed with
  invalid files marked by their Schema error.
- `config init` seeds a fresh `~/.gauntlet` with ordinary `quick`, `low`,
  `medium`, and `high` recipes (default `medium`, all four favorites). The
  initial Default Lenses explicitly name all eleven shipped Lenses, including
  `spec-conformance`. The settings and seeded files are user-owned; init is a
  no-op when the configuration is already valid and refuses a partial one with
  repair guidance.
- `config set` / `config unset` manage `~/.gauntlet/settings.json`:
  `default-recipe` (must name an available valid recipe; cannot be unset),
  `default-lenses` (replaced as a whole; no names writes an empty selection;
  cannot be unset), `favorites` (ordered, distinct, replaced as a whole), and
  `runs-root` (absolute or `~/` path; unset restores `~/.gauntlet/runs`).

## Dossier

A Run always writes local artifacts under the runs root (`~/.gauntlet/runs/`
unless `runs-root` says otherwise). Delivery to a PR is additive.

- **stdout** — a bounded markdown digest: one tally line, one line per
  surviving finding, then paths to the Dossier files. Relay it verbatim;
  do not parse it as the review.
- **`dossier.md`** — the human-readable Dossier. Read it for review detail.
  `--destination pr` and `deliver` post this file as a single PR comment.
- **`dossier.json`** — the machine-readable Dossier. Parse it from disk,
  never from stdout.

Exit 0 means a review was produced (zero findings included). Exit 1 means
it could not review or delivery failed. Findings never affect the exit code.

## Lenses

Default Lenses are the required standing membership for ordinary reviews.
`gauntlet config` lists every shipped and current project-local Lens and marks
the defaults. `gauntlet config set default-lenses <name...>` replaces the list;
passing no names writes a valid empty selection.

`--lenses a,b` is the one runtime control and means exactly those names. It
changes Lens membership without changing the selected Recipe's Seats. Adding a
Markdown file under `content/lenses/` or `.gauntlet/lenses/` makes it available,
not selected. Recipes remain Seat policy only.

A fully explicit `gauntlet review <recipe> --lenses a,b` does not need a
settings file. Omitting either choice requires its configured default.

## Recipes

A recipe is one strict JSON file in `~/.gauntlet/recipes/`; the
lowercase-kebab-case filename is its only name. Editing files is the mutation
interface — inspect or copy a nearby recipe, write a new file, then run
`gauntlet config` to validate it. Admitted fields (anything else is invalid):

- `default` — required seat (`provider/model:effort`) for every seated stage
- `finders`, `interpretive-finders`, `pool`, `verification`, `judgment` —
  optional per-stage seat overrides

```json
{
  "default": "openai-codex/gpt-5.6-sol:high",
  "finders": "openai-codex/gpt-5.6-luna:low",
  "interpretive-finders": "openai-codex/gpt-5.6-sol:high",
  "judgment": "openai-codex/gpt-5.6-sol:xhigh"
}
```

Lenses never name models. A lens is standard by omission or declares
`finder-class: interpretive` in its frontmatter; the selected recipe resolves
the class to a seat — standard finders through `finders` then `default`,
interpretive finders through `interpretive-finders`, then `finders`, then
`default`. Other seated stages resolve through their named override then
`default`. The ReviewPlan
freezes every resolved seat at submission, so recipe edits never change an
in-flight run or a resumed run whose target is unchanged. Resume continues
from completed semantic checkpoints under the currently installed code; it
does not attempt to resume active model conversations or partial Finder
fan-outs. A changed target starts a new review.

## Toolchain

- pnpm + TypeScript 7 (tsgo), Node ≥ 23.6
- GitHub CLI (`gh`), installed and authenticated — required for `review --pr`,
  `--destination pr`, and `deliver`
- `LINEAR_API_KEY` — optional until the current branch contains a Linear issue
  ID; then it authorizes automatic Linear ReviewSpecification acquisition
- `effect` / `@effect/platform-node` / `@effect/vitest` pinned **exactly** to
  one shared version (enforced by `scripts/check-effect-pin.mjs`; bump with
  `pnpm add -E effect@rc @effect/platform-node@rc @effect/vitest@rc`)
- `pnpm lint` — the house-style gate: oxlint baseline + the `gauntlet` custom
  rule pack (`scripts/lint-rules/`), a `Record<string, unknown>` early-warning
  scan, official type-aware Effect diagnostics (`@effect/tsgo`), the exact-pin
  check, and an import-cycle check
- `pnpm test` — vitest (`@effect/vitest`), covering the lint rules and Effect code
- `pnpm typecheck` — tsgo

## Docs

- [`.agents/skills/gauntlet/`](.agents/skills/gauntlet/SKILL.md) — universal
  invoking-agent skill
- `docs/effect-house-style.md`, `docs/effect-v4-patterns.md` — house style +
  patterns, imported from cloudflare-hub (see the provenance banners for
  the deltas from beta.90 to our pin)
- `docs/research/` — Wayfinder research findings (Effect batteries, durable
  execution, Pi harness surface)
