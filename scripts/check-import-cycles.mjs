import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const madge = fileURLToPath(new URL("../node_modules/madge/bin/cli.js", import.meta.url))

const result = spawnSync(
  process.execPath,
  [madge, "--circular", "--extensions", "ts", "src"],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
)

if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
