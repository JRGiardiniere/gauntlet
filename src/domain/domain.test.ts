import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Candidate } from "./candidate.ts"
import { modelIdentityOfSeat, Seat } from "./recipe.ts"
import { ReviewTarget } from "./review-target.ts"

describe("domain model", () => {
  it.effect("a candidate self-classifies by failure-scenario presence", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(Candidate)
      const core = {
        id: "fixture-lens/1",
        lens: "fixture-lens",
        file: "src/alpha.ts",
        line: 12,
        summary: "off-by-one in the pager",
      }

      const bugClaim = yield* decode({
        _tag: "BugClaim",
        ...core,
        failureScenario: "page size 0 loops forever",
      })
      expect(Candidate.guards.BugClaim(bugClaim)).toBe(true)

      const observation = yield* decode({ _tag: "Observation", ...core })
      expect(Candidate.guards.Observation(observation)).toBe(true)

      // Lines are 1-indexed (docs/spec/emit-tools.md); 0 is a finder bug.
      const rejected = yield* Effect.flip(
        decode({ _tag: "Observation", ...core, line: 0 }),
      )
      expect(rejected._tag).toBe("SchemaError")
    }))

  it.effect("a seat follows the provider/model:effort grammar", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(Seat)
      // Model ids may contain colons; only the trailing segment is effort.
      expect(yield* decode("acme/luna-4:high")).toBe("acme/luna-4:high")
      expect(yield* decode("acme/luna:4-6:high")).toBe("acme/luna:4-6:high")
      const rejected = yield* Effect.flip(decode("just-a-model"))
      expect(rejected._tag).toBe("SchemaError")
    }))

  it("identifies a model independently of its thinking effort", () => {
    expect(modelIdentityOfSeat("acme/luna-4:low")).toBe("acme/luna-4")
    expect(modelIdentityOfSeat("acme/luna:4-6:high")).toBe("acme/luna:4-6")
  })

  it.effect("decodes a working-tree target frozen before untrackedFile digests", () =>
    Effect.gen(function* () {
      const target = yield* Schema.decodeEffect(ReviewTarget)({
        _tag: "WorkingTree",
        repoRoot: "/fixture",
        headCommit: "abcdef0",
        changedFiles: ["src/fixture.ts"],
        diff: "+change",
        warnings: [],
      })
      expect(ReviewTarget.guards.WorkingTree(target)).toBe(true)
      if (!ReviewTarget.guards.WorkingTree(target)) return
      expect(target.untrackedFiles).toEqual([])
    }))
})
