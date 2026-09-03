// The workflow build's runMain boundary. Gauntlet also ships as a Claude Code
// workflow (.claude/workflows/gauntlet.js): the same five-stage pipeline,
// driven by workflow subagents. Lenses and stage prompts stay pure content
// (ADR 0004), so the workflow never carries its own copy of them by hand —
// this script embeds the shipped catalog verbatim, together with the pipeline
// constants and Default Lenses the CLI uses, into the hand-written
// orchestration in workflow/gauntlet.body.js (at its @@CONTENT@@ marker,
// after the meta literal) and writes the result.
//
//   bun scripts/build-workflow.ts          # regenerate
//   bun scripts/build-workflow.ts --check  # exit 1 when the committed file is stale
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { POOL_SKIP_UNDER, VERIFIER_BUNDLE_SIZE } from "../src/assembly/pool.ts"
import { loadLens } from "../src/content/lens.ts"
import {
  DEFAULT_CANDIDATE_CAP,
  DEFAULT_LENSES,
  SUBJECTIVE_CANDIDATE_CAP,
} from "../src/domain/review-plan.ts"

class WorkflowStale extends Data.TaggedError("WorkflowStale")<{
  readonly path: string
  readonly remedy: string
}> {}

class WorkflowBuildError extends Data.TaggedError("WorkflowBuildError")<{
  readonly reason: string
}> {}

const repoRoot = `${import.meta.dirname}/..`
process.chdir(repoRoot)

const OUTPUT = ".claude/workflows/gauntlet.js"
const BODY = "workflow/gauntlet.body.js"
const PROMPTS = "content/prompts"
const LENSES = "content/lenses"
const JUDGE = "src/stages/judgment/judge.md"
const MARKER = "// @@CONTENT@@"
const REGENERATE = "run `bun run build-workflow` and commit the result"

// Pretty-printed so a lens or prompt edit lands as a readable hunk in the
// committed artifact rather than one 40KB line.
const jsonLiteral = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

// The substitutions the workflow body supplies for each embedded prompt. A
// prompt that grows a placeholder the body does not fill would pass `--check`
// and crash the workflow on every run, so the coupling is checked here.
const BODY_SUBSTITUTIONS = {
  "finder-system": [],
  "finder-shared-block": ["REPO_ROOT", "CHANGED_FILES", "DIFF_SECTION", "MAX_PER_LENS"],
  "stage-scope-block": ["REPO_ROOT", "CHANGED_FILES", "DIFF_SECTION"],
  pool: ["CANDIDATES"],
  verifier: ["SCOPE_BLOCK", "CLAIMS"],
  judge: ["SCOPE_BLOCK", "CANDIDATES"],
} satisfies Record<string, ReadonlyArray<string>>
const substitutionsFor = (name: string): ReadonlyArray<string> | undefined =>
  Object.entries(BODY_SUBSTITUTIONS).find(([prompt]) => prompt === name)?.[1]

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
  const check = process.argv.includes("--check")

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

  for (const [name, text] of promptEntries) {
    const expected = substitutionsFor(name)
    if (expected === undefined) {
      return yield* new WorkflowBuildError({
        reason: `prompt ${name} has no substitution entry in BODY_SUBSTITUTIONS; add one alongside the workflow body's render call`,
      })
    }
    const unfilled = placeholdersOf(text).filter((p) => !expected.includes(p))
    if (unfilled.length > 0) {
      return yield* new WorkflowBuildError({
        reason: `prompt ${name} uses {{${unfilled.join("}}, {{")}}} which the workflow body never fills`,
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

  const missingDefaults = DEFAULT_LENSES.filter((name) => !(name in lenses))
  if (missingDefaults.length > 0) {
    return yield* new WorkflowBuildError({
      reason: `Default Lenses without a content file under ${LENSES}: ${missingDefaults.join(", ")}`,
    })
  }

  // The body opens with the workflow's meta literal and a marker line; the
  // embedded content replaces the marker so meta stays the first statement.
  const body = yield* fs.readFileString(BODY)
  if (!body.includes(MARKER)) {
    return yield* new WorkflowBuildError({ reason: `${BODY} has no ${MARKER} line` })
  }
  const content = yield* jsonLiteral({
    constants: {
      DEFAULT_CANDIDATE_CAP,
      SUBJECTIVE_CANDIDATE_CAP,
      POOL_SKIP_UNDER,
      VERIFIER_BUNDLE_SIZE,
    },
    defaultLenses: DEFAULT_LENSES,
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

  if (check) {
    // An absent output is stale; any other read failure is its own problem
    // (house rule 22), never reported as staleness.
    const current = yield* fs.readFileString(OUTPUT).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", (failure) =>
        Predicate.isTagged("NotFound")(failure.reason)
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(failure)),
    )
    if (Option.isNone(current) || current.value !== output) {
      return yield* new WorkflowStale({ path: OUTPUT, remedy: REGENERATE })
    }
    yield* Console.log(`${OUTPUT} is up to date`)
    return
  }

  yield* fs.makeDirectory(".claude/workflows", { recursive: true })
  yield* fs.writeFileString(OUTPUT, output)
  yield* Console.log(
    `wrote ${OUTPUT} (${String(lensNames.length)} lenses, ${String(promptEntries.length)} prompts)`,
  )
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
