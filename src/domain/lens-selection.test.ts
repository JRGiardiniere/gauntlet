import { describe, expect, it } from "@effect/vitest"
import { resolveLensNames } from "./lens-selection.ts"

describe("resolveLensNames", () => {
  it("uses deduplicated Default Lens membership when the caller is silent", () => {
    expect(resolveLensNames(undefined, ["zeta", "alpha", "zeta"])).toEqual([
      "zeta",
      "alpha",
    ])
    expect(resolveLensNames(undefined, [])).toEqual([])
  })

  it("uses the deduplicated exact caller selection instead of defaults", () => {
    expect(resolveLensNames(["beta", "alpha", "beta"], ["default"])).toEqual([
      "beta",
      "alpha",
    ])
  })
})
