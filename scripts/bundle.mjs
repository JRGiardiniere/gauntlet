import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Compile the single-file distribution: bin/gauntlet.mjs plus the shipped
// content catalog embedded as Bun assets. Bun embeds only files imported
// `with { type: "file" }`, so a transient entry module at the repo root
// (asset names are entry-relative) imports the catalog and then the real bin.
// `--no-compile-autoload-bunfig` keeps a stray bunfig.toml in a user's cwd
// from crashing the binary; `--asset-naming` preserves the content/ paths the
// loader resolves against the bundle root.
const repoRoot = fileURLToPath(new URL("..", import.meta.url))
process.chdir(repoRoot)

// The shipped catalog plus stage-owned prompt templates (markdown living
// with its Stage module, e.g. src/stages/judgment/judge.md).
const contentImports = [
  ...["lenses", "prompts"].flatMap((directory) =>
    readdirSync(`content/${directory}`)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => `content/${directory}/${entry}`)),
  ...readdirSync("src", { recursive: true })
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => `src/${entry}`),
]

const entryFile = "bundle-entry.generated.mjs"
writeFileSync(
  entryFile,
  [
    // Pi loads OAuth flow modules through variable dynamic imports the
    // bundler cannot follow; a standalone binary registers them statically
    // instead — the same wiring as Pi's own compiled CLI entry.
    `import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"`,
    `registerBunOAuthFlows()`,
    ...contentImports.map((file, index) =>
      `import asset${String(index)} from "./${file}" with { type: "file" }`),
    `export const embeddedContentAssets = [${contentImports.map((_, index) => `asset${String(index)}`).join(", ")}]`,
    `import "./bin/gauntlet.mjs"`,
    "",
  ].join("\n"),
)

mkdirSync("dist", { recursive: true })
const result = spawnSync(
  "bun",
  [
    "build",
    "--compile",
    "--no-compile-autoload-bunfig",
    "--asset-naming=[dir]/[name].[ext]",
    entryFile,
    "--outfile",
    "dist/gauntlet",
  ],
  { stdio: "inherit" },
)
rmSync(entryFile)

if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
