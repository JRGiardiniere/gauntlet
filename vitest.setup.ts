// Shared Vitest setup (loaded via vitest.config.ts `setupFiles`). Two jobs:
//
//   1. Register Effect's deep-equality testers so `expect(...).toEqual(...)`
//      understands Effect data types (Option, Data.TaggedError, etc.).
//   2. Scrub GIT_* environment variables before any test runs: git hooks
//      export GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, … into the environment,
//      and those OVERRIDE `git -C <path>`. A test driving a throwaway repo,
//      when run from a pre-commit/CI hook, would instead operate on THIS
//      repo. Gauntlet shells out to git (review targets are repos), so this
//      guard applies the moment the first git-driving test lands.
import { addEqualityTesters } from "@effect/vitest"

addEqualityTesters()

const GIT_ENV_KEYS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_AUTHOR_DATE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMITTER_DATE",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const

for (const key of GIT_ENV_KEYS) {
  // @effect-diagnostics-next-line processEnv:off
  delete process.env[key]
}
