import { describe, expect, it } from "vitest"
import { betaNotice } from "./beta-update.ts"

const remote = ["abc\trefs/tags/gc-cli-beta.1", "def\trefs/tags/gc-cli-beta.3", "123\trefs/tags/gc-cli-beta.2"].join("\n")

describe("the beta's update notice", () => {
  it("names the newest beta tag when the checkout sits on an older one", () => {
    expect(betaNotice("gc-cli-beta.1\n", remote)).toMatch(/^gc-cli-beta\.3 is available \(this is gc-cli-beta\.1\)/)
  })

  it("stays quiet on the newest tag and on a checkout off any beta tag", () => {
    expect(betaNotice("gc-cli-beta.3", remote)).toBeUndefined()
    expect(betaNotice("", remote)).toBeUndefined()
  })
})
