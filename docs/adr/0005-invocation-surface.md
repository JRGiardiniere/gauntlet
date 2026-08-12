# Invocation surface: three verbs, explicit aiming, recipes as content

The old reviewer's five-verb grammar (`start|status|wait|execute|deliver`)
existed only because launchd detached execution; #8 gave the Run back to the
CLI, so four verbs lose their reason to exist. Provenance confirmed the real
invocation was always one shape (`start --repo $PWD --preset X --destination Y
--wait`), with `status`/`wait`, `--runs-root`, `--config`, and the seat-override
flags documented-but-unexercised.

## Verbs

```
gauntlet review [recipe] [--pr N] [--destination local|pr] [--resume [run-id]] [--lenses a,b]
gauntlet deliver <run-id>
gauntlet config
gauntlet config init
gauntlet config set <key> <value...>
gauntlet config unset <key>
```

- `review` runs the pipeline to completion — running *is* waiting; there is no
  `--wait`, `start`, `execute`, `status`, or bare `wait`. Resume is a flag
  (skip-what-exists per ADR 0003), defaulting to the latest incomplete run.
- `deliver` posts an already-completed run's Dossier to the PR — #8's
  "run directory is the backstop" made actionable, never re-paying a review.
- `config set` and `config unset` explicitly manage the standing choices in
  `~/.gauntlet/settings.json`:
  `default-recipe`, `favorites`, `runs-root`. Bare `gauntlet config` prints
  settings and the recipe list, favorites first. An unnamed review requires a
  configured Default Recipe; if the setting is absent or names no available
  Recipe, it fails with a clear error instead of silently choosing one.
- `config init` explicitly creates the initial Recipe Catalog and settings. It
  is idempotent when they are already valid, never overwrites or replenishes a
  partial catalog, and ordinary review commands never mutate configuration.

## Targets: explicit aiming, no autodetect

The caller aims the tool. Default target is the working tree (uncommitted
changes vs HEAD — the mid-flight agent case); `--pr <number>` reviews that
PR's range. Destination defaults to `local`, which means the Run lands on disk
and its bounded digest is printed. `pr` keeps those local outputs and also
posts the human-readable Dossier; it requires `--pr`. There is no `both`
destination because local artifacts are always produced. The old repo's ~250-line
autodetect (gh PR discovery plus a degradation-warning ladder) existed only to
guess what the caller already knows; the invoking agent states it in one flag,
and the future PR watcher arrives with the number in hand.

## Recipes

The Recipe Catalog is user-owned content: one JSON file per Recipe in
`~/.gauntlet/recipes/`, with a portable lowercase-kebab-case filename as its
sole name — the JSON does not repeat it. There is no app/user or built-in/custom
distinction and no second recipe source to merge: writing `high.json` changes
the Recipe named `high`. Even a large catalog remains ordinary inspectable
files; SQLite and a monolithic catalog file add machinery without a present
reader or scale problem.

A Recipe contains a required `default` Seat and optional top-level `finders`,
`deep-finders`, `pool`, `verification`, and `judgment` Seat overrides; no budget
or cost fields (amended by ADR 0006: cost is read afterward, never constrained
proactively). A standard Finder resolves through `finders` then `default`; a
deep Finder resolves through `deep-finders`, then `finders`, then `default`.
All other seated Stages resolve through their named override then `default`.
Unknown keys are invalid so a misspelled Stage cannot silently inherit the
Default Seat. Trialling a model is writing one file directly — agents do not
need a recipe CRUD command. There are no per-stage override flags or config
overlay file (the old one shipped literally empty).

One invalid Recipe never disables the catalog: bare `config` marks its file
invalid with the Schema error, selecting it fails before a Run is created, and
unrelated Recipes remain usable. Documentation gives one positive JSON example
and the admitted fields; agents can inspect or copy nearby Recipes rather than
learning a mutation DSL.

Favorites are ordered settings metadata, not recipe anatomy: bare `config`
lists existing Favorites in configured order and all remaining Recipes
alphabetically. It prints the settings and Recipe Catalog paths, annotates the
Default Recipe wherever it appears, and summarizes each Recipe's Default Seat
and overrides. Missing Favorite names produce one warning rather than hiding
the rest of the catalog. No separate machine-output mode exists without a real
consumer.

Selection precedence is exactly: a Recipe named positionally, otherwise the
configured Default Recipe. If neither resolves, review fails and lists the
available Recipes. Environment variables, flags, and a hidden built-in
fallback do not select a Recipe. The ReviewPlan freezes the resolved seats at
submission (#6), so editing a Recipe never changes an in-flight or resumed
Run.

`config set default-recipe` accepts only an available valid Recipe and
`config unset default-recipe` is rejected. Unsetting `favorites` restores an
empty list; unsetting `runs-root` restores `~/.gauntlet/runs`. Direct edits may
still create dangling or malformed settings, so bare `config` explains the
inconsistency and unnamed `review` refuses to guess.

Settings are strict JSON: required `default-recipe`, required ordered
`favorites` (possibly empty), and optional `runs-root`. `config set favorites`
replaces the whole list, requires distinct available valid Recipe names, and
`config unset favorites` clears it. Settings writes use the existing atomic
sibling-temp-and-rename mechanism; the personal-tool use case does not justify
locking or conflict machinery.

On a genuinely fresh configuration, `config init` creates ordinary `quick`,
`low`, `medium`, and `high` Recipe files, makes all four Favorites, and selects
`medium` as the Default Recipe. Those files are immediately user-owned; after
creation Gauntlet retains no provenance or special behavior for them. A valid
second invocation changes nothing. A partial configuration gets a precise
repair error rather than an automatic overwrite. Exact initial Seats are
selected from the valid model lineup at implementation time, not frozen in
this ADR.

## Output contract

Shell tools truncate output (~30k chars), and truncated JSON is garbage — so
stdout never carries the review, it lands it:

- **stdout**: a bounded markdown digest — one tally line (confirmed / kept /
  unverified counts, recipe, target) plus one line per *surviving* finding
  (confirmed BugClaims and kept Observations), then paths to `dossier.md` and
  `dossier.json`. Refuted, dropped, and evidence live only in the run dir.
- **stderr**: progress narration only.
- **exit code**: 0 = review produced (even with zero findings), 1 = could not
  review or delivery failed. Findings never affect the exit code.

Agents triage from the digest — small enough to relay verbatim — and read
`dossier.md` only for what they act on.

Delivery posts `dossier.md`, never raw `dossier.json`. Re-delivering a Run with
a posted receipt is an idempotent no-op that returns the existing comment URL;
a not-posted attempt may be retried. Oversize handling stays deliberately
simple: truncate the posted rendering, preserve identity, and point to the full
Dossier in the Run directory.

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
- Paths: the Recipe Catalog and settings in `~/.gauntlet/`; runs under
  `~/.gauntlet/runs/` unless `runs-root` says otherwise; project-local lenses
  in `.gauntlet/lenses/` (#9's loader). `runs-root` accepts an absolute path or
  a `~/` path and is persisted as a normalized absolute path; other relative
  paths are rejected so invocation directory never changes its meaning.
- Machine consumers parse `dossier.json` from disk, never stdout.
