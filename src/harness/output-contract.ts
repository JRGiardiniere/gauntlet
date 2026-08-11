import * as Schema from "effect/Schema"
import { Severity } from "../domain/verdict.ts"

// One immutable contract drives the model-facing tool schema and every
// decode/persistence boundary for that output. Stage callers choose one of
// these values; invocation mechanics remain stage-agnostic.
export interface OutputContract<O> {
  readonly toolName:
    | "emit_findings"
    | "emit_pool"
    | "emit_verdicts"
    | "emit_judgments"
  readonly description: string
  readonly schema: Schema.Codec<O, O, never, never>
}

const defineOutputContract = <O>(
  toolName: OutputContract<O>["toolName"],
  description: string,
  schema: Schema.Codec<O, O, never, never>,
): OutputContract<O> => ({
  toolName,
  description,
  schema,
})

const described = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description })

const oneIndexedInteger = described(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  "1-indexed line in the new version of the file. Omit only when the finding is about the change as a whole rather than a location.",
)

export const FindingsOutput = Schema.Struct({
  findings: Schema.Array(
    Schema.Struct({
      file: described(
        Schema.NonEmptyString,
        "Path of the file the finding is in, as it appears in the changed-file list.",
      ),
      line: Schema.optionalKey(oneIndexedInteger),
      summary: described(
        Schema.NonEmptyString,
        "One sentence stating the defect or issue.",
      ),
      failure_scenario: Schema.optionalKey(
        described(
          Schema.NonEmptyString,
          "Concrete inputs or state that produce the wrong behaviour. Required for any claim a reviewer could refute; omit only for judgment calls with no refutable fact.",
        ),
      ),
    }),
  ),
})
export interface FindingsOutput
  extends Schema.Schema.Type<typeof FindingsOutput> {}

export const EmitFindings = defineOutputContract(
  "emit_findings",
  "Report the findings from your review pass. Call this exactly once, as your final action, even if you found nothing (pass an empty array). Do not describe findings in prose instead of calling this tool.",
  FindingsOutput,
)

const candidateIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const PoolOutput = Schema.Struct({
  clusters: Schema.Array(
    Schema.Struct({
      indexes: described(
        Schema.NonEmptyArray(candidateIndex),
        "Candidate indexes in this cluster (1+ members).",
      ),
      summary: described(
        Schema.NonEmptyString,
        "Canonical one-sentence statement of the defect.",
      ),
    }),
  ),
})
export interface PoolOutput extends Schema.Schema.Type<typeof PoolOutput> {}

export const EmitPool = defineOutputContract(
  "emit_pool",
  "Report the organized clusters for the verifier stage. Call this exactly once, as your final action. Every candidate index must appear in exactly one cluster. Do not answer in prose instead.",
  PoolOutput,
)

const verdictCore = {
  cluster: described(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    "The [cN] label of the cluster.",
  ),
  evidence: described(
    Schema.NonEmptyString,
    "One line: the inputs/state and wrong output, or the line that refutes it.",
  ),
}

const reportedVerdict = Schema.Struct({
  ...verdictCore,
  verdict: described(
    Schema.Literals(["CONFIRMED", "UNVERIFIED"]),
    "`CONFIRMED` | `UNVERIFIED` | `REFUTED` — see the ladder in the verifier prompt.",
  ),
  severity: described(
    Severity,
    "`P1` | `P2` | `P3`. Judged on reachability × consequence.",
  ),
})

const refutedVerdict = Schema.Struct({
  ...verdictCore,
  verdict: described(
    Schema.Literal("REFUTED"),
    "`CONFIRMED` | `UNVERIFIED` | `REFUTED` — see the ladder in the verifier prompt.",
  ),
})

export const VerdictsOutput = Schema.Struct({
  verdicts: Schema.Array(Schema.Union([reportedVerdict, refutedVerdict])),
})
export interface VerdictsOutput
  extends Schema.Schema.Type<typeof VerdictsOutput> {}

export const EmitVerdicts = defineOutputContract(
  "emit_verdicts",
  "Report one verdict per cluster in this verifier bundle. Call this exactly once, as your final action. Do not answer in prose instead.",
  VerdictsOutput,
)

const judgmentCore = {
  index: described(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    "The [i] label of the candidate this decision is about.",
  ),
  reason: described(
    Schema.NonEmptyString,
    "One line. Keeps: why it is warranted AND what was checked in the tree to confirm the premise. Drops: which failure it is — false premise / disproportionate / taste, not cost / repo convention / BugClaim-path claim / no nameable payer.",
  ),
}

const keepDecision = Schema.Struct({
  ...judgmentCore,
  decision: described(
    Schema.Literal("keep"),
    "`keep` = warranted criticism worth reporting; `drop` = not worth the author's time.",
  ),
  tier: described(
    Severity,
    "`P1` | `P2` | `P3`. Required when keep, omitted when drop — a dropped candidate has no tier at all; \"not actually a problem\" is a drop with a reason, never a severity.",
  ),
  merge: Schema.optionalKey(
    described(
      Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      "Indexes of duplicate candidates folded into this kept one — same root observation arriving at two altitudes. Merge duplicates, not themes.",
    ),
  ),
  goodFind: described(
    Schema.Boolean,
    "Was this genuinely worth catching, as opposed to merely admissible? Admissible but obvious is `false`.",
  ),
  cleanlyExplained: described(
    Schema.Boolean,
    "Reading ONLY the finder's own summary, are the problem and the better shape clear enough to act on? Judge the text as written.",
  ),
  qualityNote: Schema.optionalKey(
    described(
      Schema.NonEmptyString,
      "Keeps only, when either rating is false: one line on what is weak.",
    ),
  ),
})

const dropDecision = Schema.Struct({
  ...judgmentCore,
  decision: described(
    Schema.Literal("drop"),
    "`keep` = warranted criticism worth reporting; `drop` = not worth the author's time.",
  ),
})

export const JudgmentsOutput = Schema.Struct({
  decisions: Schema.Array(Schema.Union([keepDecision, dropDecision])),
})
export interface JudgmentsOutput
  extends Schema.Schema.Type<typeof JudgmentsOutput> {}

export const EmitJudgments = defineOutputContract(
  "emit_judgments",
  "Report one keep/drop decision per candidate index. Call this exactly once, as your final action. Do not answer in prose instead.",
  JudgmentsOutput,
)
