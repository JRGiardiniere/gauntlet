import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Record from "effect/Record"
import { Recipe, type RecipeName, type Seat } from "../domain/recipe.ts"
import { writeArtifactJson } from "../run/artifact.ts"
import { CatalogEntry, listRecipes } from "./recipe-catalog.ts"

// Seat upgrade (#121): `gauntlet upgrade` moves recipe seats to the newest
// Luna/Terra/Sol their provider's catalog lists. Only this hardcoded family
// pattern gets a newer model — variants (-pro, -mini, :batch) keep theirs,
// though a legacy provider's seat still moves provider — and versions compare
// numerically, so gpt-10 outranks gpt-6. Widen the pattern to add a family.
const familyModel = /^gpt-(\d+(?:\.\d+)*)-(luna|terra|sol)$/

// v1's `openai-codex` provider is Sign in with ChatGPT on `openai` now, so a
// legacy seat always moves to its successor. Until the user signs in there,
// reviews fail with the Host's missing-credential error.
const successorProviders: ReadonlyMap<string, string> = new Map([
  ["openai-codex", "openai"],
])

const parseFamilyModel = (
  modelId: string,
): Option.Option<{ readonly version: ReadonlyArray<number>; readonly family: string }> => {
  const match = familyModel.exec(modelId)
  const version = match?.[1]
  const family = match?.[2]

  return version === undefined || family === undefined
    ? Option.none()
    : Option.some({ version: Array.map(version.split("."), Number), family })
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

// The newest same-family model in `modelIds` that `accepts` admits; the model
// itself when it is not Luna/Terra/Sol or is already newest.
const newestFamilyModel = (
  modelId: string,
  modelIds: ReadonlyArray<string>,
  accepts: (modelId: string) => boolean,
): string => {
  const current = parseFamilyModel(modelId)

  if (Option.isNone(current)) return modelId
  let newest = { id: modelId, version: current.value.version }

  for (const id of modelIds) {
    const candidate = parseFamilyModel(id)

    if (Option.isNone(candidate) || candidate.value.family !== current.value.family) continue

    if (compareVersions(candidate.value.version, newest.version) > 0 && accepts(id)) {
      newest = { id, version: candidate.value.version }
    }
  }

  return newest.id
}

// The provider whose models a Seat upgrades onto: its successor's, if any.
export const upgradeProvider = (seat: Seat): string => {
  const provider = seat.slice(0, seat.indexOf("/"))

  return successorProviders.get(provider) ?? provider
}

// Whether a Seat could run; the Host's model list answers it (`hostAccepts`).
export type SeatAcceptance = (seat: Seat) => boolean

// The seat on its successor provider, then on the newest same-family model
// there, keeping effort and Fast mode; none when neither step moves it or
// `accepts` refuses where it would land.
export const newerSeat = (
  seat: Seat,
  providerModelIds: (provider: string) => ReadonlyArray<string>,
  accepts: SeatAcceptance,
): Option.Option<Seat> => {
  const effortSeparator = seat.lastIndexOf(":")
  const model = seat.slice(seat.indexOf("/") + 1, effortSeparator)
  const provider = upgradeProvider(seat)
  const effort = seat.slice(effortSeparator)

  const newest = newestFamilyModel(
    model,
    providerModelIds(provider),
    (candidate) => accepts(`${provider}/${candidate}${effort}`),
  )

  const next = `${provider}/${newest}${effort}`

  return next === seat || !accepts(next) ? Option.none() : Option.some(next)
}

export interface SeatChange {
  readonly recipe: RecipeName
  readonly from: string
  readonly to: string
}

export const seatFields = [
  "default",
  "finders",
  "interpretive-finders",
  "pool",
  "verification",
  "judgment",
] as const satisfies ReadonlyArray<keyof Recipe>

const seatModel = (seat: Seat): string => seat.slice(0, seat.lastIndexOf(":"))

// Rewrites every valid recipe with a newer Luna/Terra/Sol seat in place and reports
// each change as provider/model pairs. Invalid recipes are never rewritten;
// they are named as skipped so "current" never covers an unchecked file.
export const upgradeRecipeSeats = Effect.fn("gauntlet.seat_upgrade.upgrade")(
  function* (
    providerModelIds: (provider: string) => ReadonlyArray<string>,
    accepts: SeatAcceptance,
  ) {
    const changes: Array<SeatChange> = []
    const skipped: Array<string> = []

    for (const entry of yield* listRecipes()) {
      if (CatalogEntry.$is("InvalidRecipe")(entry)) {
        skipped.push(entry.name)
        continue
      }

      const upgradedSeats = Array.flatMap(seatFields, (field) => {
        const seat = entry.recipe[field]
        const next = seat === undefined ? Option.none() : newerSeat(seat, providerModelIds, accepts)

        if (seat === undefined || Option.isNone(next)) return []
        changes.push({ recipe: entry.name, from: seatModel(seat), to: seatModel(next.value) })

        return [[field, next.value] as const]
      })

      if (upgradedSeats.length > 0) {
        yield* writeArtifactJson(entry.path, Recipe, {
          ...entry.recipe,
          ...Record.fromEntries(upgradedSeats),
        })
      }
    }

    return { changes, skipped }
  },
)
