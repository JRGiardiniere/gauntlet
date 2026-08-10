import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { AgentOutcome, Termination } from "./agent-outcome.ts"
import { Candidate } from "./candidate.ts"
import { DeliveryReceipt } from "./delivery-receipt.ts"
import { Judgment } from "./judgment.ts"
import { Seat } from "./recipe.ts"
import { Verdict } from "./verdict.ts"

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

  it.effect("every expected bad ending is a Termination mode, as data", () =>
    Effect.gen(function* () {
      const outcome = yield* Schema.decodeEffect(AgentOutcome)({
        termination: { _tag: "BudgetExhausted" },
        output: { findings: [] },
        usage: { inputTokens: 12000, costUsd: 0.31 },
        diagnostics: ["budget hit during second corrective turn"],
      })
      // Output, usage, and a bad ending coexist (ADR 0001).
      expect(Termination.guards.BudgetExhausted(outcome.termination)).toBe(true)
      expect(outcome.output).toEqual({ findings: [] })
      expect(outcome.diagnostics).toHaveLength(1)
    }))

  it.effect("unverified and undecided are first-class, with optional detail", () =>
    Effect.gen(function* () {
      const verdict = yield* Schema.decodeEffect(Verdict)({ _tag: "Unverified" })
      expect(Verdict.guards.Unverified(verdict)).toBe(true)

      const judgment = yield* Schema.decodeEffect(Judgment)({ _tag: "Undecided" })
      expect(Judgment.guards.Undecided(judgment)).toBe(true)
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

  it.effect("a delivery receipt records posted or not-posted, never both", () =>
    Effect.gen(function* () {
      const posted = yield* Schema.decodeEffect(DeliveryReceipt)({
        _tag: "Posted",
        runId: "run-1",
        url: "https://example.invalid/pr/1#comment",
        truncated: false,
      })
      expect(DeliveryReceipt.guards.Posted(posted)).toBe(true)

      const notPosted = yield* Schema.decodeEffect(DeliveryReceipt)({
        _tag: "NotPosted",
        runId: "run-1",
        reason: "PR comment API returned 502",
      })
      expect(DeliveryReceipt.guards.NotPosted(notPosted)).toBe(true)
    }))
})
