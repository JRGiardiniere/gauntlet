import * as Array from "effect/Array"
import type { AgentOutcome } from "../domain/agent-outcome.ts"
import {
  type BugClaim,
  Candidate,
  type Observation,
} from "../domain/candidate.ts"
import type { CoverageGap } from "../domain/dossier.ts"
import type { FrozenLens } from "../domain/review-plan.ts"
import type { FindingsOutput } from "../harness/output-contract.ts"
import { describeMissingOutput } from "./outcome.ts"

export interface FinderResult {
  readonly lens: FrozenLens
  readonly outcome: AgentOutcome<FindingsOutput>
}

export const enforceCandidateCap = (
  lens: FrozenLens,
  outcome: AgentOutcome<FindingsOutput>,
): AgentOutcome<FindingsOutput> => {
  const findings = outcome.output?.findings
  if (findings === undefined || findings.length <= lens.candidateCap) {
    return outcome
  }
  return {
    ...outcome,
    output: { findings: Array.take(findings, lens.candidateCap) },
    diagnostics: [
      ...outcome.diagnostics,
      `finder ${lens.name} emitted ${String(findings.length)} candidates; retained the plan cap of ${String(lens.candidateCap)}`,
    ],
  }
}

export interface RoutedFinderResults {
  readonly bugClaims: ReadonlyArray<BugClaim>
  readonly observations: ReadonlyArray<Observation>
  readonly coverageGaps: ReadonlyArray<CoverageGap>
}

// Finders only produce and route Candidates. Verdicts, Judgments, and the
// canonical Dossier belong to their downstream stages and final Assembly.
export const routeFinderResults = (
  results: ReadonlyArray<FinderResult>,
): RoutedFinderResults => {
  const bugClaims: Array<BugClaim> = []
  const observations: Array<Observation> = []
  const coverageGaps: Array<CoverageGap> = []

  for (const { lens, outcome } of results) {
    if (outcome.output === undefined) {
      coverageGaps.push({
        stage: "finders",
        lens: lens.name,
        reason: describeMissingOutput("finder", outcome),
      })
      continue
    }

    for (const [index, finding] of outcome.output.findings.entries()) {
      // `line` may be absent on whole-change findings; it is added to the
      // core only when the finder located one.
      const base = {
        id: `${lens.name}/${String(index + 1)}`,
        lens: lens.name,
        file: finding.file,
        summary: finding.summary,
      }
      const core = finding.line === undefined
        ? base
        : { ...base, line: finding.line }
      if (finding.failure_scenario === undefined) {
        observations.push(Candidate.cases.Observation.make(core))
      } else {
        bugClaims.push(Candidate.cases.BugClaim.make({
          ...core,
          failureScenario: finding.failure_scenario,
        }))
      }
    }
  }

  return { bugClaims, observations, coverageGaps }
}
