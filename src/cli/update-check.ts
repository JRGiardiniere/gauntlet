// Release discovery for the compiled binary. The probe reads the version out
// of GitHub's `releases/latest` 302 redirect Location instead of the REST
// API: the redirect is not subject to the API's per-IP 60/hour unauthenticated
// quota, which a shared NAT can silently exhaust. The daily notice rides a
// forked fiber for the whole command and is claimed briefly at exit, so a
// slow or offline network never delays a review.
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpClient from "effect/unstable/http/HttpClient"
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

// The probe must see the 302 itself; a redirect-following client would land
// on the release page HTML and lose the tag.
export const releaseProbeHttp = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }),
  ),
)

const releaseTagPattern = /\/releases\/tag\/v(\d+\.\d+\.\d+)$/

export const probeLatestVersion = Effect.fn("gauntlet.update.probe_latest")(
  function* () {
    const response = yield* HttpClient.head(latestReleaseUrl).pipe(
      Effect.mapError((cause) =>
        new UpdateProbeError({ reason: "release lookup failed", cause })),
    )
    const location = Headers.get(response.headers, "location")
    if (Option.isNone(location)) {
      return yield* new UpdateProbeError({
        reason: `${latestReleaseUrl} did not redirect — the repository may have no releases`,
      })
    }
    const version = releaseTagPattern.exec(location.value)?.[1]
    if (version === undefined) {
      return yield* new UpdateProbeError({
        reason: `unrecognized release redirect: ${location.value}`,
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
  latest: Schema.String,
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
      return Option.some(cached.value.latest)
    }
    const probed = yield* probeLatestVersion().pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.orElseSucceed(() => Option.none<string>()),
      Effect.provide(releaseProbeHttp),
    )
    // A failed probe is not persisted: the next invocation simply probes
    // again, which costs nothing on the forked fiber.
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
