import {
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import * as Data from "effect/Data"
import { Bash, type BashOptions, OverlayFs } from "just-bash"
import {
  REVIEW_WORKSPACE_ROOT,
  type ReviewWorkspace,
} from "./review-workspace.ts"

// The local ReviewWorkspace adapter: just-bash (exact-pinned) over a
// copy-on-write OverlayFs whose backing is the Run's frozen snapshot
// worktree. Reads load lazily from the host; writes live in this
// invocation's in-memory overlay and are discarded with it. Each `bash`
// call gets fresh shell state (env, cwd, functions) while the filesystem
// persists for the invocation's life — that is the library's own state
// model, not something this adapter arranges.
//
// This is pragmatic capability reduction for trusted local repositories:
// no guest git, no host processes, no network, no inherited environment —
// not hardened VM-grade isolation against a hostile repository.

// Execution limits: the `normal` profile wholesale, with exactly one
// override. maxOutputSize drops from 256MiB to the cap Pi's own bash tool
// truncates at today (DEFAULT_MAX_BYTES, 50KiB) — output beyond what the
// host tool would show a model is pure interpreter spend. Exhaustion of any
// limit is an ordinary tool error; nothing here can mutate the snapshot.
export const WORKSPACE_EXECUTION_LIMITS: NonNullable<
  BashOptions["executionLimits"]
> = {
  maxOutputSize: DEFAULT_MAX_BYTES,
}

// Ordinary tool errors (CONTEXT.md: Termination, not Failure): limit
// exhaustion, a nonzero exit, an unsupported construct in the beta
// interpreter. They reject at the Pi Promise seam, surface as isError tool
// results, and the invocation continues — same recovery path as a bad flag
// on real bash.
export class WorkspaceToolError extends Data.TaggedError(
  "WorkspaceToolError",
)<{
  readonly message: string
}> {}

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

// Pi's stock read tool advertises image attachments for these extensions.
// Its default detector sniffs host files; this one maps extensions so
// detection stays overlay-pure. A mislabeled file degrades gracefully:
// Pi's image processing fails and returns a textual note.
const IMAGE_MIME_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
])

const detectImageMimeType = (absolutePath: string): Promise<string | null> => {
  const dot = absolutePath.lastIndexOf(".")
  const mimeType = dot === -1
    ? null
    : IMAGE_MIME_TYPES.get(absolutePath.slice(dot).toLowerCase()) ?? null
  return Promise.resolve(mimeType)
}

// Pi's path normalization expands `~` against the HOST home directory
// before any operation sees the path. Reject everything outside the
// virtual root here, without echoing the path: the expanded form is a
// host path that must never reach model-visible output.
const guardWorkspacePath = (absolutePath: string): void => {
  if (
    absolutePath !== REVIEW_WORKSPACE_ROOT &&
    !absolutePath.startsWith(`${REVIEW_WORKSPACE_ROOT}/`)
  ) {
    throw new WorkspaceToolError({
      message: `Path is outside the workspace root ${REVIEW_WORKSPACE_ROOT}`,
    })
  }
}

// Pi's own read tool — contract, truncation, continuation notices, image
// attachments — parameterized over the invocation's overlay instead of the
// host filesystem, so reads observe this invocation's scratch writes and a
// Pi bump cannot drift a duplicated contract. Path resolution runs against
// the virtual root; confinement holds because every operation goes through
// the overlay, which rejects paths outside it.
// The widening cast is the same SDK-seam erasure pi-live applies to the
// host-backed factories: it drops Pi's per-tool parameter generics only.
const makeReadTool = (fs: OverlayFs): ToolDefinition =>
  createReadToolDefinition(REVIEW_WORKSPACE_ROOT, {
    operations: {
      readFile: async (absolutePath) => {
        guardWorkspacePath(absolutePath)
        return Buffer.from(await fs.readFileBuffer(absolutePath))
      },
      access: async (absolutePath) => {
        guardWorkspacePath(absolutePath)
        await fs.stat(absolutePath)
      },
      detectImageMimeType,
    },
  }) as unknown as ToolDefinition

interface BashArgs {
  readonly command: string
  readonly timeout?: number
}

const combinedOutput = (stdout: string, stderr: string): string => {
  if (stdout === "") return stderr
  if (stderr === "") return stdout
  return stdout.endsWith("\n") ? `${stdout}${stderr}` : `${stdout}\n${stderr}`
}

const makeBashTool = (bash: Bash): ToolDefinition => ({
  name: "bash",
  label: "bash",
  description: `Execute a bash command in the repository workspace at ${REVIEW_WORKSPACE_ROOT}. Returns stdout and stderr. Commands whose output exceeds ${formatSize(DEFAULT_MAX_BYTES)} fail, and intermediate pipeline output counts — narrow at the source (more specific patterns, -m or -l style flags, fewer files) rather than piping to head, then retry. Optionally provide a timeout in seconds.`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command to execute" },
      timeout: {
        type: "number",
        description: "Timeout in seconds (optional, no default timeout)",
      },
    },
    required: ["command"],
  } as unknown as ToolDefinition["parameters"],
  execute: async (_toolCallId, args, signal) => {
    const { command, timeout } = args as BashArgs
    let timeoutSignal: AbortSignal | undefined
    if (timeout !== undefined) {
      // The upper bound guards Node's 2^31-1ms timer ceiling: a delay past
      // it overflows and fires the abort immediately instead of later.
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483) {
        throw new WorkspaceToolError({
          message:
            "Invalid timeout: must be a positive number of seconds at most 2147483",
        })
      }
      // Rounded: AbortSignal.timeout rejects non-integer delays.
      timeoutSignal = AbortSignal.timeout(Math.round(timeout * 1000))
    }
    const signals = [signal, timeoutSignal].filter(
      (candidate) => candidate !== undefined,
    )
    const result = await bash
      .exec(command, signals.length === 0 ? {} : {
        signal: AbortSignal.any(signals),
      })
      .catch((cause: unknown) => {
        throw new WorkspaceToolError({
          message: timeoutSignal?.aborted === true
            ? `Command timed out after ${String(timeout)} seconds`
            : failureMessage(cause),
        })
      })
    const outputText = combinedOutput(result.stdout, result.stderr) ||
      "(no output)"
    if (result.exitCode !== 0) {
      // The interpreter may honor the abort by resolving with exit 124
      // instead of rejecting; report that as the timeout it is.
      throw new WorkspaceToolError({
        message: timeoutSignal?.aborted === true
          ? `Command timed out after ${String(timeout)} seconds`
          : `${outputText}\n\nCommand exited with code ${String(result.exitCode)}`,
      })
    }
    return {
      content: [{ type: "text", text: outputText }],
      details: {},
    }
  },
})

export interface ReviewWorkspaceOptions {
  // Capability-test seam for the copy-on-write memory cap. Production
  // accepts the library default (1 GiB); exhausting that in a test would
  // mean actually writing a gibibyte, so tests shrink it to prove the
  // exhaustion path is an ordinary tool error.
  readonly maxOverlayMemoryBytes?: number
}

// One ReviewWorkspace per AgentInvocation: one overlay, one interpreter.
// Invocations never observe one another's writes and cannot modify the
// backing snapshot.
export const makeReviewWorkspace = async (
  snapshotRoot: string,
  options?: ReviewWorkspaceOptions,
): Promise<ReviewWorkspace> => {
  const fs = new OverlayFs({
    root: snapshotRoot,
    mountPoint: REVIEW_WORKSPACE_ROOT,
    // The library default-denies symlinks, which would silently break
    // repository-contained links. Enabling them keeps the overlay's
    // canonicalize-and-validate gates: a target outside the root is still
    // rejected, not followed.
    allowSymlinks: true,
    // The 10MiB per-file default makes a larger tracked file invisible in
    // a misleading way — bash reports "No such file or directory", which a
    // finder could read as the file being absent. 64MiB covers real
    // generated/vendored files; a backing read is transient, so this cap
    // (not maxMemoryBytes, which counts only copied files) bounds it.
    maxFileReadSize: 64 * 1024 * 1024,
    ...(options?.maxOverlayMemoryBytes === undefined
      ? {}
      : { maxMemoryBytes: options.maxOverlayMemoryBytes }),
  })
  // The snapshot is a git worktree whose `.git` administrative entry names
  // the host git directory. Tombstone it in the overlay: the deletion lives
  // in memory, the host file is untouched, and no guest tool can read it.
  await fs.rm(`${REVIEW_WORKSPACE_ROOT}/.git`, { recursive: true, force: true })
  const bash = new Bash({
    fs,
    cwd: REVIEW_WORKSPACE_ROOT,
    // No env is passed: the interpreter inherits nothing from process.env
    // and synthesizes the same minimal environment on every machine.
    executionLimits: WORKSPACE_EXECUTION_LIMITS,
  })
  return {
    root: REVIEW_WORKSPACE_ROOT,
    readTool: makeReadTool(fs),
    bashTool: makeBashTool(bash),
  }
}
