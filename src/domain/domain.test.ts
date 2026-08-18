import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Candidate } from "./candidate.ts"
import { Dossier } from "./dossier.ts"
import { Seat } from "./recipe.ts"

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

  it.effect("decodes the current Dossier hierarchy", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferTypedSchemaDecoder:off
      const dossier = yield* Schema.decodeUnknownEffect(Dossier)({
        runId: "run-fixture",
        target: {
          _tag: "WorkingTree",
          repoRoot: "/fixture",
          headCommit: "abcdef0",
        },
        findings: [],
        unresolved: [],
        rejected: { refutedClaims: [], droppedObservations: [] },
        coverageGaps: [],
      })
      expect(dossier.findings).toEqual([])
    }))

  it.effect("rejects a pre-hierarchy Dossier without compatibility defaults", () =>
    Effect.gen(function* () {
      const rejected = yield* Effect.flip(
        Schema.decodeUnknownEffect(Dossier)({
          runId: "run-fixture",
          target: {
            _tag: "WorkingTree",
            repoRoot: "/fixture",
            headCommit: "abcdef0",
          },
          bugClaims: [
            {
              candidate: {
                _tag: "BugClaim",
                id: "fixture-lens/1",
                lens: "fixture-lens",
                file: "src/alpha.ts",
                summary: "off-by-one in the pager",
                failureScenario: "page size 0 loops forever",
              },
              cluster: 1,
              verdict: {
                _tag: "Confirmed",
                severity: "P1",
                evidence: "reproduced on empty input",
              },
            },
          ],
          observations: [],
          coverageGaps: [],
        }),
      )
      expect(rejected._tag).toBe("SchemaError")
    }))

})
