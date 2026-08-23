# gauntlet

Effect-v4-native, Pi-harnessed, model-agnostic code-review agent. ("Run the
gauntlet on medium.")

**Status: v1.** Spec is
[#15](https://github.com/JRGiardiniere/gauntlet/issues/15). The invoking-agent
skill is [`.agents/skills/gauntlet/`](.agents/skills/gauntlet/SKILL.md) — copy
or symlink that folder into `~/.agents/skills/` to invoke from other
repositories. It assumes `gauntlet` is on `PATH`: from this checkout that is
`bun bin/gauntlet.ts`, or `bun run bundle` once and put the standalone
`dist/gauntlet` binary on `PATH` — the shape distributed to other machines.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/JRGiardiniere/gauntlet/main/install.sh | sh
```

Fetches the latest [release](https://github.com/JRGiardiniere/gauntlet/releases)
binary for your platform into `~/.local/bin` (override with
`GAUNTLET_INSTALL_DIR`). The binary checks for a newer release at most once a
day, on a background fiber that never fails a command and delays one by at
most a second; `gauntlet upgrade` replaces the binary in place and touches
nothing else — settings, recipes, runs, and project lenses all survive. Releases are cut by pushing a
`v<major>.<minor>.<patch>` tag; the tag is the single source of truth for the
version.

## Commands

```
gauntlet review [recipe] <target> [--github-spec] [--spec <file>] [--destination local|pr] [--lenses a,b] [--resume [run-id]]
  <target> = --pr N | --commits <base>[..<head>] | --working-tree
           | --commits <base> --working-tree
gauntlet deliver <run-id>
gauntlet config [init | set <key> <value...> | unset <key>]
```

`gauntlet --help` (and per-command `--help`) is the authoritative flag
reference; the [skill](.agents/skills/gauntlet/SKILL.md) is the authoritative
operating guide. The short version:

- **Every review names its target** — there is no default and no autodetect.
  `--commits` reviews `merge-base(base, head)..head` with both ends frozen as
  SHAs; adding `--working-tree` extends that range to the current uncommitted
  work as one target.
- **Specification** — a branch containing one Linear issue ID resolves that
  issue as the review's Slice (needs `LINEAR_API_KEY`); a `--pr` review falls
  back to GitHub closing issues when Linear is absent, or uses them
  exclusively under `--github-spec`. `--spec <file>` freezes a Caller Addendum
  beside any fetched material.
- **Recipe** — the positional name selects from the catalog; omitting it uses
  the configured `default-recipe`. Nothing else selects a recipe.
- **Destination** — `local` (default) writes the run directory and digest;
  `pr` additionally posts `dossier.md` as a PR comment (requires `--pr`, like
  `deliver`).
- **Resume** — `--resume` continues an interrupted run from its frozen inputs
  under the currently installed code; it never re-resolves the target and
  never starts a replacement review.
- **Config** — `config` prints settings, the Lens and Recipe Catalogs, and
  the standards manifest path; `config init` seeds a fresh `~/.gauntlet`
  (recipes `quick`/`low`/`medium`/`high`, default `medium`, and all thirteen
  shipped Lenses as the Default Lenses); `set`/`unset` manage
  `default-recipe`, `default-lenses`, `favorites`, and `runs-root`.

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

Default Lenses are the required standing membership for ordinary reviews;
`gauntlet config` lists every shipped and project-local Lens and marks the
defaults. `--lenses a,b` is the one runtime control and means exactly those
names — it changes Lens membership without changing the selected Recipe's
Seats. Adding a Markdown file under `content/lenses/` or `.gauntlet/lenses/`
makes it available, not selected.

## Recipes

A recipe is one strict JSON file in `~/.gauntlet/recipes/`; the
lowercase-kebab-case filename is its only name. Editing files is the mutation
interface — copy a nearby recipe, write a new file, then run `gauntlet config`
to validate it. Admitted fields (anything else is invalid):

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

Lenses never name models: a lens is standard by omission or declares
`finder-class: interpretive`, and the selected recipe resolves the class to a
seat. The ReviewPlan freezes every resolved seat at submission, so recipe
edits never change an in-flight or resumed run.

## Toolchain

- Bun ≥ 1.4 — runtime, package manager, and single-file compiler; every
  script and the checkout entrypoint run on Bun. Node is needed only to run
  the vitest suite
- GitHub CLI (`gh`), installed and authenticated — required for `review
  --pr`, `--destination pr`, and `deliver`
- `LINEAR_API_KEY` — optional until the current branch contains a Linear
  issue ID; then it authorizes automatic Linear specification acquisition
- `effect` / `@effect/platform-node` / `@effect/vitest` pinned **exactly** to
  one shared version (enforced by `scripts/check-effect-pin.ts`; bump with
  `bun add --exact effect@rc @effect/platform-node@rc @effect/vitest@rc`)
- `bun run lint` — the house-style gate, run concurrently: oxlint baseline +
  the `gauntlet` custom rule pack (`scripts/lint-rules/`), a
  `Record<string, unknown>` early-warning scan, official type-aware Effect
  diagnostics (`@effect/tsgo`), the exact-pin check, and an import-cycle check
- `bun run test` — vitest (`@effect/vitest`), covering the lint rules and
  Effect code
- `bun run typecheck` — tsgo
- `bun run bundle` — compile `dist/gauntlet` with the shipped content catalog
  embedded; `bun run live-gate-compiled` builds it and proves it with
  `config init` plus one real review from a fresh HOME

## Docs

- [`.agents/skills/gauntlet/`](.agents/skills/gauntlet/SKILL.md) — universal
  invoking-agent skill
- `docs/adr/` — binding decision records; `docs/spec/` — normative pipeline
  and emit-tool specs
- `docs/effect-house-style.md`, `docs/effect-v4-patterns.md` — house style +
  patterns, verified against the pinned Effect beta
- `docs/research/` — dated research notes (Effect batteries, durable
  execution, Pi harness surface, Bun 1.4 embedding and test-runner findings)
