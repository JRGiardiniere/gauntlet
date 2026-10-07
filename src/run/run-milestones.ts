import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type { CoverageGap } from "../domain/dossier.ts"
import type { DossierEntryTag } from "../render/dossier-view.ts"
import type { ReviewPriority } from "../domain/verdict.ts"

// What a Run reports beside its progress lines, as data, for a host that
// draws the Run instead of printing it (the Claude Code mod's run view).
// The CLI prints its lines and ignores these.
export type RunMilestone = Data.TaggedEnum<{
  Started: { readonly runId: string; readonly lenses: ReadonlyArray<string> }
  FindersFinished: {}
  Routed: { readonly bugClaims: number; readonly observations: number }
  // The digest's surviving entries, the work missing from them, and where
  // the dossier is.
  Reviewed: {
    readonly entries: ReadonlyArray<{
      readonly tag: DossierEntryTag
      readonly reviewPriority?: ReviewPriority | undefined
    }>
    readonly coverageGaps: ReadonlyArray<CoverageGap>
    readonly dossierMarkdown: string
  }
  // The rendered reason a review could not run or could not be delivered.
  Refused: { readonly message: string }
}>
export const RunMilestone = Data.taggedEnum<RunMilestone>()

export const RunMilestones = Context.Reference<
  (milestone: RunMilestone) => Effect.Effect<void>
>("gauntlet/RunMilestones", {
  defaultValue: () => () => Effect.void,
})

export const reportMilestone = Effect.fn("Run.reportMilestone")(function* (
  milestone: RunMilestone,
) {
  yield* (yield* RunMilestones)(milestone)
})
