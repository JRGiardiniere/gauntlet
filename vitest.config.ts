import { defineConfig } from "vitest/config"

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
