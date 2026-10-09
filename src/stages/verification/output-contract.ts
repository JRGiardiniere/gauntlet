import * as Schema from "effect/Schema"
import { ReviewPriority } from "../../domain/verdict.ts"
import {
  defineOutputContract,
  described,
} from "../../harness/output-contract.ts"

const oneLine = Schema.NonEmptyString.check(
  Schema.isPattern(/^(?![\s\S]*[\r\n])[\s\S]+$/),
)

// Deliberately content-loose: a malformed suggestion must never fail-close
// the bundle's verdicts, so deterministic resolution validates contents
// (non-empty tests and reason, CONFIRMED/PLAUSIBLE only) and drops bad
// suggestions with a diagnostic instead of the decoder rejecting them.
// A factory, not a shared instance: both union branches carry the field, and
// a shared object schema would be hoisted into JSON-schema definitions,
// breaking the self-contained tool projection.
const testSuggestion = () =>
  Schema.optionalKey(
    described(
      Schema.Struct({
        tests: Schema.optionalKey(
          described(
            Schema.Array(Schema.String),
            "Existing repository test areas, files, classes, or suites (1+) whose execution would materially increase confidence in this verdict. Never generated test source or shell commands.",
          ),
        ),
        reason: Schema.optionalKey(
          described(
            Schema.String,
            "One concise reason these existing tests are relevant to the claim.",
          ),
        ),
      }),
      "Optional, CONFIRMED/PLAUSIBLE only: existing repository tests worth running to increase confidence. Omit for REFUTED and whenever no existing test would materially help.",
    ),
  )

const verdictCore = {
  cluster: described(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    "The [cN] label of the cluster.",
  ),
  evidence: described(
    oneLine,
    "One line: the inputs/state and wrong output, or the line that refutes it. When Review Priority rests on specification responsibility, include that reasoning on the same line.",
  ),
}

const reportedVerdict = Schema.Struct({
  ...verdictCore,
  verdict: described(
    Schema.Literals(["CONFIRMED", "PLAUSIBLE"]),
    "`CONFIRMED` | `PLAUSIBLE` | `REFUTED` — see the ladder in the verifier prompt.",
  ),
  review_priority: described(
    ReviewPriority,
    "`P1` | `P2` | `P3`. Review Priority for the author of the current ReviewTarget: reachability, consequence, and whether that target is responsible. A regression introduced by the target stays P1; a real parent-only concern may be Confirmed P3 with evidence stating both the factual premise and the specification reasoning. Slice silence alone never lowers priority.",
  ),
  test_suggestion: testSuggestion(),
})

const refutedVerdict = Schema.Struct({
  ...verdictCore,
  verdict: described(
    Schema.Literal("REFUTED"),
    "`CONFIRMED` | `PLAUSIBLE` | `REFUTED` — see the ladder in the verifier prompt.",
  ),
  // Accepted by the decoder so a stray suggestion cannot fail-close the
  // bundle; resolution rejects it with a diagnostic.
  test_suggestion: testSuggestion(),
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
