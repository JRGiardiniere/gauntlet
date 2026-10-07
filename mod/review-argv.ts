import { flow } from "effect/Function"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

// `/gc-cli [target] [--recipe=…] [--lenses=…] [--spec=…]` as `gauntlet
// review` argv. The target is `gauntlet review`'s: nothing is the working
// tree, a number a pull request, anything else `--commits` (`base..head`,
// or a base whose merge-base with HEAD starts the range). Other flags pass
// through as written (`--resume`, `--github-spec`, `--related-files`), and a
// flag that takes a value takes the next word too (`--resume <run-id>`).
const VALUE_FLAGS = new Set(["--recipe", "--lenses", "--spec", "--destination", "--pr", "--commits", "--resume"])

export const reviewArgv = (args: string): ReadonlyArray<string> => {
  const words = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map((word) => word.replace(/^(["'])(.*)\1$/, "$2")) ?? []
  const flags: Array<string> = []
  let target: string | undefined
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? ""
    const value = words[index + 1]
    if (VALUE_FLAGS.has(word) && value !== undefined && !value.startsWith("--")) {
      flags.push(`${word}=${value}`)
      index++
    } else if (word.startsWith("--")) flags.push(word)
    else target ??= word
  }
  const argv = ["review", ...flags.map((flag) => (flag.startsWith("--recipe=") ? flag.slice("--recipe=".length) : flag))]
  if (argv.some((word) => word.startsWith("--resume"))) return argv
  // Related files are this host's default: they lifted seeded-bugs-2 from
  // 3.7 to 5.5 of 7 on claude-code/ Seats, and the cost is plan usage (#135).
  const optedOut = argv.indexOf("--no-related-files")
  if (optedOut !== -1) argv.splice(optedOut, 1)
  else if (!argv.includes("--related-files")) argv.push("--related-files")
  if (target === undefined) argv.push("--working-tree")
  else if (/^\d+$/.test(target)) argv.push(`--pr=${target}`)
  else argv.push(`--commits=${target}`)
  return argv
}

// The review tool's `args`, decoded where the call arrives; undefined when
// the call carries none.
export const reviewToolArgs = flow(
  Schema.decodeUnknownOption(Schema.Struct({ args: Schema.String })),
  Option.map(({ args }) => args),
  Option.getOrUndefined,
)
