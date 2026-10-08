import { flow } from "effect/Function"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

// The words typed after /gauntlet (or passed as the review tool's `args`), as
// the shared syntax (src/syntax/syntax.ts) parses them: `deliver <run-id>`,
// or a review, whose `review` may be left out. Words split as a shell splits
// them: a quoted part, even one inside a word (`--repo="~/My Projects/x"`),
// keeps its spaces and loses its quotes.
export const commandWords = (args: string): ReadonlyArray<string> => {
  const words = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/(["'])(.*?)\1/g, "$2")) ?? []
  return words[0] === "review" || words[0] === "deliver" ? words : ["review", ...words]
}

// The review tool's `args`, decoded where the call arrives; undefined when
// the call carries none.
const ReviewToolInput = Schema.Struct({
  args: Schema.String.annotate({ description: "The review's target and flags, as /gauntlet takes them" }),
})

// The tool's input schema, projected from the decoder below.
export const reviewToolInputSchema = Schema.toJsonSchemaDocument(ReviewToolInput).schema

export const reviewToolArgs = flow(
  Schema.decodeUnknownOption(ReviewToolInput),
  Option.map(({ args }) => args),
  Option.getOrUndefined,
)
