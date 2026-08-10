# Review-shape content

Curated content ported from the old reviewer (`/Users/johngiardiniere/Code
Review Agent`, read-only oracle — see the map notes). Content only: prompts
and lens files, no plumbing. The companion specifications live in
`docs/spec/pipeline-shape.md` and `docs/spec/emit-tools.md`.

## Layout

- `lenses/` — the shipped built-in lenses, in the ADR 0004 format: name from
  the filename, body is the prompt tail, frontmatter limited to an optional
  model override and an optional `needs-spec: true` flag (skip-if-absent).
  Project-local lenses in `.gauntlet/lenses/` use the identical format.
- `prompts/` — finder system prompt, and templates for the shared finder
  block, the stage scope block, and the Pool / verifier / judge prompts.
  `{{PLACEHOLDER}}` slots are filled at prompt-assembly time. Template files
  are pure prompt text — usage notes live here and in the specs, never inline.

## Template slots

- `finder-shared-block.md`: `{{REPO_ROOT}}`, `{{CHANGED_FILES}}` (one `- path`
  per line), `{{DIFF}}`, `{{MAX_PER_LENS}}`. The assembled finder prompt is
  system prompt + shared block + lens tail (+ cap override + spec text, when
  applicable) — see the cache-prefix invariant in `docs/spec/pipeline-shape.md`.
- `stage-scope-block.md`: shared by verifier and judge. `{{DIFF_SECTION}}` is
  either the inline fenced diff or a pointer to the diff file stored with the
  plan (ADR 0006 stores it exactly once). `{{INTENT_SECTION}}` is the PR
  title/description and/or spec text; when neither exists it is replaced by:
  "(No PR description or spec was supplied — judge the change on its own
  terms, and do not assume intent you cannot see.)" and the proportionality
  sentence is kept.
- `pool.md` / `judge.md`: `{{CANDIDATES}}` in the candidate line format
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
| spec | spec-conformance |
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
  no severity, matching the judge's no-tier-on-drop rule.
- **Judge prompt curated**: the preamble referencing retired lenses
  (`subjective-code`/`subjective-design`), bench files, and the jettisoned
  subjective corpus is gone; the operative prompt is intact. The
  `goodFind`/`cleanlyExplained` ratings are kept — per-run data in the
  journal, the Observation path's only quality record.
- **Terminology**: preset → recipe, bug path → BugClaim path, subjective
  path → Observation path / Judgment, per CONTEXT.md.
