import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Recipe, type RecipeName, type Seat } from "../domain/recipe.ts"
import { writeArtifactJson } from "../run/artifact.ts"
import { listRecipes } from "./recipe-catalog.ts"

// Seat upgrade (#121): `gauntlet upgrade` moves recipe seats to the newest
// Luna/Sol their provider's catalog lists. Only this hardcoded family pattern
// matches — variants (-pro, -mini, :batch) never do — and versions compare
// numerically, so gpt-10 outranks gpt-6. Widen the pattern to add a family.
const familyModel = /^gpt-(\d+(?:\.\d+)*)-(luna|sol)$/

const parseFamilyModel = (modelId: string) => {
  const match = familyModel.exec(modelId)
  return match === null
    ? Option.none<{ readonly version: ReadonlyArray<number>; readonly family: string }>()
    : Option.some({ version: (match[1] ?? "").split(".").map(Number), family: match[2] ?? "" })
}

const compareVersions = (
  left: ReadonlyArray<number>,
  right: ReadonlyArray<number>,
): number => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

// The newest same-family model the seat's provider lists, keeping the seat's
// thinking level; none when the seat is not Luna/Sol or is already newest.
export const newerSeat = (
  seat: Seat,
  providerModelIds: (provider: string) => ReadonlyArray<string>,
): Option.Option<Seat> => {
  const providerSeparator = seat.indexOf("/")
  const effortSeparator = seat.lastIndexOf(":")
  const provider = seat.slice(0, providerSeparator)
  const current = parseFamilyModel(seat.slice(providerSeparator + 1, effortSeparator))
  if (Option.isNone(current)) return Option.none()
  let newest: { readonly id: string; readonly version: ReadonlyArray<number> } | undefined
  for (const id of providerModelIds(provider)) {
    const candidate = parseFamilyModel(id)
    if (Option.isNone(candidate) || candidate.value.family !== current.value.family) continue
    const baseline = newest?.version ?? current.value.version
    if (compareVersions(candidate.value.version, baseline) > 0) {
      newest = { id, version: candidate.value.version }
    }
  }
  return newest === undefined
    ? Option.none()
    : Option.some(`${provider}/${newest.id}${seat.slice(effortSeparator)}`)
}

interface SeatChange {
  readonly recipe: RecipeName
  readonly from: string
  readonly to: string
}

const seatFields = [
  "default",
  "finders",
  "interpretive-finders",
  "pool",
  "verification",
  "judgment",
] as const satisfies ReadonlyArray<keyof Recipe>

const seatModel = (seat: Seat): string => seat.slice(0, seat.lastIndexOf(":"))

// Rewrites every valid recipe with a newer Luna/Sol seat in place and reports
// each change as provider/model pairs. Invalid recipes are never rewritten;
// they are named as skipped so "current" never covers an unchecked file.
export const upgradeRecipeSeats = Effect.fn("gauntlet.seat_upgrade.upgrade")(
  function* (providerModelIds: (provider: string) => ReadonlyArray<string>) {
    const changes: Array<SeatChange> = []
    const skipped: Array<string> = []
    for (const entry of yield* listRecipes()) {
      if (entry._tag === "InvalidRecipe") {
        skipped.push(entry.name)
        continue
      }
      const upgradedSeats = seatFields.flatMap((field) => {
        const seat = entry.recipe[field]
        const next = seat === undefined ? Option.none() : newerSeat(seat, providerModelIds)
        if (seat === undefined || Option.isNone(next)) return []
        changes.push({ recipe: entry.name, from: seatModel(seat), to: seatModel(next.value) })
        return [[field, next.value] as const]
      })
      if (upgradedSeats.length > 0) {
        yield* writeArtifactJson(entry.path, Recipe, {
          ...entry.recipe,
          ...Object.fromEntries(upgradedSeats),
        })
      }
    }
    return { changes, skipped }
  },
)

// One line per destination model, naming every recipe that moved to it and
// the models it replaced, plus one line for any invalid recipe left unchecked.
export const renderSeatUpgrade = (
  upgrade: { readonly changes: ReadonlyArray<SeatChange>; readonly skipped: ReadonlyArray<string> },
): ReadonlyArray<string> => {
  const grouped = new Map<string, { recipes: Set<string>; from: Set<string> }>()
  for (const change of upgrade.changes) {
    const group = grouped.get(change.to) ?? { recipes: new Set(), from: new Set() }
    group.recipes.add(change.recipe)
    group.from.add(change.from)
    grouped.set(change.to, group)
  }
  const lines = [...grouped].map(([to, group]) =>
    `recipes ${[...group.recipes].join(", ")} → ${to} (was ${[...group.from].join(", ")})`
  )
  if (upgrade.skipped.length > 0) {
    lines.push(`skipped invalid recipes ${upgrade.skipped.join(", ")} — run \`gauntlet config\``)
  }
  return lines.length === 0 ? ["recipe seats are current"] : lines
}
