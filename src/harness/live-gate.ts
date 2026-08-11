import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import {
  type AgentOutcome,
  Termination,
} from "../domain/agent-outcome.ts"
import { invoke } from "./invoke.ts"
import { EmitFindings, type FindingsOutput } from "./output-contract.ts"
import { livePiLayer } from "./pi-live.ts"

// The narrow live gate exercises the two properties only a real provider can
// answer: Effect Schema parameters round-trip through Pi validation, and the
// terminating emit actually settles the run. Everything else is deterministic
// at the invocation interface with the scripted adapter.

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
      yield* Console.log(`${status}${entry.name}${detail}`)
    }
    const failures = checks.filter((entry) => !entry.ok).length
    yield* Console.log(
      failures === 0 ? "\nlive gate passed" : `\n${String(failures)} FAILED`,
    )
    return failures === 0 ? 0 : 1
  },
)

interface GateResult {
  readonly outcome?: AgentOutcome<FindingsOutput>
  readonly failure?: string
}

const outcomeDetail = (outcome: AgentOutcome<FindingsOutput>) => {
  const diagnostics = outcome.diagnostics.join("; ")
  const suffix = diagnostics === "" ? "" : ` diagnostics=${diagnostics}`
  return `termination=${outcome.termination._tag}${suffix}`
}

const usageDetail = (outcome: AgentOutcome<FindingsOutput>) => {
  const diagnostics = outcome.diagnostics.join("; ")
  const suffix = diagnostics === "" ? "" : ` diagnostics=${diagnostics}`
  return `rows=${String(outcome.usage.rawRows.length)} cost=$${outcome.usage.costUsd.toFixed(6)}${suffix}`
}

export const runLiveGate = Effect.fn("gauntlet.live_gate.run")(
  function* (argv: ReadonlyArray<string>) {
    const provider = argv[0] ?? "openai-codex"
    const model = argv[1] ?? "gpt-5.6-luna:low"

    const document = Schema.toJsonSchemaDocument(EmitFindings.schema)
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

    yield* Console.log(
      `running one live emit round-trip on ${provider}/${model}...`,
    )
    const fs = yield* FileSystem.FileSystem
    const run = Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* fs.makeTempDirectoryScoped({
          prefix: "gauntlet-live-gate-",
        })
        return yield* invoke({
          cwd,
          systemPrompt: SYSTEM_PROMPT,
          prompt: PROMPT,
          contract: EmitFindings,
          tools: [],
          deadlines: {
            overallMillis: 300_000,
            startupMillis: 60_000,
            firstResponseMillis: 240_000,
            toolMillis: 120_000,
            bashMillis: 600_000,
          },
        }).pipe(
          Effect.provide(livePiLayer({ provider, model })),
          Effect.map((outcome): GateResult => ({ outcome })),
          Effect.catchTags({
            InvocationSetupError: (error) =>
              Effect.succeed<GateResult>({
                failure: `invocation setup failed (${error.operation}): ${error.reason}`,
              }),
            AdapterContractViolation: (error) =>
              Effect.succeed<GateResult>({
                failure: `adapter contract violation: ${error.reason}`,
              }),
          }),
        )
      }),
    )

    const result = yield* run
    const outcome = result.outcome
    const checks: Array<GateCheck> = []
    checks.push(
      check(
        "one live invocation settled inside its absolute deadline",
        outcome !== undefined,
        result.failure ?? "",
      ),
    )

    checks.push(
      check(
        "tool-projection round-trip: projected schema validated and decoded back",
        outcome?.output !== undefined,
        outcome?.output === undefined
          ? "emit output missing"
          : `findings=${String(outcome.output.findings.length)}`,
      ),
    )

    checks.push(
      check(
        "terminate-batch: the validated emit completed the invocation",
        outcome !== undefined &&
          Termination.guards.Completed(outcome.termination),
        outcome === undefined
          ? result.failure ?? "outcome missing"
          : outcomeDetail(outcome),
      ),
    )

    checks.push(
      check(
        "usage sweep decodes at the boundary with real token counts",
        outcome !== undefined &&
          outcome.usage.rawRows.length > 0 &&
          outcome.usage.input > 0 &&
          outcome.usage.output > 0,
        outcome === undefined
          ? result.failure ?? "outcome missing"
          : usageDetail(outcome),
      ),
    )

    return yield* reportChecks(checks)
  },
)
