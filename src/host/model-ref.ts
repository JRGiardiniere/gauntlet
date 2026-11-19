import * as Array from "effect/Array"
import { type Seat, seatSpeed } from "../domain/recipe.ts"
import type { HostModel } from "./host.ts"

// OpenCode's name for a Seat's model: `provider/model:effort[+fast]` becomes
// provider, model and variant. Fast mode is OpenCode's `<model>-fast` model,
// and `claude-code/` is the provider OpenCode calls `claude-agent`.
export interface ModelRef {
  readonly providerID: string
  readonly modelID: string
  readonly variant: string
}

const providerAliases: ReadonlyMap<string, string> = new Map([["claude-code", "claude-agent"]])

export const toModelRef = (seat: Seat): ModelRef => {
  const { seat: plain, fast } = seatSpeed(seat)
  const slash = plain.indexOf("/")
  const colon = plain.lastIndexOf(":")
  const provider = plain.slice(0, slash)
  const model = plain.slice(slash + 1, colon)
  return {
    providerID: providerAliases.get(provider) ?? provider,
    modelID: fast ? `${model}-fast` : model,
    variant: plain.slice(colon + 1),
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
