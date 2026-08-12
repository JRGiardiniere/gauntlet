import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as String from "effect/String"
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

export const defineOutputContract = <O>(
  toolName: OutputContract<O>["toolName"],
  description: string,
  schema: Schema.Codec<O, O, never, never>,
): OutputContract<O> => ({
  toolName,
  description,
  schema,
})

export const described = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description })

const canonicalizeInlineText = (value: string): string =>
  String.trim(String.replace(/\r\n?|\n/g, " ")(value))

// Model-authored text used by the line-oriented stage prompts is normalized at
// the OutputContract seam so capture, persistence, and every consumer agree.
export const inlineText = (description: string) =>
  described(Schema.NonEmptyString, description).pipe(
    Schema.decodeTo(
      Schema.NonEmptyString,
      SchemaTransformation.transform({
        decode: canonicalizeInlineText,
        encode: canonicalizeInlineText,
      }),
    ),
  )

const oneIndexedInteger = described(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  "1-indexed line in the new version of the file. Omit only when the finding is about the change as a whole rather than a location.",
)

export const FindingsOutput = Schema.Struct({
  findings: Schema.Array(
    Schema.Struct({
      file: inlineText(
        "Path of the file the finding is in, as it appears in the changed-file list.",
      ),
      line: Schema.optionalKey(oneIndexedInteger),
      summary: inlineText(
        "One sentence stating the defect or issue.",
      ),
      failure_scenario: Schema.optionalKey(
        inlineText(
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

const oneLine = Schema.NonEmptyString.check(
  Schema.isPattern(/^(?![\s\S]*[\r\n])[\s\S]+$/),
)

export const PoolOutput = Schema.Struct({
  clusters: Schema.Array(
    Schema.Struct({
      indexes: described(
        Schema.NonEmptyArray(candidateIndex),
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

const verdictCore = {
  cluster: described(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    "The [cN] label of the cluster.",
  ),
  evidence: described(
    oneLine,
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
