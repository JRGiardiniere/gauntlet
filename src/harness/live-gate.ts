import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import type { HarnessEvent } from "./harness-session.ts"
import { livePiLayer } from "./pi-live.ts"
import {
  abortAbandonedSession,
  finalizeCapture,
  makeCaptureState,
  openCapturedSession,
} from "./session-bridge.ts"

// The narrow live gate (#17, kept narrow by decision in #7): the two
// properties only a real provider can answer — the Effect-Schema-projected
// tool parameters round-trip through Pi's validation, and a terminating emit
// actually ends the run. It caught a real drift bug on its first run in the
// old reviewer; everything else lives in the scripted suite. Requires Pi
// credentials (~/.pi/agent/auth.json) and spends a near-zero amount of real
// model usage.
//
//   pnpm live-gate [provider] [model[:effort]]

// A miniature of the emit_findings wire shape (docs/spec/emit-tools.md):
// same field names, same optionality, integer line numbers — so the gate
// exercises the projection the real tools will use. The full tools land with
// the invocation engine (#18).
const GateEmit = Schema.Struct({
  findings: Schema.Array(
    Schema.Struct({
      file: Schema.NonEmptyString,
      line: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      summary: Schema.NonEmptyString,
      failure_scenario: Schema.optionalKey(Schema.NonEmptyString),
    }),
  ),
})

const SYSTEM_PROMPT =
  "You are a code-review finder. You report findings only through the emit_findings tool, never in prose."

const DIFF = `--- a/src/discount.ts
+++ b/src/discount.ts
@@ -1,6 +1,6 @@
 export function applyDiscount(totalCents: number, percent: number): number {
-  if (percent < 0 || percent > 100) throw new Error("bad percent")
-  return Math.round(totalCents * (1 - percent / 100))
+  return Math.round(totalCents * (1 - percent / 10))
 }
`

const PROMPT = `Review this diff and report findings via the emit_findings tool.
For a finding that asserts a concrete failure, include failure_scenario with
specific inputs; for a pure judgment call, omit failure_scenario entirely.
Call emit_findings exactly once, as your final action. Do not answer in prose.

Changed file: src/discount.ts

\`\`\`diff
${DIFF}\`\`\``

// Both deadlines are the gate's own (deadlines are caller-owned adapter
// mechanics): open covers credential/catalog reads and session construction,
// prompt covers the model round-trip.
const OPEN_DEADLINE = Duration.minutes(1)
const PROMPT_DEADLINE = Duration.minutes(4)

const writeLine = (text: string) => Console.log(text)

// Pi's prompt() can reject (missing auth, transport failure). Typed so the
// rejection stays on the error channel and renders as a FAIL line instead of
// escaping the gate as a defect.
class PromptRejected extends Data.TaggedError("PromptRejected")<{
  readonly reason: string
}> {}

interface GateCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

const check = (name: string, ok: boolean, detail = ""): GateCheck => ({
  name,
  ok,
  detail,
})

const reportChecks = Effect.fn("gauntlet.live_gate.report_checks")(
  function* (checks: ReadonlyArray<GateCheck>) {
    for (const entry of checks) {
      const status = entry.ok ? "  ok  " : "FAIL  "
      const detail = entry.detail === "" ? "" : ` — ${entry.detail}`
      yield* writeLine(`${status}${entry.name}${detail}`)
    }
    const failures = checks.filter((entry) => !entry.ok).length
    yield* writeLine(
      failures === 0 ? "\nlive gate passed" : `\n${String(failures)} FAILED`,
    )
    return failures === 0 ? 0 : 1
  },
)

// Index of the emit tool's execution start in the event list, or -1.
const emitEventIndex = (events: ReadonlyArray<HarnessEvent>) =>
  events.findIndex(
    (event) =>
      event.type === "tool_execution_start" && event.toolName === "emit_findings",
  )

export const runLiveGate = Effect.fn("gauntlet.live_gate.run")(
  function* (argv: ReadonlyArray<string>) {
    const provider = argv[0] ?? "openai-codex"
    const model = argv[1] ?? "gpt-5.6-luna:low"

    // The projection under test: the same Schema declaration that decodes the
    // emit is handed to Pi as plain JSON Schema parameters (#4 §5). The
    // parameters must be self-contained — Pi never sees the document's
    // definition table.
    const document = Schema.toJsonSchemaDocument(GateEmit)
    const definitionCount = Object.keys(document.definitions ?? {}).length
    if (definitionCount > 0) {
      return yield* reportChecks([
        check(
          "projected emit parameters are a self-contained JSON Schema",
          false,
          `projection produced ${String(definitionCount)} out-of-line definition(s)`,
        ),
      ])
    }

    yield* writeLine(
      `running one live emit round-trip on ${provider}/${model}...`,
    )

    const state = makeCaptureState()
    const fs = yield* FileSystem.FileSystem

    const run = Effect.scoped(
      Effect.gen(function* () {
        // A scratch working directory: the session is emit-only (hard tool
        // allowlist), so nothing should ever read or write here.
        const cwd = yield* fs.makeTempDirectoryScoped({
          prefix: "gauntlet-live-gate-",
        })
        const opened = yield* openCapturedSession(
          {
            systemPrompt: SYSTEM_PROMPT,
            emitTool: {
              name: "emit_findings",
              description:
                "Report the findings from your review pass. Call this exactly once, as your final action, even if you found nothing (pass an empty array). Do not describe findings in prose instead of calling this tool.",
              parameters: document.schema,
            },
          },
          state,
        ).pipe(
          // The interruptible acquire is what makes this bound real: a
          // hanging credential read or session construction is cut loose
          // here, not left to hang the command.
          Effect.timeout(OPEN_DEADLINE),
          Effect.provide(livePiLayer({ provider, model, cwd })),
        )

        // tryPromise, not promise: Pi's prompt() rejects (e.g. missing auth),
        // and a rejection must surface as this gate's typed failure — a
        // defect would bypass the check report entirely.
        const settled = yield* Effect.tryPromise({
          try: () => opened.session.prompt(PROMPT),
          catch: (cause) => new PromptRejected({ reason: String(cause) }),
        }).pipe(Effect.timeoutOption(PROMPT_DEADLINE))
        if (Option.isNone(settled)) {
          yield* abortAbandonedSession(opened.session)
        }
        const events = yield* Queue.takeAll(opened.events)
        return { settled: Option.isSome(settled), events }
      }),
    )

    // Every failure renders with its reason — a bare String() on a tagged
    // error drops the reason, which is the actionable part.
    const failed = (failure: string) =>
      Effect.succeed({
        settled: false,
        events: [] as ReadonlyArray<HarnessEvent>,
        failure: failure as string | undefined,
      })
    const outcome = yield* run.pipe(
      Effect.map((value) => ({ ...value, failure: undefined as string | undefined })),
      Effect.catchTags({
        SessionOpenError: (error) =>
          failed(`session open failed (${error.operation}): ${error.reason}`),
        TimeoutError: () =>
          failed(`session open did not settle inside ${Duration.format(OPEN_DEADLINE)}`),
        PromptRejected: (error) => failed(`prompt rejected: ${error.reason}`),
      }),
    )

    const checks: Array<GateCheck> = []
    checks.push(
      check(
        "one live session opened and its run settled inside the deadline",
        outcome.failure === undefined && outcome.settled,
        outcome.failure ?? "",
      ),
    )

    // 1. Tool-projection round-trip: Pi validated the arguments against the
    // projected schema (execute ran), and the captured value decodes back
    // through the same Schema declaration.
    const decodedEmit = Schema.decodeUnknownOption(GateEmit)(state.validatedEmit)
    checks.push(
      check(
        "tool-projection round-trip: projected schema validated and decoded back",
        state.hasValidatedEmit && Option.isSome(decodedEmit),
        state.hasValidatedEmit
          ? `findings=${String(Option.map(decodedEmit, (emit) => emit.findings.length).pipe(Option.getOrElse(() => -1)))}`
          : "emit tool execute never ran",
      ),
    )

    // 2. Terminate-batch: the terminating emit ended the run — no further
    // assistant turn started after the emit executed, and the final stop
    // reason is the tool batch itself.
    const emitAt = emitEventIndex(outcome.events)
    const turnsAfterEmit = outcome.events
      .slice(emitAt + 1)
      .filter((event) => event.type === "message_start").length
    checks.push(
      check(
        "terminate-batch: the run ended on the emit tool batch",
        emitAt >= 0 && turnsAfterEmit === 0 && state.stopReason === "toolUse",
        `stopReason=${String(state.stopReason)} turnsAfterEmit=${String(turnsAfterEmit)}`,
      ),
    )

    // 3. The boundary decode holds live: swept usage rows match UsageRow and
    // the run was actually metered. Deliberately beyond the #7 "round-trip +
    // terminate-batch" minimum: this check is what caught the
    // present-but-undefined `reasoning` drift on the gate's first real run —
    // a measured justification (standing directive, #8).
    const capture = yield* finalizeCapture(state).pipe(
      Effect.match({
        onSuccess: (result) => result,
        onFailure: (violation) => {
          checks.push(check("usage sweep decodes at the boundary", false, violation.reason))
          return undefined
        },
      }),
    )
    if (capture !== undefined) {
      checks.push(
        check(
          "usage sweep decodes at the boundary with real token counts",
          capture.usageRows.length > 0 &&
            capture.usageRows.some((row) => row.input > 0 && row.output > 0),
          `rows=${String(capture.usageRows.length)} cost=$${String(
            capture.usageRows.reduce((total, row) => total + row.cost.total, 0),
          )}`,
        ),
      )
    }

    return yield* reportChecks(checks)
  },
)
