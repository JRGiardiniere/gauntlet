# Harness: sessions, agents, prompts, emit, turns and usage

- **Status:** Research only. Nothing here is approved architecture.
- **Date:** 2026-11-18
- **Scope:** the `harness.md` area of [the rebuild brief](README.md). It follows the brief's fixed decisions and keep/cut list, and applies the ladder to each capability: OpenCode natively, then an OpenCode plugin, then Effect, then hand-coded.
- **Sources (read only):**
  - OpenCode at `0b87612`, cited as `oc:` (`/home/silentverdict/Projects/reference/opencode/packages/…`).
  - Gauntlet `main` at `42c92bc`, cited as `src/…`.
  - The spike worktree, cited as `spike:` (`/home/silentverdict/Projects/gauntlet-spike-opencode/…`). `spike/embedded/` was still being written while this was researched, so nothing below relies on its results.
  - Claude Agent SDK 0.3.301, taken from the spike's `node_modules`.

## Conclusion

OpenCode covers more of the harness natively than the spike used. Three spike mechanisms have native or plugin replacements:

1. **Cache key.** A session's OpenAI `prompt_cache_key` and `session-id` header come from `parentID ?? fork ?? id` (`oc:core/src/session/affinity.ts:7`, `oc:core/src/session/model-request.ts:321-336`, `oc:core/src/plugin/provider/chatgpt.ts:290`). Creating one anchor session per finder partition, with every finder as its child, gives the partition one key **with no body rewrite**. The spike's plugin decompresses, rewrites and recompresses every request body; this would replace it.
2. **First-response signal.** The durable event `session.step.first-token` (`oc:schema/src/session-event.ts:350-360`) fires when the provider streams its first token. That is earlier and more precise than the spike's `step.ended`, which waits for the step's tools to finish.
3. **Usage.** Each step is one assistant message, and each message carries normalized `tokens` (`oc:schema/src/session-message.ts:221-238`: `finish`, `tokens`, `error`). A sweep after the turn, plus `experimental.session.wait`, replaces the event reducer.

Two things stay hand-made, but each lives in a few lines of one Gauntlet plugin:

- **Ending the turn at the emit.** OpenCode has no terminating tool. The step continues whenever a local tool ran (`oc:core/src/session/runner/publish-llm-event.ts:615`, `step.ts:328`).
- **Corrective turns.** These stay a small driver loop.

Keep a Gauntlet seam, but make it **turn-level**, not Pi's event-level mirror. On that basis, `invoke.ts` shrinks from 1,056 lines to roughly 250.

## 1. Per-stage agents and system prompts

**Rung 2 wins (an agent transform), plus rung 1 (the session's model).**

- **One OpenCode agent per stage role per run.** The Gauntlet plugin registers them with `ctx.agent.transform` (`oc:plugin/src/effect/agent.ts`, README `:39-46`).
  - The agents are `finder-<partition>`, `pool`, `verifier` and `judge`.
  - Each sets `system`, `mode: "primary"`, `hidden: true`, and a `permissions` ruleset: deny `*`, then allow `read`/`grep`/`glob` (pool gets none) and the stage's own emit tool. Wholly denied tools leave the tool snapshot (`oc:core/src/session/context.ts:152-155`). That gives the read-only fence and Pool's emit-only rule in one place, and gives every finder a byte-identical tool set.
- **The finder `system` is the finder system prompt plus the shared block** (and the spec, for interpretive finders), exactly as today (`src/run/finder-execution.ts:141`). The lens tail stays the user message. The pipeline spec requires the shared block in the system prompt, not a user message (`docs/spec/pipeline-shape.md:136-150`). This rules out a single static finder agent.
- **Each run is its own Location (its snapshot directory).** So the plugin's per-Location setup looks the run up by `ctx.location.directory` and defines all of its agents at activation.
  - The run registers its agent specs, including every partition's shared block, before it creates its first session.
  - This needs no `reload()` round-trips; the spike's `reloadAll` did need them (`spike:src/harness/opencode-live.ts:188-193`).
- **Model and effort go on the session, not the agent:** `sessions.create({ agent, model: { providerID, id, variant }, title, parentID, location })` (`oc:client/src/effect/api/api.ts:153-162`). The variant carries effort, so agents stay provider-neutral. What `low`/`medium`/`high` mean belongs to `providers-config.md`.
- **Always set `title`.** An untitled top-level session triggers an extra title-model call; child sessions never do (`oc:core/src/session/runner/llm.ts:202-205`).
- **Per-session `permissions` are not needed.** They only narrow the agent's permissions (`context.ts:152`).
- **The `context` hook is used for two things only:** stripping the instructions part (below) and the emit gate (item 2).

**How the prompt lands.**

- **OpenAI:** `system = [agent.system, joinedInstructions]` (`oc:core/src/session/model-request.ts:116-126`).
  - A non-empty `agent.system` **replaces** OpenCode's base prompt.
  - The second part joins the codemode catalog, MCP, references, skills, discovered `AGENTS.md`, the built-ins (`core/date`, `core/environment` with `<env>`), and API entries, in that order (`oc:core/src/session/context.ts:171-179`, `oc:core/src/instructions/builtins.ts:24-53`).
- **Claude:**
  - The `claude_code` preset (with `snapshot: false`), plus `append` = `<runtime_info>…</runtime_info>`, plus `# Agent role (from OpenCode)\n<agent.system>`, plus the instruction sources except date and environment (`oc:core/src/plugin/provider/claude-agent/language-model/system-prompt.ts:9-23`, `instructions.ts:18,39-53`).
  - Claude Code supplies its own env/date/model sections inside the preset.
  - The spike measured the preset as cheap: the starter's first prompt was 193.6k tokens via OpenCode against 191.6k via `claude -p` (`spike:spike/results/cache-summary.json`).

**Can the appended blocks be stripped or pinned? Yes for OpenAI; partly for Claude.**

- **OpenAI.** A Gauntlet `context` hook keeps only `system[0]` for Gauntlet agents.
  - Hooks may mutate `system` (`oc:plugin/src/effect/session.ts:114-129`).
  - Gauntlet's workspace prompt already names the root, so date, `<env>` and discovery are pure noise.
  - Also turn the sources off in config: `instructions: { project: false, global: false, claude: false }` (`oc:core/src/instruction-discovery.ts:49-53`), and no skills, MCP or references. The hook is then a backstop.
- **Claude.**
  - The append is controllable. If the Gauntlet plugin registers **before** its claude-agent instance (both are SDK plugins, and hooks run in registration order), Claude's hook reads the already-stripped `system` and appends only the role.
  - `<runtime_info>` is a constant. The preset's dynamic sections (cwd, date, model) are fixed inside one run, which is all the finder cache needs. The spike measured a 98.8% median first hit for a cold follower.
  - Removing them for cross-run reuse would need `excludeDynamicSections: true` (SDK `sdk.d.ts:2357-2369`). OpenCode hard-codes the preset, but Gauntlet already wraps the claude-agent `registry`, whose `run(request)` carries `request.system` (`oc:…/claude-agent/claude/sessions.ts:36`). That makes it a one-line rewrite if it's ever worth it. It isn't needed for v1.
- **Mid-session drift.**
  - `core/date` is day-granular and re-renders as a chronological System message if the day changes mid-session (`oc:specs/v2/session.md:90-96`). The OpenAI hook drops it.
  - The read tool injects nested `AGENTS.md`/`CLAUDE.md` as a synthetic message after reads (`oc:core/src/tool/plugin/read.ts:146-164`). That breaks the fence ("a reviewed repo's instructions never load"); it belongs to `isolation-tools.md`. The same `context` hook can drop messages whose metadata has `instruction.paths` as a backstop.

## 2. The emit tool and ending the turn at emit

**Rung 2 wins: a plugin tool plus a `context`-hook gate.** OpenCode has no terminating tool.

- `Tool.Info` has no stop flag (`oc:schema/src/tool.ts:109-117`).
- Hooks cannot fail with a typed error (`oc:plugin/src/effect/registration.ts:19-25`).
- Agent `steps` only forces a text-only final step (`oc:core/src/session/runner/llm.ts:261-280`).
- `experimental.idle` runs only after the turn would have ended (`oc:plugin/src/effect/session.ts:271-286`).

**The gate.**

1. Emit tools are registered once with `ctx.tool.transform`. Their `execute` routes by `context.sessionID` to the invocation's capture and records the first valid emit.
2. A `context` hook, which runs before every provider dispatch, checks for that session: *has a validated emit landed?* If so, it forks `ctx.session.interrupt({ sessionID })` and returns `Effect.never`.

The step that called the emit has already ended and published its usage (`oc:core/src/session/runner/step.ts:301-315`), so no extra request is ever built or sent. This is the spike's two-part mechanism (`blockAfterEmit` in `model.request` plus an interrupt at `step.ended`, `spike:src/harness/opencode-live.ts:144,294-329`) folded into one hook. With it, the cache runs recorded 0 post-emit turns; the service runs without it recorded 11–12.

**Rejected alternatives.**

- **Interrupting on `tool.success`.** It can land before the provider's finish event, and the step then records no usage (`step.ts:290-304`).
- **Interrupting on `step.ended` from outside without a gate.** It races the next step's dispatch.

**Strict decoding.** Let the failure return in-turn as a `Tool.Error`; keep corrective turns only for "ended without emitting".

- The tool's `input` is the contract's JSON Schema projection (`projectOutputContract`). OpenCode validates the call against it and answers schema-level misses itself with `Invalid arguments for tool "…": … Update the arguments and call the tool again.` (`oc:core/src/tool/runtime.ts:64-70,101`). The tool never runs on invalid input.
- Inside `execute`, run Gauntlet's strict decoder (`decodeOutputContract`). On rejection, return `new Tool.Error({ message })`. That is a model-visible failure the model corrects in the same turn (`oc:specs/v2/tools.md:276-283`), and it now behaves the same on Claude and OpenAI.
- Pass JSON Schema rather than an Effect `Schema` as `input`. OpenCode pins effect 4.1.0 and Gauntlet uses 4.1.4, so passing a cross-copy `Schema` is a risk until the copies are unified.
- In-turn retries don't spend the 2 corrective turns. The overall deadline bounds them, so leave agent `steps` unset.

## 3. Corrective turns, deadline, abort, first-response

| Concern | OpenCode gives (rung 1) | Gauntlet keeps |
|---|---|---|
| Provider retry | Generic retry, at most 4 with jittered backoff (`oc:specs/v2/session.md:82-86`). Claude Code retries itself, so OpenCode turns retry off for Claude (`claude-agent/session.ts:52-60`). Stalls: `headerTimeout`/`chunkTimeout` settings (`oc:schema/src/provider.ts:91-101`). | Nothing. The stall retry, startup deadline and first-response watchdog all go. |
| Waiting for a turn | `experimental.session.wait({sessionID})` waits for idle (`oc:core/src/session/session.ts:275-277`). Execution ends `succeeded`/`failed`/`interrupted`. | `prompt` then `wait`, then read the last assistant message's `finish`/`error`. |
| Corrective turns | None. `experimental.idle` could admit a synthetic message (rung 2), but it is experimental and moves policy out of reach of the scripted tests. | A ≤2-turn loop that re-prompts the same session with today's text (`src/harness/invoke.ts:558-559`). |
| Deadline | None per invocation. | `Effect.timeout` around the invocation (rung 3). Its scope finalizer runs `sessions.interrupt` then `sessions.remove`. |
| Abort | `sessions.interrupt` stops local execution (`oc:specs/v2/session.md:59-64`). | Plain fiber interruption from the run's scope (MCP `review_cancel`). The same finalizer. The `AbortSignal` plumbing goes. |
| First response | `session.step.first-token` | A `Deferred` the starter completes on its first `first-token`, from `ctx.event.subscribe({ types: ["session.step.first-token"] })` in the plugin. The follower wait gets `Effect.timeoutOption` (rung 3), as the brief requires. |

**What of `invoke.ts` survives** (1,056 lines today):

- **Kept and simplified:**
  - The corrective loop and its constants (`:43`, `:558-559`, and the `stop`/`toolUse` branch at `:651-686`).
  - The overall deadline and cancel race (`:962-993`), rewritten as `Effect.timeout` plus scope finalizers.
  - Usage decode and sum (`:727-794`, mapped as in item 4, `costUsd` dropped).
  - `finalizeOutcome`/`outputFrom` (`:796-897`), keeping only the validated-emit decode.
  - `invokeSignaled`/`PrefixSignal` (`:1030-1056`), re-pointed at first-token.
  - Input validation (`:692-714`), reduced to the deadline.
- **Deleted:**
  - The capture reducer and accumulator (`:85-281`), which a turn result replaces.
  - Dispose, abort-settle and the usage sweep at teardown (`:43-48`, `:288-372`).
  - The event queue and `openCapturedSession` (`:374-470`).
  - The watchdog and `runPrompt` race (`:471-556`).
  - The startup deadline (`:577-587`).
  - The fresh-session retry (`:689-690`, `:939-960`).
  - Salvage (`:833-847`).
  - Pi transcript debug logging (`:312-350`). At debug level, dump the session's messages to `run.log` instead.
  - `AdapterContractViolation` shrinks to "the turn ended with no terminal assistant message".

## 4. Usage capture

**Rung 1 wins:** sweep the session's assistant messages after the invocation.

- **OpenCode's `TokenUsage`** is `input` (non-cached), `output` (visible: output minus reasoning), `reasoning`, `cache.read` and `cache.write` (`oc:core/src/session/usage.ts:11-19`, `oc:ai/src/schema/events.ts:88-90`).
  - OpenAI Responses: `input = input_tokens − cached − cache_write` (`oc:ai/src/protocols/open-responses.ts:921-931`).
  - Claude: the provider keeps the per-response maximum of each counter. Context occupancy is the last API call's input (`oc:…/claude-agent/language-model/usage.ts:17-57`, `specs/v2/claude-agent-provider.md:123`).
- **Mapping to `UsageRow`** (`src/harness/harness-session.ts:39-48`), which matches the spike (`spike:src/harness/opencode-live.ts:311`):

  | `UsageRow` | From |
  |---|---|
  | `input` | `tokens.input` |
  | `output` | `tokens.output + tokens.reasoning` (Gauntlet's output includes reasoning) |
  | `reasoning` | `tokens.reasoning` |
  | `cacheRead` | `tokens.cache.read` |
  | `cacheWrite` | `tokens.cache.write` |
  | `cost` | Dropped (dollars are cut) |

  `cacheShare` (`src/run/progress-text.ts:36-41`), `read / (input + read + write)`, stays correct because `input` excludes cached tokens.

**Double-counting rules.**

- **Count one source.** Use assistant messages only. Never add them to `session.step.ended` events, `session.usage.updated` (an ephemeral running total) or `experimental.session.stats`.
- **One row per assistant message.** A retry before any output reuses the assistant message and publishes no usage. A fresh-assistant retry produces two real calls, and both count (`oc:core/src/session/runner/step.ts:255-318`).
- **The emit gate leaves no interrupted step.** Interrupting a live step instead would publish `step.failed` with tokens, which the spike had to special-case (`opencode-live.ts:294-304`).
- **Auxiliary calls** (title, compaction, generate) are recorded separately as `session.usage.recorded` (`session-event.ts:160-170`). Prevent them: set the title, and keep `compaction.auto: false` as the spike did. Don't count them.
- **Claude undercount (accepted).** When Claude calls a tool OpenCode didn't offer, one step makes several API calls; only the last call's input is kept, and a response whose only call was such a tool goes uncounted (`claude-agent-provider.md:154`).
- **OpenAI cache writes are not reported.** `cache_write_tokens` is absent, so `cacheWrite = 0` and the to-be-cached tokens sit in `input`. Record what was reported, never infer a write. `run.log` should say "OpenAI reports no cache writes" rather than imply a 0% write.

## 5. Cache sharing

**Recommendation: don't make the spike's cache-key plugin the production design.** Use OpenCode's native affinity (rung 1):

1. Create one never-prompted anchor session per finder partition.
2. Create every finder as `sessions.create({ parentID: anchor, … })`. `SessionAffinity.get` then gives every finder the same `prompt_cache_key` and `session-id`/`x-session-affinity` headers, including the ChatGPT `session-id` (`oc:core/src/session/model-request.ts:321-336`, `oc:core/src/plugin/provider/chatgpt.ts:290`).

That deletes `http.request` body surgery (zstd/gzip decompress, rewrite, recompress: `spike:spike/cache/cache-key-plugin/server.ts:52-90`), which is the most fragile code in the spike.

- **Evidence that the key matters:** OpenCode's default per-session key gave 66.8% cold and 83.7% warm stage hit; the shared key gave 96.4% and 99.3% (`spike:spike/results/cache-summary.json`, `svc-luna-observe`/`override`). That matches Pi's 93.9% and 99.5%.
- **Claude** caches by prefix inside Claude Code, so no key is involved. OpenCode Claude already reached 93.9% cold and 98.3% warm stage hit.

**Starter/follower ordering against OpenCode sessions** (finder-execution keeps the shape, with new signals):

1. Create the anchor, then the starter (child).
2. `prompt` the starter, then await its first `session.step.first-token`, with a follower timeout.
3. Wait the settle delay, which is `FinderCacheSettle`, 1,500 ms (`src/run/finder-execution.ts:50-60,217-221`). Measuring it is "later" in the brief.
4. Create and prompt every follower concurrently.
5. If the starter ends without a first token, followers start at once (`PrefixNotObserved`).

All finder sessions share one Location, so the env, tools and agent are identical.

## 6. The harness seam

**Recommendation: keep a Gauntlet seam, but make it turn-level and about 80 lines** (rung 4, hand-coded, because OpenCode has no public fake host).

- OpenCode's own tests mock `LLMClient.Service` internally (`oc:core/test/session-generate.test.ts:69`), or replay a fake `claude` binary (`oc:core/test/plugin/provider/claude-agent/lib/fake-claude.ts`). Neither is public SDK.
- Calling OpenCode from the stages directly would put the host into every pool, verification and judgment test.

```ts
// harness-session.ts, replacing Pi's literal mirror
type TurnEnd = Data.TaggedEnum<{
  Emitted: { readonly raw: Schema.Json }
  Stopped: { readonly finish: "stop" | "length" }
  Failed: { readonly reason: string }
  Interrupted: {}
}>
interface AgentSession {
  readonly turn: (text: string) => Effect.Effect<TurnEnd>
  readonly firstToken: Effect.Effect<void>
  readonly usage: Effect.Effect<ReadonlyArray<UsageRow>>
}
interface Harness {
  readonly open: (spec: AgentSpec) => Effect.Effect<AgentSession, InvocationSetupError, Scope.Scope>
}
// AgentSpec: run, stage role, seat, prompt, contract, cacheGroup?
```

- **Live layer:** the OpenCode adapter. It does create, prompt plus wait, the gate, the message sweep and the interrupt-and-remove finalizer.
- **Test layer:** the scripted adapter, cut from 472 lines to about 120. It is a script of `TurnEnd`s plus usage rows per open.
- **Policy stays generic** and is unit-testable in `invoke.ts`: corrective turns, the deadline, first-response and outcome finalization. The Effect skill's "model test over generated event sequences" fits it.
- **Delete** `workspaceRoot`, `workspacePrompt` and `emitToolName` from the factory contract. With one host there is one workspace prompt, and tool names are the contract names (per `docs/spec/emit-tools.md`).
- **A handful of adapter tests** run the real embedded host with a scripted language model, injected through the `ctx.aisdk.hook("language", …)` runtime hook (`oc:plugin/src/effect/README.md:85-104`). Those tests cover the emit gate, the corrective re-prompt and the usage sweep without network access. This is a quick check, since boot cost per test is unknown.

## 7. Embedded host lifetime

- **One embedded host per process,** shared by every run in it: one for the CLI's single run, one for `gauntlet mcp` serving concurrent runs. Booting is the expensive part (about 237 MB idle with the lean config, per the brief).
- **Each run is a Location: its snapshot directory, `Location.Ref { directory }`** (`oc:schema/src/location.ts`). Location services boot lazily per directory: plugin activation, tools, agents.
- **Don't use workspaces** (`workspaceID`). The claude-agent plugin skips any Location that has one (`oc:…/claude-agent/index.ts:27`), and workspaces exist for remote or provisioned placements.
- **Location eviction is idle-based,** 60 minutes by default (`oc:core/src/location-activity.ts:29`).
  - Set `experimental.location_idle_timeout` short, for example `"2 minutes"` (`oc:schema/src/config/experimental.ts:51`), because the snapshot is deleted at run end anyway.
  - Remove every session at invocation end (`sessions.remove`), after the usage sweep.
- **Keep the database in memory,** which is the SDK default (`oc:sdk/src/internal/host.ts:41`).
  - The host resumes suspended sessions at startup (`host.ts:56`, `oc:specs/v2/session.md:68`). A file-backed database would replay a crashed run's sessions on the next `gauntlet mcp` start.
  - If OpenAI credentials force a file-backed store, that is a `providers-config.md` question. Gauntlet would then have to clear its sessions at boot.
- **Process release.**
  - Disable the built-in `opencode.provider.claude-agent` in config, and register Gauntlet's own `make(io, registry)` (`oc:…/claude-agent/index.ts:20`). Register it **after** the Gauntlet plugin (item 1).
  - The spike's wrapper maps Claude session to OpenCode session through `registry.attach → run` and kills that session's children when the invocation's scope closes (`spike:spike/embedded/release.ts:41-85`). That meets "released straight away" without waiting for the 5-minute `IDLE_MS` (`oc:…/claude/sessions.ts:25,105-112`).
  - **Cheaper alternative to check:** the SDK's `instances` option builds a separate plugin instance per key (`oc:sdk/src/internal/instances.ts:15-24`). Keying it by a run id in session metadata gives each run its own `registry()`, and `registry.close()` at run end stops exactly that run's processes natively (`sessions.ts:113-133`). That removes the `io.spawn` wrapper and the process bookkeeping. Both options import core internals by path; that cost is the same either way.

## What is deleted or ported

| Old code | Fate |
|---|---|
| `src/harness/pi-live.ts`, `pi-login.ts`, `pi-catalog.ts`, `fast-mode.ts`, `claude-live.ts`, `tool-deadline.ts` | Deleted (cut list). |
| `src/harness/harness-session.ts` (220 lines) | Rewritten as the turn-level seam (about 80 lines). Keep `UsageRow` without `cost`, plus `InvocationSetupError`. |
| `src/harness/invoke.ts` (1,056 lines) | Ported to about 250 lines (item 3). |
| `src/harness/scripted.ts` (472 lines) | Rewritten as a `TurnEnd` script (about 120 lines). |
| `src/harness/output-contract.ts` | Kept: the projection becomes the emit tool's `input`, and the decoder runs in `execute`. The Claude `--json-schema` note goes. |
| `src/stages/evaluation.ts` | Kept. `EVALUATION_SYSTEM_PROMPT` becomes the `pool`/`verifier`/`judge` agents' `system`. |
| `src/run/finder-execution.ts` | Ported: anchor plus child sessions, first-token signal, follower timeout. `cacheGroupId` becomes the anchor. |
| `spike:src/harness/opencode-live.ts` | Ported as the live adapter. Drop the `http.request` rewrite, header copying, polling `waitFor`, the `any` typing and the instance-wide event demux (use `wait` plus the message sweep). Write it on the Effect plugin API. |
| `spike:spike/cache/cache-key-plugin/` | Not ported. Native `parentID` affinity replaces it. |

## Risks and unknowns: quick hands-on checks

1. **Does `parentID` affinity give the shared cache?** Check that child sessions send one `prompt_cache_key` on OpenAI, and on ChatGPT login one `session-id`, and that the hit rate matches the spike's `override` runs. Also check that child sessions created directly behave as plain sessions, not subagent jobs. The council flagged this as untested.
2. **The emit gate.** Check that forking `interrupt` and then `Effect.never` inside a `context` hook ends the execution as `interrupted`, without deadlocking or defecting, on both providers. Check that the emit step's usage survives. Check that the Claude process then sits waiting for a tool result until it is released, never sending a post-emit API call.
3. **Hook order.** Check that SDK plugins run their `context` hooks in list order, so the Gauntlet plugin strips instructions before its claude-agent instance reads them. Capture the Claude `append` once to confirm.
4. **The `first-token` event.** Check that it reaches an in-process `ctx.event.subscribe` for both providers. The spike found that a per-session `session.log` follow delivered only its sync marker in-process (`opencode-live.ts:99-102` comment). Also check that it fires before tools run.
5. **Nested `AGENTS.md` injection on read** (`read.ts:146-164`). Confirm `instructions.project: false` suppresses it; otherwise the `context` hook drops it. This is shared with `isolation-tools.md`.
6. **Effect copy skew** (4.1.0 against 4.1.4). Check that `Tool.Error` and `Effect` values built from Gauntlet's copy are accepted by OpenCode's runtime. If not, unify the copies before writing the plugin on the Effect API.
7. **Location eviction.** Check that the run's Location, and its claude-agent attach, actually unload after `location_idle_timeout` once its sessions are removed. Watch RSS across 3 back-to-back runs in one `gauntlet mcp` host.
8. **Claude tool naming.** Claude sees `mcp__opencode__emit_findings`. Check that prompts naming `emit_findings` still get the call; the spike's identity mapping suggests they do.
9. **Scripted language model through `aisdk` `language`.** Check boot time per test; if it is slow, keep those tests to a handful.
