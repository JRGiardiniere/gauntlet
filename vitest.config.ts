import { defineConfig } from "vitest/config"

// Two runtimes, one config. `src/` runs on Bun (`bun --bun vitest`) because
// the shipped binary is Bun and just-bash behaves differently there than on
// Node. `scripts/` stays on Node because Oxlint's RuleTester refuses other
// runtimes. The package.json `test` script encodes the split.

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["vitest.setup.ts"],
    // Worker threads share one process; no test calls chdir or mutates
    // process.env (a house-style lint rule bans the latter), and the setup
    // file is idempotent per worker.
    pool: "threads",
    isolate: false,
  },
})
