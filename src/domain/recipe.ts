import * as Schema from "effect/Schema"

// Seat grammar: provider/model:effort (ADR 0005). Model ids may themselves
// contain colons, so the pattern anchors on the provider slash and requires a
// trailing :effort segment without splitting the middle.
export const Seat = Schema.String.check(
  Schema.isPattern(/^[^/\s]+\/\S+:[^\s:]+$/),
)
export type Seat = typeof Seat.Type

// Thinking effort changes inference policy, not the provider/model cache
// partition. The grammar guarantees the final colon introduces the effort.
export const modelIdentityOfSeat = (seat: Seat): string =>
  seat.slice(0, seat.lastIndexOf(":"))

// The portable lowercase-kebab-case filename is the sole recipe name; the
// JSON never repeats it (ADR 0005).
export const RecipeName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
)
export type RecipeName = typeof RecipeName.Type

// A lens is standard by omission or opts into exactly `interpretive` (ADR
// 0004); the recipe maps the class to a seat, the lens never names one.
export const FinderClass = Schema.Literals(["standard", "interpretive"])
export type FinderClass = typeof FinderClass.Type

// A Recipe is user-owned content: one strict JSON file in the Recipe Catalog
// naming a required default seat plus optional per-stage overrides — seats
// only, never budgets or cost limits (ADR 0005/0006). Decoding rejects
// unknown keys so a misspelled stage cannot silently inherit the default.
export const Recipe = Schema.Struct({
  default: Seat,
  finders: Schema.optionalKey(Seat),
  "interpretive-finders": Schema.optionalKey(Seat),
  pool: Schema.optionalKey(Seat),
  verification: Schema.optionalKey(Seat),
  judgment: Schema.optionalKey(Seat),
})
export type Recipe = typeof Recipe.Type

// Standard finders resolve through `finders` then `default`; interpretive
// finders through `interpretive-finders`, then `finders`, then `default`
// (ADR 0005).
export const finderSeat = (recipe: Recipe, finderClass: FinderClass): Seat =>
  finderClass === "interpretive"
    ? recipe["interpretive-finders"] ?? recipe.finders ?? recipe.default
    : recipe.finders ?? recipe.default

// Every other seated stage resolves through its named override then `default`.
export const stageSeat = (
  recipe: Recipe,
  stage: "pool" | "verification" | "judgment",
): Seat => recipe[stage] ?? recipe.default
