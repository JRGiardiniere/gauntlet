import * as Schema from "effect/Schema"
import { ReviewPriority } from "../../domain/verdict.ts"
import {
  defineOutputContract,
  described,
  inlineText,
} from "../../harness/output-contract.ts"

const judgmentCore = {
  index: described(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    "The [i] label of the candidate this decision is about.",
  ),
  reason: inlineText(
    "One line. Keeps: why it is warranted AND what was checked in the tree to confirm the premise. Drops: which failure it is — false premise / disproportionate / taste, not cost / repo convention / BugClaim-path claim / no nameable payer. Merges: the shared root observation.",
  ),
}

const DECISION =
  "`keep` = warranted criticism worth reporting; `drop` = not worth the author's time; `merge` = a duplicate of the kept candidate named in `into`."

const keepDecision = Schema.Struct({
  ...judgmentCore,
  decision: described(Schema.Literal("keep"), DECISION),
  review_priority: described(
    ReviewPriority,
    "`P1` | `P2` | `P3`. Review Priority. Required when keep, omitted when drop — a dropped candidate has no Review Priority at all; \"not actually a problem\" is a drop with a reason, never a priority.",
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
    inlineText(
      "Keeps only, when either rating is false: one line on what is weak.",
    ),
  ),
})

const dropDecision = Schema.Struct({
  ...judgmentCore,
  decision: described(Schema.Literal("drop"), DECISION),
})

const mergeDecision = Schema.Struct({
  ...judgmentCore,
  decision: described(Schema.Literal("merge"), DECISION),
  into: described(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    "Merges only: the index of the kept candidate this one duplicates — same root observation arriving at two altitudes. Merge duplicates, not themes.",
  ),
})

export const JudgmentsOutput = Schema.Struct({
  decisions: Schema.Array(
    Schema.Union([keepDecision, dropDecision, mergeDecision]),
  ),
})
export interface JudgmentsOutput
  extends Schema.Schema.Type<typeof JudgmentsOutput> {}

export const EmitJudgments = defineOutputContract(
  "emit_judgments",
  "Report one keep, drop or merge decision per candidate index: every index appears exactly once. Call this exactly once, as your final action. Do not answer in prose instead.",
  JudgmentsOutput,
)
