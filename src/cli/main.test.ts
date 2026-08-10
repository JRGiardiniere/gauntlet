import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Sink from "effect/Sink"
import * as Stdio from "effect/Stdio"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Dossier } from "../domain/dossier.ts"
import { ReviewPlan } from "../domain/review-plan.ts"
import { InvocationDirectory, runGauntlet } from "./main.ts"

const git = (cwd: string, ...args: Array<string>) => {
  execFileSync("git", args, { cwd, stdio: "pipe" })
}

const commitAll = (repo: string, message: string) => {
  git(repo, "add", "--all")
  git(
    repo,
    "-c",
    "user.name=gauntlet-test",
    "-c",
    "user.email=gauntlet-test@example.invalid",
    "commit",
    "--message",
    message,
  )
}

interface Fixture {
  readonly repo: string
  readonly home: string
  readonly runsRoot: string
}

const makeFixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "gauntlet-cli-test-"))
  const repo = join(root, "repo")
  const home = join(root, "home")
  mkdirSync(repo, { recursive: true })
  mkdirSync(home, { recursive: true })
  git(repo, "init")
  return { repo, home, runsRoot: join(home, ".gauntlet", "runs") }
}

const makeDirtyRepo = (): Fixture => {
  const fixture = makeFixture()
  writeFileSync(join(fixture.repo, "alpha.txt"), "first line\n")
  commitAll(fixture.repo, "initial")
  writeFileSync(join(fixture.repo, "alpha.txt"), "first line\nneedle-added-line\n")
  return fixture
}

interface CapturedOutput {
  readonly stdout: Array<string>
  readonly stderr: Array<string>
}

const decodeChunk = (input: string | Uint8Array): string =>
  typeof input === "string" ? input : new TextDecoder().decode(input)

const testLayers = (fixture: Fixture, captured: CapturedOutput) =>
  Layer.mergeAll(
    Stdio.layerTest({
      stdout: () =>
        Sink.forEach((input: string | Uint8Array) =>
          Effect.sync(() => {
            captured.stdout.push(decodeChunk(input))
          })
        ),
      stderr: () =>
        Sink.forEach((input: string | Uint8Array) =>
          Effect.sync(() => {
            captured.stderr.push(decodeChunk(input))
          })
        ),
    }),
    ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: fixture.home })),
  ).pipe(Layer.provideMerge(NodeServices.layer))

const review = (fixture: Fixture, captured: CapturedOutput) =>
  runGauntlet(["review"]).pipe(
    Effect.provideService(InvocationDirectory, fixture.repo),
    Effect.provide(testLayers(fixture, captured)),
  )

describe("gauntlet review — walking skeleton", () => {
  it.effect("lands a complete run record for a dirty working tree", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      const captured: CapturedOutput = { stdout: [], stderr: [] }

      const exitCode = yield* review(fixture, captured)
      expect(exitCode).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const runIds = yield* fs.readDirectory(fixture.runsRoot)
      expect(runIds).toHaveLength(1)
      const runDir = join(fixture.runsRoot, runIds[0] ?? "")

      const entries = yield* fs.readDirectory(runDir)
      expect([...entries].sort()).toEqual([
        "dossier.json",
        "journal",
        "plan.json",
        "report.md",
        "run.log",
      ])

      const planText = yield* fs.readFileString(join(runDir, "plan.json"))
      const plan = yield* Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))(planText)
      expect(plan.runId).toBe(runIds[0])
      expect(plan.lenses).toEqual([])
      expect(plan.target._tag).toBe("WorkingTree")
      expect(plan.target.diff).toContain("+needle-added-line")

      const dossierText = yield* fs.readFileString(join(runDir, "dossier.json"))
      const dossier = yield* Schema.decodeEffect(Schema.fromJsonString(Dossier))(dossierText)
      expect(dossier.runId).toBe(plan.runId)
      expect(dossier.bugClaims).toEqual([])
      expect(dossier.observations).toEqual([])
      expect(dossier.coverageGaps).toEqual([])
      expect(dossier.target._tag).toBe("WorkingTree")

      const report = yield* fs.readFileString(join(runDir, "report.md"))
      expect(report).toContain(`# Gauntlet review ${plan.runId}`)
      expect(report).toContain("No findings.")
      expect(report).toContain("0 invocations")

      // The diff is stored exactly once, in the plan (ADR 0006).
      const runRecordText = planText + dossierText + report
      expect(runRecordText.split("needle-added-line").length - 1).toBe(1)

      const runLog = yield* fs.readFileString(join(runDir, "run.log"))
      expect(runLog.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("prints a bounded digest on stdout and narrates on stderr", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      const captured: CapturedOutput = { stdout: [], stderr: [] }

      const exitCode = yield* review(fixture, captured)
      expect(exitCode).toBe(0)

      const stdout = captured.stdout.join("")
      const [tally = ""] = stdout.split("\n")
      expect(tally).toContain("0 confirmed · 0 kept · 0 unverified · 0 undecided")
      expect(tally).toContain("working tree @")
      expect(tally).toContain("recipe: none")
      expect(stdout).toContain(`report: ${fixture.runsRoot}`)
      expect(stdout).toContain("report.md")
      expect(stdout).toContain("dossier.json")
      expect(stdout).not.toContain("gauntlet:")

      const stderr = captured.stderr.join("")
      expect(stderr).toContain("gauntlet: resolving working-tree review target")
      expect(stderr).not.toContain("confirmed ·")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("records untracked files as a scope-degradation warning", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      writeFileSync(join(fixture.repo, "untracked.txt"), "not in the diff\n")
      const captured: CapturedOutput = { stdout: [], stderr: [] }

      const exitCode = yield* review(fixture, captured)
      expect(exitCode).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const runIds = yield* fs.readDirectory(fixture.runsRoot)
      const planText = yield* fs.readFileString(
        join(fixture.runsRoot, runIds[0] ?? "", "plan.json"),
      )
      const plan = yield* Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))(planText)
      expect(plan.target.warnings).toHaveLength(1)
      expect(plan.target.warnings[0]).toContain("untracked.txt")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("exits 1 with no run directory when the tree has nothing to review", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()
      writeFileSync(join(fixture.repo, "alpha.txt"), "first line\n")
      commitAll(fixture.repo, "initial")
      const captured: CapturedOutput = { stdout: [], stderr: [] }

      const exitCode = yield* review(fixture, captured)
      expect(exitCode).toBe(1)

      expect(captured.stdout.join("")).toBe("")
      expect(captured.stderr.join("")).toContain(
        "could not review — working tree has no uncommitted changes",
      )

      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.exists(fixture.runsRoot)).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("exits 1 outside a git repository", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "gauntlet-cli-test-"))
      const notARepo = join(root, "plain")
      const home = join(root, "home")
      mkdirSync(notARepo, { recursive: true })
      mkdirSync(home, { recursive: true })
      const fixture: Fixture = {
        repo: notARepo,
        home,
        runsRoot: join(home, ".gauntlet", "runs"),
      }
      const captured: CapturedOutput = { stdout: [], stderr: [] }

      const exitCode = yield* review(fixture, captured)
      expect(exitCode).toBe(1)
      expect(captured.stderr.join("")).toContain("could not review — not inside a git repository")
    }).pipe(Effect.provide(NodeServices.layer)))
})
