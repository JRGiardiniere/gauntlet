import * as Array from "effect/Array"
import type { AgentOutcome } from "../domain/agent-outcome.ts"
import { Candidate } from "../domain/candidate.ts"
import { Dossier } from "../domain/dossier.ts"
import { Judgment } from "../domain/judgment.ts"
import type { FrozenLens } from "../domain/review-plan.ts"
import type { TargetIdentity } from "../domain/review-target.ts"
import { Verdict } from "../domain/verdict.ts"
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

// Finder Assembly preserves every retained Candidate as unverified or
// undecided so each downstream path can replace only its own evaluation.
export const assembleFinderDossier = (
  runId: string,
  target: TargetIdentity,
  results: ReadonlyArray<FinderResult>,
): Dossier => {
  const bugClaims: Array<Dossier["bugClaims"][number]> = []
  const observations: Array<Dossier["observations"][number]> = []
  const coverageGaps: Array<Dossier["coverageGaps"][number]> = []

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
      const core = {
        id: `${lens.name}/${String(index + 1)}`,
        lens: lens.name,
        file: finding.file,
        ...(finding.line === undefined ? {} : { line: finding.line }),
        summary: finding.summary,
      }
      if (finding.failure_scenario === undefined) {
        observations.push({
          candidate: Candidate.cases.Observation.make(core),
          judgment: Judgment.cases.Undecided.make({}),
        })
      } else {
        bugClaims.push({
          candidate: Candidate.cases.BugClaim.make({
            ...core,
            failureScenario: finding.failure_scenario,
          }),
          verdict: Verdict.cases.Unverified.make({}),
        })
      }
    }
  }

  return Dossier.make({
    runId,
    target,
    bugClaims,
    observations,
    coverageGaps,
  })
}
