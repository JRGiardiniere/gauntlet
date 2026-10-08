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
import { viewDossier } from "../render/dossier-view.ts"
import { renderDossierMarkdown } from "../render/dossier-markdown.ts"
import { executeJudgment } from "../stages/judgment/judgment.ts"
import { writeArtifactJson, writeArtifactText } from "./artifact.ts"
import { executePool, executeVerification } from "./bug-claim-path.ts"
import { measureLowFinderCacheHealth } from "./finder-cache-health.ts"
import { measureFinderToolHealth } from "./finder-tool-health.ts"
import { executeFinders } from "./finder-execution.ts"
import {
  cacheShare,
  counted,
  runProgress,
  coverageGapLine,
  wallSeconds,
} from "./progress-text.ts"
import { acquireReviewWorkingDirectory } from "./review-working-directory.ts"
import type { RunPaths } from "./run-record.ts"
import { reportMilestone, RunMilestone } from "./run-milestones.ts"

export interface ReviewExecution {
  readonly plan: ReviewPlan
  readonly paths: RunPaths
  readonly startedAt: DateTime.Utc
}

// Runs a submitted Run to its Dossier, answering the digest and the coverage
// gaps for the Host to show.
export const executeReviewPlan = Effect.fn(
  "gauntlet.run_executor.execute_review_plan",
)(function* ({ paths, plan, startedAt }: ReviewExecution) {
  yield* Console.error(`gauntlet: run ${plan.runId}`)
  yield* reportMilestone(RunMilestone.Started({
    runId: plan.runId,
    lenses: plan.lenses.map((lens) => lens.name),
  }))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fileLogger = yield* Logger.toFile(Logger.formatLogFmt, paths.runLog)
      const reviewWorkingDirectory = yield* acquireReviewWorkingDirectory(
        plan.target,
        plan.runId,
        paths.workspaceOverlay,
      )
      return yield* Effect.gen(function* () {
        yield* Effect.log(`run ${plan.runId} executing`)
        const findersStartedAt = yield* DateTime.now
        const finderStage = yield* executeFinders({
          plan,
          paths,
          reviewWorkingDirectory,
        })
        const results = finderStage.finders

        yield* runProgress(
          `Finders finished — ${String(yield* wallSeconds(findersStartedAt))}s`,
          cacheShare(results.map(({ outcome }) => outcome.usage)),
        )
        yield* reportMilestone(RunMilestone.FindersFinished())
        const routed = routeFinderResults(results)
        for (const gap of routed.coverageGaps) {
          yield* runProgress(coverageGapLine(gap))
        }
        yield* runProgress(
          `${counted(routed.bugClaims.length, "BugClaim")} → Verification · ${counted(routed.observations.length, "Observation")} → Judgment`,
        )
        yield* reportMilestone(RunMilestone.Routed({
          bugClaims: routed.bugClaims.length,
          observations: routed.observations.length,
        }))
        // Judgment waits for Pool's clusters, so it can drop an Observation
        // that restates one, then runs beside Verification; neither sees the
        // other's decisions until Assembly joins them.
        const pooled = yield* executePool({
          plan,
          reviewWorkingDirectory,
          bugClaims: routed.bugClaims,
        })
        const [bugClaimPath, judgmentPath] = yield* Effect.all(
          [
            executeVerification({ plan, reviewWorkingDirectory, pooled }),
            executeJudgment({
              plan,
              reviewWorkingDirectory,
              observations: routed.observations,
              pooled,
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
        yield* runProgress("assembling dossier")
        yield* writeArtifactJson(paths.dossier, Dossier, dossier)

        const endedAt = yield* DateTime.now
        const wallTime = DateTime.distance(startedAt, endedAt)
        const accounting = {
          costUsd: results.reduce(
            (total, result) => total + result.outcome.usage.costUsd,
            0,
          ) + bugClaimPath.costUsd + judgmentPath.costUsd,
          invocationCount:
            results.length +
            bugClaimPath.invocationCount +
            judgmentPath.invocationCount,
          wallTimeSeconds: Math.round(Duration.toSeconds(wallTime)),
          finderCacheHealth: measureLowFinderCacheHealth(plan, results),
          finderToolHealth: measureFinderToolHealth(results),
        }
        const dossierMarkdown = renderDossierMarkdown(plan, dossier, accounting)
        yield* writeArtifactText(paths.dossierMarkdown, dossierMarkdown)
        yield* Effect.log("dossier rendered", { path: paths.dossierMarkdown })

        const view = viewDossier(dossier)
        yield* reportMilestone(RunMilestone.Reviewed({
          entries: [...view.findings, ...view.unresolved].map(
            ({ reviewPriority, tag }) => ({ tag, reviewPriority }),
          ),
          coverageGaps: dossier.coverageGaps,
          dossierMarkdown: paths.dossierMarkdown,
        }))
        return {
          digest: renderDigest(plan, dossier, accounting, paths),
          coverageGaps: dossier.coverageGaps,
        }
      }).pipe(Effect.provide(Logger.layer([fileLogger])))
    }),
  )
})
