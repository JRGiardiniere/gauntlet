// The build-mod step's runMain boundary: builds the Mod
// (#134 Idea 3) as the plugin folder mod/dist/gauntlet, or under the folder
// given as the first argument. The release workflow zips that folder for the
// marketplace (#184); GAUNTLET_VERSION, the release's, becomes plugin.json's
// version, which is what `claude plugin update` compares.
//
// mod/gauntlet is the plugin minus its vendor folder. Its hooks module ships
// as source (the engine reads a hooks module's source statically), with its
// import of the bundled review program (mod/engine.ts) respelled to
// hooks/vendor/engine.js. The bundle carries exactly one Effect copy: Bun
// resolves `effect` from this repository's node_modules (a second copy fails
// every Schema decode).
// Pi stays out of the import graph: the lens loader's parseFrontmatter is
// Pi's own small module, and any other Pi import fails the build, as does
// any node: import but node:buffer's isUtf8. The plugin carries its own
// content: content/ and the Stage templates (src/**/*.md) sit beside the
// bundle as they sit in the checkout, and each source file's
// import.meta.dirname becomes its directory there, found from the bundle's
// import.meta.url (Claude Code's mod loader gives modules no dirname).
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

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
  readonly fileURLToPath: (url: URL) => string
}

class ModBuildFailed extends Data.TaggedError("ModBuildFailed")<{
  readonly step: string
  readonly cause: unknown
}> {}

const repoRoot = `${import.meta.dirname}/..`
// The checkout's root as Bun reports module paths, for each source file's
// directory relative to it.
const sourceRoot = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")

const plugin = { name: "gauntlet", entry: "engine.ts", vendor: "engine.js", respell: "../../engine.ts" } as const

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
      Bun.file(args.path).text().then((source) => {
        const directory = `./${args.path.slice(`${sourceRoot}/`.length, args.path.lastIndexOf("/"))}`
        return {
          contents: !args.path.startsWith(`${sourceRoot}/src/`) ? source : source.replaceAll(
            "import.meta.dirname",
            `decodeURIComponent(new URL(${JSON.stringify(directory)}, import.meta.url).pathname)`,
          ),
          loader: "ts",
        }
      }))
  },
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(repoRoot)
  const outDir = path.resolve(process.argv[2] ?? `${root}/mod/dist`)
  const minify = !process.argv.includes("--no-minify")
  const version = yield* Config.String("GAUNTLET_VERSION").pipe(Config.withDefault("0.0.0-dev"))

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
  for (const file of ["hooks/hooks.json", "types/gauntlet.d.ts"]) {
    yield* fs.copyFile(`${source}/${file}`, `${staging}/${file}`)
  }
  yield* fs.copy(`${source}/skills`, `${staging}/skills`)
  const manifest = yield* decodeJson(yield* fs.readFileString(`${source}/.claude-plugin/plugin.json`))
  yield* fs.writeFileString(
    `${staging}/.claude-plugin/plugin.json`,
    `${yield* encodeJson({ ...manifest, version })}\n`,
  )
  // The content the bundle reads, where its rewritten paths look.
  yield* fs.copy(`${root}/content`, `${staging}/hooks/vendor/content`)
  for (const template of (yield* fs.readDirectory(`${root}/src`, { recursive: true })).filter((entry) => entry.endsWith(".md"))) {
    yield* fs.makeDirectory(path.dirname(`${staging}/hooks/vendor/src/${template}`), { recursive: true })
    yield* fs.copyFile(`${root}/src/${template}`, `${staging}/hooks/vendor/src/${template}`)
  }
  const hooks = yield* fs.readFileString(`${source}/hooks/register.ts`)
  yield* fs.writeFileString(
    `${staging}/hooks/register.ts`,
    hooks.replaceAll(`"${plugin.respell}"`, `"./vendor/${plugin.vendor}"`),
  )
  yield* fs.makeDirectory(outDir, { recursive: true })
  yield* fs.remove(dir, { recursive: true, force: true })
  yield* fs.rename(staging, dir)
  const size = (yield* fs.stat(`${dir}/hooks/vendor/${plugin.vendor}`)).size
  yield* Console.log(`${plugin.name} built at ${dir}: vendor/${plugin.vendor} ${String(size)} B`)
  yield* Console.log(`version ${version}`)
})

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain)
