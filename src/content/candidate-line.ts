import { Candidate, type Candidate as CandidateValue } from "../domain/candidate.ts"

export interface IndexedCandidate<C extends CandidateValue = CandidateValue> {
  readonly index: number
  readonly candidate: C
}

export const formatCandidateLine = (
  { candidate, index }: IndexedCandidate,
): string => {
  const location = `${candidate.file}${candidate.line === undefined ? "" : `:${String(candidate.line)}`}`
  const line = `[${String(index)}] (${candidate.lens}) ${location} — ${candidate.summary}`
  return Candidate.guards.BugClaim(candidate)
    ? `${line}\n    claimed failure: ${candidate.failureScenario}`
    : line
}
