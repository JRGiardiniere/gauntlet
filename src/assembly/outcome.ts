import type { AgentOutcome } from "../domain/agent-outcome.ts"
import { Termination } from "../domain/agent-outcome.ts"

export const describeMissingOutput = (
  stage: string,
  outcome: AgentOutcome<unknown>,
): string =>
  Termination.match(outcome.termination, {
    Completed: () => `${stage} completed without a decodable emit`,
    MissingEmit: ({ correctiveTurns }) =>
      `${stage} emitted nothing after ${String(correctiveTurns)} corrective turns`,
    BudgetExhausted: () => `${stage} exhausted its invocation deadline`,
    ContextLimit: () => `${stage} reached its context limit`,
    ProviderFailed: () => `${stage} provider failed`,
    Interrupted: () => `${stage} was interrupted`,
  })
