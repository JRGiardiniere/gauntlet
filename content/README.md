# Review-shape content

Curated content ported from the old reviewer (`/Users/johngiardiniere/Code
Review Agent`, read-only oracle — see the map notes). Content only: prompts
and lens files, no plumbing. The companion specifications live in
`docs/spec/pipeline-shape.md` and `docs/spec/emit-tools.md`.

## Layout

- `lenses/` — the shipped built-in lenses, in the ADR 0004 format: name from
  the filename, body is the prompt tail, frontmatter limited to an optional
  `finder-class: interpretive` declaration (the selected recipe maps the class
  to a seat; a lens never names a model) and an optional display-only
  `category`
  tag (validated but not surfaced today — future lens-listing grouping
  metadata; never frozen into the plan, never read by routing — a candidate
  routes by its own type).
  Project-local lenses in `.gauntlet/lenses/` use the identical format.
- `prompts/` — finder system prompt, and templates for the shared finder
  block, the stage scope block, and the Pool / verifier prompts.
  `{{PLACEHOLDER}}` slots are filled at prompt-assembly time. Template files
  are pure prompt text — usage notes live here and in the specs, never inline.
  A Stage module may instead own its main template next to the code that
  assembles it (the judge prompt lives at `src/stages/judgment/judge.md`);
  the slot format is identical.

## Template slots

- `finder-shared-block.md`: `{{REPO_ROOT}}`, `{{CHANGED_FILES}}` (one `- path`
  per line), `{{DIFF_SECTION}}`, `{{MAX_PER_LENS}}`. The diff section uses a
  fence longer than any backtick run in the diff. The assembled finder prompt
  is system prompt + shared block + ReviewSpecification section (interpretive
  finders only, when the plan froze one) + lens tail (+ cap override, when
  applicable) — see the cache-prefix invariant in `docs/spec/pipeline-shape.md`.
- `stage-scope-block.md`: shared by verifier and judge. `{{DIFF_SECTION}}` is
  either the inline fenced diff or a pointer to the diff file stored with the
  plan (ADR 0006 stores it exactly once). When the plan froze a
  ReviewSpecification, its section is appended after the rendered scope, so
  `{{SCOPE_BLOCK}}` carries it into both stage prompts before the assignment.
- `pool.md` / the judge prompt: `{{CANDIDATES}}` in the candidate line format
  (`docs/spec/pipeline-shape.md`). `verifier.md`: `{{SCOPE_BLOCK}}` and
  `{{CLAIMS}}` ([cN]-labelled clusters with member lines).

## Provenance and staleness review

Lens texts are ported near-verbatim from `pi-lenses.ts` (whose angle wording
was itself tuned across the old repo and the `code-review-tiered` workflow) —
the wording is tuned, so it is reused rather than rewritten. Stage prompts
come from `pipeline.ts` / `judge-prompt.md` / `pi-finders.ts`. Old lens names
map to descriptive filenames (an alphabet of angles implies a closed set;
files don't):

| old | new |
|---|---|
| angle-A | diff-scan |
| angle-B | removed-behavior |
| angle-C | cross-file |
| angle-D | language-pitfalls |
| angle-E | wrapper-proxy |
| angle-F | presentation-environment |
| cleanup | cleanup |
| cleanup-v2 (absence section) | absence |
| spec | spec-conformance (removed, #52) |
| subjective | subjective |

Deliberate changes made during the port:

- **Lens anatomy stripped** (ADR 0004): `role`, `path`, and `maxPerLensFactor`
  are gone. Routing is the candidate's own type; caps live in the ReviewPlan
  (the subjective 2× default is noted in the pipeline-shape spec); the
  role→model matrix is dead.
- **`cleanup-v2` dissolved.** It was `cleanup` duplicated wholesale plus an
  absence-check checklist, kept as a solo-run trial variant. The checklist is
  now its own lens (`absence.md`); the duplication is deleted. Running
  cleanup + absence reproduces cleanup-v2 exactly. Its stale reference to "the
  PR description above" (finder prompts never included one) now says "when one
  is provided".
- **Verdict ladder renamed** to CONTEXT.md canon: CONFIRMED / UNVERIFIED /
  REFUTED. The old middle rung PLAUSIBLE ("mechanism real, trigger uncertain")
  is exactly what Unverified means as a first-class Verdict; the
  don't-refute-realistic-state guidance is kept word for word.
- **Verdict fields trimmed**: the old `real` boolean (bench-compat mirror of
  the verdict), `confidence` (asked but never read downstream), and severity
  `"none"` (only legal when refuted) are dropped. Refuted claims simply carry
  no Review Priority, matching the judge's no-priority-on-drop rule.
- **Judge prompt curated**: the preamble referencing retired lenses
  (`subjective-code`/`subjective-design`), bench files, and the jettisoned
  subjective corpus is gone; the operative prompt is intact. The
  `goodFind`/`cleanlyExplained` ratings are kept — per-run data in the
  journal, the Observation path's only quality record.
- **Terminology**: preset → recipe, bug path → BugClaim path, subjective
  path → Observation path / Judgment, per CONTEXT.md.

Post-port additions (gap-fill after comparing against an external two-axis
review skill):

- **`refactoring-checklist.md`** — a second judgment lens carrying the Fowler
  smell catalogue (*Refactoring*, ch. 3) as a checklist with fix directions.
  Differs from `subjective.md` by *method* (shape-matching vs open judgment),
  not by altitude — the axis the failed 2026-08-04 code/design split got
  wrong.
- **Conventions sweep widened** — `cleanup.md` now reads repo-documented
  standards (CONTRIBUTING.md, CODING_STANDARDS.md, style guides) alongside
  CLAUDE.md files, and skips anything tooling already enforces.
- **`category` frontmatter** — every shipped lens carries a display-only
  category (`correctness` / `cleanup` / `judgment`); ADR 0004 and
  CONTEXT.md amended accordingly. It is live catalog metadata, not a
  FrozenLens field (#52).
- **`spec-conformance` removed** (#52) — the shipped `needs-spec` lens and
  frontmatter flag had no reachable CLI path. Reintroduce with a real
  spec-ingress design.
