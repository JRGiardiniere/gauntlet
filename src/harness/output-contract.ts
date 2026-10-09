import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as String from "effect/String"

// One immutable contract drives the model-facing tool schema and every
// decode/persistence boundary for that output. Tool names are owned by the
// stage that defines the contract (the normative set lives in
// docs/spec/emit-tools.md); invocation mechanics remain stage-agnostic.
export interface OutputContract<O> {
  readonly toolName: string
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

const outputContractParseOptions = {
  onExcessProperty: "error",
} as const

// Pi validates model-authored arguments against this projection before
// invoking the emit tool. Keep its excess-property policy identical to the
// strict decoder below the adapter seam: otherwise Pi can accept a payload
// that Gauntlet must immediately reject.
export const projectOutputContract = (
  contract: { readonly schema: Schema.Constraint },
) =>
  Schema.toJsonSchemaDocument(contract.schema, outputContractParseOptions)

export const decodeOutputContract = <O>(contract: OutputContract<O>) =>
  Schema.decodeUnknownEffect(contract.schema, outputContractParseOptions)

export const checkOutputContract = <O>(contract: OutputContract<O>) =>
  Schema.decodeUnknownResult(contract.schema, outputContractParseOptions)

export const described = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description })

const canonicalizeInlineText = (value: string): string =>
  String.trim(String.replace(/\r\n?|\n/g, " ")(value))

// Model-authored text used by the line-oriented stage prompts is normalized at
// the OutputContract seam so capture, persistence, and every consumer agree.
// The projected pattern rejects blank text at tool validation, on Pi as in the
// strict decode, instead of failing the run after a blank emit is accepted.
export const inlineText = (description: string) =>
  described(Schema.String.check(Schema.isPattern(/\S/u)), description).pipe(
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
      source_references: Schema.optionalKey(described(
        Schema.Array(Schema.NonEmptyString),
        "Repository-relative file paths needed to evaluate this candidate, including callers, helpers, guards, or configuration you actually read. Include evidence that limits or could refute the claim. Do not copy source or invent references. No URLs or absolute paths. Omit if no source file is available.",
      )),
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
