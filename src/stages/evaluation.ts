import * as Effect from "effect/Effect"
import { invoke, type InvokeInput } from "../harness/invoke.ts"
import { REVIEW_INVOCATION_DEADLINES } from "../run/invocation-policy.ts"
import {
  cacheShare,
  invocationTrail,
  logDiagnostics,
  runProgress,
} from "../run/progress-text.ts"

// What Pool, Verification and Judgment share: the one system prompt their
// agents get, and how one of their invocations runs and is reported.

const EVALUATION_SYSTEM_PROMPT =
  "You are a stage in a code-review pipeline. Follow the supplied stage instructions and finish by calling the required emit tool."

export interface StageInvocation<O> extends Pick<
  InvokeInput<O>,
  "invocationId" | "seat" | "cwd" | "prompt" | "contract" | "tools"
> {
  // How the progress lines and run.log name the invocation.
  readonly label: string
}

export const invokeStageAgent = Effect.fn("StageAgent.invoke")(function* <O>(
  { label, ...invocation }: StageInvocation<O>,
) {
  yield* runProgress(`invoking ${label}`)
  const outcome = yield* invoke({
    ...invocation,
    systemPrompt: EVALUATION_SYSTEM_PROMPT,
    deadlines: REVIEW_INVOCATION_DEADLINES,
  })
  yield* runProgress(
    `${label} done — ${invocationTrail(outcome)}`,
    cacheShare([outcome.usage]),
  )
  yield* logDiagnostics(label, outcome.diagnostics)
  return outcome
})
