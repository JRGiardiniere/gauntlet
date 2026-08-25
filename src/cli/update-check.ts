// Release discovery for the compiled binary. The probe reads the version out
// of GitHub's `releases/latest` 302 redirect Location instead of the REST
// API: the redirect is not subject to the API's per-IP 60/hour unauthenticated
// quota, which a shared NAT can silently exhaust. The daily notice rides a
// forked fiber for the whole command and is claimed briefly at exit, so a
// slow or offline network never fails a command and delays one by at most
// the one-second claim.
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { gauntletHome } from "../config/settings.ts"
import { isCompiledBinary } from "../content/lens.ts"
import { readOptionalArtifactText, writeArtifactJson } from "../run/artifact.ts"
import { gauntletVersion } from "./version.ts"

export const repository = "JRGiardiniere/gauntlet"
const latestReleaseUrl = `https://github.com/${repository}/releases/latest`

export class UpdateProbeError extends Data.TaggedError("UpdateProbeError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

const releaseTagPattern = /\/releases\/tag\/v(\d+\.\d+\.\d+)$/

const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 429 || status === 500 || status === 502 ||
  status === 503 || status === 504

export const probeLatestVersion = Effect.fn("gauntlet.update.probe_latest")(
  function* () {
    const fetch = yield* FetchHttpClient.Fetch
    // Own redirect behavior at the request boundary. An ambient HttpClient can
    // be replaced by an outer application Layer, which made the 1.0 updater
    // follow this redirect and lose the release tag.
    const response = yield* Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(latestReleaseUrl, {
            method: "HEAD",
            redirect: "manual",
            signal,
          }),
        catch: (cause) =>
          new UpdateProbeError({ reason: "release lookup failed", cause }),
      })
      if (isTransientStatus(result.status)) {
        return yield* new UpdateProbeError({
          reason: `release lookup failed with status ${String(result.status)}`,
        })
      }
      return result
    }).pipe(
      Effect.timeoutOrElse({
        duration: "3 seconds",
        orElse: () =>
          Effect.fail(
            new UpdateProbeError({ reason: "release lookup timed out" }),
          ),
      }),
      Effect.retry({ times: 2 }),
    )
    const location = response.headers.get("location")
    if (location === null) {
      return yield* new UpdateProbeError({
        reason: `${latestReleaseUrl} did not redirect — the repository may have no releases`,
      })
    }
    const version = releaseTagPattern.exec(location)?.[1]
    if (version === undefined) {
      return yield* new UpdateProbeError({
        reason: `unrecognized release redirect: ${location}`,
      })
    }
    return version
  },
)

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/

const parseVersion = (raw: string) => {
  const match = versionPattern.exec(raw)
  return match === null
    ? Option.none<ReadonlyArray<number>>()
    : Option.some(match.slice(1).map(Number))
}

// False whenever either side is not a plain release version: the dev sentinel
// never nags, and a malformed tag never reads as an upgrade.
export const isNewer = (candidate: string, current: string): boolean => {
  const parsed = Option.all([parseVersion(candidate), parseVersion(current)])
  if (Option.isNone(parsed)) return false
  const [candidateParts, currentParts] = parsed.value
  for (let index = 0; index < candidateParts.length; index += 1) {
    const difference = (candidateParts[index] ?? 0) - (currentParts[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

// ~/.gauntlet/update-check.json: probe cache, not a setting. Unlike
// settings.json (house rule 22), a corrupt or unreadable cache degrades to
// "never checked" — the file is disposable enrichment state the next probe
// rewrites.
const UpdateCheckState = Schema.Struct({
  "checked-at": Schema.Finite,
  // Absent while a probe is in flight or after it failed: the attempt still
  // counts against the daily budget, so an offline day probes once instead
  // of on every command.
  latest: Schema.optionalKey(Schema.String),
})

const decodeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(UpdateCheckState),
)

const statePath = Effect.fn("gauntlet.update.state_path")(function* () {
  const path = yield* Path.Path
  return path.join(yield* gauntletHome(), "update-check.json")
})

const dayMillis = 24 * 60 * 60 * 1000

const latestKnownVersion = Effect.fn("gauntlet.update.latest_known")(
  function* () {
    const path = yield* statePath()
    const now = DateTime.toEpochMillis(yield* DateTime.now)
    const cached = yield* readOptionalArtifactText(path).pipe(
      Effect.flatMap(Option.match({
        onNone: () => Effect.succeed(Option.none<typeof UpdateCheckState.Type>()),
        onSome: (text) => decodeState(text).pipe(Effect.map(Option.some)),
      })),
      Effect.orElseSucceed(() =>
        Option.none<typeof UpdateCheckState.Type>()),
    )
    if (
      Option.isSome(cached) && now - cached.value["checked-at"] < dayMillis
    ) {
      const latest = cached.value.latest
      return latest === undefined
        ? Option.none<string>()
        : Option.some(latest)
    }
    // Reserve the attempt before probing: the notice fiber is joined for at
    // most a second at exit, so a marker written only after a slow probe
    // would be interrupted and the daily budget would never hold offline.
    // A fresh compiled-binary install may not have ~/.gauntlet yet; the
    // cache is enrichment, so a failed write just means the next invocation
    // probes again.
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(yield* gauntletHome(), { recursive: true }).pipe(
      Effect.ignore,
    )
    yield* writeArtifactJson(path, UpdateCheckState, {
      "checked-at": now,
    }).pipe(Effect.ignore)
    const probed = yield* probeLatestVersion().pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.orElseSucceed(() => Option.none<string>()),
    )
    if (Option.isSome(probed)) {
      yield* writeArtifactJson(path, UpdateCheckState, {
        "checked-at": now,
        latest: probed.value,
      }).pipe(Effect.ignore)
    }
    return probed
  },
)

// Never fails and never applies to a source checkout; the returned version is
// present only when it is strictly newer than this build.
export const availableUpdateNotice = Effect.fn("gauntlet.update.notice")(
  function* () {
    if (!isCompiledBinary) return Option.none<string>()
    const latest = yield* latestKnownVersion().pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    )
    return Option.filter(latest, (candidate) =>
      isNewer(candidate, gauntletVersion))
  },
)
