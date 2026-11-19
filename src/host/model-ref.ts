import * as Array from "effect/Array"
import type { Seat } from "../domain/recipe.ts"
import type { HostModel } from "./host.ts"

// OpenCode's name for a Seat's model: `provider/model:effort[+fast]` becomes
// provider, model and variant. Fast mode is OpenCode's `<model>-fast` model,
// and `claude-code/` is the provider OpenCode calls `claude-agent`.
export interface ModelRef {
  readonly providerID: string
  readonly modelID: string
  readonly variant: string
}

const FAST = "+fast"
const providerAliases: ReadonlyMap<string, string> = new Map([["claude-code", "claude-agent"]])

export const toModelRef = (seat: Seat): ModelRef => {
  const slash = seat.indexOf("/")
  const colon = seat.lastIndexOf(":")
  const provider = seat.slice(0, slash)
  const model = seat.slice(slash + 1, colon)
  const effort = seat.slice(colon + 1)
  const fast = effort.endsWith(FAST)
  return {
    providerID: providerAliases.get(provider) ?? provider,
    modelID: fast ? `${model}-fast` : model,
    variant: fast ? effort.slice(0, -FAST.length) : effort,
  }
}

// Whether the Host would run this Seat: its model is listed and offers the
// Seat's effort as a variant.
export const hostAccepts = (models: ReadonlyArray<HostModel>, seat: Seat): boolean => {
  const ref = toModelRef(seat)
  return Array.some(
    models,
    (model) =>
      model.providerID === ref.providerID && model.id === ref.modelID && Array.contains(model.variants, ref.variant),
  )
}
