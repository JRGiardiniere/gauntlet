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
   same frozen diff. Prompt = finder system prompt + shared block +
   ReviewSpecification (Interpretive Finders only, when the plan froze one) +
   lens tail (see the cache invariant below). Standard Finders never receive
   specification material. Each emits Candidates via `emit_findings`.
2. **Pool** — receives the BugClaims only. Clusters duplicates and bundles
   clusters for verifiers. May bundle, never delete. Text-only: no file reads,
   no ReviewSpecification.
3. **Verification** — one invocation per bundle; adversarial; attaches a
   Verdict (confirmed / refuted / unverified) plus Review Priority and one-line
   evidence to each cluster. Receives the frozen ReviewSpecification, when one
   exists, after the scope block and before the claims.
4. **Judgment** — one invocation, all Observations, decisions by index:
   kept (with Review Priority + reason + finder ratings), dropped (with reason), merged.
   Receives the frozen ReviewSpecification, when one exists, after the scope
   block and before the candidates.

A run whose plan froze no ReviewSpecification carries no absence text in any
prompt — nothing announces that no specification was supplied.
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
- A Pool cluster renders as one finding: its fullest member states it, every
  member's lens is credited, and all members stay in the Dossier.
- Judge merge claims are sanitized: a candidate cannot be merged into itself,
  into an unknown keeper, or into a keeper that another merge removed.
- Review Priority is judged downstream (verifier/judge), never self-reported by
  finders — a finder rates its own work and has seen only its own lens.
- Refuted claims and judge drops are not discarded: they land in the Dossier
  and render as Markdown Dossier appendices (ADR 0006).

## The cache-prefix invariant (finder fan-out)

Provider prefix caching only engages when the prompt is byte-identical from
the first token to the point of divergence. So: shared block first, lens tail
last, always — nothing lens-specific (no label, no index, no run id, no
timestamp) may appear before the tail, and every finder in a fan-out carries a
byte-identical tool set. An Interpretive Finder's ReviewSpecification section
sits between the shared block and the tail: it is identical for every
interpretive lens in the run, so it extends the shared prefix rather than
breaking it (interpretive finders simply share a longer prefix than standard
ones). Warmup/fan-out sequencing, session-key sharing,
and cache diagnostics are operational mechanics (ADR 0002), not review
semantics.

The scheduler partitions unfinished Finders by the complete resolved Seat and
shared context shape: ordinary context, or ordinary context plus the frozen
ReviewSpecification. A singleton runs directly. A larger partition first runs
one bounded preload AgentInvocation with the same system prompt and tool
definitions as its followers. The setup contract forbids analysis and tool
execution; adapters enforce that prohibition before any tool can reach the
workspace. Only the exact contract acknowledgment is accepted and captured;
other prose degrades to an ordinary direct Finder invocation. After the generic
settle delay, every follower replays that exact
user/assistant prefix and appends only its Lens assignment as the last turn.

One provider-neutral cache-group identifier names the partition; an adapter may
map it to a native key. A missing or failed cache changes cost only: followers
still receive the complete context and retain the ordinary invocation retry,
termination, output, and coverage behavior. Every preload outcome is journaled
as paid work, but never reused as evidence of transient provider cache state.
If the adapter cannot decode enough evidence to construct an honest typed
outcome, the review fails rather than journaling fabricated accounting data.
Resume reuses completed Finder outcomes and freshly preloads any partition that
still has more than one unfinished Finder. Final accounting reads every valid
sequenced preload artifact, including attempts from an interrupted execution.
