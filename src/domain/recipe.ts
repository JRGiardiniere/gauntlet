import * as Schema from "effect/Schema"

// Seat grammar: provider/model:effort (ADR 0005). Model ids may themselves
// contain colons, so the pattern anchors on the provider slash and requires a
// trailing :effort segment without splitting the middle.
export const Seat = Schema.String.check(
  Schema.isPattern(/^[^/\s]+\/\S+:[^\s:]+$/),
)
export type Seat = typeof Seat.Type

// The portable lowercase-kebab-case filename is the sole recipe name; the
// JSON never repeats it (ADR 0005).
export const RecipeName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
)
export type RecipeName = typeof RecipeName.Type

// A lens is specific by omission or opts into exactly `interpretive` (ADR
// 0004); the recipe maps the class to a seat, the lens never names one.
export const FinderClass = Schema.Literals(["specific", "interpretive"])
export type FinderClass = typeof FinderClass.Type

// Each Host runs its own providers' Seats, and keeps its own Recipe Catalog
// (#177): the Mod runs only claude-code/ Seats, the CLI every other provider.
// A Seat the catalog's Host cannot run is a Schema error on that Recipe.
const CLAUDE_CODE = "claude-code/"
export const ClaudeSeat = Seat.check(
  Schema.makeFilter((seat) =>
    seat.startsWith(CLAUDE_CODE) ||
    `the Mod runs only claude-code/<model>:<effort> Seats (claude-code/opus:medium), not ${seat}`
  ),
)
export const PiSeat = Seat.check(
  Schema.makeFilter((seat) =>
    !seat.startsWith(CLAUDE_CODE) ||
    `${seat} runs only in the Mod; its recipes are in ~/.gauntlet/mod/recipes`
  ),
)

// A Recipe is user-owned content: one strict JSON file in the Recipe Catalog
// naming a required default seat plus optional per-stage overrides — seats
// only, never budgets or cost limits (ADR 0005/0006). Decoding rejects
// unknown keys so a misspelled stage cannot silently inherit the default.
const recipeOf = <S extends typeof Seat>(seat: S) =>
  Schema.Struct({
    default: seat,
    finders: Schema.optionalKey(seat),
    "interpretive-finders": Schema.optionalKey(seat),
    pool: Schema.optionalKey(seat),
    verification: Schema.optionalKey(seat),
    judgment: Schema.optionalKey(seat),
  })
export const Recipe = recipeOf(Seat)
export type Recipe = typeof Recipe.Type
export const PiRecipe = recipeOf(PiSeat)
export const ClaudeRecipe = recipeOf(ClaudeSeat)

// Specific finders resolve through `finders` then `default`; interpretive
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
