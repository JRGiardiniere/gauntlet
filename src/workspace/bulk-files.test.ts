import { describe, expect, it } from "@effect/vitest"
import * as Array from "effect/Array"
import * as Schema from "effect/Schema"
import { inlinedDiff, isLockfile, LOCKFILE_NAMES } from "./bulk-files.ts"

const section = (file: string, body: string) =>
  `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${body}\n+${body}!`

describe("isLockfile", () => {
  it.each([
    ["bun.lock", true],
    ["packages/web/pnpm-lock.yaml", true],
    ["rust/Cargo.lock", true],
    ["go.sum", true],
    ["src/bun.lock.ts", false],
    ["docs/yarn.lock.md", false],
    ["lock.ts", false],
    ["package.json", false],
  ])("%s → %s", (file, expected) => {
    expect(isLockfile(file)).toBe(expected)
  })
})

describe("inlinedDiff", () => {
  it("leaves a lockfile's section out of the inlined diff and names it", () => {
    const diff = Array.join([section("src/app.ts", "a"), section("bun.lock", "lockfile body"), section("README.md", "b")], "\n")
    const inlined = inlinedDiff(diff)
    expect(inlined.diff).toBe(Array.join([section("src/app.ts", "a"), section("README.md", "b")], "\n"))
    expect(inlined.omitted).toEqual(["bun.lock"])
    expect(inlined.diff).not.toContain("lockfile body")
  })

  it("leaves a diff without lockfiles as it was", () => {
    const diff = `${section("src/app.ts", "a")}\n`
    expect(inlinedDiff(diff)).toEqual({ diff, omitted: [] })
  })

  const File = Schema.Struct({
    path: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9/_-]{0,20}\.[a-z]{1,4}$/)),
    lockfile: Schema.Literals([...LOCKFILE_NAMES]),
    isLock: Schema.Boolean,
  })
  it.prop(
    "keeps exactly the sections of files that are not lockfiles, in order",
    { files: Schema.Array(File).check(Schema.isMaxLength(6)) },
    ({ files }) => {
      const named = Array.map(files, ({ path, lockfile, isLock }) => (isLock ? `pkg/${lockfile}` : path))
      const sections = Array.map(named, (file, index) => section(file, `line ${String(index)}`))
      const inlined = inlinedDiff(Array.join(sections, "\n"))
      expect(inlined.diff).toBe(Array.join(Array.filter(sections, (_, index) => !isLockfile(named[index] ?? "")), "\n"))
      expect(inlined.omitted).toEqual(Array.filter(named, isLockfile))
    },
  )
})
