import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type ToolDefinition,
  truncateHead,
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

interface ReadArgs {
  readonly path: string
  readonly offset?: number
  readonly limit?: number
}

// Mirrors Pi's stock read-tool result contract for text files — the model
// already knows that shape — resolving through the shared overlay instead of
// the host, so reads observe this invocation's scratch writes.
const makeReadTool = (fs: OverlayFs): ToolDefinition => ({
  name: "read",
  label: "read",
  description: `Read the contents of a file. Output is truncated to ${String(DEFAULT_MAX_LINES)} lines or ${String(DEFAULT_MAX_BYTES / 1024)}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read (relative or absolute)",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-indexed)",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read",
      },
    },
    required: ["path"],
  } as unknown as ToolDefinition["parameters"],
  execute: async (_toolCallId, args, signal) => {
    const { limit, offset, path } = args as ReadArgs
    if (signal?.aborted) {
      throw new WorkspaceToolError({ message: "Operation aborted" })
    }
    const resolved = fs.resolvePath(REVIEW_WORKSPACE_ROOT, path)
    const textContent = await fs.readFile(resolved).catch((cause: unknown) => {
      throw new WorkspaceToolError({ message: failureMessage(cause) })
    })

    const allLines = textContent.split("\n")
    const startLine = offset === undefined ? 0 : Math.max(0, offset - 1)
    const startLineDisplay = startLine + 1
    if (startLine >= allLines.length) {
      throw new WorkspaceToolError({
        message: `Offset ${String(offset)} is beyond end of file (${String(allLines.length)} lines total)`,
      })
    }

    let selectedContent: string
    let userLimitedLines: number | undefined
    if (limit === undefined) {
      selectedContent = allLines.slice(startLine).join("\n")
    } else {
      const endLine = Math.min(startLine + limit, allLines.length)
      selectedContent = allLines.slice(startLine, endLine).join("\n")
      userLimitedLines = endLine - startLine
    }

    const truncation = truncateHead(selectedContent)
    let outputText: string
    let details: { truncation: typeof truncation } | undefined
    if (truncation.firstLineExceedsLimit) {
      outputText = `[Line ${String(startLineDisplay)} exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${String(startLineDisplay)}p' ${path} | head -c ${String(DEFAULT_MAX_BYTES)}]`
      details = { truncation }
    } else if (truncation.truncated) {
      const endLineDisplay = startLineDisplay + truncation.outputLines - 1
      const nextOffset = endLineDisplay + 1
      const limitNote = truncation.truncatedBy === "lines"
        ? ""
        : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`
      outputText = `${truncation.content}\n\n[Showing lines ${String(startLineDisplay)}-${String(endLineDisplay)} of ${String(allLines.length)}${limitNote}. Use offset=${String(nextOffset)} to continue.]`
      details = { truncation }
    } else if (
      userLimitedLines !== undefined &&
      startLine + userLimitedLines < allLines.length
    ) {
      const remaining = allLines.length - (startLine + userLimitedLines)
      const nextOffset = startLine + userLimitedLines + 1
      outputText = `${truncation.content}\n\n[${String(remaining)} more lines in file. Use offset=${String(nextOffset)} to continue.]`
    } else {
      outputText = truncation.content
    }
    return {
      content: [{ type: "text", text: outputText }],
      details,
    }
  },
})

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
  description: `Execute a bash command in the repository workspace at ${REVIEW_WORKSPACE_ROOT}. Returns stdout and stderr. Commands producing more than ${formatSize(DEFAULT_MAX_BYTES)} of output fail — narrow with head, grep, or -l style flags and retry. Optionally provide a timeout in seconds.`,
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
      if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new WorkspaceToolError({
          message: "Invalid timeout: must be a finite number of seconds",
        })
      }
      timeoutSignal = AbortSignal.timeout(timeout * 1000)
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
      throw new WorkspaceToolError({
        message: `${outputText}\n\nCommand exited with code ${String(result.exitCode)}`,
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
