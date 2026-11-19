import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { Seat } from "../domain/recipe.ts"
import type { HostModel } from "./host.ts"
import { hostAccepts, toModelRef } from "./model-ref.ts"

describe("toModelRef", () => {
  it.each([
    ["openai/gpt-6.2-sol:high", { providerID: "openai", modelID: "gpt-6.2-sol", variant: "high" }],
    ["openai/gpt-6.1-terra:high+fast", { providerID: "openai", modelID: "gpt-6.1-terra-fast", variant: "high" }],
    ["claude-code/opus:medium", { providerID: "claude-agent", modelID: "opus", variant: "medium" }],
    ["claude-agent/sonnet:low", { providerID: "claude-agent", modelID: "sonnet", variant: "low" }],
    // Model ids may hold colons; the effort is after the last one.
    ["acme/terra:4:high+fast", { providerID: "acme", modelID: "terra:4-fast", variant: "high" }],
    // Recorded v1 Seats: the retired openai-codex provider, the Mod's Claude Seats.
    ["openai-codex/gpt-6-sol:xhigh", { providerID: "openai-codex", modelID: "gpt-6-sol", variant: "xhigh" }],
    ["claude-code/claude-opus-5:max", { providerID: "claude-agent", modelID: "claude-opus-5", variant: "max" }],
  ])("%s", (seat, expected) => {
    expect(toModelRef(seat)).toEqual(expected)
  })

  const Part = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.-]*$/))
  it.prop(
    "splits any provider/model:effort back into its parts",
    { provider: Part, model: Part, effort: Part },
    ({ provider, model, effort }) => {
      const seat = Schema.decodeSync(Seat)(`${provider}/${model}:${effort}`)
      const ref = toModelRef(seat)
      expect(ref.modelID).toBe(model)
      expect(ref.variant).toBe(effort)
      expect(ref.providerID).toBe(provider === "claude-code" ? "claude-agent" : provider)
    },
  )
})

describe("hostAccepts", () => {
  const models: ReadonlyArray<HostModel> = [
    { providerID: "openai", id: "gpt-6.1-terra", variants: ["none", "low", "high"] },
    { providerID: "openai", id: "gpt-6.1-terra-fast", variants: ["low"] },
    { providerID: "claude-agent", id: "opus", variants: ["low", "medium", "high"] },
  ]
  it.each([
    ["openai/gpt-6.1-terra:high", true],
    ["openai/gpt-6.1-terra:low+fast", true],
    ["openai/gpt-6.1-terra:high+fast", false],
    ["openai/gpt-6.1-terra:max", false],
    ["openai/gpt-6.2-sol:high", false],
    ["claude-code/opus:medium", true],
    ["claude-code/sonnet:medium", false],
  ])("%s → %s", (seat, accepted) => {
    expect(hostAccepts(models, seat)).toBe(accepted)
  })
})
