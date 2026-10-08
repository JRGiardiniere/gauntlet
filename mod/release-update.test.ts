import { describe, expect, it } from "vitest"
import { releaseNotice } from "./release-update.ts"

const remote = ["abc\trefs/tags/v1.4.0", "def\trefs/tags/v1.10.0", "123\trefs/tags/v1.5.0"].join("\n")

describe("the mod's update notice", () => {
  it("names the newest release when the checkout sits on an older one", () => {
    expect(releaseNotice("v1.5.0\n", remote)).toMatch(/^Gauntlet v1\.10\.0 is available \(this is v1\.5\.0\)/)
  })

  it("stays quiet on the newest release and on a checkout off any release tag", () => {
    expect(releaseNotice("v1.10.0", remote)).toBeUndefined()
    expect(releaseNotice("", remote)).toBeUndefined()
  })
})
