import { describe, expect, it } from "vitest"
import { commandWords, reviewToolArgs } from "./review-argv.ts"

// What each word becomes is the shared syntax's table (src/syntax/syntax.test.ts).
describe("/gauntlet arguments as the shared syntax's words", () => {
  it("implies review, and splits words as a shell does", () => {
    expect(commandWords("")).toEqual(["review"])
    expect(commandWords("12 --recipe high")).toEqual(["review", "12", "--recipe", "high"])
    expect(commandWords("review abc~1..abc")).toEqual(["review", "abc~1..abc"])
    expect(commandWords("deliver 2026-10-08T12-00-00-000Z-ab12")).toEqual(["deliver", "2026-10-08T12-00-00-000Z-ab12"])
    expect(commandWords('--repo="~/My Projects/x" 641')).toEqual(["review", "--repo=~/My Projects/x", "641"])
  })

  it("takes the review tool's args from its call, and nothing from a call without them", () => {
    expect(reviewToolArgs({ tool: "mcp__gauntlet__review", args: "--recipe fixture-recipe 145" })).toBe("--recipe fixture-recipe 145")
    expect(reviewToolArgs({ tool: "mcp__gauntlet__review" })).toBeUndefined()
  })
})
