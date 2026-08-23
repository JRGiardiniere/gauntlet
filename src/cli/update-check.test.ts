import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { isNewer, probeLatestVersion, UpdateProbeError } from "./update-check.ts"

describe("isNewer", () => {
  it("orders release versions field by field", () => {
    expect(isNewer("1.0.1", "1.0.0")).toBe(true)
    expect(isNewer("1.10.0", "1.9.9")).toBe(true)
    expect(isNewer("2.0.0", "1.99.99")).toBe(true)
    expect(isNewer("1.0.0", "1.0.0")).toBe(false)
    expect(isNewer("1.0.0", "1.0.1")).toBe(false)
  })

  it("never reports an upgrade against the dev sentinel or a malformed tag", () => {
    expect(isNewer("1.0.0", "0.0.0-dev")).toBe(false)
    expect(isNewer("nightly", "1.0.0")).toBe(false)
  })
})

describe("probeLatestVersion", () => {
  const respondingWith = (response: () => Response) =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, response()))),
    )

  const redirectTo = (location: string) =>
    respondingWith(() =>
      new Response(null, { status: 302, headers: { location } })
    )

  it.effect("reads the version from the releases/latest redirect", () =>
    Effect.gen(function* () {
      const version = yield* probeLatestVersion()
      expect(version).toBe("1.2.3")
    }).pipe(
      Effect.provide(redirectTo(
        "https://github.com/JRGiardiniere/gauntlet/releases/tag/v1.2.3",
      )),
    ))

  it.effect("fails on a redirect that is not a release tag", () =>
    Effect.gen(function* () {
      const error = yield* probeLatestVersion().pipe(Effect.flip)
      expect(error).toBeInstanceOf(UpdateProbeError)
    }).pipe(
      Effect.provide(
        redirectTo("https://github.com/JRGiardiniere/gauntlet/releases"),
      ),
    ))

  it.effect("fails when nothing redirects (no releases yet)", () =>
    Effect.gen(function* () {
      const error = yield* probeLatestVersion().pipe(Effect.flip)
      expect(error).toBeInstanceOf(UpdateProbeError)
    }).pipe(
      Effect.provide(
        respondingWith(() => new Response("<html/>", { status: 200 })),
      ),
    ))
})
