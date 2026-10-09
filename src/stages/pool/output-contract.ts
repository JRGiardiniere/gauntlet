import * as Schema from "effect/Schema"
import {
  defineOutputContract,
  described,
  inlineText,
} from "../../harness/output-contract.ts"

export const PoolOutput = Schema.Struct({
  clusters: Schema.Array(
    Schema.Struct({
      indexes: described(
        Schema.NonEmptyArray(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
        "Candidate indexes in this cluster (1+ members).",
      ),
      summary: inlineText(
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
