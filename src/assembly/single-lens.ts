import type { FindingsOutput } from "../harness/output-contract.ts"
import { Candidate } from "../domain/candidate.ts"
import { Dossier } from "../domain/dossier.ts"
import { Judgment } from "../domain/judgment.ts"
import type { FrozenLens } from "../domain/review-plan.ts"
import type { TargetIdentity } from "../domain/review-target.ts"
import { Verdict } from "../domain/verdict.ts"

// This tracer-bullet Assembly preserves every finder Candidate as an
// unverified or undecided entry; no model call occurs in Assembly.
export const assembleSingleLensDossier = (
  runId: string,
  target: TargetIdentity,
  lens: FrozenLens,
  output: FindingsOutput | undefined,
): Dossier => {
  const candidates = (output?.findings ?? []).map((finding, index) => {
    const core = {
      id: `${lens.name}/${String(index + 1)}`,
      lens: lens.name,
      file: finding.file,
      ...(finding.line === undefined ? {} : { line: finding.line }),
      summary: finding.summary,
    }
    return finding.failure_scenario === undefined
      ? Candidate.cases.Observation.make(core)
      : Candidate.cases.BugClaim.make({
          ...core,
          failureScenario: finding.failure_scenario,
        })
  })

  return Dossier.make({
    runId,
    target,
    bugClaims: candidates.flatMap((candidate) =>
      Candidate.guards.BugClaim(candidate)
        ? [{ candidate, verdict: Verdict.cases.Unverified.make({}) }]
        : []
    ),
    observations: candidates.flatMap((candidate) =>
      Candidate.guards.Observation(candidate)
        ? [{ candidate, judgment: Judgment.cases.Undecided.make({}) }]
        : []
    ),
    coverageGaps: [],
  })
}
