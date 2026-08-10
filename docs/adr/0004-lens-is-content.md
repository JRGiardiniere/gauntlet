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
- **Model policy** belongs to the preset: one default finder model, with
  optional per-lens or per-invocation overrides. There is no role→model
  matrix, so a new lens never edits a preset.
- **Applicability** is planning: a lens may declare it needs the spec text;
  when absent, the lens is skipped — not an error, not a coverage gap.

What remains **is** the lens: a name and a prompt. Lenses are markdown files
in one format — name from the filename, body is the prompt, frontmatter
limited to the optional model override and the needs-spec flag. Built-ins
ship inside Gauntlet; a project drops the same format in its own lens
directory; one loader reads both. Caps, routing, schemas, and tool sets are
banned from lens files by design — reintroducing them rebuilds the old
anatomy.

Version identity is derived, never maintained: at submission the ReviewPlan
freezes each lens's prompt text and records its content hash
(`angle-b@3f9a2c71`), which surfaces in logs and reports. Editing a prompt
changes the next run's hash automatically; runs are comparable exactly when
their lens hashes match. Git history complements this for shipped lenses but
cannot record what text an actual run used — the frozen text and hash travel
with the run.

## Consequences

- Adding a lens = adding one markdown file. It can never require touching
  schemas, routing, presets, or core stages, and tests must never key
  assertions to real lens names (fixture lenses only).
- The per-project coding-style lens (fast-follow) is just a project-local
  file; the loader ships in v1.
- A finder's emit schema keeps `failure_scenario` optional — that optionality
  is the routing discriminator, not sloppiness.
- Editing a lens file changes review behavior without a code review; the
  frozen text + hash on every run is the accepted mitigation for a personal
  tool.
