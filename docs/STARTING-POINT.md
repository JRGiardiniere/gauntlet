# Possible Effect-native review-agent successor: architectural starting point

> ⚠️ **DELETE after the Wayfinder map's decisions are made** (when
> [Assemble spec + backlog, #14](https://github.com/JRGiardiniere/gauntlet/issues/14)
> closes). This is pre-decision exploration; where it disagrees with the map's
> Decisions-so-far or the spec, it is WRONG. Do not treat it as guidance.

- **Status:** Exploratory input for Wayfinder charting — superseded by decisions on [map #1](https://github.com/JRGiardiniere/gauntlet/issues/1)
- **Created:** 2026-08-09
- **Decision state:** Nothing in this document is approved architecture

> This is a collection of hypotheses, observed behavior, candidate primitives,
> trade-offs, and questions. It is deliberately not a specification, plan, ADR,
> or commitment to preserve the current system. Wayfinder and its individual
> decision tickets are where choices will be made.

## Why this document exists

The current Code Review Agent works, has accumulated extensive behavioral
protection, and is about to lose a substantial legacy branch: the Claude Agent
SDK runtime. At the same time, there is interest in building the successor
around Effect v4 rather than translating the current implementation file by
file.

Before building anything, the goal is to talk through:

- what the review product actually is;
- which domain primitives deserve names;
- which current features are essential, accidental, obsolete, or configurable;
- which failures are product outcomes versus infrastructure failures;
- what durability and recovery should mean;
- where Effect should own execution and where plain TypeScript remains better;
- how a successor can prove itself without risking the working reviewer.

This document prevents the first Wayfinder sessions from beginning with a
blank page. Its suggestions are prompts to challenge, not defaults to ratify.

## Candidate Wayfinder destination

One possible destination statement is:

> A decision-complete architecture and behavioral specification for an
> Effect-native successor to the current Code Review Agent, including the
> protections it retains, rejects, or makes configurable, and a safe validation
> and cutover strategy.

Questions for the destination-grilling session:

- Is the destination an architecture specification, an executable prototype,
  an implementation-ready backlog, or some combination?
- Is this specifically a code-review product, or a reusable agent-evaluation
  engine whose first program is code review?
- Is compatibility with current-generation artifacts required, useful only for
  testing, or explicitly out of scope?
- Does Wayfinder stop before implementation, as usual, or carry selected
  prototypes far enough to settle uncertain decisions?
- What result would make us decide not to build the successor?

## Current context

### What the existing product does

At a high level, the current system performs:

```text
Scope
  -> parallel finder agents
  -> bug-path Pool and verification
  -> subjective-path judgment
  -> deterministic review assembly
  -> canonical ReviewHandoff
  -> presentation
  -> optional external delivery
```

The current orchestration is spread across standalone TypeScript CLIs and
durable filesystem artifacts. `launchd` owns detached execution so a paid run
can outlive the Codex or terminal session that started it.

The existing repository is:

```text
/Users/johngiardiniere/Code Review Agent
```

It should be treated as a working reference implementation and behavioral
oracle during successor design.

### Planned cleanup before or alongside successor work

The current cleanup proposal is itself not reproduced here as an approved
plan, but its intended direction is relevant:

- remove pre-freeze resume compatibility;
- remove the `modelTiers` overlay superseded by presets;
- route through `Candidate.path` instead of retired subjective routing rules;
- collapse candidate-file input to one `{ candidates }` projection;
- require frozen seats, finders, destination, and complete pipeline inputs;
- tighten current-generation scope and PR identity metadata;
- repair stale workflow documentation;
- migrate the one current-generation handoff lacking frozen seats;
- remove `claude-session.ts` and the shallow stage dispatcher;
- make the pipeline use the Pi stage runner directly;
- remove the special `claude` pseudo-provider and legacy seat decoder;
- remove the Claude Agent SDK, direct Zod dependency, and Claude-specific gates;
- retain Claude/Cursor/Codex skill adapters because they are entry points, not
  runtime dependencies.

This cleanup would make the existing implementation easier to understand and
would narrow the behavioral baseline the successor needs to examine.

## Evidence informing the discussion

### Dillon Mulroy and Ben Davis

A public-repository survey found no universal rule that agent code should be
Effect-native:

- Dillon Mulroy's direct Pi work is predominantly ordinary TypeScript:
  Promises, `AbortSignal`, async iterators, `try`/`catch`, and small Result
  unions. Even substantial Pi/MCP lifecycle code remains Promise-based.
- Ben Davis uses both styles. Simple or run-to-completion agent calls remain
  plain TypeScript, while newer long-lived multi-backend subagent orchestration
  uses an Effect-native core behind a plain Pi callback/Promise adapter.

The resulting empirical hypothesis is:

> Effect earns its cost through coordination, resource lifetime, cancellation,
> services, deterministic testing, and observability—not merely because an LLM
> or typed error is involved.

Full source-linked research currently lives at:

```text
/Users/johngiardiniere/Code Review Agent/docs/research/pi-effect-practice-dmmulroy-davis7.md
```

Research into `better-result` and the current harness lives at:

```text
/Users/johngiardiniere/Code Review Agent/docs/research/better-result-harness-fit.md
```

### Initial architectural hypothesis

The initial hypothesis—not a decision—is:

> Use Effect throughout the orchestration module, while retaining plain data
> values and thin adapters at CLI, persisted JSON, SDK callback, and external
> delivery seams.

This needs to be tested against a real vertical slice. If the slice is mostly
`Effect.tryPromise` wrapped around the current architecture, the hypothesis has
not earned adoption.

## Candidate domain primitives

These names are provisional. A domain-modeling session should challenge all of
them, especially overloaded terms such as “run,” “stage,” “failure,” and
“result.”

### `ReviewTarget`

Potential meaning: the exact change being reviewed and the intent available to
interpret it.

Possible contents:

- repository identity and root;
- reviewed commit;
- changed files and diff;
- PR identity and base/head metadata;
- issue/specification context;
- warnings about degraded scope discovery.

Open questions:

- Does the diff belong inside the target or as an artifact reference?
- Is an uncommitted working tree the same kind of target as a PR?
- Is the reviewed commit meaningful when untracked files are present?
- Should scope degradation be part of the target or a separate acquisition
  outcome?

### `ReviewPlan`

Potential meaning: the completely resolved, immutable instructions governing
one review.

Possible contents:

- enabled lenses;
- model/provider choices;
- stage policies and budgets;
- tool capabilities;
- cache/warmup policy;
- delivery selection;
- artifact schema version.

Open questions:

- Is “plan” the right word, or is this a `ReviewConfigurationSnapshot`?
- Which policies must freeze at submission?
- Which operational settings may legitimately change on resume?
- Does delivery belong in the plan if review completion is independent of it?

### `AgentInvocation`

Potential meaning: one bounded request to an agent runtime.

Possible contents:

- role and label;
- prompt;
- working directory;
- model and reasoning effort;
- allowed tools;
- structured-output contract;
- cache identity;
- startup, first-response, tool, and overall deadlines.

Open questions:

- Is a corrective emit turn part of the same invocation?
- Does warmup count as an invocation or as cache preparation?
- Are model/provider details domain data or adapter configuration?
- Does an invocation expose a stream of events, one terminal outcome, or both?

### `AgentOutcome<A>`

Potential meaning: everything learned from one invocation, including valuable
information produced by an imperfect run.

An initial shape to challenge:

```ts
interface AgentOutcome<A> {
  readonly output: Option.Option<A>
  readonly termination:
    | Completed
    | MissingEmit
    | FirstResponseTimeout
    | BudgetExhausted
    | ContextLimit
    | ProviderFailed
    | Interrupted
  readonly usage: Usage
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly attemptedOutput: Option.Option<unknown>
}
```

The important unresolved decision is what belongs in the Effect error channel.
The current system permits a valid structured output, late timeout, usage, and
diagnostics to coexist. A binary success/failure type can accidentally discard
that information.

One hypothesis is:

- expected terminal agent conditions are data in `AgentOutcome`;
- the typed Effect error channel represents inability to truthfully produce an
  outcome, such as invalid configuration, adapter corruption, or a violated
  internal contract;
- defects remain defects and are not normalized into provider failures.

Alternatives include:

- make provider failures typed Effect errors and harvest siblings through
  `Exit` values;
- expose a stream of agent events and derive the outcome separately;
- use a richer tagged state machine rather than one terminal record;
- remove salvage entirely and require only validated structured output.

### `Candidate`

Potential meaning: one finder-produced claim or judgment proposal before
downstream evaluation.

Current distinguishing information includes:

- originating lens;
- falsifiable versus subjective path;
- model;
- file/line;
- summary;
- claimed failure scenario.

Open questions:

- Is `Candidate.path` intrinsic to the candidate or derived from the lens?
- Should candidates have stable IDs rather than positional indexes?
- Should evidence be required at finder time?
- Is a subjective observation really the same primitive as a bug claim?

### `Evaluation`

Potential umbrella for Pool clusters, verifier verdicts, subjective decisions,
refutations, and undecided/degraded outcomes.

Open questions:

- Is one umbrella useful, or does it erase meaningful differences?
- Does Pool create domain objects or merely an execution plan for verifiers?
- Is `UNVERIFIED` a verdict, absence of a verdict, or a presentation state?
- Is severity decided by evaluators or by deterministic policy?

### `ReviewHandoff`

Potential meaning: the canonical, complete semantic result of a review,
independent of Markdown, logs, and delivery.

Current semantics worth questioning:

- findings, refutations, and judge-dropped observations remain distinguishable;
- coverage failures are explicit;
- counts must agree with included collections;
- target and reviewed-commit identity are enforced;
- artifact identities are recorded;
- operational diagnostics and accounting are not necessarily part of the
  semantic object.

Open questions:

- Is “handoff” still the right term if this becomes the product result?
- Should accounting be excluded, referenced, or embedded?
- Is presentation derivable enough to avoid a separate presentation receipt?
- Should delivery consume this object or a smaller projection?

### `DurableRun`

Potential meaning: a persisted execution that can be observed and resumed
without paying again for valid completed work.

Open questions:

- Is durability filesystem artifacts plus atomic rename, a journal, or a small
  database?
- Does resume validate artifacts, replay events, or execute a step state
  machine?
- Can two workers ever race to resume the same run?
- What constitutes a paid step, and which steps may be repeated safely?
- Is `launchd` part of the domain model or only a Mac production adapter?

### `DeliveryReceipt`

Potential meaning: the independent durable outcome of attempting to deliver a
completed review somewhere external.

Open questions:

- Is external delivery a core product concern or an adapter/application layer?
- Which destinations are actually needed?
- Is partial multi-comment delivery a first-class outcome?
- Should a failed delivery ever affect review completion?

## Candidate deep modules

This is one possible decomposition. It should be judged on interface depth,
not on whether each box maps neatly to a current file.

```text
CLI / skill / launchd adapter
             |
             v
DurableRuns: submit, inspect, await, execute
             |
             v
ReviewEngine: review a frozen target + plan
       |                 |
       v                 v
  Finder program    Evaluation program
       \                 /
        \               /
         v             v
          AgentRunner port
                 |
        +--------+--------+
        |                 |
     Pi adapter      deterministic test adapter

ReviewHandoff -> Presentation -> optional ReviewDelivery
```

### Possible external interfaces

```ts
interface DurableRuns {
  readonly submit: (request: SubmitReview) => Effect.Effect<RunHandle, SubmitError>
  readonly inspect: (id: RunId) => Effect.Effect<RunSnapshot, RunNotFound | RunReadError>
  readonly await: (id: RunId) => Effect.Effect<RunSnapshot, RunNotFound | RunReadError>
  readonly execute: (id: RunId) => Effect.Effect<ReviewHandoff, RunExecutionError>
}

interface ReviewDelivery {
  readonly deliver: (
    runId: RunId,
    destination: DeliveryDestination,
  ) => Effect.Effect<DeliveryReceipt, DeliveryRuntimeError>
}
```

Questions:

- Is this interface too broad?
- Should `execute` be private to a worker adapter?
- Should `await` be a `Stream<RunEvent>` rather than polling to a snapshot?
- Does the caller need a `ReviewEngine` interface at all, or only durable runs?
- Should delivery accept a `ReviewHandoff` instead of a run ID?

## Where Effect might earn its place

This section lists candidate uses, not requirements.

### Structured concurrency

Potential replacements for:

- hand-managed Promise sets;
- broad `Promise.all` fan-out;
- custom semaphores;
- scattered `AbortController` wiring;
- ambiguous ownership of background tasks.

Possible Effect tools:

- scoped fibers;
- `Effect.forEach` with explicit concurrency;
- `FiberSet` or `FiberMap` where keyed lifecycle is real;
- interruption propagation;
- `Deferred`, `Queue`, and `Ref` for coordination.

### Resource lifetime

Potential resources:

- Pi sessions;
- event subscriptions;
- subprocesses and file descriptors;
- temporary files;
- runtime observers;
- delivery clients.

Possible Effect tools:

- `Scope`;
- `Effect.acquireRelease`;
- scoped layers;
- finalizers that remain observable and testable.

### Time and retry policy

Potential policies:

- startup deadline;
- first-response deadline;
- tool deadline;
- total invocation budget;
- bounded missing-emit correction;
- warmup retry;
- durable-run polling;
- provider backoff.

Possible Effect tools:

- `Effect.timeout`;
- `Schedule`;
- `TestClock`;
- typed retry predicates;
- explicit distinction between interruption and typed failure.

### Agent event streams

Pi exposes subscriptions, callbacks, Promises, and async iteration. One
hypothesis is to adapt callbacks into a private `Queue` and expose a `Stream` to
the Effect-native implementation.

Questions:

- Does backpressure matter for these events?
- Is a full `Stream` abstraction useful, or would an Effect callback bridge be
  simpler?
- Which events are product-relevant versus diagnostics?
- What must happen when the consumer is interrupted?

### Services and layers

Possible internal ports:

- `AgentRunner`;
- `RunStore`;
- `ScopeAcquirer`;
- `ReviewPresenter`;
- `ReviewDelivery`;
- clock/configuration/telemetry services.

Guardrail:

> Introduce a seam only where behavior genuinely varies. Pi plus a deterministic
> test adapter can justify `AgentRunner`; a one-implementation helper does not
> automatically deserve a public service.

### Schema

Potential use:

- decode untrusted CLI and persisted JSON;
- construct current-generation contracts;
- version boundary-crossing tagged unions;
- produce tool parameter schemas where Pi accepts the projection;
- validate artifacts on resume.

Questions:

- Can one Effect Schema definition truthfully serve domain, persistence, and
  model-facing tool contracts?
- Where would projection make schemas less clear than separate explicit forms?
- Which artifacts remain intentionally structurally lenient?
- Is compatibility decoding part of production or only a migration utility?

### Observability

Potential value:

- one trace per durable review;
- spans for finder, Pool, verifier bundle, judge, presentation, and delivery;
- structured annotations for run, lens, seat, reviewed commit, cache identity,
  and artifact path;
- metrics for cache hits, termination modes, coverage failures, and retry use;
- distinguish defects, typed failures, interruption, and degraded-but-complete
  outcomes.

Questions:

- Which observability backend, if any, is justified for a small local tool?
- Are structured logs enough initially?
- Which labels risk leaking repository or prompt content?
- What operational question must each metric answer?

## Protection inventory to review

No item in this inventory is automatically retained. “Initial reason” records
why the existing system has it; “decision questions” are what Wayfinder should
resolve.

### Review identity and configuration

| Current protection | Initial reason | Decision questions |
| --- | --- | --- |
| Freeze models, seats, finders, destination, and reviewed commit | Resume should not silently change behavior after configuration edits | Which fields must freeze? Is destination truly execution configuration? |
| Review remote PR head rather than a divergent local checkout | The review must describe the commit GitHub will merge | Is remote-head review always desired? What about intentionally local review? |
| Require target/head consistency in the semantic result | Prevent a review from claiming a different commit | Should identity be cryptographically tied to artifacts or is schema validation enough? |
| Stable provider/model/effort grammar | Make frozen choices readable and replayable | Does Pi's provider configuration make a separate grammar redundant? |

### Agent authority

| Current protection | Initial reason | Decision questions |
| --- | --- | --- |
| Finder/verifier/judge agents have no edit or write tools | A reviewer should inspect, not mutate, the target | Is read-only absolute for all programs? Are scratch-space writes useful and safe? |
| Pool is emit-only | Pool should cluster supplied text without exploring the repository | Does Pool need to remain an agent? |
| Model-facing output must use terminating emit tools | Structured output is the inter-stage protocol | Is tool termination still the best Pi mechanism? |
| Live gate verifies the real tool projection | Offline source assertions previously missed drift | Which properties truly require a paid live gate? |

### Deadlines and interruption

| Current protection | Initial reason | Decision questions |
| --- | --- | --- |
| Separate startup deadline | Model catalog, credentials, or resource loading can hang before prompting | Is startup a distinct product-visible termination? |
| First-response watchdog | Detect a provider/session that never begins responding | What event truthfully counts as a first response? |
| Overall invocation budget | A stream, tool, or abort can otherwise hold the entire fan-out forever | Should timeout interrupt and await cleanup, or return before an uncooperative abort settles? |
| Separate tool and bash deadlines | Repository inspection commands may need more time than emit tools | Should tools own their own budgets or draw only from the invocation budget? |
| Do not retry after context-length stop or insufficient remaining budget | Avoid paying for a request that cannot succeed | Which terminal modes are retryable? |

### Structured output and salvage

| Current protection | Initial reason | Decision questions |
| --- | --- | --- |
| Bounded corrective turns for missing emit | Models sometimes prepare an answer but omit the tool call | Is correction worth latency and spend? One turn or two? |
| Capture pre-validation tool arguments | Pi may emit intended arguments that fail schema validation | Is invalid structured data valuable enough to retain? |
| Validated output wins over later salvage | Never demote known-good structured output | Should multiple emit attempts be rejected instead? |
| Preserve output alongside a late error | A timeout after emit should not resurrect refuted findings | How should partial success be represented? |
| Preserve final assistant prose from a dead agent | Avoid losing potentially useful work | Product input, diagnostic only, or remove? |

### Finder fan-out and cache behavior

| Current protection | Initial reason | Decision questions |
| --- | --- | --- |
| Byte-identical shared prefix across lenses | Provider cache reuse depends on prefix identity | Is cache optimization part of product semantics or an adapter optimization? |
| Warm one agent per model group before fan-out | Increase cache availability for sibling lenses | Does measured benefit still justify serial latency? |
| One model per shipped preset | Mixed fan-out pays multiple warmups and fragments cache | Must a preset forbid model diversity, or merely report its cost? |
| Per-lens candidate caps enforced after output | One noisy lens should not explode downstream cost | Fixed rule, plan policy, or removable? |
| Canonicalize emitted file paths conservatively | Agents produce absolute, partial, or ambiguous paths | Should invalid paths fail the candidate or remain with warnings? |
| One failed lens cannot reject successful siblings | A review should retain paid work and expose coverage loss | How should concurrency collection encode failure? |
| Separate diagnostics from coverage failures | Cache/retry noise should not pollute the review, while missing coverage matters | Which operational events change semantic completeness? |

### Evaluation behavior

| Current protection | Initial reason | Decision questions |
| --- | --- | --- |
| Bug and subjective paths remain independent | Avoid one path biasing or suppressing the other | Is independence still a core product theory? |
| Pool skips under three bug candidates | Avoid paying for clustering when little can be deduplicated | Is this threshold still measured and useful? |
| Pool may bundle but never delete | Refutation belongs to verifiers | Is the authority division still correct? |
| Pool output is repaired so every candidate appears once | Malformed clustering must not silently erase claims | Should malformed Pool output fail the stage instead? |
| Verifier bundles contain at most four clusters | Prevent overloading one verifier | Fixed domain rule or model-dependent policy? |
| Missing verifier output becomes visible `UNVERIFIED` | Dead verification must not promote or hide a claim silently | Is `UNVERIFIED` a review finding or coverage appendix entry? |
| Empty judge output preserves subjective candidates as undecided | A dead judge must not silently drop observations | Should undecided items appear in the main report? |
| Drops carry reasons | Preserve accountability for subjective suppression | Must every drop always have a reason? |
| Final assembly is deterministic | Avoid another model arbitrating or losing findings | Which grouping/folding remains deterministic policy? |
| No hard final finding cap | Severe design findings should not disappear behind bug volume | Is unlimited output still desirable for large diffs? |

### Durable execution and artifacts

| Current protection | Initial reason | Decision questions |
| --- | --- | --- |
| OS supervisor owns the paid run | Initiating agent sessions are not durable | Keep `launchd`, add other adapters, or use a different durable runtime? |
| Attached waiter does not own execution | Interactive UX should not compromise durability | Snapshot polling or event stream? |
| Completion files are removed before work and committed by rename | File existence must truthfully mean completion | Retain file signals or replace with a run journal? |
| Every persisted artifact is decoded before reuse | Resume must not trust partial/corrupt output | What makes an artifact valid: schema, identity, checksum, or all three? |
| Resume reuses valid paid outputs | Do not repay after presentation or delivery failure | What is the idempotency unit? |
| Empty finder output still flows through evaluation and rendering | “No findings” is a semantic result, not absence of execution | Can an entirely failed finder set still complete a review? |
| Presentation repair is separate from paid review replay | Corrupt Markdown should not cause model calls | Is presentation always derivable from the semantic result? |

### Delivery

| Current protection | Initial reason | Decision questions |
| --- | --- | --- |
| Local/agent delivery is the no-write default | External writes require explicit intent | Preserve as a product-wide safety default? |
| PR delivery preflights durable authentication before paid work | Request-local credentials may disappear before detached delivery | Should delivery selection ever block starting the review? |
| Recheck PR identity and head immediately before write | Avoid commenting on a changed or unrelated PR | Is stale delivery always forbidden, or optionally allowed with an explicit marker? |
| Stable hidden run markers support update instead of duplicate | Retry should be idempotent | Could GitHub check runs or another transport replace comments? |
| Split large output at finding boundaries | Preserve actionable units under comment limits | Is multi-comment delivery worth supporting? |
| Truncate evidence before identity | Severity, location, summary, and verdict remain actionable | What information is mandatory in every destination? |
| Partial writes produce an incomplete receipt | Successful chunks must survive a later write failure | Must delivery resume at chunk granularity? |
| Delivery failure does not undo review completion | Review semantics and transport reliability are distinct | Any destination where this should differ? |

### Testing and drift protection

| Current protection | Initial reason | Decision questions |
| --- | --- | --- |
| Behavioral tests drive real seams instead of grepping source | Mutation testing showed source assertions gave false confidence | What becomes the new deep module's test interface? |
| Deterministic scripted agent adapter | Exercise expensive behavior without providers | Should it model event timing, failures, and interruption explicitly? |
| Recorded real payload replays | Guard against projection and lenient-decoder drift | Which corpus should cross into the successor? |
| One narrow Pi live gate | Some SDK/tool properties exist only at the real provider boundary | What is the minimum live acceptance contract? |
| Exact runtime dependency pins | SDK and Effect betas can drift behavior | What update cadence and compatibility policy are acceptable? |

## Things that may be legacy rather than product

Candidates to challenge aggressively:

- Claude Agent SDK routing and pseudo-provider vocabulary;
- pre-freeze job and handoff decoders;
- `modelTiers` overlays;
- retired subjective lens names;
- raw-array candidate-file input;
- configuration fallback during resume;
- optional current-generation frozen fields;
- a monolithic `contracts.ts` covering runtime, handoff, delivery, and benchmark
  shapes;
- subprocess separation that exists because scripts evolved independently;
- duplicated CLI parsing and completion-file machinery;
- source-specific storage naming under `~/.claude`;
- direct coupling between benchmark contracts and production contracts;
- provider abstractions that have only one production adapter after Claude
  removal.

An item appearing here does not mean it should be deleted. It means its burden
of proof is higher than “the old implementation already has it.”

## Repository-separation hypothesis

The initial recommendation is a new sibling repository under:

```text
/Users/johngiardiniere/projects/<name-to-be-decided>
```

This temporary planning folder is deliberately named:

```text
/Users/johngiardiniere/projects/review-agent-wayfinding
```

It has not been initialized as a Git repository. The permanent product name and
repository home remain decisions.

Possible benefits of a separate repository:

- independent Effect/package/toolchain choices;
- no accidental imports from legacy code;
- clean history beginning with the chosen domain model;
- explicit compatibility and cutover;
- the working reviewer can review every successor change;
- the old implementation remains a stable fallback and differential oracle.

Possible costs:

- fixtures and behavioral laws must be curated rather than imported casually;
- cross-repository differential testing needs a deliberate harness;
- decisions, issues, and implementation can split across trackers if not
  organized carefully;
- duplicated documentation may drift;
- eventual naming/archive/canonical-repository transition needs a plan.

Alternative repository strategies to compare:

1. new sibling repository;
2. isolated package/folder inside the current repository;
3. temporary prototype repository followed by a later canonical home;
4. clean branch/history rewrite of the current repository;
5. a monorepo containing old and new during migration.

The initial lean is a new sibling repository, but Wayfinder should record the
decision rather than treat this document as its authority.

## Candidate build strategy

One hypothesis is a parallel clean implementation with compatibility only at
selected outer contracts:

1. finish or define the current-generation cleanup baseline;
2. classify existing acceptance checks as product law, configurable policy,
   migration-only behavior, or legacy;
3. build one finder-to-artifact vertical slice in Effect;
4. decide whether the slice demonstrates real depth and leverage;
5. build a unified Pi `AgentRunner`;
6. add finder orchestration;
7. add evaluation orchestration;
8. add durable execution and artifact validation;
9. add presentation and selected delivery behavior;
10. replay recorded inputs through both systems;
11. run a narrow live parity gate;
12. cut over only after explicit acceptance criteria are met.

Alternatives:

- refactor the existing implementation incrementally into Effect;
- build only a new execution/session module and keep the rest;
- perform the cleanup and stop without building a successor;
- use `better-result` and plain Promises rather than Effect;
- use Effect only for the durable controller, not agent orchestration;
- build a generic workflow engine first.

## Candidate vertical spike

A deliberately small but meaningful spike might perform:

```text
one frozen ReviewTarget
  -> one finder AgentInvocation
  -> one Pi session
  -> one structured CandidateSet
  -> one atomic artifact
```

It should include enough hard behavior to test the architectural hypothesis:

- startup and first-response deadlines;
- total budget interruption;
- scoped subscription/session cleanup;
- structured output decoding;
- output plus late-failure representation;
- usage accounting;
- deterministic test adapter;
- `TestClock` or equivalent deterministic time tests;
- plain Promise/CLI adapter at the outer edge.

Possible decision gate:

Continue only if the spike provides:

- simpler ownership of cancellation and cleanup;
- deterministic tests without real sleeps;
- no loss of partial output/accounting semantics;
- a thin Pi adapter;
- one obvious runtime boundary;
- clearer failures and traces;
- less manual lifecycle machinery rather than merely different syntax.

## Candidate Wayfinder frontier

These are possible initial decision tickets. The actual charting session should
recompute the frontier and should not create all of these blindly.

### Destination and scope

- What exactly is the successor product?
- What must the Wayfinder map deliver before implementation begins?
- What is explicitly out of scope for the first product?

### Repository and lineage

- Where should successor decisions and implementation live?
- What relationship, if any, may new code have to the old repository?
- How and when does the successor become canonical?

### Domain model

- What are the canonical terms for target, plan, invocation, outcome, review,
  run, failure, degradation, completion, and delivery?
- Are bug claims and subjective observations one primitive?
- Is `ReviewHandoff` still the canonical name and semantic result?

### Agent execution

- What is the terminal algebra of an agent invocation?
- What belongs in `AgentOutcome` versus the Effect error channel?
- Which structured-output recovery behavior is worth preserving?
- What timeout and interruption semantics are truthful?

### Review program

- Which lenses and paths define the product?
- Which Pool, verifier, judge, and assembly policies are essential?
- Which policies must be frozen versus configurable?

### Durability

- What does durable completion mean?
- What is the artifact or journal model?
- Which steps may resume or repeat without paying again?
- Which process supervisor adapters are needed?

### Authority and safety

- What may review agents read, execute, or write?
- What external writes are allowed and how are they authorized?
- Which fail-closed checks belong to every delivery destination?

### Validation

- What is the successor's deep test interface?
- Which existing fixtures and laws are admitted into the new corpus?
- What differential and live evidence is required for cutover?

## Questions that should remain uncomfortable

- Are we designing a better product, or laundering the existing implementation
  into cleaner abstractions?
- Which current protections have measured incidents behind them, and which are
  responses to hypothetical risks?
- Are partial/degraded reviews useful enough to justify their state complexity?
- Is durability proportionate for a local review tool, or has it become the
  product's defining advantage?
- Does the two-path review theory still outperform a simpler reviewer?
- Is Pool saving enough verifier cost to justify another agent and protocol?
- Is cache warmup an optimization the architecture should know about?
- Does a fully Effect-native orchestration core remain understandable to the
  people likely to maintain it?
- Would a smaller plain-TypeScript successor plus a disciplined session module
  meet the actual needs?
- What is the smallest successor that would be worth switching to?
- What evidence would justify abandoning the rewrite?

## Non-decisions recorded by this document

To prevent accidental interpretation, this document does **not** decide:

- the repository or product name;
- whether a new repository will definitely be created;
- whether Effect will be adopted;
- whether all current protections survive;
- whether current artifacts remain compatible;
- whether `ReviewHandoff` retains its name or shape;
- whether `launchd`, filesystem artifacts, Pool, verifier bundles, subjective
  judgment, delivery, or benchmarking remain;
- whether the candidate module decomposition is correct;
- whether implementation begins immediately after charting;
- whether this planning folder becomes the permanent repository.

Its only assertion is that these questions should be made explicit before a
replacement is built.
