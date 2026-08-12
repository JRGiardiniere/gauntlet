# Pipeline shape

The frozen two-path review pipeline, as specification. Prompts and lenses live
in `content/`; this file is the ordering, routing, and assembly policy ported
from the old reviewer and restated in CONTEXT.md terms.

## Stages

```
Finders ──► (BugClaims)   ──► Pool ──► Verification ──┐
        └─► (Observations) ─────────► Judgment ───────┴─► Assembly
```

1. **Finders** — one AgentInvocation per lens, fanned out in parallel over the
   same frozen diff. Prompt = finder system prompt + shared block + lens tail
   (see the cache invariant below). Each emits Candidates via `emit_findings`.
2. **Pool** — receives the BugClaims only. Clusters duplicates and bundles
   clusters for verifiers. May bundle, never delete. Text-only: no file reads.
3. **Verification** — one invocation per bundle; adversarial; attaches a
   Verdict (confirmed / refuted / unverified) plus severity and one-line
   evidence to each cluster.
4. **Judgment** — one invocation, all Observations, decisions by index:
   kept (with tier + reason + finder ratings), dropped (with reason), merged.
5. **Assembly** — deterministic code, no model. Produces the Dossier.

## Routing

A Candidate routes by its own type, decided at emit time by the presence of a
`failure_scenario` (ADR 0001, ADR 0004): present → BugClaim → Pool →
Verification; absent → Observation → Judgment. Any lens may emit both kinds.
There is no lens→path mapping anywhere.

## Internal constants (unmeasured folklore, kept as defaults per #7)

- **Pool skip**: with fewer than 3 BugClaims, Pool is skipped and each claim
  becomes its own single-member cluster.
- **Bundle size**: verifier bundles carry 4 clusters each.
- **Corrective turns**: an invocation that ends without calling its emit tool
  gets up to 2 corrective turns on the same session before its Termination is
  recorded as missing-emit.

Per-lens candidate caps live in the ReviewPlan. The cap is stated in the
prompt AND enforced at truncation — one over-emitting lens otherwise floods
every stage downstream. Historical default: 6 per lens, with the `subjective`
lens at 2× (it absorbed two lenses' budgets when the code/design altitudes
merged, 2026-08-04); when a lens's cap differs from the shared cap, the
override is stated in its tail position, never the shared block.

## Candidate line format

Pool, Verification, and Judgment all receive candidates in one format:

```
[i] (lens-name) file:line — summary
    claimed failure: <failure_scenario, when present>
```

`line` may be absent on whole-change findings. Verifier bundles label clusters
`[cN]`, numbered across the whole run, each cluster listing its member
candidates with lens, location, and claimed failure.

## Assembly policy

Each Stage enforces its own accounting and sanitization at its result seam;
Assembly is the deterministic aggregation of those results.

- Every candidate index is accounted for exactly once across keep / merge /
  drop (Judgment) or appears in exactly one cluster (Pool). The stage output
  decoders are strict — one off-spec field fails the stage result so the
  affected candidates surface as unverified/undecided rather than silently
  relabeled.
- A BugClaim whose verifier never returned a verdict is **unverified** — a
  first-class Verdict, rendered tagged in the main findings section.
- An Observation the judge said nothing about is **undecided** — kept and
  rendered tagged, never silently dropped.
- Malformed Pool output is repaired (per #7): unclustered indexes become
  single-member clusters; a candidate may never be lost to a clustering error.
- Judge merge claims are sanitized: a candidate cannot be merged into itself,
  into an unknown keeper, or into a keeper that another merge removed.
- Severity is judged downstream (verifier/judge), never self-reported by
  finders — a finder rates its own work and has seen only its own lens.
- Refuted claims and judge drops are not discarded: they land in the Dossier
  and render as Markdown Dossier appendices (ADR 0006).

## The cache-prefix invariant (finder fan-out)

Provider prefix caching only engages when the prompt is byte-identical from
the first token to the point of divergence. So: shared block first, lens tail
last, always — nothing lens-specific (no label, no index, no run id, no
timestamp) may appear before the tail, and every finder in a fan-out carries a
byte-identical tool set. Anything a lens `needs-spec` pulls in (the spec text)
is appended after the tail. Warmup/fan-out sequencing, session-key sharing,
and cache diagnostics are adapter mechanics (ADR 0002), not review shape.
