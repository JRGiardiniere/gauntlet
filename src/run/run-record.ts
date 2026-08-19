import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"
import { ReviewPlan } from "../domain/review-plan.ts"
import { readOptionalArtifactText } from "./artifact.ts"

export interface RunPaths {
  readonly root: string
  readonly plan: string
  readonly workspaceOverlay: string
  readonly finderStage: string
  readonly dossier: string
  readonly dossierMarkdown: string
  readonly receipt: string
  readonly runLog: string
}

export interface LoadedRun {
  readonly paths: RunPaths
  readonly plan: ReviewPlan
}

// Resume additionally needs to know whether the final artifacts already exist:
// a complete run reports or delivers them without re-entering the pipeline.
export interface ResumableRun extends LoadedRun {
  readonly complete: boolean
}

export class RunError extends Data.TaggedError("RunError")<{
  readonly operation: "find-latest" | "load-plan" | "execute-plan"
  readonly reason: string
  readonly runId?: string
  readonly cause?: unknown
}> {}

const RunIdPathSegment = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]*$/),
)

// The run directory is the entire history: cat-able files of Gauntlet's own
// schemas, no aggregate store, no retention machinery (ADR 0006).
export const runPaths = (runsRoot: string, runId: string, path: Path.Path): RunPaths => {
  const root = path.join(runsRoot, runId)
  return {
    root,
    plan: path.join(root, "plan.json"),
    workspaceOverlay: path.join(root, "workspace-overlay.patch"),
    finderStage: path.join(root, "finder-stage.json"),
    dossier: path.join(root, "dossier.json"),
    dossierMarkdown: path.join(root, "dossier.md"),
    receipt: path.join(root, "receipt.json"),
    runLog: path.join(root, "run.log"),
  }
}

export const makeRunId = Effect.fn("gauntlet.run_record.make_run_id")(
  function* () {
    const startedAt = yield* DateTime.now
    const suffix = yield* Random.nextIntBetween(0, 0xffff)
    const stamp = DateTime.formatIso(startedAt).replace(/[:.]/g, "-")
    return `${stamp}-${suffix.toString(16).padStart(4, "0")}`
  },
)

export const createRunDirectory = Effect.fn("gauntlet.run_record.create_run_directory")(
  function* (runsRoot: string, runId: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const paths = runPaths(runsRoot, runId, path)
    yield* fs.makeDirectory(runsRoot, { recursive: true })
    // The run directory itself is created non-recursively: a colliding run ID
    // fails loudly here instead of two runs silently sharing artifacts.
    yield* fs.makeDirectory(paths.root)
    return paths
  },
)

const decodePlanOption = Schema.decodeOption(
  Schema.fromJsonString(ReviewPlan),
)
const loadPlanOption = Effect.fn("gauntlet.run_record.load_plan_option")(
  function* (paths: RunPaths, expectedRunId: string) {
    const source = yield* readOptionalArtifactText(paths.plan)
    return Option.flatMap(source, (text) =>
      decodePlanOption(text).pipe(
        Option.filter((plan) => plan.runId === expectedRunId),
      ))
  },
)

const runIsComplete = Effect.fn("gauntlet.run_record.is_complete")(
  function* (paths: RunPaths) {
    const markdownSource = yield* readOptionalArtifactText(paths.dossierMarkdown)
    return Option.exists(markdownSource, (markdown) => markdown.length > 0)
  },
)

const runError = (
  operation: RunError["operation"],
  reason: string,
  runId: string | undefined,
  cause?: unknown,
) => {
  const core = runId === undefined
    ? { operation, reason }
    : { operation, reason, runId }
  return new RunError(cause === undefined ? core : { ...core, cause })
}

export const loadRun = Effect.fn("gauntlet.run_record.load_run")(
  function* (runsRoot: string, requestedRunId: string) {
    const runId = yield* Schema.decodeEffect(RunIdPathSegment)(
      requestedRunId,
    ).pipe(
      Effect.mapError((cause) =>
        runError(
          "load-plan",
          `invalid run id: ${requestedRunId}`,
          requestedRunId,
          cause,
        )),
    )
    const path = yield* Path.Path
    const paths = runPaths(runsRoot, runId, path)
    const fs = yield* FileSystem.FileSystem
    const source = yield* fs.readFileString(paths.plan).pipe(
      Effect.mapError((cause) =>
        runError(
          "load-plan",
          `could not read frozen plan for run ${runId}`,
          runId,
          cause,
        )),
    )
    const plan = yield* Schema.decodeEffect(
      Schema.fromJsonString(ReviewPlan),
    )(source).pipe(
      Effect.mapError((cause) =>
        runError(
          "load-plan",
          `frozen plan for run ${runId} is corrupt`,
          runId,
          cause,
        )),
    )
    if (plan.runId !== runId) {
      return yield* runError(
        "load-plan",
        `frozen plan belongs to run ${plan.runId}, not ${runId}`,
        runId,
      )
    }
    const complete = yield* runIsComplete(paths).pipe(
      Effect.mapError((cause) =>
        runError(
          "load-plan",
          `could not inspect completion artifacts for run ${runId}`,
          runId,
          cause,
        )),
    )
    return { paths, plan, complete } satisfies ResumableRun
  },
)

const loadLatestIncompleteRun = Effect.fn(
  "gauntlet.run_record.load_latest_incomplete_run",
)(function* (runsRoot: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* fs.readDirectory(runsRoot).pipe(
    Effect.catchTag("PlatformError", (failure) =>
      Predicate.isTagged("NotFound")(failure.reason)
        ? Effect.succeed([])
        : Effect.fail(
          runError(
            "find-latest",
            `could not inspect runs root ${runsRoot}`,
            undefined,
            failure,
          ),
        )),
  )

  // makeRunId starts with a descending-sortable UTC timestamp. Invalid names
  // cannot be generated by Gauntlet and are ignored as unrelated entries.
  const candidates = entries
    .filter((entry) => Schema.is(RunIdPathSegment)(entry))
    .sort((left, right) => right.localeCompare(left))

  for (const runId of candidates) {
    const paths = runPaths(runsRoot, runId, path)
    const plan = yield* loadPlanOption(paths, runId).pipe(
      Effect.mapError((cause) =>
        runError(
          "find-latest",
          `could not inspect frozen plan for run ${runId}`,
          runId,
          cause,
        )),
    )
    if (Option.isNone(plan)) continue
    const complete = yield* runIsComplete(paths).pipe(
      Effect.mapError((cause) =>
        runError(
          "find-latest",
          `could not inspect completion artifacts for run ${runId}`,
          runId,
          cause,
        )),
    )
    if (!complete) {
      return { paths, plan: plan.value, complete } satisfies ResumableRun
    }
  }

  return yield* runError(
    "find-latest",
    "no incomplete run with a valid frozen plan was found",
    undefined,
  )
})

export const loadRunToResume = Effect.fn(
  "gauntlet.run_record.load_run_to_resume",
)(function* (runsRoot: string, requestedRunId: Option.Option<string>) {
  return yield* Option.match(requestedRunId, {
    onNone: () => loadLatestIncompleteRun(runsRoot),
    onSome: (runId) => loadRun(runsRoot, runId),
  })
})
