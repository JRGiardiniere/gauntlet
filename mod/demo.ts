// `/gauntlet demo [scenario]`: a review played from a script, for seeing the
// Mod's surfaces on any Claude Code surface without agents, git or cost. It
// stands in for the Run module's review and delivery only: the milestones it
// reports, the strip that draws them, the digest's hand-off and the Stop
// button are the real ones. Its digest copies the CLI digest's layout
// (src/render/digest.ts) with made-up findings, and its dossier is a short
// note in a temporary directory.
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import type { CoverageGap } from "../src/domain/dossier.ts"
import type { ReviewPriority } from "../src/domain/verdict.ts"
import type { DossierEntryTag } from "../src/render/dossier-view.ts"
import { reportMilestone, RunMilestone, type SkippedLens } from "../src/run/run-milestones.ts"
import { type ReviewRequest, RunRefusal } from "../src/run/run.ts"
import { SubmissionTargetRequest } from "../src/run/submission.ts"
import type { Destination } from "../src/syntax/syntax.ts"
import type { AgentActivity } from "./activity.ts"

interface DemoEntry {
  readonly tag: DossierEntryTag
  readonly reviewPriority?: ReviewPriority
  readonly location: string
  readonly summary: string
}

interface Scenario {
  readonly skipped: ReadonlyArray<SkippedLens>
  // Each lens's Finder in open order, with its seconds and its candidates;
  // no candidates is a Finder that fails.
  readonly finders: ReadonlyArray<readonly [lens: string, seconds: number, candidates: number | undefined]>
  readonly routed: { readonly bugClaims: number; readonly observations: number }
  readonly bundles: number
  readonly entries: ReadonlyArray<DemoEntry>
  readonly coverageGaps: ReadonlyArray<CoverageGap>
  readonly destination: Destination
  // Why the review could not run, said once the strip is up.
  readonly refusal?: string
}

const FINDINGS: Scenario = {
  skipped: [],
  finders: [
    ["absence", 4, 1],
    ["cleanup", 3, 0],
    ["cross-file", 6, 2],
    ["diff-scan", 7, 1],
    ["removed-behavior", 5, 0],
    ["subjective", 8, 3],
  ],
  routed: { bugClaims: 4, observations: 3 },
  bundles: 2,
  entries: [
    { tag: "confirmed", reviewPriority: "P1", location: "src/cart/totals.ts:42", summary: "A coupon and a sale on one line item both discount it" },
    { tag: "confirmed", reviewPriority: "P2", location: "src/cart/totals.ts:88", summary: "Rounding happens per line, so the total drifts from the receipt by a cent" },
    { tag: "judgment", reviewPriority: "P3", location: "src/cart/view.tsx:17", summary: "The empty-cart message is built twice with different wording" },
    { tag: "plausible", location: "src/cart/sync.ts:120", summary: "A retry after a timeout may submit the cart twice" },
  ],
  coverageGaps: [],
  destination: "local",
}

const SCENARIOS = {
  findings: FINDINGS,
  clean: {
    ...FINDINGS,
    finders: FINDINGS.finders.map(([lens, seconds]) => [lens, seconds, 0]),
    routed: { bugClaims: 0, observations: 0 },
    bundles: 0,
    entries: [],
  },
  gaps: {
    ...FINDINGS,
    skipped: [{ lens: "standards", reason: "no Standards Manifest" }, { lens: "subjective", reason: "not selected" }],
    finders: FINDINGS.finders.filter(([lens]) => lens !== "subjective").map(([lens, seconds, candidates]) =>
      lens === "cross-file" ? [lens, seconds + 4, undefined] : [lens, seconds, candidates]
    ),
    routed: { bugClaims: 2, observations: 0 },
    bundles: 1,
    entries: FINDINGS.entries.slice(0, 1),
    coverageGaps: [{ stage: "finders", lens: "cross-file", reason: "the Finder's model call timed out" }],
  },
  pr: { ...FINDINGS, destination: "pr" },
  refused: { ...FINDINGS, refusal: "the working tree has no uncommitted changes to review" },
} satisfies Record<string, Scenario>

export const DEMO_SCENARIOS = Object.keys(SCENARIOS)

// The digest as src/render/digest.ts lays it out.
const digestOf = (scenario: Scenario, seconds: number, dossierMarkdown: string) => {
  const count = (tag: DossierEntryTag) => scenario.entries.filter((entry) => entry.tag === tag).length
  return [
    `${String(count("confirmed"))} confirmed · ${String(count("judgment"))} kept · ${String(count("plausible"))} plausible · ` +
    `${String(count("undecided"))} undecided — demo — recipe: demo — ${String(seconds)}s`,
    ...(scenario.coverageGaps.length === 0
      ? []
      : [`coverage gaps: ${String(scenario.coverageGaps.length)} — ${scenario.coverageGaps.map((gap) => `${gap.lens ?? gap.stage} (${gap.reason})`).join("; ")}`]),
    ...(scenario.skipped.length === 0 ? [] : [`Not run: ${scenario.skipped.map(({ lens, reason }) => `${lens} (${reason})`).join(", ")}`]),
    ...scenario.entries.map((entry) =>
      `- [${entry.reviewPriority === undefined ? entry.tag : `${entry.reviewPriority} ${entry.tag}`}] ${entry.location} — ${entry.summary}`
    ),
    "",
    `dossier.md: ${dossierMarkdown}`,
  ].join("\n")
}

const dossierOf = (scenario: Scenario) =>
  [
    "# Gauntlet demo dossier",
    "",
    "A scripted run from `/gauntlet demo`: nothing was reviewed, and these findings are made up.",
    "",
    ...scenario.entries.map((entry) => `- **${entry.reviewPriority ?? entry.tag}** \`${entry.location}\` — ${entry.summary}`),
    "",
  ].join("\n")

// The words after `demo` name a scenario; none is `findings`.
export const playDemo = Effect.fn("Demo.play")(
  function* (words: ReadonlyArray<string>, cwd: string) {
    const name = words[0] ?? "findings"
    const scenario: Scenario | undefined = Object.entries(SCENARIOS).find(([key]) => key === name)?.[1]
    if (scenario === undefined || words.length > 1) {
      return yield* new RunRefusal({ reason: `no demo ${words.join(" ")}; the scenarios are ${DEMO_SCENARIOS.join(", ")}` })
    }
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const runId = `demo-${String(yield* Clock.currentTimeMillis)}`
    const activity: Array<AgentActivity> = []
    // One agent, from its open to its answer, or a failure without one.
    const invoke = (id: string, seconds: number, items: number | undefined) =>
      Effect.gen(function* () {
        const record: AgentActivity = { id: `${runId}-${id}#1`, invocationId: `${runId}-${id}`, state: "opening" }
        activity.push(record)
        yield* Effect.sleep("400 millis")
        record.state = "running"
        yield* Effect.sleep(Duration.seconds(seconds))
        if (items === undefined) record.state = "failed"
        else {
          record.state = "answered"
          record.items = items
        }
      })
    const lenses = scenario.finders.map(([lens]) => lens)
    const review: ReviewRequest = {
      target: SubmissionTargetRequest.WorkingTree({ base: undefined }),
      recipeName: Option.some("demo"),
      selectedLensNames: lenses,
      directory: cwd,
      specPath: undefined,
    }
    const reviewed = Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const directory = yield* fs.makeTempDirectory({ prefix: "gauntlet-demo-" })
      yield* reportMilestone(RunMilestone.Started({ runId, directory, lenses, skipped: scenario.skipped }))
      yield* Effect.sleep("1500 millis")
      if (scenario.refusal !== undefined) return yield* new RunRefusal({ reason: scenario.refusal })
      // The first Finder alone, then the rest, as the cache warm-up runs them.
      const [first, ...rest] = scenario.finders
      const finder = ([lens, seconds, candidates]: Scenario["finders"][number]) => invoke(`finders-1-finder-${lens}`, seconds, candidates)
      if (first !== undefined) yield* finder(first)
      yield* Effect.forEach(rest, (each, at) => Effect.delay(finder(each), Duration.millis(at * 150)), { concurrency: "unbounded" })
      yield* reportMilestone(RunMilestone.FindersFinished())
      yield* reportMilestone(RunMilestone.Routed(scenario.routed))
      if (scenario.routed.bugClaims > 1) yield* invoke("pool", 3, scenario.bundles)
      yield* Effect.all([
        ...Array.from({ length: scenario.bundles }, (_, at) => invoke(`verification-${String(at + 1)}`, 4 + at * 2, 2)),
        ...(scenario.routed.observations === 0 ? [] : [invoke("judgment", 5, scenario.routed.observations)]),
      ], { concurrency: "unbounded" })
      yield* Effect.sleep("1 second")
      const dossierMarkdown = path.join(directory, "dossier.md")
      yield* fs.writeFileString(dossierMarkdown, dossierOf(scenario))
      yield* reportMilestone(RunMilestone.Reviewed({ entries: scenario.entries, coverageGaps: scenario.coverageGaps, dossierMarkdown }))
      const seconds = Math.round(((yield* Clock.currentTimeMillis) - startedAt) / 1000)
      return { runId, digest: digestOf(scenario, seconds, dossierMarkdown) }
    }).pipe(
      Effect.catchTag("PlatformError", (failure) => new RunRefusal({ reason: `the demo could not write its dossier: ${failure.message}` })),
    )
    const deliver = () =>
      Effect.sleep("3 seconds").pipe(Effect.as({ url: "https://github.com/example/demo/pull/7#issuecomment-1" }))
    return {
      review,
      destination: scenario.destination,
      run: { review: reviewed, deliver, activity: () => activity.map((each) => ({ ...each })) },
    }
  },
)
