# Pi harness surface — what an Effect `AgentRunner` port must wrap

- **Ticket:** [#4 Research: Pi harness surface](https://github.com/JRGiardiniere/gauntlet/issues/4) (part of #1)
- **Research date:** 2026-08-09
- **Status:** Research findings. Nothing here is approved architecture.

## Sources

Two bodies of ground truth, both read-only:

1. **The production reviewer** at `/Users/johngiardiniere/Code Review Agent`.
   Its Pi boundary is four files:
   - `/Users/johngiardiniere/Code Review Agent/pi-session.ts` — the whole in-process Pi
     session boundary (650 lines). This is the file a port replaces.
   - `/Users/johngiardiniere/Code Review Agent/sdk-utilities.ts` — first-response watchdog,
     per-tool timeout wrapper, terminating-tool factory.
   - `/Users/johngiardiniere/Code Review Agent/pi-stage.ts` — a second consumer of the same
     boundary (Pool/verify/judge seats).
   - `/Users/johngiardiniere/Code Review Agent/emit-schemas.ts` — the schema AST both the
     model-facing tool schema and the runtime decoder project from.
   Plus `pi-finders.ts` (fan-out, prompt-cache strategy) and `contracts.ts` (seat parsing).
2. **The Pi SDK itself**, under
   `/Users/johngiardiniere/Code Review Agent/node_modules/@earendil-works/pi-coding-agent/`
   — `dist/index.d.ts`, `dist/core/agent-session.d.ts`, `dist/core/model-resolver.d.ts`,
   the bundled `docs/`, and the transitive `node_modules/@earendil-works/pi-agent-core`
   and `.../pi-ai` packages where the agent loop and validation actually live.

## Version

| Fact | Value |
| --- | --- |
| Package | `@earendil-works/pi-coding-agent` |
| Version pinned in production | `0.84.1` (exact pin, `package.json` line 24) |
| npm `latest` as of 2026-08-09 | `0.84.1`, published 2026-08-07 |
| Other dist-tag | `legacy-node20` → `0.74.2` |

**There is no newer Pi to design against.** The production pin *is* the head of the
registry. The surface documented below is therefore current, not historical.

Recent-history caveats that matter for a port (from the bundled `CHANGELOG.md`):

- **0.84.0 was a large breaking release.** `message_update` events in JSON/RPC mode became
  delta-only — the cumulative `message` field and `assistantMessageEvent.partial` were
  removed to stop quadratic output growth. *A port must not depend on `message_update`
  carrying a cumulative message; `message_end` is the authoritative snapshot.*
- 0.84.0 also replaced pi-agent-core's session model with a lane-based `Session`/
  `SessionStorage`/`SessionRepo` API and promoted the v2 `AgentHarness` API to default.
- 0.84.1 added `terminate` support to *blocked* extension `tool_call` events.

The release cadence is roughly weekly with breaking changes inside the 0.x minor. A port
that hand-mirrors SDK shapes needs the drift tripwire pattern described in §8.

---

## 1. What "one invocation" is

In the production reviewer, one invocation is exactly one call to
`runSessionToolCall(opts)` in `pi-session.ts:472`. Its contract is the single most
important fact for the port:

> **`runSessionToolCall` never throws.** Every failure — construction, stall, budget
> exhaustion, missing emit, drifted usage shape, teardown — comes back as data in
> `SessionToolCallResult`.

That totality is not stylistic. Callers are a `Promise.all` fan-out of finder lenses and
four bench stages that pay real money per run; one throw discards every sibling's paid
work. **An Effect port gets this for free** — `Effect<SessionToolCallResult, never, …>`
with the failure modes as fields, or an explicit typed error channel. Either way, the
"one throw kills the fan-out" hazard is the requirement being encoded.

The invocation shape (`RunSessionToolCallOptions`, `pi-session.ts:221`):

```ts
interface RunSessionToolCallOptions {
  cli: { provider; model; tools; systemPrompt; sessionId? };
  prompt: string;
  cwd: string;
  timeoutMs: number;              // overall budget
  emitTool: string;               // name of the terminating tool
  firstResponseTimeoutMs?: number; // stall detector, default 300_000
  toolTimeoutMs?: number;          // default 120_000
  bashTimeoutMs?: number;          // default 600_000 — separate, larger
  startupTimeoutMs?: number;       // default 60_000
  onFirstUsage?: (usage: TokenUsage | null) => void;
  sessionFactory?: SessionFactory; // the offline test seam
}
```

Note `sessionFactory` — the existing design already has a port seam. In Effect terms this
is the service interface; `createSdkSession` is the live layer, scripted sessions are the
test layer.

---

## 2. Session lifecycle

### Creation

`createAgentSession(options)` from `@earendil-works/pi-coding-agent`
(`dist/core/sdk.ts`, re-exported from `dist/index.d.ts`) returns
`{ session: AgentSession, extensionsResult, modelFallbackMessage? }`.

The production construction (`pi-session.ts:281-343`, `createSdkSession`) is a five-step
sequence, and each step is a distinct resource acquisition:

```ts
const modelRuntime = await ModelRuntime.create();                    // 1. model catalog + auth
const resolved = resolveCliModel({ cliProvider, cliModel, modelRuntime }); // 2. model resolution
const settingsManager = SettingsManager.inMemory({ transport: "sse", compaction: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager,
  noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true,
  noThemes: true, systemPrompt });
await resourceLoader.reload();                                       // 3. resource load (disk I/O)
const sessionManager = SessionManager.inMemory(cwd, sessionId ? { id: sessionId } : undefined);
const { session } = await createAgentSession({ cwd, model, modelRuntime, thinkingLevel,
  noTools: "builtin", tools: allowed, customTools, resourceLoader, sessionManager, settingsManager });
```

Design facts a port needs:

- **Construction does blocking disk I/O** — credential reads (`auth.json`), the model
  catalog, resource loading. `pi-session.ts:378-394` documents that this used to sit inside
  the run deadline and now has its own `SESSION_STARTUP_TIMEOUT_MS = 60_000`, because "a
  blocking read there hangs the agent forever, and because the fan-out awaits every agent,
  one such hang costs the whole run its report." **Startup is a separately-bounded acquire,
  not part of the run budget.**
- **`SettingsManager.inMemory` / `SessionManager.inMemory`** keep the session off disk.
  A `sessionId` may be supplied — see §6, it is the prompt-cache key.
- **Compaction is deliberately disabled** (`compaction: { enabled: false }`). Rationale in
  the source: compaction rewrites the conversation prefix, which is the one thing every
  agent in a fan-out shares; letting it fire invalidates the provider cache entry the
  warmup paid for and re-prices the whole group. The cost is that a run which outgrows its
  context reports `stopReason: "length"` instead of recovering. **This is a policy choice
  the port must be able to express, not a Pi default.**
- **`DefaultResourceLoader` with all the `no*` flags** is how you get a hermetic agent:
  no user extensions, skills, `AGENTS.md` context files, prompt templates, or themes.
  Passing `systemPrompt` overrides Pi's stock "expert coding assistant… editing code"
  prompt; an **empty string falls through to the stock prompt** (`pi-stage.ts:30-31`).

### What a session holds

Per the `AgentSession` class docstring (`dist/core/agent-session.d.ts:1-13`) and its
private fields: an `Agent` instance, an `ExtensionRunner`, event listeners, and **five
distinct abort controllers** — `_compactionAbortController`, `_autoCompactionAbortController`,
`_branchSummaryAbortController`, `_retryAbortController`, and a collection
`_bashAbortControllers`. Plus session persistence handles (`sessionManager`,
`settingsManager`), the tool registry, and the built system prompt.

### Disposal

`session.dispose(): void` — "Remove all listeners and disconnect from agent. Call this when
completely done with the session." Synchronous, returns `void`.

Ordering constraint from production (`pi-session.ts:597-620`): **dispose must come after
the usage-accounting read**, because dispose disconnects the session from the agent that
owns `messages`. The production code puts the accounting read in a `try` and `dispose()` in
its `finally`, and swallows dispose errors deliberately ("teardown of work already done and
accounted for… the resources are process-lifetime").

For a port: `Effect.acquireRelease` where release is `dispose`, but the **final state read
must happen inside the scope**, before release. This is a real ordering hazard, not a
detail.

### Multi-session

`AgentSessionRuntime` / `createAgentSessionRuntime()` exists for apps that switch, fork, or
import sessions. Documented gotcha: `runtime.session` is *replaced* by those operations, so
event subscriptions (attached to a specific `AgentSession`) must be re-established. Gauntlet's
one-shot-per-invocation model does not need this; noted so the port does not accidentally
grow it.

---

## 3. Event delivery

### The mechanisms that exist

| Mechanism | Exists? | Notes |
| --- | --- | --- |
| `session.subscribe(listener) => unsubscribe` | **Yes — canonical** | Synchronous callback. Multiple listeners. Returns an unsubscribe thunk. |
| `session.prompt(text, opts): Promise<void>` | Yes | Resolves only when the **full accepted run** finishes, *including auto-retries*. |
| `PromptOptions.preflightResult?: (success: boolean) => void` | Yes | Fires once, *before* `prompt()` resolves, signalling accept/reject at preflight. |
| `session.waitForIdle(): Promise<void>` | Yes | Promise for "run is over" without aborting. |
| Async iteration / `AsyncIterable` | **No** | `AgentSession` exposes no iterator. |
| Out-of-process streams | Yes, separate | `--mode json` (`docs/json.md`) emits `JsonAgentSessionEvent` lines on stdout; `--mode rpc` (`docs/rpc.md`) via `runRpcMode`. Not the in-process path. |

**Canonical answer: push-based `subscribe` callbacks, plus a Promise that resolves at
end-of-run.** There is no pull-based stream. An Effect port must bridge the callback into a
`Queue`/`Stream` itself — which is exactly what Ben Davis's `my-pi-setup` Pi backend does
(feeds subscription events into Effect queues/streams, attaches unsubscribe + abort +
dispose to a scope finalizer), per
`/Users/johngiardiniere/Code Review Agent/docs/research/pi-effect-practice-dmmulroy-davis7.md`.

### Event vocabulary

Base `AgentEvent` (pi-agent-core, quoted in `docs/json.md`):

```ts
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start";  toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end";    toolCallId: string; toolName: string; result: any; isError: boolean };
```

`AgentSessionEvent` (`dist/core/agent-session.d.ts:36+`) is that minus `agent_end`, plus:

```
agent_end { messages, willRetry }        // note the extra willRetry
agent_settled
queue_update { steering, followUp }
compaction_start { reason: "manual"|"threshold"|"overflow" }
compaction_end   { reason, result, aborted, willRetry, errorMessage? }
entry_appended { entry }
session_info_changed { name }
thinking_level_changed { level }
auto_retry_start { attempt, maxAttempts, delayMs, errorMessage }
auto_retry_end   { success, attempt, finalError? }
summarization_retry_scheduled { attempt, maxAttempts, delayMs, errorMessage }
summarization_retry_attempt_start { source: "branchSummary" | "compaction" }
summarization_retry_finished
bash_execution_update { id?, delta }
```

Nested `AssistantMessageEvent.type` (streaming deltas, from `docs/custom-provider.md`):
`start`, `text_start`, `text_delta`, `text_end`, `thinking_start`, `thinking_delta`,
`thinking_end`, `toolcall_start`, `toolcall_delta`, `toolcall_end`, `done`, `error`.

### Which events production actually consumes

Only **three**, and this is a useful minimum for the port
(`pi-session.ts:533-552`, `sdk-utilities.ts:73`):

| Event | Read for |
| --- | --- |
| `message_start` (role `assistant`) | **Disarms the first-response watchdog.** That is its entire job. |
| `message_end` (role `assistant`) | First-turn `usage`; `errorMessage`; `stopReason`. |
| `tool_execution_start` | Tool-call counting, `toolsUsed`, and **pre-validation emit-argument salvage** (§5). |

Nothing reads `message_update` deltas. **A port does not need token streaming to
reproduce current behavior** — the reviewer is batch, not interactive.

### Mapping to a port's event vocabulary

| Ticket's asked-for vocabulary | Pi source |
| --- | --- |
| assistant text | `message_end.message.content[]` blocks where `type === "text"` (accumulated; production reads the last non-empty one, `pi-session.ts:421-426`). Streaming equivalent: `message_update` + `text_delta`. |
| tool calls | `tool_execution_start` (raw args) → `tool_execution_end` (`result`, `isError`). |
| usage | `message_end.message.usage` per assistant turn, *and* the terminal sweep over `session.messages`. See §7. |
| termination | `message_end.message.stopReason` + `agent_end { willRetry }` + `agent_settled`; and out-of-band, the `terminate: true` tool result. |

---

## 4. Cancellation / abort semantics

`AgentSession.abort(): Promise<void>` — docstring: **"Abort current operation and wait for
agent to become idle."** The `await waitForIdle()` inside it is the single most
consequential fact here.

Production has two deadlines with **deliberately opposite** abort-await policies, and the
reasoning is recorded in the source:

### Overall budget (`withOverallDeadline`, `pi-session.ts:432-459`) — do NOT await the abort

> "`AgentSession.abort()` awaits `waitForIdle()`, so gating the rejection on it means a
> session that never reaches idle (a tool promise that never settles, a stream that stops
> yielding without erroring) makes this function hang forever. The old out-of-process path
> could not hang — it killed the worker outright. Rejecting first restores that guarantee;
> the abort still runs, just not on the caller's critical path."

```ts
void session.abort().catch(() => {});   // fire and forget
reject(new OverallSessionTimeoutError(timeoutMs));
```

### First-response watchdog (`runWithFirstResponseWatchdog`, `sdk-utilities.ts:54-97`) — DO await the abort

> "On a stall the session abort is AWAITED before the rejection surfaces, so the caller
> regains control with the session already idle and free to be re-prompted; rejecting
> mid-abort would make the obvious retry throw **'Agent is already processing'**."

```ts
void session.abort().catch(() => {}).then(() => rejectPromise(error));
```

**The rule: await `abort()` if and only if you intend to re-prompt the same session.**
Otherwise `abort()` is a hang risk. This is the sharpest port-design constraint in the
whole surface — in Effect terms, interrupting a run fiber is not enough; the finalizer's
relationship to `abort()` differs by whether the scope is being reused or torn down.

### What can hang

- `abort()` itself, indefinitely, if the agent never reaches idle. Causes: a custom tool's
  `execute` promise that never settles; a provider stream that stops yielding without
  erroring.
- Session **construction** (credential/catalog disk reads) — hence the separate 60s startup
  deadline.
- Pi's own bash tool has **no default timeout at all** (`pi-session.ts:39-46`), so an
  unwrapped bash call is unbounded.

### What settles cleanly

- `prompt()` rejects/resolves normally on provider error (errors are surfaced as
  `stopReason: "error"` + `errorMessage` on the assistant message, not thrown from the
  stream — see §8).
- Tool `execute` receives `signal: AbortSignal | undefined` as its 3rd argument. Built-in
  tools honor it (`read.js` rejects with a bare `"Operation aborted"`).
- A thrown tool error becomes an `isError` tool result and **the agent loop continues** —
  it does not fail the run (`prepareToolCall` catch, agent-loop.js:444-451).

### Per-tool timeouts must be wrapped by the caller

`withToolCallTimeout` (`sdk-utilities.ts:104-138`) wraps a `ToolDefinition`'s `execute`.
Two non-obvious details worth carrying into a port:

1. **`originalExecute` must be `.bind(tool)`** — Pi's own wrapper calls `execute` as a
   method (`tool-definition-wrapper.js`), so definitions may rely on `this`.
2. **Reject before aborting.** Tools that reject on abort (every SDK built-in) would
   otherwise win the race and mask the named timeout error with `"Operation aborted"`.

---

## 5. Structured output ("emit") mechanics

This is the most Gauntlet-specific part of the surface and the one with the most traps.

### Declaring the tool

A terminating emit tool is an ordinary `ToolDefinition` passed in `customTools`, whose
`execute` returns `terminate: true`. Full shape
(`dist/core/extensions/types.d.ts:340-376`):

```ts
interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TParams;                     // TypeBox TSchema
  constrainedSampling?: false | ConstrainedSamplingConfig;
  renderShell?: "default" | "self";
  prepareArguments?: (args: unknown) => Static<TParams>;   // pre-validation shim
  executionMode?: ToolExecutionMode;       // "sequential" | "parallel"
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>;
  renderCall?; renderResult?;
}
```

And the result (`pi-agent-core/dist/types.d.ts:315-328`):

```ts
interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  usage?: Usage;              // tool-execution usage; NOT part of LLM context accounting
  addedToolNames?: string[];
  terminate?: boolean;        // "hint that the agent should stop after the current tool batch"
}
```

Production's factory is `createTerminatingTool` (`sdk-utilities.ts:161-181`): a closure that
captures `params` in `execute` and returns `{ terminate: true }`.

### `terminate` is a HINT, not a guarantee

From `pi-agent-core/dist/agent-loop.js:377`:

```js
function shouldTerminateToolBatch(finalizedCalls) {
  return finalizedCalls.length > 0 && finalizedCalls.every((f) => f.result.terminate === true);
}
```

**Every** finalized result in the batch must terminate. If the model emits the emit tool in
a parallel batch alongside any other call, the run continues for one more turn. Because
capture is last-call-wins, a re-emit on that extra turn **replaces** what was already
captured rather than adding to it — potentially replacing a complete emit with a truncated
one. Production documents the two mitigations: forbid parallel tool calls for the
terminating batch, or merge across calls yourself.

### Parameters: TypeBox, but plain JSON Schema works

The declared type is TypeBox's `TSchema`, and the documented usage is
`Type.Object({ … })` from the `typebox` package. **But production does not use TypeBox at
all.** `pi-session.ts:235-279` projects its own schema AST (`emit-schemas.ts`) into a plain
JSON-Schema object literal and casts it:

```ts
parameters: objectSchema(schema.parameters) as ToolDefinition<any, any, any>["parameters"]
```

That works because of an explicit branch in
`pi-ai/dist/utils/validation.js` → `validateToolArguments`:

```js
const args = structuredClone(toolCall.arguments);
Value.Convert(tool.parameters, args);
const validator = getValidator(tool.parameters);   // typebox/compile Compile()
if (!Object.getOwnPropertySymbols(tool.parameters).includes(Symbol.for("TypeBox.Kind"))) {
  const coerced = coerceWithJsonSchema(args, tool.parameters);   // ← plain-JSON-Schema path
  …
}
if (validator.Check(args)) return args;
throw new Error(`Validation failed for tool "${name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`);
```

**Fact for the port:** Pi detects a non-TypeBox schema (missing the `TypeBox.Kind` symbol)
and runs an extra JSON-Schema coercion pass — numbers from strings, booleans from
`"true"`/`0`/`1`, `null` → zero-value, recursive through `properties`, `items`, `allOf`,
`anyOf`, `oneOf`. So an Effect-Schema-derived JSON Schema can be handed to Pi directly and
gets *more* lenient coercion than a native TypeBox schema would. No TypeBox dependency is
required.

### What happens on invalid arguments

`prepareToolCall` (`agent-loop.js:393-451`):

1. Tool not found → immediate error result `Tool <name> not found`, `isError: true`.
2. `prepareArguments()` runs (if defined), then `validateToolArguments()`.
3. On a validation throw, the `catch` produces `{ kind: "immediate", result: createErrorToolResult(message), isError: true }`.
4. **`execute` is never called.** The closure captures nothing.
5. The error text is fed back to the model as a tool result and **the loop continues** — the
   model gets a chance to re-issue.

### Pre-validation arguments ARE observable

This is the key affordance. `tool_execution_start` is emitted **before** `prepareToolCall`
runs, carrying the raw, unvalidated `toolCall.arguments`
(`agent-loop.js:299-305` sequential, `335-341` parallel):

```js
await emit({ type: "tool_execution_start", toolCallId, toolName, args: toolCall.arguments });
const preparation = await prepareToolCall(...);
```

Production exploits this as a **salvage path** (`pi-session.ts:506-513`):

> "Pi calls `execute` only AFTER `validateToolArguments` succeeds, so a batch that dies on a
> missing required field — or an assistant message truncated at the output limit, which pi
> replays as a `tool_execution_start` with salvaged args and an error result — captures
> nothing, and the lens is reported as never having emitted. The event carries what the
> agent MEANT to report; keep it as a fallback only, so a clean validated call always wins."

```ts
const captured = terminating.getCaptured() ?? intendedArgs;
```

The truncation path is real and separate: `failToolCallsFromTruncatedMessage`
(`agent-loop.js:257-280`) emits `tool_execution_start` with best-effort-JSON-salvaged
arguments for every tool call from an output-limit-truncated assistant message, then fails
them all — "Streamed tool-call arguments are finalized with a best-effort JSON salvage
parser, so a truncated message can yield tool calls whose arguments parse and validate but
are silently incomplete."

**Port requirement: the event stream must expose raw `tool_execution_start.args`, not only
validated tool inputs.** A port that models emit-capture purely as "the value `execute`
received" throws away recoverable output.

### Missing-emit retry

Production re-prompts the *same session* up to `MAX_EMIT_RETRIES = 2` times
(`pi-session.ts:570-579`) with:

> "You ended without calling {tool}. Call {tool} now, exactly once, with the result you
> already prepared. Do not answer in prose."

Two guards make the retry economically sane, both worth preserving:

- `if (lastAssistantStopReason === "length") break;` — a context-death session has no room
  for another turn; the corrective prompt would be billed for nothing.
- `if (timeoutMs - elapsed < MIN_RETRY_BUDGET_MS /* 5_000 */) break;` — otherwise
  `Math.max(1, …)` issues a paid request with a 1ms deadline that cannot land.

### The tool allowlist is HARD

`pi-session.ts:322-326`: `tools` is a hard allowlist — Pi's `_refreshToolRegistry` filters
every *custom* tool through it, so an emit tool absent from the allowlist string is dropped
before the model ever sees it, and the run then reads as a model-behaviour failure.
Production force-adds the emit tool name:

```ts
const allowed = names.includes(emitTool.name) ? names : [...names, emitTool.name];
```

Related `AgentSessionConfig` knobs: `initialActiveToolNames`, `allowedToolNames`,
`excludedToolNames`; `createAgentSession` surfaces these as `tools`, `excludeTools`,
`noTools: "all" | "builtin"`. Production uses `noTools: "builtin"` plus explicit
`customTools` built from `createReadToolDefinition(cwd)` / `createBashToolDefinition(cwd)`,
each wrapped with its own timeout.

---

## 6. Provider / model / reasoning-effort configuration

### Naming

Canonical form is **`provider/modelId:thinkingLevel`**, e.g.
`anthropic/claude-opus-4-5:high`, `openai-codex/gpt-5.6-luna:high`.

Thinking levels are a fixed 7-value enum:
`off | minimal | low | medium | high | xhigh | max`.

**Do not hand-parse this string.** `pi-session.ts:284-291` is emphatic:

> "pi's own resolver, not a re-implementation of it: model ids contain colons, so
> `pattern:level` must be tried as a whole id FIRST, and the deleted CLI path also accepted
> partial ids. Splitting on the last colon and demanding an exact id match rejects model
> strings the CLI resolved fine."

Use `resolveCliModel({ cliProvider, cliModel, modelRuntime })` →
`{ model, thinkingLevel?, warning?, error? }`. Its documented algorithm
(`dist/core/model-resolver.d.ts`): try the full pattern as a model id; if not found and it
contains colons, split on the *last* colon, and if the suffix is a valid thinking level,
recurse on the prefix — otherwise warn and recurse with `off`. It also does fuzzy matching
(exact id, then partial id/name) and prefers an alias like `claude-sonnet-4-5` over dated
versions. OpenRouter's `:exacto` suffix is the motivating example of a colon-in-id.

Related helpers: `resolveModelScopeWithDiagnostics(patterns, modelRuntime)` returns
`{ scopedModels, diagnostics }` with `code: "no-match" | "invalid-thinking-level"` instead
of printing; `findInitialModel` implements the CLI's 5-level priority chain.

The reviewer's seat type is `{ provider, model, effort }` with canonical string
`provider/model:effort` (`contracts.ts:392-476`), reconstructed for Pi as
`` `${seat.model}:${seat.effort}` `` with provider passed separately (`pi-stage.ts:87-89`).
Production default seat: `openai-codex/gpt-5.6-luna:high` (`contracts.ts:569`).

### Applying the thinking level

Pass `thinkingLevel` to `createAgentSession`, or `session.setThinkingLevel(level)` after.
`resolveCliModel` **parses but does not apply** it — the caller must forward it.
Related session API: `getAvailableThinkingLevels()`, `supportsThinking()`,
`cycleThinkingLevel()`; `setThinkingLevel` clamps to model capability.

Under the hood a model's `thinkingLevelMap` in `models.json` maps Pi's 7 levels to
provider-specific values, with `null` hiding an unsupported level:

```ts
thinkingLevelMap?: Partial<Record<"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max", string | null>>
```

Provider transport quirks live in `compat.thinkingFormat`:
`"openai" | "openrouter" | "deepseek" | "together" | "baseten" | "zai" | "qwen" |
"chat-template" | "qwen-chat-template" | "string-thinking" | "ant-ling"`, plus
`compat.forceAdaptiveThinking` for Anthropic's `thinking.type: "adaptive"` +
`output_config.effort`.

### "Log-in coding plan" providers

Two distinct auth shapes:

**(a) OAuth / subscription — `/login`, tokens in `~/.pi/agent/auth.json`, auto-refreshed**
(`docs/providers.md` "Subscriptions"):

| Login provider | Notes |
| --- | --- |
| **ChatGPT Plus/Pro (Codex)** — provider id `openai-codex` | Requires ChatGPT Plus/Pro. Officially endorsed by OpenAI ("Codex for OSS"). **This is what the production reviewer runs on** (`pi-finders.ts:79`, `bench-*.ts`). |
| **Claude Pro/Max** | Active for Pro/Max accounts, but: *"Third-party harness usage draws from extra usage and is billed per token, not against Claude plan limits."* |
| **GitHub Copilot** | Enter github.com or a GHES domain. "model not supported" → enable the model in VS Code's Copilot Chat model selector. |
| **xAI (Grok/X subscription)** | `/login xai` → "Use a subscription". `XAI_API_KEY` still available. |
| **OpenRouter** | PKCE OAuth that *mints a user-controlled API key* billed from OpenRouter credits; does not auto-expire. Headless fallback: paste the redirect URL / code. |
| **Radius** | Dynamic `pi-messages` gateway; OAuth tokens in `auth.json`, catalog cached in `models-store.json`. Custom gateways via `"oauth": "radius"` + `baseUrl` in `models.json`. |

**(b) Coding-plan providers that are API-key-shaped** (`docs/providers.md` "API Keys") —
note that **`opencode` is in this group, not the OAuth group**:

| Provider | Env var | `auth.json` key |
| --- | --- | --- |
| OpenCode Zen | `OPENCODE_API_KEY` | `opencode` |
| OpenCode Go | `OPENCODE_API_KEY` | `opencode-go` |
| ZAI Coding Plan (Global / China) | `ZAI_API_KEY` / `ZAI_CODING_CN_API_KEY` | `zai` / `zai-coding-cn` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |
| Qwen Token Plan (×3 regions) | `QWEN_TOKEN_PLAN[_CN]_API_KEY` | `qwen-token-plan[-individual|-cn]` |
| Xiaomi MiMo Token Plan (×3 regions) | `XIAOMI_TOKEN_PLAN_*_API_KEY` | `xiaomi-token-plan-*` |

Plus ~20 conventional key providers (`anthropic`, `openai`, `google`, `deepseek`, `groq`,
`cerebras`, `mistral`, `xai`, `openrouter`, `vercel-ai-gateway`, `amazon-bedrock`,
`azure-openai-responses`, `cloudflare-ai-gateway`, `cloudflare-workers-ai`, `nvidia`,
`huggingface`, `fireworks`, `together`, `baseten`, `minimax[-cn]`, `ant-ling`, `radius`,
`xiaomi`) and llama.cpp / custom `models.json` providers.

**Credential resolution order (SDK, via `ModelRuntime`)**, which differs from the CLI's:
1. runtime overrides (`setRuntimeApiKey`, not persisted) → 2. `auth.json` → 3. env vars →
4. custom-provider `models.json` fallback resolver.
CLI order is: `--api-key` flag → `auth.json` → env → custom-provider keys.

`ModelRuntime.create({ signal })` and other model/auth ops accept an optional `AbortSignal`
and are **unbounded when omitted**. `modelRuntime.refresh({ providers, signal })` returns
`{ aborted, errors }` rather than throwing on a timed-out catalog refresh, and "a failed or
timed-out network refresh does not undo a successful credential operation."
`CredentialSynchronizationError` (exported) carries `providerId`, `operation`, `credential`,
`cause`.

New in 0.84.1: `pi auth check` for provider/model credential preflight.

### `sessionId` is the prompt-cache key — a load-bearing provider detail

`pi-finders.ts:25-44` documents an empirically-measured behavior that a port must preserve:

> "For the `openai-codex` provider pi sends `prompt_cache_key: sessionId` (pi-ai
> `api/openai-codex-responses.js`), and `--no-session` alone still mints a fresh session id
> per process — so a fan-out of N agents sends N different cache keys and OpenAI scatters
> them across cache partitions. Measured on a 20k prefix: distinct keys hit 0/4, 2/4, 2/4
> across trials on a provably identical prefix; one shared key hit 4/4 at 97.9%, both
> simultaneously and staggered."

So: **`SessionManager.inMemory(cwd, { id })` sets the provider prompt-cache partition.**
Pi rejects `/` and `:` in ids, so seats are slugified (`pi-stage.ts:96-99`,
`gauntlet-stage-openai-codex-gpt-5.6-luna-high`). Caching is per-model, so lenses are
grouped by model, each group pays one warmup run to completion, then fans out after a
`CACHE_SETTLE_MS = 1_500` grace period. `MIN_PREFIX_CACHE_FRACTION = 0.8` against the
*shared prefix* (not `cacheRead/totalPrompt`) is the health bar.

A byte-identical prefix is necessary but not sufficient: tool definitions serialize ahead
of messages, so **every agent in a fan-out must carry a byte-identical tool set**, and the
system prompt (first in the cached prefix) must have zero per-run variation.

`PI_CACHE_RETENTION=long` extends prompt cache retention (Anthropic 1h, OpenAI 24h).

---

## 7. Usage / accounting

The `Usage` type (`pi-ai/dist/types.d.ts:253-274`):

```ts
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;  // subset of cacheWrite at 1h retention — Anthropic only
  reasoning?: number;     // SUBSET of output (output already includes it); undefined if provider doesn't report
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```

Two facts that a naive port gets wrong:

- **`reasoning` is a subset of `output`, not additive.** Summing them double-counts.
- **`reasoning` and `cacheWrite1h` are optional** and genuinely absent for many providers.

### When it is reported

- **Per assistant turn**, on `AssistantMessage.usage`, delivered via the
  `message_end` event. Production uses the *first* such event to fire `onFirstUsage` — the
  fan-out's signal that the shared prefix now exists in the provider cache
  (`pi-session.ts:516-521`, `533-541`).
- **Terminally**, by sweeping `session.messages` and summing every assistant message's
  usage (`pi-session.ts:602-610`). This must happen **before `dispose()`**.
- Optionally on tool results (`AgentToolResult.usage` / `ToolResultMessage.usage`) —
  explicitly documented as *"Not part of main LLM context accounting."*
- `session.getSessionStats()` returns `SessionStats` aggregating **all** session entries
  including history compacted away, "so token/cost totals reflect what was actually billed."
  `session.getContextUsage()` returns `ContextUsage`.

Cost is computed by `calculateCost(model, usage)` in pi-ai from the model's per-million
`cost: { input, output, cacheRead, cacheWrite }` rates, with optional `tiers` for
request-wide pricing breaks above an `inputTokensAbove` threshold. **Pi reports dollars, so
the port does not need its own price table** — but it inherits Pi's catalog accuracy.

The reviewer's normalized shape (`pi-session.ts:189-196`):

```ts
interface TokenUsage { input; output; cacheRead; cacheWrite; reasoning; costUsd }
```

with `reasoning: usage.reasoning ?? 0` and `costUsd: usage.cost.total`.

**Accounting failure is treated as a run failure, not swallowed** (`pi-session.ts:597-601`,
`pi-stage.ts:165-177`): if the usage shape is not what the reader expects, the stage fails
*even when an emit was captured*, because "a lens that silently reports $0 and 0% cache
would be taken for a healthy one." `pi-stage.ts:101-106` additionally asserts every field is
finite and non-negative.

---

## 8. Error surfaces

### Stop reasons

```ts
type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
```

On `AssistantMessage.stopReason`, alongside `errorMessage?: string` and
`rawStopReason?: string` (provider-native string, for diagnostics). `AgentState.errorMessage`
mirrors the most recent failed/aborted turn at session level.

The stream contract splits terminal events:
`done → reason ∈ {stop, length, toolUse, deferred}`; `error → reason ∈ {aborted, error}`.

**`"length"` deserves its own handling.** From `pi-session.ts:77-84`:

> "`length` is a context/output-limit death with **no `errorMessage`**, which reads exactly
> like a normal turn that simply chose not to emit — so without this the harness blames the
> model for ignoring the tool contract and pays for a corrective turn the session has no
> room for."

A port that only inspects `errorMessage` will misclassify context exhaustion as model
misbehaviour and bill for a doomed retry.

### Provider failures do not throw from the stream

Documented provider contract (`docs/custom-provider.md`): a provider stream **must not
throw**; failures are encoded in the stream as protocol events plus a final
`AssistantMessage` with `stopReason` `"error"` or `"aborted"` and an `errorMessage`.
Custom providers set `stopReason = signal?.aborted ? "aborted" : "error"`.

**Consequence for the port: `prompt()` resolving is not proof of success.** The failure is
in the message, not the promise.

### Retry

Pi retries transient errors *itself*, inside `prompt()`. Settings (`docs/settings.md`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `retry.enabled` | `true` | agent-level retry on transient errors |
| `retry.maxRetries` | `3` | agent-level attempts |
| `retry.baseDelayMs` | `2000` | exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | SDK default | provider/SDK request timeout |
| `retry.provider.maxRetries` | `0` | provider/SDK retries |
| `retry.provider.maxRetryDelayMs` | `60000` | max server-requested delay before failing |

Pi's own warning: keep `retry.provider.maxRetries` at `0` — above 0, SDK/provider retries
can absorb out-of-usage-limit errors before Pi sees them, blocking the agent until the
provider quota resets. Retryability is decided by `_isRetryableError` (overloaded, rate
limit, server errors); **context-overflow errors are explicitly NOT retryable** and are
routed to compaction instead — which production has disabled, so overflow surfaces as
`"length"`.

Observable via `auto_retry_start` / `auto_retry_end` events and `agent_end.willRetry`.
`session.retryAttempt` / `session.isRetrying` / `abortRetry()`.

**Port implication: `prompt()`'s wall-clock duration silently includes up to 3 backoff
retries.** Any overall budget must account for that, and a port layering its own Effect
`retry` policy on top would multiply attempts.

### Context-length stops

Detection requires `stopReason === "error"` **and** an `errorMessage` matching a known
overflow pattern; custom providers must normalize theirs to start with
`context_length_exceeded` for Pi's auto-compact-and-retry to fire. With compaction disabled
(production's choice), overflow lands as `stopReason: "length"` with no `errorMessage`.

### Timeouts are entirely the caller's job

Pi provides `retry.provider.timeoutMs` but no per-run or per-tool wall clock. Production
layers four, all of them caller-owned:

| Deadline | Default | Purpose |
| --- | --- | --- |
| `SESSION_STARTUP_TIMEOUT_MS` | 60s | credential/catalog disk reads during construction |
| `DEFAULT_FIRST_RESPONSE_TIMEOUT_MS` | **300s** | stall detector, disarmed by `message_start` |
| `timeoutMs` (overall) | 600s finders / 900s stages | the actual budget |
| `DEFAULT_TOOL_TIMEOUT_MS` / `DEFAULT_BASH_TIMEOUT_MS` | 120s / **600s** | per tool call |

The 300s first-response figure is not arbitrary — it "matches pi's own
`DEFAULT_HTTP_IDLE_TIMEOUT_MS` (`http-dispatcher.ts`). The watchdog disarms on the assistant
`message_start`, which for codex SSE is only pushed after `response.ok` — so anything
shorter than pi's own header tolerance kills runs pi would have completed. **This is a stall
detector, not a latency budget**; `timeoutMs` is the budget."

Bash gets its own larger budget because "bash is the tool finders use to PROVE a finding
(typecheck, run a test), and pi's own bash has no default timeout at all — capping it at the
generic per-tool deadline silently overrides the `timeout` parameter the tool still
advertises to the model, and turns every slow-but-correct verification into a failed one."

The reviewer distinguishes two timeout outcomes, and the distinction is load-bearing:

- `timedOut` — *any* of our deadlines fired.
- `budgetExhausted` — only the full `timeoutMs` was actually spent. Only this makes an
  identical-budget retry futile. "A 300s stall out of a 900s budget is exactly the transient
  failure a retry exists to absorb, and treating it as exhaustion drops the lens AND leaves
  its whole model group running uncached."

### Other error surfaces

- `SettingsManager.drainErrors()` — settings I/O errors are not printed by Pi; the app layer
  must drain and report them.
- `CredentialSynchronizationError` — inspect `providerId` / `operation` / `credential` /
  `cause` rather than blindly retrying the credential mutation.
- `createAgentSession` returns `modelFallbackMessage?` when it silently fell back to a
  different model; `AgentSessionRuntime` exposes `diagnostics`.

### Drift is a real, demonstrated hazard

`pi-session.ts:95-124` documents an empirically-verified failure: the SDK mirrors are
hand-written and both seams are casts, so a renamed SDK field typechecks fine, reads
`undefined`, and turns every total into `NaN` — "a run that reports $0 and trips the
UNCACHED warning while looking healthy."

Crucially, **assignability alone does not catch it** — the first version of the tripwire made
exactly that mistake. The mirrors are deliberately all-optional (a `MessageLike` covers user
and toolResult messages too), so a renamed field reads as an absent optional, which is
assignable. Verified empirically: renaming `usage` → `tokenUsage` **compiled clean**.

The working pattern asserts *presence* separately from *shape*:

```ts
type AssertMirrors<Mirror, Sdk extends Mirror> = Sdk;
type RequireKeys<Sdk, K extends keyof Sdk> = Pick<Sdk, K>;   // fails when K stops being a key
type SdkSessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];
type SdkEvent<T extends SdkSessionEvent["type"]> = Extract<SdkSessionEvent, { type: T }>;
```

…with the assertion made against a **required** local shape rather than the all-optional
mirror, and **per-variant** (one combined `Extract` let a renamed `message_end` hide behind
its surviving siblings). Result: drift becomes a `tsc` failure naming the field.

**An Effect port that decodes Pi events through `Schema` gets a runtime version of this
guarantee** — a renamed field becomes a decode failure rather than a silent `undefined`.
That is a genuine argument for the Effect adapter, not a stylistic one. But the *compile-time*
half (`RequireKeys` against the live SDK types) is still worth keeping, because a runtime
decode failure only surfaces when a paid run has already started.

---

## 9. Answering the ticket's four framing questions

**What is one invocation?**
Construct → subscribe → `prompt()` → (retry loop) → read `messages` → `dispose()`.
Construction is separately-bounded disk I/O; `prompt()` is a Promise that resolves at
end-of-run *including Pi's own up-to-3 auto-retries*; the terminal accounting read must
precede disposal. Configuration is `{ provider, model:effort, cwd, systemPrompt, tool
allowlist, customTools, sessionId }`. The `sessionId` doubles as the provider prompt-cache
partition key.

**What events does it yield?**
Push callbacks only, via `subscribe`, returning an unsubscribe thunk. ~20 event types; the
minimum viable set is three — `message_start` (liveness), `message_end` (usage, stopReason,
errorMessage, text), `tool_execution_start` (tool activity + raw pre-validation emit args).
No async iterator exists; a port must bridge callbacks to a `Queue`/`Stream` and attach
unsubscribe + abort + dispose to one scope finalizer.

**How does it end?**
Five distinct terminations, all of which the port must model separately:
1. **Emit captured** — a `terminate: true` tool result whose whole batch terminated.
2. **Clean stop without emit** — `stopReason: "stop"`; retryable with a corrective prompt.
3. **Context death** — `stopReason: "length"`, **no `errorMessage`**; retry is pure waste.
4. **Provider error** — `stopReason: "error"` + `errorMessage`; *does not throw*.
5. **Caller deadline** — startup / first-response stall / overall budget, with
   `budgetExhausted` distinguishing "retry is futile" from "retry is exactly right".
Plus the salvage path: raw `tool_execution_start.args` recover an emit that failed
validation or was truncated at the output limit.
Cancellation caveat: `abort()` awaits `waitForIdle()` and **can hang forever**; await it
only when re-prompting the same session.

**What does it cost?**
Pi reports it, per assistant turn on `message_end.message.usage` and in aggregate over
`session.messages`: `input`, `output`, `cacheRead`, `cacheWrite`, optional `cacheWrite1h`,
optional `reasoning` (**a subset of `output`**), `totalTokens`, and a computed
`cost.{input,output,cacheRead,cacheWrite,total}` in USD. The first `message_end` is the
fan-out's cache-warm signal. Accounting-shape drift must fail the run loudly — a silently-$0
stage is indistinguishable from a healthy one.

---

## 10. Open questions this research did not settle

- **Does a port keep the 2-retry corrective-emit loop, or model it as an Effect `Schedule`
  with the same `"length"` / min-budget guards?** The guards are the substance; the loop is
  incidental.
- **Should the port force `executionMode: "sequential"` (or otherwise forbid parallel batches)
  for the emit tool**, given that `terminate` requires unanimity and capture is last-call-wins?
  Production tolerates the hazard and documents it rather than closing it.
- **Is compaction staying off?** It is a prompt-cache-economics decision, not a Pi
  constraint, and it converts a recoverable overflow into a hard `"length"` failure.
- **Does Gauntlet want Pi's own `retry.*` on or off**, given an Effect port would naturally
  own retry policy and layering both multiplies attempts?
- **Does the port need `message_update` streaming at all?** Nothing in the current product
  reads deltas; adding it buys progress UI at the cost of the delta-assembly contract that
  0.84.0's breaking change already tightened.
