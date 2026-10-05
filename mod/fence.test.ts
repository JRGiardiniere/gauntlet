import { describe, expect, it } from "vitest"
import { fencedPathOf, isInsideRoot } from "./fence.ts"

const root = "/private/var/folders/x/gauntlet-review.abc/worktree"

describe("isInsideRoot", () => {
  it("admits the root and paths beneath it", () => {
    expect(isInsideRoot(root, root)).toBe(true)
    expect(isInsideRoot(`${root}/src/a.ts`, root)).toBe(true)
    expect(isInsideRoot(`${root}/src/a.ts`, `${root}/`)).toBe(true)
  })

  it("refuses siblings that share the root as a prefix", () => {
    expect(isInsideRoot(`${root}-other/a.ts`, root)).toBe(false)
  })

  it("refuses unresolved paths and relative roots", () => {
    expect(isInsideRoot(undefined, root)).toBe(false)
    expect(isInsideRoot("/etc/passwd", root)).toBe(false)
    expect(isInsideRoot(`${root}/a.ts`, "worktree")).toBe(false)
  })
})

describe("fencedPathOf", () => {
  it("reads Read's file_path and Grep/Glob's path, absolute against the root", () => {
    expect(fencedPathOf("Read", { file_path: "src/a.ts" }, root)).toBe(`${root}/src/a.ts`)
    const grep = { pattern: "x", path: "/etc" }
    const glob = { pattern: "*.ts", path: undefined }
    expect(fencedPathOf("Grep", grep, root)).toBe("/etc")
    expect(fencedPathOf("Glob", glob, root)).toBe(root)
  })

  it("names no path for a Read without one", () => {
    expect(fencedPathOf("Read", {}, root)).toBeUndefined()
  })
})
