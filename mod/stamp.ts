// The freshness stamp (#134 Idea 3): a hash of what the mod's bundle is
// built from. `bun run build-mod` writes it beside the bundle; the mod
// computes it again at command start and rebuilds when the checkout moved.
// Both sides call this one function with their own way to run git.
//
// Content (lenses, stage prompts) is not an input: the bundle reads it from
// the checkout at run time, as `bun bin/gauntlet.ts` does.
export const STAMP_INPUTS = ["src", "mod", "scripts/build-mod.ts", "package.json", "bun.lock"] as const

export interface GitRun {
  readonly run: (
    argv: ReadonlyArray<string>,
    stdin?: string,
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>
}

const git = async (runner: GitRun, root: string, args: ReadonlyArray<string>, stdin?: string) => {
  const result = await runner.run(["git", "-C", root, ...args], stdin)
  if (result.exitCode !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${result.stderr.trim()}`)
  return result.stdout
}

const nulList = (text: string) => text.split("\0").filter((entry) => entry !== "")

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")

// Every tracked or untracked (not ignored) input file by path and blob id,
// as the working tree has it; deleted files drop out.
export const inputsStamp = async (runner: GitRun, root: string) => {
  const listed = nulList(
    await git(runner, root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...STAMP_INPUTS]),
  )
  const deleted = new Set(nulList(await git(runner, root, ["ls-files", "-z", "--deleted", "--", ...STAMP_INPUTS])))
  const paths = [...new Set(listed)].filter((path) => !deleted.has(path) && !path.startsWith("mod/dist/")).sort()
  const blobs = (await git(runner, root, ["hash-object", "--stdin-paths"], `${paths.join("\n")}\n`)).trim().split("\n")
  const lines = paths.map((path, index) => `${blobs[index] ?? ""} ${path}`).join("\n")
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines))
  return { stamp: hex(digest), files: paths.length }
}
