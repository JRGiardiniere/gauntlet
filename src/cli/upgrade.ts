// Self-upgrade: replace this executable with the latest release binary and
// nothing else. Settings, recipes, runs (~/.gauntlet) and project lenses
// (.gauntlet/lenses) survive by construction — the shipped lens catalog is
// embedded in the binary, so swapping the file swaps the catalog atomically,
// and a resumed run replays its frozen plan.json regardless (ADR 0004).
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Command from "effect/unstable/cli/Command"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { isCompiledBinary } from "../content/lens.ts"
import { writeArtifactAtomically } from "../run/artifact.ts"
import {
  isNewer,
  probeLatestVersion,
  releaseProbeHttp,
  repository,
} from "./update-check.ts"
import { gauntletVersion } from "./version.ts"

export class UpgradeError extends Data.TaggedError("UpgradeError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

const releaseAsset = () =>
  (process.platform === "darwin" || process.platform === "linux") &&
    (process.arch === "arm64" || process.arch === "x64")
    ? `gauntlet-${process.platform}-${process.arch}`
    : undefined

const executeUpgrade = Effect.fn("gauntlet.cli.execute_upgrade")(function* () {
  if (!isCompiledBinary) {
    return yield* new UpgradeError({
      reason:
        "this is a source checkout, not a release binary — git pull and re-bundle instead",
    })
  }
  const latest = yield* probeLatestVersion().pipe(
    Effect.mapError((cause) =>
      new UpgradeError({ reason: cause.reason, cause })),
    Effect.provide(releaseProbeHttp),
  )
  if (!isNewer(latest, gauntletVersion)) {
    yield* Console.log(`already up to date (v${gauntletVersion})`)
    return
  }
  const asset = releaseAsset()
  if (asset === undefined) {
    return yield* new UpgradeError({
      reason: `no release binary for ${process.platform}-${process.arch}`,
    })
  }
  // Pin the download to the probed tag rather than /latest/download: the two
  // resolve independently, and a release landing between the probe and the
  // download must not produce a binary that disagrees with the printed version.
  const url =
    `https://github.com/${repository}/releases/download/v${latest}/${asset}`
  yield* Console.error(`gauntlet: downloading ${url}`)
  const download = yield* Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      // Per-attempt bound covers reaching the redirected download host, not
      // the body transfer, which runs as long as bytes keep arriving.
      HttpClient.transformResponse((attempt) =>
        attempt.pipe(Effect.timeout("30 seconds"))),
      HttpClient.retryTransient({ times: 2 }),
    )
    const response = yield* client.get(url).pipe(
      Effect.mapError((cause) =>
        new UpgradeError({ reason: `download failed (${url})`, cause })),
    )
    if (response.status !== 200) {
      return yield* new UpgradeError({
        reason:
          `download failed with status ${String(response.status)} (${url})`,
      })
    }
    return yield* response.arrayBuffer.pipe(
      Effect.mapError((cause) =>
        new UpgradeError({
          reason: `download failed mid-body (${url})`,
          cause,
        })),
    )
  }).pipe(Effect.provide(FetchHttpClient.layer))
  // Sibling temp file + rename over the running executable: the process keeps
  // its inode, the path atomically becomes the new release.
  const targetPath = process.execPath
  yield* writeArtifactAtomically(targetPath, (fs, tempPath) =>
    fs.writeFile(tempPath, new Uint8Array(download)).pipe(
      Effect.andThen(fs.chmod(tempPath, 0o755)),
    )).pipe(
      Effect.mapError((cause) =>
        new UpgradeError({
          reason: `could not replace ${targetPath}`,
          cause,
        })),
    )
  yield* Console.log(`upgraded to v${latest} (was v${gauntletVersion})`)
})

export const upgradeCommand = Command.make(
  "upgrade",
  {},
  () => executeUpgrade(),
).pipe(
  Command.withDescription(
    "Replace this binary with the latest GitHub release. Settings, recipes, runs, and project lenses are never touched",
  ),
)
