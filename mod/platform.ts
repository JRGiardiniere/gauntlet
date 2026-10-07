// The Effect platform services the review program needs, answered by the
// Claude Code host's `$` instead of Node (#134 Idea 3): FileSystem, Path,
// ChildProcessSpawner, Stdio, Terminal, Console and the Config provider.
//
// FileSystem covers exactly the methods the review path calls. `$.fs` reads
// text and bytes, writes text, lists, stats (realPath included) and tests
// existence; everything else goes through `$.process.run` with a stock Unix
// tool, or is emulated:
//   writeFile (bytes)   UTF-8 bytes as text; anything else via `base64 -d`
//   rename              mv -f
//   remove              rm (-r, -f as asked)
//   makeDirectory       mkdir (-p when recursive)
//   readLink            `$.fs.stat` says whether it is a link; readlink names it
//   makeTempDirectory   mktemp -d under the host's TMPDIR; scoped: rm -rf
//   makeTempFile        mktemp under the host's TMPDIR; scoped: rm -f
//   open (append only)  Logger.toFile's run.log: the text is kept and
//                       rewritten whole on each batch
// Every other method fails NotFound (FileSystem.makeNoop): a CLI change that
// starts calling one fails loudly on the next mod run.
//
// The engine refuses a hooks module that hands `$` itself to imported code,
// so the hooks module passes these ports: closures that each spell out one
// `$.noun.call(...)`.
import type {
  FsEntry,
  FsStat,
  ProcessRunInit,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
} from "claude-code"
import * as ByteSize from "effect/ByteSize"
import * as Channel from "effect/Channel"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import * as Terminal from "effect/Terminal"
import type * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"

export interface PlatformPorts {
  readonly read: (path: string) => Promise<string>
  // The file's bytes as base64 (`$.fs.read(path, { as: "bytes" })`).
  readonly readBytes: (path: string) => Promise<string>
  readonly write: (path: string, text: string) => Promise<void>
  readonly list: (path: string) => Promise<ReadonlyArray<FsEntry>>
  readonly exists: (path: string) => Promise<boolean>
  readonly stat: (path: string, resolve: boolean) => Promise<FsStat>
  readonly run: (argv: ReadonlyArray<string>, init?: ProcessRunInit) => Promise<ProcessRunResult>
  // `$.process.spawn`: the child's output piece by piece, then how it ended.
  // Leaving the loop (`return()`) kills the child.
  readonly spawnProcess: (request: ProcessSpawnRequest) => AsyncIterable<ProcessSpawnChunk, ProcessSpawnResult>
  // The variables the review program reads (HOME, LINEAR_API_KEY) and
  // TMPDIR, as `$.env.get` answered them.
  readonly env: Readonly<Record<string, string>>
  // Where the program's stdout and stderr go: the digest and the progress
  // lines.
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const encoder = new TextEncoder()
const strictUtf8 = new TextDecoder("utf-8", { fatal: true })

const failure = (
  tag: PlatformError.SystemErrorTag,
  method: string,
  path: string,
  description?: string,
) =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description,
  })

// `$.fs` rejects with the host's message; the tag callers match on (absence
// above all: optional settings files) is recovered by asking again.
const hostCall = <A>(ports: PlatformPorts, method: string, path: string, call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: String }).pipe(
    Effect.catch((cause) =>
      Effect.tryPromise({ try: () => ports.exists(path), catch: () => failure("Unknown", method, path, cause) }).pipe(
        Effect.flatMap((present) =>
          Effect.fail(failure(present ? "Unknown" : "NotFound", method, path, cause))
        ),
      )
    ),
  )

// One host command; a non-zero exit is the failure, its stderr the message.
const tool = (ports: PlatformPorts, method: string, path: string, argv: ReadonlyArray<string>, stdin?: string) =>
  Effect.tryPromise({
    try: () => ports.run(argv, stdin === undefined ? {} : { stdin }),
    catch: (cause) => failure("Unknown", method, path, `${argv[0] ?? ""} could not run: ${String(cause)}`),
  }).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.succeed(result.stdout)
      const message = result.stderr.trim()
      const tag = /No such file/i.test(message)
        ? "NotFound"
        : /File exists/i.test(message)
        ? "AlreadyExists"
        : /Permission denied/i.test(message)
        ? "PermissionDenied"
        : "Unknown"
      return Effect.fail(failure(tag, method, path, message))
    }),
  )

const FILE_TYPES = { file: "File", dir: "Directory", other: "Unknown" } as const

// Only `type` and `size` are read by the review program; the rest is
// reported as unknown rather than invented.
const fileInfo = (stat: FsStat): FileSystem.File.Info => ({
  type: FILE_TYPES[stat.kind],
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(BigInt(stat.size)),
  blksize: Option.none(),
  blocks: Option.none(),
})

const chomp = (text: string) => text.replace(/\n$/, "")

// Logger.toFile opens run.log for appending and writes batches to it.
// Each write rewrites the whole text after the one before it settles, so a
// write left behind by an interrupted batch never lands over a later one; a
// failed write fails its own batch and the next write goes on.
const appendOnlyFile = (ports: PlatformPorts, path: string, initial: string): FileSystem.File => {
  let text = initial
  let writing = Promise.resolve()
  const unsupported = (method: string) => Effect.fail(failure("Unknown", method, path, "only appending is available in the mod"))
  const settled = (method: string, call: () => Promise<void>) =>
    Effect.tryPromise({ try: call, catch: (cause) => failure("Unknown", method, path, String(cause)) })
  const writeAll = (bytes: Uint8Array) =>
    settled("writeAll", () => {
      text += new TextDecoder().decode(bytes)
      const snapshot = text
      writing = writing.then(() => undefined, () => undefined).then(() => ports.write(path, snapshot))
      return writing
    })
  return {
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    stat: unsupported("stat"),
    seek: () => unsupported("seek"),
    sync: settled("sync", () => writing),
    read: () => unsupported("read"),
    readAlloc: () => unsupported("readAlloc"),
    truncate: () => unsupported("truncate"),
    write: (bytes) => writeAll(bytes).pipe(Effect.as(bytes.length)),
    writeAll,
  }
}

const makeTemp = (ports: PlatformPorts, kind: "directory" | "file", prefix: string | undefined) => {
  const template = `${(ports.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/${prefix ?? "gauntlet-"}XXXXXX`
  return kind === "directory"
    ? tool(ports, "makeTempDirectory", template, ["mktemp", "-d", template]).pipe(Effect.map(chomp))
    : tool(ports, "makeTempFile", template, ["mktemp", template]).pipe(Effect.map(chomp))
}

const fileSystemOver = (ports: PlatformPorts) =>
  FileSystem.makeNoop({
    exists: (path) =>
      Effect.tryPromise({ try: () => ports.exists(path), catch: (cause) => failure("Unknown", "exists", path, String(cause)) }),
    stat: (path) => hostCall(ports, "stat", path, () => ports.stat(path, false)).pipe(Effect.map(fileInfo)),
    realPath: (path) =>
      hostCall(ports, "realPath", path, () => ports.stat(path, true)).pipe(
        Effect.flatMap((stat) =>
          stat.realPath === undefined ? Effect.fail(failure("NotFound", "realPath", path)) : Effect.succeed(stat.realPath)
        ),
      ),
    readLink: (path) =>
      hostCall(ports, "readLink", path, () => ports.stat(path, false)).pipe(
        Effect.flatMap((stat) =>
          stat.isLink
            ? tool(ports, "readLink", path, ["readlink", path]).pipe(Effect.map(chomp))
            : Effect.fail(failure("InvalidData", "readLink", path, "not a symbolic link"))
        ),
      ),
    readDirectory: (path) =>
      hostCall(ports, "readDirectory", path, () => ports.list(path)).pipe(
        Effect.map((entries) => entries.map((entry) => entry.name)),
      ),
    readFileString: (path) => hostCall(ports, "readFileString", path, () => ports.read(path)),
    readFile: (path) =>
      hostCall(ports, "readFile", path, () => ports.readBytes(path)).pipe(
        Effect.map((base64) => Uint8Array.fromBase64(base64)),
      ),
    writeFileString: (path, text) => hostCall(ports, "writeFileString", path, () => ports.write(path, text)),
    writeFile: (path, bytes) => {
      let text: string | undefined
      try {
        text = strictUtf8.decode(bytes)
      } catch {
        text = undefined
      }
      return text === undefined
        ? tool(ports, "writeFile", path, ["sh", "-c", 'base64 -d > "$1"', "sh", path], bytes.toBase64()).pipe(Effect.asVoid)
        : hostCall(ports, "writeFile", path, () => ports.write(path, text))
    },
    rename: (from, to) => tool(ports, "rename", from, ["mv", "-f", "--", from, to]).pipe(Effect.asVoid),
    remove: (path, options) =>
      tool(ports, "remove", path, [
        "rm",
        ...(options?.recursive === true ? ["-r"] : []),
        ...(options?.force === true ? ["-f"] : []),
        "--",
        path,
      ]).pipe(Effect.asVoid),
    makeDirectory: (path, options) =>
      tool(ports, "makeDirectory", path, ["mkdir", ...(options?.recursive === true ? ["-p"] : []), "--", path]).pipe(
        Effect.asVoid,
      ),
    makeTempDirectory: (options) => makeTemp(ports, "directory", options?.prefix),
    makeTempDirectoryScoped: (options) =>
      Effect.acquireRelease(
        makeTemp(ports, "directory", options?.prefix),
        (directory) => tool(ports, "remove", directory, ["rm", "-rf", "--", directory]).pipe(Effect.ignore),
      ),
    makeTempFile: (options) => makeTemp(ports, "file", options?.prefix),
    makeTempFileScoped: (options) =>
      Effect.acquireRelease(
        makeTemp(ports, "file", options?.prefix),
        (file) => tool(ports, "remove", file, ["rm", "-f", "--", file]).pipe(Effect.ignore),
      ),
    open: (path, options) => {
      if (options?.flag !== "a" && options?.flag !== "a+") {
        return Effect.fail(failure("Unknown", "open", path, "only appending is available in the mod"))
      }
      return Effect.tryPromise({ try: () => ports.exists(path), catch: (cause) => failure("Unknown", "open", path, String(cause)) }).pipe(
        Effect.flatMap((present) => (present ? hostCall(ports, "open", path, () => ports.read(path)) : Effect.succeed(""))),
        Effect.map((initial) => appendOnlyFile(ports, path, initial)),
      )
    },
  })

// `$.process.spawn` sets variables over the host's environment and cannot
// unset one, so a variable the command unsets (the CLI's Git scrub: an
// `undefined` value) is unset by running the command under `env -u`.
const commandArgv = (command: ChildProcess.StandardCommand) => {
  const unset = Object.entries(command.options.env ?? {}).flatMap(([key, value]) => (value === undefined ? [key] : []))
  return unset.length === 0
    ? [command.command, ...command.args]
    : ["env", ...unset.flatMap((key) => ["-u", key]), command.command, ...command.args]
}

const definedEnv = (env: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(Object.entries(env ?? {}).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])))

const spawnOver = (ports: PlatformPorts) => (command: ChildProcess.Command) =>
  Effect.gen(function* () {
    if (command._tag !== "StandardCommand") {
      return yield* PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "spawn",
        description: "piped commands are not available in the mod",
      })
    }
    if (command.options.extendEnv === false) {
      return yield* PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "spawn",
        description: "a child without the host's environment is not available in the mod",
      })
    }
    const request: ProcessSpawnRequest = { argv: commandArgv(command), env: definedEnv(command.options.env) }
    if (command.options.cwd !== undefined) request.cwd = command.options.cwd
    // The loop runs in a scope of its own: an interrupt (a cancelled run)
    // closes it, which leaves the loop and so kills the child before cleanup
    // removes the snapshot under it.
    const output = { stdout: "", stderr: "" }
    const ended = yield* Channel.runForEach(
      Channel.fromAsyncIterable(ports.spawnProcess(request), (cause) =>
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: `${command.command} could not run: ${String(cause)}`,
        })),
      (chunk) =>
        Effect.sync(() => {
          output[chunk.stream] += chunk.text
        }),
    )
    // A child a signal ended reads as 1, as `$.process.run` reports it.
    const result = { exitCode: ended.code ?? 1, ...output }
    const once = (text: string) => Stream.make(encoder.encode(text))
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(0),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: once(result.stdout),
      stderr: once(result.stderr),
      all: once(`${result.stdout}${result.stderr}`),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    })
  })

const text = (args: ReadonlyArray<unknown>) => args.map(String).join(" ")

// stdout carries the digest, stderr the progress lines, as in a terminal.
const consoleOver = (ports: PlatformPorts): Console.Console => {
  const out = (...args: ReadonlyArray<unknown>) => ports.stdout(`${text(args)}\n`)
  const err = (...args: ReadonlyArray<unknown>) => ports.stderr(`${text(args)}\n`)
  return {
    assert: (condition, ...args) => {
      if (!condition) err(...args)
    },
    clear: () => undefined,
    count: () => undefined,
    countReset: () => undefined,
    debug: err,
    dir: (item) => err(item),
    dirxml: err,
    error: err,
    group: err,
    groupCollapsed: err,
    groupEnd: () => undefined,
    info: out,
    log: out,
    table: (data) => out(JSON.stringify(data)),
    time: () => undefined,
    timeEnd: () => undefined,
    timeLog: () => undefined,
    trace: err,
    warn: err,
  }
}

const sinkOver = (write: (text: string) => void) =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => write(chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : chunk))
  )

// The CLI parser needs a Terminal and Stdio; nothing reads input in a review.
const terminalOver = (ports: PlatformPorts) =>
  Terminal.make({
    columns: Effect.succeed(100),
    rows: Effect.succeed(40),
    readInput: Effect.die("the mod has no terminal input"),
    readLine: Effect.fail(new Terminal.QuitError()),
    display: (shown) => Effect.sync(() => ports.stdout(shown)),
  })

export const platformLayer = (ports: PlatformPorts) =>
  Layer.mergeAll(
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: ports.env })),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawnOver(ports))),
    Layer.succeed(FileSystem.FileSystem, fileSystemOver(ports)),
    Layer.succeed(
      Stdio.Stdio,
      Stdio.make({
        args: Effect.succeed([]),
        stdout: () => sinkOver(ports.stdout),
        stderr: () => sinkOver(ports.stderr),
        stdin: Stream.empty,
      }),
    ),
    Layer.succeed(Terminal.Terminal, terminalOver(ports)),
    Layer.succeed(Console.Console, consoleOver(ports)),
    Path.layer,
  )
