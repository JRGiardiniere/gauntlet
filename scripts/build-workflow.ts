// Embed the shared prompts, lenses, and constants in the experimental workflow.
// The generated file is ignored; test:workflow rebuilds it before execution.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Order from "effect/Order"
import * as Schema from "effect/Schema"
import { POOL_SKIP_UNDER, VERIFIER_BUNDLE_SIZE } from "../src/assembly/pool.ts"
import { loadLens } from "../src/content/lens.ts"
import {
  DEFAULT_CANDIDATE_CAP,
  SEEDED_DEFAULT_LENSES,
  SUBJECTIVE_CANDIDATE_CAP,
} from "../src/domain/review-plan.ts"

class WorkflowBuildError extends Data.TaggedError("WorkflowBuildError")<{
  readonly message: string
}> {}

const repoRoot = `${import.meta.dirname}/..`
process.chdir(repoRoot)

const OUTPUT = ".claude/workflows/gauntlet.js"
const BODY = "workflow/gauntlet.body.js"
const PROMPTS = "content/prompts"
const LENSES = "content/lenses"
const JUDGE = "src/stages/judgment/judge.md"
const MARKER = "// @@CONTENT@@"
const CLI_PROMPTS_NOTE = "a prompt the workflow body never renders must still be listed, with no placeholders, so the coupling stays explicit"

// Keep generated content readable during workflow debugging.
const jsonLiteral = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

// The substitutions the workflow body supplies for each embedded prompt, a
// hand-kept mirror of its render calls. Checked both ways: a prompt that grows
// a placeholder the body does not fill, or a listed prompt with no content
// file, would build successfully and crash the workflow on every run.
const BODY_SUBSTITUTIONS = new Map<string, ReadonlyArray<string>>([
  ["finder-system", []],
  ["finder-shared-block", ["REPO_ROOT", "CHANGED_FILES", "DIFF_SECTION", "MAX_PER_LENS"]],
  ["stage-scope-block", ["REPO_ROOT", "CHANGED_FILES", "DIFF_SECTION"]],
  ["pool", ["CANDIDATES"]],
  ["verifier", ["SCOPE_BLOCK", "CLAIMS"]],
  ["judge", ["SCOPE_BLOCK", "CANDIDATES"]],
])

const placeholdersOf = (text: string): ReadonlyArray<string> =>
  Array.dedupe(
    globalThis.Array.from(text.matchAll(/\{\{([^{}]+)\}\}/g), (m) => m[1] ?? ""),
  )

const markdownNames = (entries: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.sort(
    entries.filter((entry) => entry.endsWith(".md")).map((entry) => entry.slice(0, -".md".length)),
    Order.String,
  )

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  const [promptNames, lensNames] = yield* Effect.all(
    [fs.readDirectory(PROMPTS), fs.readDirectory(LENSES)],
    { concurrency: 2 },
  ).pipe(Effect.map(([prompts, lenses]) => [markdownNames(prompts), markdownNames(lenses)]))

  const promptEntries = yield* Effect.forEach(
    [...promptNames.map((name) => [name, `${PROMPTS}/${name}.md`] as const), ["judge", JUDGE] as const],
    ([name, path]) => fs.readFileString(path).pipe(Effect.map((text) => [name, text] as const)),
    { concurrency: 4 },
  )
  const prompts = Object.fromEntries(promptEntries)

  const loadedPrompts = new Set(promptEntries.map(([name]) => name))
  for (const listed of BODY_SUBSTITUTIONS.keys()) {
    if (!loadedPrompts.has(listed)) {
      return yield* new WorkflowBuildError({
        message: `BODY_SUBSTITUTIONS lists prompt ${listed} but no such file exists under ${PROMPTS} (or at ${JUDGE})`,
      })
    }
  }
  for (const [name, text] of promptEntries) {
    const expected = BODY_SUBSTITUTIONS.get(name)
    if (expected === undefined) {
      return yield* new WorkflowBuildError({
        message: `prompt ${name} has no BODY_SUBSTITUTIONS entry in scripts/build-workflow.ts; ${CLI_PROMPTS_NOTE}`,
      })
    }
    const unfilled = placeholdersOf(text).filter((p) => !expected.includes(p))
    if (unfilled.length > 0) {
      return yield* new WorkflowBuildError({
        message: `prompt ${name} uses {{${unfilled.join("}}, {{")}}} which the workflow body never fills`,
      })
    }
  }

  const lensEntries = yield* Effect.forEach(
    lensNames,
    (name) =>
      loadLens(LENSES, name).pipe(
        Effect.map((lens) => [name, { promptText: lens.promptText, finderClass: lens.finderClass }] as const),
      ),
    { concurrency: 4 },
  )
  const lenses = Object.fromEntries(lensEntries)

  const missingSeeded = SEEDED_DEFAULT_LENSES.filter((name) => !Object.hasOwn(lenses, name))
  if (missingSeeded.length > 0) {
    return yield* new WorkflowBuildError({
      message: `seeded lenses without a content file under ${LENSES}: ${missingSeeded.join(", ")}`,
    })
  }

  // The body opens with the workflow's meta literal and a marker line; the
  // embedded content replaces the marker so meta stays the first statement.
  const body = yield* fs.readFileString(BODY)
  if (!body.includes(MARKER)) {
    return yield* new WorkflowBuildError({ message: `${BODY} has no ${MARKER} line` })
  }
  const content = yield* jsonLiteral({
    constants: {
      DEFAULT_CANDIDATE_CAP,
      SUBJECTIVE_CANDIDATE_CAP,
      POOL_SKIP_UNDER,
      VERIFIER_BUNDLE_SIZE,
    },
    seededLenses: SEEDED_DEFAULT_LENSES,
    prompts,
    lenses,
  })
  // A function replacement: `$&` and friends inside the prompt text must land
  // literally, not as String.prototype.replace patterns.
  const output = body.replace(MARKER, () =>
    [
      "// GENERATED by scripts/build-workflow.ts — edit workflow/gauntlet.body.js or",
      "// the content files, then rerun `bun run build-workflow`.",
      `const CONTENT = ${content}`,
    ].join("\n"))

  yield* fs.makeDirectory(".claude/workflows", { recursive: true })
  yield* fs.writeFileString(OUTPUT, output)
  yield* Console.log(
    `wrote ${OUTPUT} (${String(lensNames.length)} lenses, ${String(promptEntries.length)} prompts)`,
  )
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
