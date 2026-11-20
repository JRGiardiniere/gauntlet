import * as Array from "effect/Array"
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
import { executePool } from "../stages/pool/pool.ts"
import { executeVerification } from "../stages/verification/verification.ts"
import { writeArtifactJson, writeArtifactText } from "./artifact.ts"
import { measureLowFinderCacheHealth } from "./finder-cache-health.ts"
import { measureFinderToolHealth } from "./finder-tool-health.ts"
import { executeFinders } from "./finder-execution.ts"
import { exposeInstalledDependencies } from "./installed-dependencies.ts"
import {
  cacheShare,
  counted,
  runProgress,
  coverageGapLine,
  wallSeconds,
} from "./progress-text.ts"
import { acquireReviewWorkingDirectory } from "./review-working-directory.ts"
import type { RunPaths } from "./run-record.ts"
import { sumTokens } from "./run-accounting.ts"

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

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fileLogger = yield* Logger.toFile(Logger.formatLogFmt, paths.runLog)

      const reviewWorkingDirectory = yield* acquireReviewWorkingDirectory(
        plan.target,
        plan.runId,
        paths.workspaceOverlay,
      )

      const installedDependencies = yield* exposeInstalledDependencies(plan.target, plan.runId, reviewWorkingDirectory)

      for (const warning of installedDependencies.lockfileWarnings) {
        yield* Console.error(`gauntlet: warning — ${warning}`)
      }

      return yield* Effect.gen(function* () {
        yield* Effect.log(`run ${plan.runId} executing`)
        const findersStartedAt = yield* DateTime.now

        const finderStage = yield* executeFinders({
          plan,
          paths,
          reviewWorkingDirectory,
        })

        const results = finderStage.finders

        const findersSeconds = yield* wallSeconds(findersStartedAt)
        yield* runProgress(
          `Finders finished — ${String(findersSeconds)}s`,
          cacheShare(Array.map(results, ({ outcome }) => outcome.usage)),
        )
        const routed = routeFinderResults(results)

        for (const gap of routed.coverageGaps) {
          yield* runProgress(coverageGapLine(gap))
        }

        yield* runProgress(
          `${counted(routed.bugClaims.length, "BugClaim")} → Verification · ${counted(routed.observations.length, "Observation")} → Judgment`,
        )

        // Judgment waits for Pool's clusters, so it can drop an Observation
        // that restates one, then runs beside Verification; neither sees the
        // other's decisions until Assembly joins them.
        const pooled = yield* executePool({
          plan,
          reviewWorkingDirectory,
          bugClaims: routed.bugClaims,
        })

        const [verification, judgment] = yield* Effect.all(
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
          bugClaimPath: {
            ...verification,
            coverageGaps: [...pooled.coverageGaps, ...verification.coverageGaps],
          },
          judgmentPath: judgment,
        })

        yield* runProgress("assembling dossier")
        yield* writeArtifactJson(paths.dossier, Dossier, dossier)

        const endedAt = yield* DateTime.now
        const wallTime = DateTime.distance(startedAt, endedAt)

        const accounting = {
          stageTokens: {
            finders: sumTokens(Array.map(results, (result) => result.outcome.usage)),
            pool: sumTokens(pooled.usages),
            verification: sumTokens(verification.usages),
            judgment: sumTokens(judgment.usages),
          },
          invocationCount:
            results.length +
            pooled.invocationCount +
            verification.invocationCount +
            judgment.invocationCount,
          wallTimeSeconds: Math.round(Duration.toSeconds(wallTime)),
          finderCacheHealth: measureLowFinderCacheHealth(plan, results),
          finderToolHealth: measureFinderToolHealth(results),
          installedDependencies,
        }

        const dossierMarkdown = renderDossierMarkdown(plan, dossier, accounting)
        yield* writeArtifactText(paths.dossierMarkdown, dossierMarkdown)
        yield* Effect.log("dossier rendered", { path: paths.dossierMarkdown })

        return {
          digest: renderDigest(plan, dossier, accounting, paths.dossierMarkdown),
          coverageGaps: dossier.coverageGaps,
        }
      }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([fileLogger])))
    }),
  )
})
