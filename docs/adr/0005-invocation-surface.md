# Invocation surface: three verbs, explicit aiming, recipes as content

The old reviewer's five-verb grammar (`start|status|wait|execute|deliver`)
existed only because launchd detached execution; #8 gave the Run back to the
CLI, so four verbs lose their reason to exist. Provenance confirmed the real
invocation was always one shape (`start --repo $PWD --preset X --destination Y
--wait`), with `status`/`wait`, `--runs-root`, `--config`, and the seat-override
flags documented-but-unexercised.

## Verbs

```
gauntlet review [recipe] [--pr N] [--destination local|pr|both] [--resume [run-id]] [--lenses a,b]
gauntlet deliver <run-id>
gauntlet config [key value...]
```

- `review` runs the pipeline to completion — running *is* waiting; there is no
  `--wait`, `start`, `execute`, `status`, or bare `wait`. Resume is a flag
  (skip-what-exists per ADR 0003), defaulting to the latest incomplete run.
- `deliver` posts an already-completed run's Dossier to the PR — #8's
  "run directory is the backstop" made actionable, never re-paying a review.
- `config` manages the standing choices in `~/.gauntlet/settings.json`:
  `default-recipe`, `favorites`, `runs-root`. Bare `gauntlet config` prints
  settings and the recipe list, favorites first.

## Targets: explicit aiming, no autodetect

The caller aims the tool. Default target is the working tree (uncommitted
changes vs HEAD — the mid-flight agent case); `--pr <number>` reviews that
PR's range. `--destination pr` requires `--pr`. The old repo's ~250-line
autodetect (gh PR discovery plus a degradation-warning ladder) existed only to
guess what the caller already knows; the invoking agent states it in one flag,
and the future PR watcher arrives with the number in hand.

## Recipes

A recipe is content: one small file in `~/.gauntlet/recipes/` naming a seat
per stage (grammar `provider/model:effort`) plus budgets. Name from the
filename, positional at invocation (`gauntlet review luna-high`). Built-ins
(`low`, `medium`, `high`, `quick`) ship as the same files; one loader reads
all; adding or renaming a recipe never touches code. Trialling a model is
writing a recipe — there are no per-stage override flags and no config overlay
file (the old one shipped literally empty). Favorites are a settings key, not
recipe anatomy: the listing shows favorited recipes on top so experiments
never clutter the quick-hitter list. No speed/priority slot in the seat
grammar — provider-specific tiers become an optional recipe field if ever
actually wanted.

Precedence collapses to: named recipe > `default-recipe` setting. The
ReviewPlan still freezes the resolved seats at submission (#6), so editing a
recipe never changes an in-flight or resumed run.

## Output contract

Shell tools truncate output (~30k chars), and truncated JSON is garbage — so
stdout never carries the review, it lands it:

- **stdout**: a bounded markdown digest — one tally line (confirmed / kept /
  unverified counts, recipe, target) plus one line per *surviving* finding
  (confirmed BugClaims and kept Observations), then paths to `report.md` and
  `dossier.json`. Refuted, dropped, and evidence live only in the run dir.
- **stderr**: progress narration only.
- **exit code**: 0 = review produced (even with zero findings), 1 = could not
  review or delivery failed. Findings never affect the exit code.

Agents triage from the digest — small enough to relay verbatim — and read
`report.md` only for what they act on.

## Skill

One universal markdown skill (no harness-specific machinery, copyable to
Codex/Cursor later): run `gauntlet review` as a background shell task, aim
with `--pr` when reviewing a PR, choose the destination (#8's judgment text),
relay the digest.

## Consequences

- Jettisoned: `start`/`execute`/`status`/`wait` verbs, target autodetect,
  the config overlay file, seat-override flags, `--runs-root` and
  `$CODE_REVIEW_DIR`, the speed axis, and a two-tier preset/recipe split.
- "Preset" leaves the vocabulary; **Recipe** enters CONTEXT.md.
- Paths: recipes and settings in `~/.gauntlet/`; runs under
  `~/.gauntlet/runs/` unless `runs-root` says otherwise; project-local lenses
  in `.gauntlet/lenses/` (#9's loader).
- Machine consumers parse `dossier.json` from disk, never stdout.
