import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// The compiled leg of the live gate: build the single-file binary, then prove
// it end to end from a fresh HOME — `config init` seeds against the embedded
// catalog, and one real working-tree review runs the whole pipeline through
// the binary. Pi credentials are the one thing carried over from the real
// HOME; everything else starts empty.
const repoRoot = fileURLToPath(new URL("..", import.meta.url))

const run = (name, command, args, options = {}) => {
  console.log(`\n[live-gate-compiled] ${name}`)
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    console.error(`[live-gate-compiled] ${name} exited ${String(result.status)}`)
    process.exit(1)
  }
}

run("build binary", "node", ["scripts/bundle.mjs"], { cwd: repoRoot })

const root = mkdtempSync(join(tmpdir(), "gauntlet-live-gate-compiled-"))
const home = join(root, "home")
for (const file of ["auth.json", "models-store.json", "settings.json"]) {
  cpSync(join(homedir(), ".pi", "agent", file), join(home, ".pi", "agent", file))
}

const binary = join(repoRoot, "dist", "gauntlet")
const env = { ...process.env, HOME: home }
run("config init in a fresh HOME", binary, ["config", "init"], { env })

const repo = join(root, "repo")
mkdirSync(repo)
const git = (...args) => run(`git ${args[0]}`, "git", args, { cwd: repo, env })
git("init", "--initial-branch=main")
git("config", "user.email", "live-gate@example.invalid")
git("config", "user.name", "live gate")
const source = (body) =>
  `export function applyDiscount(totalCents: number, percent: number): number {\n${body}}\n`
writeFileSync(
  join(repo, "discount.ts"),
  source(
    `  if (percent < 0 || percent > 100) throw new Error("bad percent")\n  return Math.round(totalCents * (1 - percent / 100))\n`,
  ),
)
git("add", ".")
git("commit", "-m", "base")
writeFileSync(
  join(repo, "discount.ts"),
  source(`  return Math.round(totalCents * (1 - percent / 10))\n`),
)

// Exit 0 alone admits a fully degraded review (skipped finders still produce
// a dossier); the gate exists to prove a live invocation, so narrated
// degradation is a failure here.
console.log("\n[live-gate-compiled] one real review through the binary")
const review = spawnSync(
  binary,
  ["review", "quick", "--working-tree", "--lenses", "diff-scan"],
  { cwd: repo, env, encoding: "utf8" },
)
process.stdout.write(review.stdout ?? "")
process.stderr.write(review.stderr ?? "")
if (review.error !== undefined) throw review.error
const narration = `${review.stdout ?? ""}${review.stderr ?? ""}`
if (review.status !== 0 || narration.includes("coverage gap")) {
  console.error(
    `[live-gate-compiled] review ${review.status === 0 ? "degraded (coverage gap)" : `exited ${String(review.status)}`}`,
  )
  process.exit(1)
}

rmSync(root, { recursive: true, force: true })
console.log("\nlive gate (compiled) passed")
