# A lens is content; candidates route by their own type

The old reviewer treated a lens as structure: it carried routing
(`Lens.path` plus a separately maintained `SUBJECTIVE_LENSES` name allowlist
that had already drifted), model policy (`role` indexing a per-preset model
matrix), spend policy (a cap multiplier), and content (the prompt tail).
Adding a lens meant touching up to four places, and adding a role meant
editing every preset. We decided none of that is lens anatomy:

- **Routing** belongs to the candidate. Each emitted finding self-classifies
  by whether it asserts a failure scenario — with one, it is a BugClaim bound
  for Pool→verification; without one, an Observation bound for judgment
  (ADR 0001, CONTEXT.md). Any lens may emit both kinds; prompts shape what a
  lens *tends* to produce, the type tag decides where each candidate *goes*.
  `Candidate.path` and the subjective-lens allowlist do not exist in Gauntlet.
- **Spend policy** (caps) belongs to the ReviewPlan (#7).
- **Selection policy** belongs outside the Lens. Making a Lens available does
  not itself select it for every review; the standing user preference, the
  selected Recipe, or the caller determines which available Lenses enter the
  ReviewPlan. Availability scope comes from which Lens Catalog contains the
  file, never from a global/repository tag in its frontmatter.
- **Interpretive policy** belongs to one stable Finder Class, not a subjective
  path or name allowlist. A Lens may declare `interpretive` when it needs broad
  reasoning over intent and context; omission means `standard`. Interpretive
  Finders receive the ReviewSpecification when one is available. The selected
  Recipe maps both classes to concrete Seats, so a Lens cannot pin a model that
  silently becomes stale. There is no arbitrary role→model matrix and no
  concrete per-Lens Seat override.

What remains **is** the lens: a name and a prompt. Lenses are markdown files
in one format — name from the filename, body is the prompt, frontmatter
limited to optional `finder-class: interpretive` and a display-only `category` tag
(amended per #12: groups lens listings for the human reader; never read by
routing, which stays on the candidate's own type; amended per #52:
`category` is live catalog metadata, never a FrozenLens field — so it cannot
appear in a Dossier, which renders from the frozen plan).
`finder-class` admits exactly `interpretive`; standard is represented by
omission. The class governs Recipe Seat resolution and whether the Finder
receives an available ReviewSpecification, never Candidate routing. Built-ins
ship inside Gauntlet; a project drops the same format in its own lens
directory; one loader reads the available Lens Catalogs. Caps, routing,
schemas, tool sets, and
applicability tags are banned from lens files by design — reintroducing them
rebuilds the old anatomy.

The restored `spec-conformance` Lens has one intrinsic execution rule: without
a frozen ReviewSpecification, its selected Finder is skipped and reported once
instead of invoked. That rule is attached to the known Lens identity in plan
execution; it does not add an applicability field to Lens content or alter how
any emitted Candidate routes.

The shipped `subjective` and `refactoring-checklist` Lenses opt into
`interpretive`; restored `spec-conformance` does too. They all reason over
broader intent rather than running only a bounded mechanical sweep, though
their Candidates may take either evaluation path. Every other shipped Lens is
standard. Category does not imply Finder Class — future Lenses opt into
`interpretive` individually when their reasoning and context needs earn it.

Version identity is the frozen prompt text, never a separately stored digest
(amended per #52): at submission the ReviewPlan freezes each lens's prompt
text (`content-frozen per run`). Editing a prompt changes the next run's
frozen tail; a resumed run replays the exact stored text. A display
fingerprint, if ever wanted, is computed at render time. Git history
complements this for shipped lenses but cannot record what text an actual
run used — the frozen text travels with the run.

## Consequences

- Adding an ordinary lens = adding one markdown file, which makes it available
  for selection. It can never require touching schemas, routing, or core
  stages, and tests use fixture content rather than the shipped catalog. The
  named `spec-conformance` no-specification skip is the sole built-in
  applicability exception.
- The per-project coding-style lens (fast-follow) is just a project-local
  file; the loader ships in v1.
- A finder's emit schema keeps `failure_scenario` optional — that optionality
  is the routing discriminator, not sloppiness.
- Editing a lens file changes review behavior without a code review; the
  frozen text on every run is the accepted mitigation for a personal
  tool.
