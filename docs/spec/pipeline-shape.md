# Pipeline shape

The frozen two-path review pipeline, as specification. Prompts and lenses live
in `content/`; this file is the ordering, routing, and assembly policy ported
from the old reviewer and restated in CONTEXT.md terms.

## Stages

```
Finders ──► (BugClaims)   ──► Pool ──► Verification ──┐
        └─► (Observations) ─────────► Judgment ───────┴─► Assembly
```

1. **Finders** — one AgentInvocation per runnable selected lens, fanned out in
   parallel over the same frozen diff. Prompt = finder system prompt + shared
   block + ReviewSpecification (Interpretive Finders only, when the plan froze
   one) + lens tail (see the cache invariant below). Standard Finders never
   receive specification material. Each emits Candidates via `emit_findings`.
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
prompt — nothing announces that no specification was supplied. A PullRequest
review acquires GitHub closing issues as current Slices (native parent one
level, owner/member/collaborator comments, shared 20k comment budget) before
the plan is frozen; GitHub unavailability or a PR with no closing issues is
the same quiet no-spec path. A Caller Addendum is appended after fetched
material and never replaces it.

The selected `spec-conformance` Lens is the one applicability exception: when
the plan froze no ReviewSpecification it creates no AgentInvocation and no
coverage gap. Other selected Finders run normally. The human-readable Dossier
lists only runnable Finders as completed coverage and adds one concise skipped
line for `spec-conformance`; invocation accounting counts only work that ran.

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

The scheduler first loads one atomic completed-Finder-stage checkpoint. When
it is absent or invalid, every runnable planned Finder starts a fresh stage
attempt and is partitioned by the complete resolved Seat and shared context
shape: ordinary context, or ordinary context plus the frozen
ReviewSpecification. A singleton runs directly. A larger partition starts one
ordinary Finder first. Its first
successfully decoded usage-bearing assistant `message_end` produces the total
`PrefixObserved` scheduling signal. If the invocation settles or fails before
that evidence, finalization produces `PrefixNotObserved` instead, so the
partition cannot deadlock. `PrefixObserved` starts a fixed 1,500 ms best-effort
settle delay; then every remaining ordinary Finder starts while the first
continues concurrently. `PrefixNotObserved` skips only the delay.

One provider-neutral cache-group identifier names the partition; an adapter may
map it to a native key. Every Finder receives a complete prompt whose system
prompt, tools, and shared user prefix are byte-identical up to the Lens tail.
A missing or failed cache changes cost only: all Finders retain the ordinary
invocation retry, termination, output, and coverage behavior.
If the adapter cannot decode enough evidence to construct an honest typed
outcome, the review fails before a completed Finder checkpoint exists.
Only after every Finder completes does Gauntlet atomically persist the ordered
Finder outcomes. Resume reuses the whole completed stage or reruns the whole
stage; it never combines partial Finder work across process attempts. Pool,
Verification, and Judgment have no intermediate checkpoints: after a completed
Finder checkpoint they rerun as whole stages, so there is no downstream state
to invalidate.
Dossier accounting includes the completed Finder attempt that supplied its
results, not abandoned-attempt provider spend.
