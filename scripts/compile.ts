// The one compile step behind the release bundle and the compile smoke: the
// same Bun build options, bundler plugins and macOS re-signing, so the smoke
// binary is built exactly as a release binary is.
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as ChildProcess from "effect/process/ChildProcess"

// Bun's bundler API, typed minimally — the project compiles against
// @types/node only, without bun-types.
interface BunPlugin {
  readonly name: string
  readonly setup: (build: {
    readonly onResolve: (
      options: { readonly filter: RegExp },
      callback: () => { readonly path: string; readonly namespace: string },
    ) => void
    readonly onLoad: (
      options: { readonly filter: RegExp; readonly namespace?: string },
      callback: () => { readonly contents: string; readonly loader: "js" },
    ) => void
  }) => void
}

declare const Bun: {
  readonly build: (options: {
    readonly entrypoints: ReadonlyArray<string>
    readonly files: Record<string, string>
    readonly naming: { readonly asset: string }
    readonly define: Record<string, string>
    readonly plugins: ReadonlyArray<BunPlugin>
    readonly target: "bun"
    readonly format: "esm"
    readonly splitting: boolean
    readonly bytecode: boolean
    readonly compile: {
      readonly outfile: string
      readonly assets: ReadonlyArray<string>
      readonly autoloadBunfig: boolean
      readonly target?: string
    }
  }) => Promise<{ readonly success: boolean; readonly logs: ReadonlyArray<unknown> }>
}

export class CompileFailed extends Schema.TaggedError<
  CompileFailed,
  { readonly brand: unique symbol }
>()("CompileFailed", {
  cause: Schema.Defect(),
}) {}

// Replaces a package with a module of fixed source, wherever it is imported.
const stubPackage = (name: string, contents: string): BunPlugin => ({
  name: `stub ${name}`,
  setup(build) {
    const exact = new RegExp(`^${name.replaceAll("/", "\\/")}$`)
    build.onResolve({ filter: exact }, () => ({ path: name, namespace: "gauntlet-stub" }))
    build.onLoad({ filter: exact, namespace: "gauntlet-stub" }, () => ({ contents, loader: "js" }))
  },
})

// The fixes OpenCode's own CLI build makes to compile its packages.
const plugins: ReadonlyArray<BunPlugin> = [
  // Bun drops `export * from "ws"` in this side-effect-free module, and the
  // compiled binary then fails to load OpenCode (`ws2 is not defined`). The
  // names are those of Bun's built-in `ws`, which the bare specifier selects;
  // under Bun, OpenCode opens sockets with the global WebSocket anyway.
  {
    name: "ws named re-exports",
    setup(build) {
      build.onLoad({ filter: /platform-node-shared[/\\]dist[/\\]NodeWS\.js$/ }, () => ({
        contents: 'export { createWebSocketStream, Receiver, Sender, WebSocket, WebSocketServer } from "ws"',
        loader: "js",
      }))
    },
  },
  // No terminal tools in a review: OpenCode falls back to a PATH lookup for
  // the persistent PTY helper, and never needs it.
  stubPackage("@opencode/pty", "export const binaryPath = undefined"),
  // The Host runs with `fs.fff: false`; without the library OpenCode reports
  // fff unavailable and searches with ripgrep.
  stubPackage("@ff-labs/fff-bun", "export const FileFinder = undefined"),
]

export interface CompileOptions {
  // The entry module's source, compiled from the working directory.
  readonly entrySource: string
  readonly outfile: string
  // A Bun compile target such as `bun-linux-arm64`; the host platform if absent.
  readonly target: string | undefined
  readonly define: Record<string, string>
}

export const compileBinary = Effect.fn("Compile.binary")(function* (options: CompileOptions) {
  // `autoloadBunfig: false` keeps a stray bunfig.toml in a user's cwd from
  // crashing the binary.
  const compileBase = { outfile: options.outfile, assets: ["content"], autoloadBunfig: false }
  const build = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        // The entry is an in-memory virtual file; it never touches disk.
        entrypoints: ["./bundle-entry.virtual.mjs"],
        files: { "./bundle-entry.virtual.mjs": options.entrySource },
        // Keeps the content/ and src/ paths the loaders resolve against the
        // bundle root.
        naming: { asset: "[dir]/[name].[ext]" },
        define: options.define,
        plugins,
        target: "bun",
        format: "esm",
        // Splitting keeps the Host's dynamic import a separate chunk, loaded
        // only by the commands that use it.
        splitting: true,
        bytecode: true,
        // Bun rejects an explicit `target: undefined`.
        compile: options.target === undefined ? compileBase : { ...compileBase, target: options.target },
      }),
    catch: (cause) => CompileFailed.make({ cause }),
  })
  if (!build.success) {
    yield* Effect.forEach(build.logs, (log) => Console.error(log))
    return yield* CompileFailed.make({ cause: "Bun.build reported failure" })
  }

  // Bun's compile has emitted an invalid ad-hoc signature on macOS that gets
  // the binary SIGKILLed on launch; re-signing is harmless when it is valid.
  // Only a darwin host can codesign, so darwin targets build on macOS runners.
  const targetsDarwin = options.target === undefined
    ? process.platform === "darwin"
    : options.target.includes("darwin")
  if (targetsDarwin && process.platform === "darwin") {
    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make("codesign", ["--sign", "-", "--force", options.outfile], {
          stdout: "inherit",
          stderr: "inherit",
        })
        return yield* handle.exitCode
      }),
    )
    if (exitCode !== 0) {
      return yield* CompileFailed.make({ cause: `codesign exited ${String(exitCode)}` })
    }
  }
})
