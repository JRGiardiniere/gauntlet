import * as Schema from "effect/Schema"
import { Severity } from "../../domain/verdict.ts"
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
    inlineText(
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
  "Report your keep/drop decisions. Every candidate index appears exactly once: as a decision's index, or inside a keeper's merge array — a merged index gets no decision of its own. Call this exactly once, as your final action. Do not answer in prose instead.",
  JudgmentsOutput,
)
