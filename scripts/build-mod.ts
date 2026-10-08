// The build-mod step's runMain boundary: builds the Mod
// (#134 Idea 3) as two plugin folders under mod/dist, or under the folder
// given as the first argument (the mod rebuilds itself into its own
// plugin folder's parent).
//
// mod/gauntlet and mod/gauntlet-tools are the plugins minus their vendor
// folders. Their hooks modules ship as source (the engine reads a hooks
// module's source statically), with their imports of the bundled slices
// respelled to hooks/vendor/*.js:
//   gauntlet        vendor/engine.js  the review program (mod/engine.ts)
//   gauntlet-tools  vendor/tools.js   emit contracts and fence (mod/tools-core.ts)
// Each bundle carries exactly one Effect copy: Bun resolves `effect` from
// this repository's node_modules (a second copy fails every Schema decode).
// Pi stays out of the import graph: the lens loader's parseFrontmatter is
// Pi's own small module, and any other Pi import fails the build, as does
// any node: import but node:buffer's isUtf8. Source files that locate
// content through import.meta get their checkout path, so the bundle reads
// lenses and prompts from the checkout as `bun bin/gauntlet.ts` does.
// vendor/build.json carries the freshness stamp, the checkout, the bun to
// rebuild with and Pi's Anthropic prices.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as ChildProcess from "effect/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Stream from "effect/Stream"
import { inputsStamp } from "../mod/stamp.ts"

interface BunPluginBuild {
  readonly onResolve: (
    options: { readonly filter: RegExp; readonly namespace?: string },
    resolve: (args: { readonly path: string; readonly importer: string }) => { readonly path: string; readonly namespace?: string } | undefined,
  ) => void
  readonly onLoad: (
    options: { readonly filter: RegExp; readonly namespace?: string },
    load: (args: { readonly path: string }) => Promise<{ readonly contents: string; readonly loader: "js" | "ts" }> | { readonly contents: string; readonly loader: "js" | "ts" },
  ) => void
}

// Bun's bundler API, typed minimally — the project compiles against
// @types/node only, without bun-types.
declare const Bun: {
  readonly build: (options: {
    readonly entrypoints: ReadonlyArray<string>
    readonly outdir: string
    readonly naming: string
    readonly target: "browser"
    readonly format: "esm"
    readonly minify: boolean
    readonly plugins: ReadonlyArray<{ readonly name: string; readonly setup: (build: BunPluginBuild) => void }>
  }) => Promise<{ readonly success: boolean; readonly logs: ReadonlyArray<object> }>
  readonly file: (path: string) => { readonly text: () => Promise<string> }
}

class ModBuildFailed extends Data.TaggedError("ModBuildFailed")<{
  readonly step: string
  readonly cause: unknown
}> {}

const repoRoot = `${import.meta.dirname}/..`

const plugins = [
  { name: "gauntlet", entry: "engine.ts", vendor: "engine.js", respell: "../../engine.ts" },
  { name: "gauntlet-tools", entry: "tools-core.ts", vendor: "tools.js", respell: "../../tools-core.ts" },
] as const

const frontmatterModule = `${repoRoot}/node_modules/@earendil-works/pi-coding-agent/dist/utils/frontmatter.js`

const refused: Array<string> = []

const graphGuard = {
  name: "gauntlet-graph",
  setup: (build: BunPluginBuild) => {
    build.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: "pi", namespace: "gc-pi" }))
    build.onLoad({ filter: /.*/, namespace: "gc-pi" }, () => ({
      contents: `export { parseFrontmatter } from ${JSON.stringify(frontmatterModule)}`,
      loader: "js",
    }))
    build.onResolve({ filter: /^node:buffer$/ }, () => ({ path: "buffer", namespace: "gc-node" }))
    build.onLoad({ filter: /.*/, namespace: "gc-node" }, () => ({
      contents:
        "const strict = new TextDecoder('utf-8', { fatal: true })\n" +
        "export const isUtf8 = (bytes) => { try { strict.decode(bytes); return true } catch { return false } }\n",
      loader: "js",
    }))
    // Recorded, then failed after the build: Bun reports a plugin's throw
    // without the importer.
    build.onResolve({ filter: /^(node:|@earendil-works\/)/ }, (args) => {
      refused.push(`${args.path} (imported by ${args.importer})`)
      return { path: args.path, namespace: "gc-refused" }
    })
    build.onLoad({ filter: /.*/, namespace: "gc-refused" }, () => ({ contents: "export {}", loader: "js" }))
    build.onLoad({ filter: /\/src\/.*\.ts$/ }, (args) =>
      Bun.file(args.path).text().then((source) => ({
        contents: source
          .replaceAll("import.meta.dirname", JSON.stringify(args.path.slice(0, args.path.lastIndexOf("/"))))
          .replaceAll("import.meta.url", JSON.stringify(`file://${args.path}`)),
        loader: "ts",
      })))
  },
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const runCommand = (argv: ReadonlyArray<string>, stdin?: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(argv[0] ?? "", argv.slice(1), {
        cwd: repoRoot,
        stdin: Stream.make(new TextEncoder().encode(stdin ?? "")),
      })
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.decodeText(handle.stdout).pipe(Stream.mkString),
          Stream.decodeText(handle.stderr).pipe(Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: 3 },
      )
      return { exitCode, stdout, stderr }
    }),
  )

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(repoRoot)
  const outDir = path.resolve(process.argv[2] ?? `${root}/mod/dist`)
  const minify = !process.argv.includes("--no-minify")
  const services = yield* Effect.context<ChildProcessSpawner>()
  const stamped = yield* Effect.tryPromise({
    try: () =>
      inputsStamp({ run: (argv, stdin) => Effect.runPromiseWith(services)(runCommand(argv, stdin)) }, root),
    catch: (cause) => new ModBuildFailed({ step: "stamp", cause }),
  })
  const runtime = yield* Effect.tryPromise({
    try: () => ModelRuntime.create(),
    catch: (cause) => new ModBuildFailed({ step: "prices", cause }),
  })
  const prices = Object.fromEntries(runtime.getModels("anthropic").map((model) => [model.id, model.cost]))
  const info = {
    stamp: stamped.stamp,
    files: stamped.files,
    repoRoot: root,
    builtAt: DateTime.formatIso(yield* DateTime.now),
    bun: process.execPath,
    prices,
  }

  for (const plugin of plugins) {
    const source = `${root}/mod/${plugin.name}`
    // Staged outside the watched folder, then moved in by one rename, so the
    // watcher sees one whole plugin change.
    const staging = `${yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-build-" })}/${plugin.name}`
    const dir = `${outDir}/${plugin.name}`
    yield* fs.makeDirectory(`${staging}/hooks/vendor`, { recursive: true })
    const built = yield* Effect.tryPromise({
      try: () =>
        Bun.build({
          entrypoints: [`${root}/mod/${plugin.entry}`],
          outdir: `${staging}/hooks/vendor`,
          naming: plugin.vendor,
          target: "browser",
          format: "esm",
          minify,
          plugins: [graphGuard],
        }),
      catch: (cause) => new ModBuildFailed({ step: plugin.name, cause }),
    })
    if (!built.success) return yield* new ModBuildFailed({ step: plugin.name, cause: built.logs })
    if (refused.length > 0) {
      return yield* new ModBuildFailed({ step: plugin.name, cause: `imports that cannot run in the mod: ${refused.join(", ")}` })
    }
    yield* fs.makeDirectory(`${staging}/.claude-plugin`, { recursive: true })
    yield* fs.makeDirectory(`${staging}/types`, { recursive: true })
    for (const file of [".claude-plugin/plugin.json", "types/index.d.ts", "hooks/hooks.json"]) {
      yield* fs.copyFile(`${source}/${file}`, `${staging}/${file}`)
    }
    // `claude plugin test <dir>` runs a built plugin's tests.
    if (yield* fs.exists(`${source}/tests`)) {
      yield* fs.makeDirectory(`${staging}/tests`, { recursive: true })
      for (const file of yield* fs.readDirectory(`${source}/tests`)) {
        yield* fs.copyFile(`${source}/tests/${file}`, `${staging}/tests/${file}`)
      }
    }
    const hooks = yield* fs.readFileString(`${source}/hooks/register.ts`)
    yield* fs.writeFileString(
      `${staging}/hooks/register.ts`,
      hooks.replaceAll(`"${plugin.respell}"`, `"./vendor/${plugin.vendor}"`),
    )
    if (plugin.name === "gauntlet") {
      yield* fs.writeFileString(`${staging}/hooks/vendor/build.json`, `${yield* encodeJson(info)}\n`)
    }
    yield* fs.makeDirectory(outDir, { recursive: true })
    yield* fs.remove(dir, { recursive: true, force: true })
    yield* fs.rename(staging, dir)
    const size = (yield* fs.stat(`${dir}/hooks/vendor/${plugin.vendor}`)).size
    yield* Console.log(`${plugin.name} built at ${dir}: vendor/${plugin.vendor} ${String(size)} B`)
  }
  yield* Console.log(`stamp ${info.stamp} over ${String(info.files)} files`)
})

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain)
