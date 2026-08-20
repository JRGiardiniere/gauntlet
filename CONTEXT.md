# Gauntlet

The domain language for Gauntlet: an Effect-native, Pi-harnessed, model-agnostic
code-review agent. This is a glossary only — no implementation detail belongs here.

## Language

**ReviewTarget**:
The exact change under review — a tagged union of target kinds (a working
tree, a pull request, or a commit range), carrying its frozen diff and any
scope-degradation warnings acquired with it. A commit range's identity is the
resolved SHA pair, never the branch, tag, or revision expression submitted for
it. A working tree may extend a commit range, in which case the review diff
starts at that range's merge-base and still ends at the working tree.
_Avoid_: scope, subject, changeset, target repo

**ReviewSpecification**:
The frozen requirements used to judge a ReviewTarget — the material of at most
one Specification Source, beside an optional Caller Addendum. Its current Slice
defines present obligations; broader material supplies intent, constraints,
and explicitly deferred work.
_Avoid_: spec context, scope block, issue text

**Caller Addendum**:
Caller-provided Markdown carried in a ReviewSpecification beside fetched
source material — labeled as caller context, never authority over fetched
text. It stands alone as the complete ReviewSpecification only when no
Specification Source resolves.
_Avoid_: spec override, supplemental source, extra context

**Slice**:
The part of a ReviewSpecification whose obligations belong to the current
ReviewTarget, distinct from sibling work described by broader material.
_Avoid_: child issue, subtask, ticket

**Specification Source**:
An authority that supplies requirement material and relationships for a
ReviewSpecification without defining what system must host that material.
_Avoid_: issue provider, tracker integration, spec resolver

**Comment Omission**:
The record that admitted comments were dropped to fit the aggregate bound —
what was dropped, how much, and the cutoff — carried on the ReviewSpecification
for contextual prompts and the report.
_Avoid_: truncation notice, comment summary, budget overflow

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
persisted once at submission. A Run owns these frozen inputs: resume continues
that exact Run from them, reusing completed paid work, under the currently
installed code. Delivery destination is not part of the plan.
_Avoid_: configuration snapshot, settings, options

**Submission**:
The act that turns a caller's review request into a persisted Run: resolving
the ReviewTarget, freezing Lenses and Seats, acquiring the ReviewSpecification,
and writing the Run record with its frozen ReviewPlan (overlay before plan —
a persisted plan implies its overlay exists). Submission happens once per Run;
resume, execution, and delivery are not part of Submission.
_Avoid_: intake, plan builder, run factory, review setup

**Recipe**:
A named review policy stored as user-owned content in the Recipe Catalog. It
assigns Seats and may select Lenses, but never contains budgets, cost limits,
caps, prompt text, or per-Lens Seat assignments.
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

**Default Lenses**:
The required standing selection of Lenses applied when the caller does not use
the exact `--lenses` override. It is a user preference, never inferred from
every available Lens and never part of a Recipe.
_Avoid_: baseline lenses, default Lens set, Lens roster

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
limited to an optional `interpretive` Finder Class and an optional display-only
category tag (grouping in listings, never routing).
A Lens never names a concrete Seat and carries no routing, caps, or schema —
its Candidates route by their own type, not by the Lens that produced them.
The ReviewPlan freezes each Lens's prompt text and Recipe-resolved Seat at
submission.
_Avoid_: bug lens / subjective lens (lenses are not typed by path), role,
angle, finder (that's the invocation, not the prompt)

**Lens Catalog**:
A collection of available Lenses whose scope comes from catalog membership,
never from tags or other applicability metadata on a Lens.
_Avoid_: lens registry, repository-only tag, global tag

**Finder Class**:
A stable statement of how a Lens reasons: `specific` for a bounded pass whose
Lens spells out exactly what to check, or `interpretive` for broader reasoning
over intent and context. An Interpretive Finder receives the
ReviewSpecification when one is available; the selected Recipe maps each class
to a concrete Seat.
_Avoid_: standard finder (the pre-#110 name for `specific`), subjective
finder, deep finder, finder role, model tier

**Standards Manifest**:
The user-owned, per-repository list of governing documents fed to the
standards Lens: one newline-delimited path list under `~/.gauntlet/standards`,
keyed by the main repository root, never a file in the reviewed repository.
Submission assembles the listed documents into the Lens's frozen prompt; with
no manifest the standards Lens is skipped, not invoked.
_Avoid_: standards config, conventions file, rules file

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

**Review Priority**:
The P1–P3 urgency of a reported Candidate for the author of the current
ReviewTarget, considering reachability, consequence, and whether that target
is responsible for addressing it.
_Avoid_: severity, impact score, confidence

**TestSuggestion**:
Verification's optional recommendation to run named existing repository tests
that would increase confidence in a confirmed or unverified BugClaim, including
why those tests are relevant. It is advice carried by the Dossier, not an
execution request or test result.
_Avoid_: test request, reproduction, generated test

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
