// The ReviewWorkspace fence's path predicate: the one mod decision that
// fails quietly (a wrong answer lets an agent read outside the snapshot, or
// silently starves it), so it is the one piece with a pure test.
//
// Both arguments are real paths (every symlink and `..` resolved by
// `$.fs.stat(path, { resolve: true })`), so this compares spellings only.

export const FENCED_TOOLS = ["Read", "Grep", "Glob"] as const

export const isInsideRoot = (realPath: string | undefined, root: string): boolean => {
  if (realPath === undefined || root === "" || !root.startsWith("/")) return false
  const base = root.endsWith("/") ? root.slice(0, -1) : root
  return realPath === base || realPath.startsWith(`${base}/`)
}

// The arguments of Read, Grep and Glob that name a location.
export interface FencedToolInput {
  readonly file_path?: string | undefined
  readonly path?: string | undefined
}

// Which path a fenced tool call names, absolute against the snapshot when the
// model gave a relative one; Grep and Glob default to the agent's cwd, which
// the mod sets to the snapshot root.
export const fencedPathOf = (tool: string, input: FencedToolInput, root: string): string | undefined => {
  const raw = tool === "Read" ? input.file_path : (input.path ?? root)
  if (raw === undefined || raw === "") return undefined
  return raw.startsWith("/") ? raw : `${root.endsWith("/") ? root.slice(0, -1) : root}/${raw}`
}
