import * as Console from "effect/Console"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import { assembleDossier } from "../assembly/dossier.ts"
import { routeFinderResults } from "../assembly/finders.ts"
import { Dossier } from "../domain/dossier.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { renderDigest } from "../render/digest.ts"
import { renderDossierMarkdown } from "../render/dossier-markdown.ts"
import { executeJudgment } from "../stages/judgment/judgment.ts"
import { writeArtifactJson, writeArtifactText } from "./artifact.ts"
import { executeBugClaimPath } from "./bug-claim-path.ts"
import { executeFinders } from "./finder-execution.ts"
import { counted, coverageGapLine, wallSeconds } from "./progress-text.ts"
import { acquireReviewWorkingDirectory } from "./review-working-directory.ts"
import type { RunPaths } from "./run-record.ts"

const progress = Effect.fn("gauntlet.run_executor.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

export interface ReviewExecution {
  readonly plan: ReviewPlan
  readonly paths: RunPaths
  readonly startedAt: DateTime.Utc
}

export const executeReviewPlan = Effect.fn(
  "gauntlet.run_executor.execute_review_plan",
)(function* ({ paths, plan, startedAt }: ReviewExecution) {
  yield* progress(`run ${plan.runId}`)
  yield* Effect.scoped(
    Effect.gen(function* () {
      const fileLogger = yield* Logger.toFile(Logger.formatLogFmt, paths.runLog)
      const reviewWorkingDirectory = yield* acquireReviewWorkingDirectory(
        plan.target,
        plan.runId,
      )
      yield* Effect.gen(function* () {
        yield* Effect.log(`run ${plan.runId} executing`)
        const findersStartedAt = yield* DateTime.now
        const finderStage = yield* executeFinders({
          plan,
          paths,
          reviewWorkingDirectory,
        })
        const results = finderStage.finders

        yield* progress(
          `Finders finished — ${String(yield* wallSeconds(findersStartedAt))}s`,
        )
        const routed = routeFinderResults(results)
        for (const gap of routed.coverageGaps) {
          yield* progress(coverageGapLine(gap))
        }
        yield* progress(
          `${counted(routed.bugClaims.length, "BugClaim")} → Verification · ${counted(routed.observations.length, "Observation")} → Judgment`,
        )
        // The two evaluation paths share no state until Assembly joins them.
        const [bugClaimPath, judgmentPath] = yield* Effect.all(
          [
            executeBugClaimPath({
              plan,
              reviewWorkingDirectory,
              bugClaims: routed.bugClaims,
            }),
            executeJudgment({
              plan,
              reviewWorkingDirectory,
              observations: routed.observations,
            }),
          ],
          { concurrency: 2 },
        )
        const dossier = assembleDossier({
          plan,
          finderCoverageGaps: routed.coverageGaps,
          bugClaimPath,
          judgmentPath,
        })
        yield* progress("assembling dossier")
        yield* writeArtifactJson(paths.dossier, Dossier, dossier)

        const endedAt = yield* DateTime.now
        const wallTime = DateTime.distance(startedAt, endedAt)
        const accounting = {
          costUsd: results.reduce(
            (total, result) => total + result.outcome.usage.costUsd,
            0,
          ) + bugClaimPath.costUsd + judgmentPath.costUsd,
          invocationCount:
            plan.lenses.length +
            bugClaimPath.invocationCount +
            judgmentPath.invocationCount,
          wallTimeSeconds: Math.round(Duration.toSeconds(wallTime)),
        }
        const dossierMarkdown = renderDossierMarkdown(plan, dossier, accounting)
        yield* writeArtifactText(paths.dossierMarkdown, dossierMarkdown)
        yield* Effect.log("dossier rendered", { path: paths.dossierMarkdown })

        yield* Console.log(renderDigest(plan, dossier, accounting, paths))
      }).pipe(Effect.provide(Logger.layer([fileLogger])))
    }),
  )
})
