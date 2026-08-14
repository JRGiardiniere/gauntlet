# Gauntlet

The domain language for Gauntlet: an Effect-native, Pi-harnessed, model-agnostic
code-review agent. This is a glossary only — no implementation detail belongs here.

## Language

**ReviewTarget**:
The exact change under review — a tagged union of target kinds (v1: a working
tree or a pull request), carrying its frozen diff and any scope-degradation
warnings acquired with it.
_Avoid_: scope, subject, changeset, target repo

**AgentInvocation**:
One bounded request to an agent for one structured output — inclusive of
harness-internal retries and corrective turns on the same session. Warmup calls
are invocations too (paid, metered, deadlined), with a trivial output contract.
_Avoid_: agent run, agent call, session (a session is the harness resource an
invocation uses, not the invocation itself)

**ReviewWorkspace**:
The confined repository view exposed to filesystem-capable AgentInvocations —
per invocation, a copy-on-write overlay on the Run's frozen snapshot behind a
stable virtual root, owning both filesystem-facing model tools. Writes are
invocation-local disposable scratch; the snapshot stays unmodified, and the
host is out of reach by capability reduction — no guest git, host processes,
or network — not by hardened isolation against a hostile repository.
_Avoid_: sandbox (a future project-execution environment has a materially
different trust and capability boundary), jail, container

**ReviewPlan**:
The fully resolved instructions governing one review — semantics-and-spend
fields only (lenses, models/recipes, caps, tool capabilities) —
persisted once at submission; resume reuses completed paid work when the
target is unchanged, under the currently installed code. Delivery
destination is not part of the plan.
_Avoid_: configuration snapshot, settings, options

**Recipe**:
A named model selection as user-owned content in the Recipe Catalog. It names
one Default Seat plus optional Stage-specific Seat overrides — seats only,
never budgets or cost limits. Favorites and the Default Recipe are settings
metadata, never recipe anatomy. The ReviewPlan freezes the resolved Seats at
submission.
_Avoid_: preset, tier, model config

**Seat**:
One concrete provider, model, and inference-effort assignment for an
AgentInvocation, written `provider/model:effort`.
_Avoid_: model (omits provider and effort), model config

**Default Seat**:
The Seat a Recipe applies to every seated Stage for which it does not name an
override.
_Avoid_: base seat, default model, fallback seat

**Recipe Catalog**:
The user's complete collection of available Recipes. Every Recipe has the same
status; Gauntlet does not distinguish app-owned, built-in, and custom Recipes.
_Avoid_: recipe database, built-in recipes, app recipes, user recipes

**Default Recipe**:
The one Recipe selected for a review when the caller does not name one. It is
a user preference that points to a Recipe, never part of that Recipe.
_Avoid_: default, fallback recipe, default model

**Candidate**:
One finder-produced claim awaiting evaluation, with a stable identity. A tagged
union of BugClaim and Observation sharing a common core (identity, lens,
location, summary).
_Avoid_: finding (reserved for what survives evaluation), issue, claim, result

**BugClaim**:
A Candidate asserting a concrete failure scenario — specific inputs or state
under which the code does the wrong thing. Creates an obligation for
Verification to attempt refutation of that scenario.
_Avoid_: falsifiable candidate, bug, defect claim

**Observation**:
A Candidate asserting that something should be different, without asserting
that anything breaks. Creates an obligation for Judgment to keep or drop it
with a reason. Checkability does not make an Observation a BugClaim — the
failure scenario does.
_Avoid_: subjective candidate, nit, suggestion

**Lens**:
One finder's point of view, as pure content: a named prompt (a markdown file,
shipped with Gauntlet or project-local, one shared format) with frontmatter
limited to an optional `deep` Finder Class and an optional display-only
category tag (grouping in listings, never routing).
A Lens never names a concrete Seat and carries no routing, caps, or schema —
its Candidates route by their own type, not by the Lens that produced them.
The ReviewPlan freezes each Lens's prompt text and Recipe-resolved Seat at
submission.
_Avoid_: bug lens / subjective lens (lenses are not typed by path), role,
angle, finder (that's the invocation, not the prompt)

**Finder Class**:
A stable statement of how much Finder reasoning a Lens needs: `standard` by
default or `deep` by explicit declaration. The selected Recipe maps the class
to a concrete Seat; the Lens never chooses a provider or model.
_Avoid_: finder role, smart model, low model, model override

**Run**:
The durable, resumable execution of one review. The only thing that "runs" —
agents are invoked, stages execute.
_Avoid_: DurableRun, agent run, pipeline run, job

**AgentOutcome**:
Everything one invocation yielded: optional output, a termination mode, usage,
and diagnostics — all data, even when the invocation ended badly. Expected bad
endings live here, never in the error channel.
_Avoid_: agent result, agent error, response

**Termination**:
How an invocation ended (completed, missing emit, first-response timeout,
budget exhausted, context limit, provider failed, interrupted). A mode on an
AgentOutcome, not a failure.
_Avoid_: failure, crash, timeout (as a noun for the ending)

**Failure**:
Something that prevents an outcome from existing at all — the Effect typed
error channel exclusively (invalid configuration, adapter contract violation).
A Run can complete with terminations and coverage gaps; only a failure stops it.
_Avoid_: using "failure" for terminations, coverage gaps, or undelivered receipts

**Stage**:
One of the five frozen pipeline phases: Finders, Pool, Verification, Judgment,
Assembly. A stage executes zero-to-many invocations.
_Avoid_: using "stage" for a single invocation, a CLI step, or anything after
Assembly

**Verdict**:
What Verification attaches to a BugClaim: confirmed, refuted, or unverified.
Unverified is a first-class verdict, never an absence.
_Avoid_: evaluation, judgment (that word belongs to Observations)

**Judgment**:
What the judge attaches to an Observation: kept, dropped with a reason, or
undecided. Undecided is first-class, never an absence.
_Avoid_: verdict (that word belongs to BugClaims), decision

**Pool**:
The stage that bundles BugClaims for verification. Its output is an execution
plan for verifier bundles, not a domain object; it may bundle but never delete.
_Avoid_: clusterer, deduper

**Dossier**:
The canonical, complete semantic result of one review: findings, refutations,
drops with reasons, coverage gaps, and target identity. A Run produces one
Dossier with machine-readable and human-readable representations; delivery
posts the human-readable representation.
_Avoid_: ReviewHandoff, review result, report, assessment

**Coverage gap**:
A lens or stage whose work is missing from the Dossier — visible data on the
Dossier, distinct from diagnostics and from failure.
_Avoid_: lens failure, partial result

**DeliveryReceipt**:
The durable record of what one external delivery attempt actually did,
independent of whether the review itself completed. v1 delivery is a single
comment; oversize output truncates evidence before identity, recorded on the
receipt.
_Avoid_: delivery result, delivery status
