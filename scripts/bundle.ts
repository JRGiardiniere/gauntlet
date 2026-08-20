// The bundle step's runMain boundary. Compile the single-file distribution:
// bin/gauntlet.ts plus the shipped content catalog embedded as Bun assets.
// `compile.assets` embeds the content/ tree wholesale; stage-owned markdown
// scattered under src/ still needs per-file `with { type: "file" }` imports
// (assets take literal directories — no globs or extension filtering, so it
// cannot target src/). The entry module carrying those imports is handed to
// Bun.build as an in-memory virtual file — it never touches disk.
// `autoloadBunfig: false` keeps a stray bunfig.toml in a user's cwd from
// crashing the binary; `naming.asset` preserves the content/ and src/ paths
// the loaders resolve against the bundle root.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"

// Bun's bundler API, typed minimally — the project compiles against
// @types/node only, without bun-types.
declare const Bun: {
  readonly build: (options: {
    readonly entrypoints: ReadonlyArray<string>
    readonly files: Record<string, string>
    readonly naming: { readonly asset: string }
    readonly compile: {
      readonly outfile: string
      readonly assets: ReadonlyArray<string>
      readonly autoloadBunfig: boolean
    }
  }) => Promise<{ readonly success: boolean }>
}

class BundleFailed extends Data.TaggedError("BundleFailed")<{
  readonly cause: unknown
}> {}

const repoRoot = `${import.meta.dirname}/..`
process.chdir(repoRoot)

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  // Stage-owned prompt templates (markdown living with its Stage module,
  // e.g. src/stages/judgment/judge.md).
  const stageTemplateImports = (yield* fs.readDirectory("src", { recursive: true }))
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => `src/${entry}`)

  const entrySource = [
    // Pi loads OAuth flow modules through variable dynamic imports the
    // bundler cannot follow; a standalone binary registers them statically
    // instead — the same wiring as Pi's own compiled CLI entry.
    `import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"`,
    `registerBunOAuthFlows()`,
    ...stageTemplateImports.map((file, index) =>
      `import asset${String(index)} from "./${file}" with { type: "file" }`),
    `export const embeddedStageTemplates = [${stageTemplateImports.map((_, index) => `asset${String(index)}`).join(", ")}]`,
    `import "./bin/gauntlet.ts"`,
    "",
  ].join("\n")

  yield* fs.makeDirectory("dist", { recursive: true })
  const build = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: ["./bundle-entry.virtual.mjs"],
        files: { "./bundle-entry.virtual.mjs": entrySource },
        naming: { asset: "[dir]/[name].[ext]" },
        compile: {
          outfile: "dist/gauntlet",
          assets: ["content"],
          autoloadBunfig: false,
        },
      }),
    catch: (cause) => new BundleFailed({ cause }),
  })
  if (!build.success) {
    return yield* new BundleFailed({ cause: "Bun.build reported failure" })
  }
  yield* Console.log("compiled dist/gauntlet")

  // Bun 1.4.0's compile emits an invalid ad-hoc signature on macOS and the
  // binary is SIGKILLed on launch; re-sign until the upstream regression is
  // fixed.
  if (process.platform === "darwin") {
    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make(
          "codesign",
          ["--sign", "-", "--force", "dist/gauntlet"],
          { cwd: repoRoot, stdout: "inherit", stderr: "inherit" },
        )
        return yield* handle.exitCode
      }),
    )
    if (exitCode !== 0) {
      return yield* new BundleFailed({ cause: `codesign exited ${String(exitCode)}` })
    }
  }
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
