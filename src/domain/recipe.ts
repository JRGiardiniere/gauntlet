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

// A Recipe is pure content: one file in the recipes directory naming a seat
// per seated stage — seats only, never budgets or cost limits (ADR 0006).
export const Recipe = Schema.Struct({
  name: Schema.NonEmptyString,
  seats: Schema.Struct({
    finders: Seat,
    pool: Seat,
    verification: Seat,
    judgment: Seat,
  }),
})
export type Recipe = typeof Recipe.Type
