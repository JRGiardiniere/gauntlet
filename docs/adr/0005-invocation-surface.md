# Invocation surface: three verbs, explicit aiming, recipes as content

The old reviewer's five-verb grammar (`start|status|wait|execute|deliver`)
existed only because launchd detached execution; #8 gave the Run back to the
CLI, so four verbs lose their reason to exist. Provenance confirmed the real
invocation was always one shape (`start --repo $PWD --preset X --destination Y
--wait`), with `status`/`wait`, `--runs-root`, `--config`, and the seat-override
flags documented-but-unexercised.

## Verbs

```
gauntlet review [recipe] <target> [--spec <file>] [--destination local|pr] [--resume [run-id]] [--lenses a,b]
  <target> = --working-tree | --pr <number> | --commits <base>[..<head>]
gauntlet deliver <run-id>
gauntlet config
gauntlet config init
gauntlet config set <key> <value...>
gauntlet config unset <key>
```

`<target>` is one required, mutually exclusive selection: `--working-tree`
(uncommitted changes vs HEAD), `--pr <number>`, or `--commits
<base>[..<head>]`. `--spec <file>` supplies a Caller Addendum per the
specification-ingress spec (#70).

- `review` runs the pipeline to completion — running *is* waiting; there is no
  `--wait`, `start`, `execute`, `status`, or bare `wait`. Resume is a flag
  (continue-from-checkpoint per ADR 0003), defaulting to the latest incomplete
  run. When the target is byte-identical, it reuses only the completed Finder
  stage; Pool, Verification, and Judgment always rerun as whole stages under
  the currently installed shared prompts, schemas, tools, and pipeline code
  (amended per #52). A complete Dossier is terminal and takes the fast path:
  existing artifacts are delivered without re-entering the pipeline. Active
  model conversations and partial Finder fan-outs are never resumed. A
  changed target makes incomplete work unavailable for resume and starts a new
  review.
- `deliver` posts an already-completed run's Dossier to the PR — #8's
  "run directory is the backstop" made actionable, never re-paying a review.
- `config set` and `config unset` explicitly manage the standing choices in
  `~/.gauntlet/settings.json`:
  `default-recipe`, `default-lenses`, `favorites`, `runs-root`. Bare `gauntlet
  config` prints settings and the recipe list, favorites first. An unnamed
  review requires a configured Default Recipe and every review requires
  configured Default Lenses; invalid standing selections fail clearly instead
  of silently choosing one.
- `config init` explicitly creates the initial Recipe Catalog and settings. It
  is idempotent when they are already valid, never overwrites or replenishes a
  partial catalog, and ordinary review commands never mutate configuration.

## Targets: explicit aiming, no autodetect

The caller aims the tool, and (amended 2026-08-14) aims it *explicitly*: every
review names its target — `--working-tree` (uncommitted changes vs HEAD — the
mid-flight agent case), `--pr <number>` for that PR's range, or `--commits
<base>[..<head>]` for committed work with no PR (#82). There is no default
target and no clean-tree fallback: with three target kinds an implicit default
invites exactly the guessing this ADR bans, an omitted target is a usage error
naming all options instead of a post-invocation `TargetUnresolvable`, and the
primary caller is an agent that writes the flag either way. The explicit-target
requirement is implemented alongside the commit-range ticket so the CLI breaks
once, not twice. Target selection is independent of Specification Source
resolution (which keys on machine-recoverable signals like the current branch
name, not on which target kind was named).

The commit range mirrors the PullRequest target's mechanics (settled
2026-08-14, #82): `<head>` defaults to `HEAD`, either end accepts any
committish, the diff base is `merge-base(base, head)`, and both ends resolve
to commit SHAs at submission. The frozen target identity is that SHA pair —
resume's unchanged-target check is SHA-pair equality, immune to moving refs.
The reviewed snapshot is the head commit's tree; uncommitted working-tree
edits are ignored with one scope-degradation warning (the mirror of the
working tree's untracked-files warning), never inferred into the review. An
unresolvable ref fails before a Run is created; a range whose merge-base
equals its head is "nothing to review" — the clean-working-tree treatment.
Commit-range and working-tree runs are local-destination; `pr` still requires
`--pr`.

Destination defaults to `local`, which means the Run lands on disk
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
`interpretive-finders`, `pool`, `verification`, and `judgment` Seat overrides;
no budget or cost fields (amended by ADR 0006: cost is read afterward, never
constrained proactively). A standard Finder resolves through `finders` then
`default`; an interpretive Finder resolves through `interpretive-finders`, then
`finders`, then `default`. All other seated Stages resolve through their named
override then `default`.
Unknown keys are invalid so a misspelled Stage cannot silently inherit the
Default Seat. Trialling a model is writing one file directly — agents do not
need a recipe CRUD command. There are no per-stage override flags or config
overlay file (the old one shipped literally empty).

Amended by #81's 2026-08-18 complexity challenge: Recipes remain Seat policy
only. No installed Recipe or project-local Lens demonstrated a repeated Lens
policy, so `lenses.extend` and `lenses.only` were deferred rather than reserved
in the schema. The configured Default Lenses apply unless the caller supplies
the exact `--lenses` override. Resolved names are validated before a Run is
created. An empty Default Lens selection is valid: the Run has no Finder
invocations and produces the ordinary zero-result Dossier. Gauntlet adds no
special protection for an obviously empty review.

Lens selections express membership, not priority or execution order. Planning
produces a deterministic invocation array and the ReviewPlan records that
resolved array because downstream candidate indexes consume it. The array's
operational order stays stable within the Run, but callers are
not promised that configuration order controls scheduling, output, or cache
behavior. The ReviewPlan does not retain the Default Lenses or source-catalog
provenance after resolution.

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

Bare `config` is also the Lens discovery surface: it lists the effective Lens
Catalog and identifies the Default Lenses. It decodes the complete catalog and
fails with the first invalid file's path and reason rather than maintaining a
second error-tolerant Lens-entry model. Help text explains selection semantics;
it does not embed a mutable catalog listing.

Selection precedence is exactly: a Recipe named positionally, otherwise the
configured Default Recipe. If neither resolves, review fails and lists the
available Recipes. Environment variables, flags, and a hidden built-in
fallback do not select a Recipe. The ReviewPlan freezes the resolved seats at
submission (#6), so editing a Recipe never changes an in-flight run or a
resumed run whose target is unchanged (amended per #52).

`config set default-recipe` accepts only an available valid Recipe and
`config unset default-recipe` is rejected. `config set default-lenses` replaces
the standing selection and `config unset default-lenses` is likewise rejected.
Unsetting `favorites` restores an empty list; unsetting `runs-root` restores
`~/.gauntlet/runs`. Direct edits may still create dangling or malformed
settings, so bare `config` explains the inconsistency and `review` refuses to
guess.

Settings are strict JSON: required `default-recipe`, required `default-lenses`,
required ordered `favorites` (possibly empty), and optional `runs-root`.
`config set favorites` replaces the whole list, requires distinct available
valid Recipe names, and `config unset favorites` clears it. Settings writes use
the existing atomic sibling-temp-and-rename mechanism; the personal-tool use
case does not justify locking or conflict machinery.

On a genuinely fresh configuration, `config init` creates ordinary `quick`,
`low`, `medium`, and `high` Recipe files, makes all four Favorites, and selects
`medium` as the Default Recipe. It also writes the initial Default Lenses as an
explicit user-owned setting rather than inferring them from every available
Lens. The Recipe files and Default Lenses are immediately user-owned; after
creation Gauntlet retains no special behavior for them. A valid second
invocation changes nothing. A partial configuration gets a precise repair error
rather than an automatic overwrite. Exact initial Seats and Default Lenses are
selected at implementation time, not frozen in this ADR.

The initial selection preserves the shipped review shape finalized for that
release. Later Lens files become available without silently joining an existing
user's Default Lenses. Gauntlet is presently a personal tool with one known
configuration, so adding this required setting does not justify general schema
migration machinery or an old-settings compatibility contract; the known
configuration may be updated explicitly during rollout.

## Output contract

Shell tools truncate output (~30k chars), and truncated JSON is garbage — so
stdout never carries the review, it lands it:

- **stdout**: a bounded markdown digest — one tally line (confirmed / kept /
  unverified / undecided counts, recipe, target), one line per Findings and
  Unresolved entry in their Dossier order, an optional single bounded
  cache-health line, then paths to `dossier.md` and `dossier.json`. Refuted,
  dropped, and evidence live only in the run dir.
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
