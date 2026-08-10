import * as Config from "effect/Config"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Random from "effect/Random"

export interface RunPaths {
  readonly root: string
  readonly plan: string
  readonly journalDirectory: string
  readonly dossier: string
  readonly report: string
  readonly receipt: string
  readonly runLog: string
}

// The run directory is the entire history: cat-able files of Gauntlet's own
// schemas, no aggregate store, no retention machinery (ADR 0006).
export const runPaths = (runsRoot: string, runId: string, path: Path.Path): RunPaths => {
  const root = path.join(runsRoot, runId)
  return {
    root,
    plan: path.join(root, "plan.json"),
    journalDirectory: path.join(root, "journal"),
    dossier: path.join(root, "dossier.json"),
    report: path.join(root, "report.md"),
    receipt: path.join(root, "receipt.json"),
    runLog: path.join(root, "run.log"),
  }
}

// Runs land under <home>/.gauntlet/runs until the runs-root setting exists
// (#24). Read via Config so tests point HOME at a temp directory instead of
// mutating the environment.
export const resolveRunsRoot = Effect.fn("gauntlet.run_record.resolve_runs_root")(
  function* () {
    const path = yield* Path.Path
    const home = yield* Config.string("HOME")
    return path.join(home, ".gauntlet", "runs")
  },
)

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
    yield* fs.makeDirectory(paths.journalDirectory, { recursive: true })
    return paths
  },
)
