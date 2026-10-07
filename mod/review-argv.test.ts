import { describe, expect, it } from "vitest"
import { reviewArgv, reviewToolArgs } from "./review-argv.ts"

describe("/gc-cli arguments as gauntlet review argv", () => {
  it("reviews the working tree, a pull request or a commit range, with related files", () => {
    expect(reviewArgv("")).toEqual(["review", "--related-files", "--working-tree"])
    expect(reviewArgv("641")).toEqual(["review", "--related-files", "--pr=641"])
    expect(reviewArgv("main --no-related-files")).toEqual(["review", "--commits=main"])
  })

  it("resumes the named run, not the latest, when the run id follows --resume", () => {
    expect(reviewArgv("--resume 2026-10-07T14-20-10-432Z-3406")).toEqual([
      "review",
      "--resume=2026-10-07T14-20-10-432Z-3406",
    ])
    expect(reviewArgv("--resume")).toEqual(["review", "--resume"])
  })

  it("gives a flag's value to the flag, written either way, and keeps the target", () => {
    expect(reviewArgv("main --lenses fixture-a,fixture-b --recipe fixture-recipe")).toEqual([
      "review",
      "--lenses=fixture-a,fixture-b",
      "fixture-recipe",
      "--related-files",
      "--commits=main",
    ])
    expect(reviewArgv("--recipe=fixture-recipe 641")).toEqual(["review", "fixture-recipe", "--related-files", "--pr=641"])
  })

  it("lets an explicit target flag name the target", () => {
    expect(reviewArgv("--pr 42")).toEqual(["review", "--pr=42", "--related-files"])
    expect(reviewArgv("--commits main --working-tree")).toEqual(["review", "--commits=main", "--working-tree", "--related-files"])
  })

  it("takes the review tool's args from its call, and nothing from a call without them", () => {
    expect(reviewToolArgs({ tool: "mcp__gc-cli__review", args: "--recipe fixture-recipe 145" })).toBe("--recipe fixture-recipe 145")
    expect(reviewToolArgs({ tool: "mcp__gc-cli__review" })).toBeUndefined()
  })
})
