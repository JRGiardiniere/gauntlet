# Gauntlet

The domain language for Gauntlet: an Effect-native, model-agnostic code-review
agent on an embedded OpenCode Host. This is a glossary only — no implementation detail belongs here.

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
The frozen requirements used to judge a ReviewTarget — the Caller Addendum's
Markdown. Its current Slice defines present obligations; broader material
supplies intent, constraints, and explicitly deferred work.
_Avoid_: spec context, scope block, issue text

**Caller Addendum**:
Caller-provided Markdown, passed with `--spec`, that is the whole
ReviewSpecification. The Caller fetches any issue text itself and puts it
here.
_Avoid_: spec override, supplemental source, extra context

**Slice**:
The part of a ReviewSpecification whose obligations belong to the current
ReviewTarget, distinct from sibling work described by broader material.
_Avoid_: child issue, subtask, ticket

**Specification Source**:
Where a ReviewSpecification's material comes from. The Caller Addendum, passed
with `--spec`, is the only one; Gauntlet fetches no issues itself.
_Avoid_: issue provider, tracker integration, spec resolver

**AgentInvocation**:
One bounded request to an agent for one structured output — inclusive of the
Host's own provider retries and corrective turns on the same session.
_Avoid_: agent run, agent call, session (a session is the Host resource an
invocation uses, not the invocation itself)

**Host**:
The agent platform a Run's AgentInvocations execute on: OpenCode, embedded in
the CLI as Gauntlet's own instance, isolated from the person's OpenCode. It
runs Claude and OpenAI Seats through the same tools, fence and usage
accounting, so one Recipe can mix them.
_Avoid_: harness, backend, runtime, provider (a provider serves models; a Host
runs invocations), agent host (that's the Caller)

**Caller**:
The person or agent that starts a Run and receives its result: a person at a
shell, or a coding agent such as Codex or Claude Code. The Caller is
independent of the Host — Claude Code can call the CLI, whose Run executes on
the OpenCode Host.
_Avoid_: agent host, client, user

**CLI**:
Gauntlet's standalone command-line program, `gauntlet`: the only way to start
a Run. Its Runs execute on the embedded OpenCode Host.
_Avoid_: `gauntlet review` as the program's name (it is one of its commands),
the Pi version

**Mod**:
Retired in v2. Gauntlet inside Claude Code, started with `/gauntlet`, whose
Runs executed as `claude -p` children. Claude Seats now run on the CLI's Host.
_Avoid_: using it for the CLI's agent skill or for Claude Seats

**Machine**:
The computer a Run executes on, outside any ReviewWorkspace — its real files,
processes, and credentials.
_Avoid_: host (that's the agent platform), host path, host file

**ReviewWorkspace**:
The permission fence over the Run's frozen snapshot that filesystem-capable
AgentInvocations see: the Host's read-only `read`, `grep` and `glob` tools,
allowed inside the snapshot and refused on `.git`, `.env*` and any path that
leaves it, through a symlink included. The reviewed repository's own agent
configuration never loads. The snapshot stays unmodified, and the Machine is
out of reach by capability reduction — no shell, writes, or network — not by
hardened isolation against a hostile repository.
_Avoid_: sandbox (a future project-execution environment has a materially
different trust and capability boundary), jail, container

**ReviewPlan**:
The fully resolved instructions governing one review — semantics-and-spend
fields only (lenses, models/recipes, caps, tool capabilities) —
persisted once at submission. A Run owns these frozen inputs: its stages and
its delivery read them from the plan. Delivery destination is not part of the
plan.
_Avoid_: configuration snapshot, settings, options

**Submission**:
The act that turns a caller's review request into a persisted Run: resolving
the ReviewTarget, freezing Lenses and Seats, acquiring the ReviewSpecification,
and writing the Run record with its frozen ReviewPlan. Submission happens
once per Run; execution and delivery are not part of Submission.
_Avoid_: intake, plan builder, run factory, review setup

**Recipe**:
A named review policy stored as user-owned content in the Recipe Catalog. It
assigns Seats and may select Lenses, but never contains budgets, cost limits,
caps, prompt text, or per-Lens Seat assignments.
_Avoid_: preset, tier, model config

**Seat**:
One concrete provider, model, and inference-effort assignment for an
AgentInvocation, written `provider/model:effort`, with `+fast` after the
effort for OpenAI's Fast mode. A `claude-code/` Seat names
a Claude model alias and effort, run through the installed `claude` on the
person's Claude plan.
_Avoid_: model (omits provider and effort), model config

**Default Seat**:
The Seat a Recipe applies to every seated Stage for which it does not name an
override.
_Avoid_: base seat, default model, fallback seat

**Recipe Catalog**:
The user's complete collection of available Recipes, one for every provider.
Every Recipe has the same status; Gauntlet does not distinguish app-owned, built-in, and
custom Recipes.
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
location, summary) and optional citations to source files the finder read.
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
keyed by the repository's common git directory (one per repository, shared by
every worktree), never a file in the reviewed repository.
Submission assembles the listed documents into the Lens's frozen prompt; with
no manifest the standards Lens is skipped, not invoked.
_Avoid_: standards config, conventions file, rules file

**Run**:
The execution of one review, from Submission to its Dossier, recorded in its
run directory. The only thing that "runs" — agents are invoked, stages
execute.
_Avoid_: agent run, pipeline run, job

**AgentOutcome**:
Everything one invocation yielded: optional output, a termination mode, usage,
and diagnostics — all data, even when the invocation ended badly. Expected bad
endings live here, never in the error channel.
_Avoid_: agent result, agent error, response

**Termination**:
How an invocation ended (completed, missing emit, budget exhausted, context
limit, provider failed, interrupted). A mode on an
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
What Verification attaches to a BugClaim: confirmed, refuted, or plausible.
Confirmed means every load-bearing fact was witnessed in the workspace;
plausible means the mechanism is coherent but at least one load-bearing fact
is not witnessable there (external tool behavior, timing, env, config) — or
the claim was never examined at all. Plausible is a first-class verdict,
never an absence.
_Avoid_: evaluation, judgment (that word belongs to Observations), unverified
(the pre-2026-08-22 name for plausible)

**Review Priority**:
The P1–P3 urgency of a reported Candidate for the author of the current
ReviewTarget, considering reachability, consequence, and whether that target
is responsible for addressing it.
_Avoid_: severity, impact score, confidence

**TestSuggestion**:
Verification's optional recommendation to run named existing repository tests
that would increase confidence in a confirmed or plausible BugClaim, including
why those tests are relevant. It is advice carried by the Dossier, not an
execution request or test result.
_Avoid_: test request, reproduction, generated test

**Judgment**:
What the judge attaches to an Observation: kept, dropped with a reason, or
undecided. Undecided is first-class, never an absence.
_Avoid_: verdict (that word belongs to BugClaims), decision

**Pool**:
The stage that clusters BugClaims reporting the same defect, so Verification
checks each defect once. Its clusters are an execution plan, not a domain
object; it may cluster but never delete.
_Avoid_: clusterer, deduper

**Verifier bundle**:
The Pool clusters one Verification invocation checks.
_Avoid_: bundle for a single cluster, batch

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
