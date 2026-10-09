import * as Array from "effect/Array"
import * as Option from "effect/Option"
import type { AgentOutcome } from "../domain/agent-outcome.ts"
import { Termination } from "../domain/agent-outcome.ts"

export const describeMissingOutput = (
  stage: string,
  outcome: AgentOutcome<unknown>,
): string => {
  const timeoutDiagnostic = Array.findLast(
    outcome.diagnostics,
    (diagnostic) =>
      diagnostic.startsWith("session construction exceeded ") ||
      diagnostic.startsWith("first response exceeded "),
  )
  return Termination.match(outcome.termination, {
    Completed: () => `${stage} completed without a decodable emit`,
    MissingEmit: ({ correctiveTurns }) =>
      `${stage} emitted nothing after ${String(correctiveTurns)} corrective turns`,
    FirstResponseTimeout: () =>
      Option.getOrElse(
        timeoutDiagnostic,
        () => `${stage} produced no first response`,
      ),
    BudgetExhausted: () => `${stage} exhausted its invocation deadline`,
    ContextLimit: () => `${stage} reached its context limit`,
    ProviderFailed: () => `${stage} provider failed`,
    Interrupted: () => `${stage} was interrupted`,
  })
}
