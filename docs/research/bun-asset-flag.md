# Can Bun 1.4's `--asset` replace Gauntlet's asset-embedding approach?

- **Date:** 2026-08-20
- **Bun under test:** `1.4.0` (pinned dev binary on this machine, verified with `bun --version`)
- **Scope:** the bundle script's content-catalog embedding and
  `src/content/lens.ts`'s `embeddedLensNames`/`isCompiledBinary` special-casing,
  as they stood at research time (`scripts/bundle.mjs`).
- **Status: implemented.** The recommendation landed the same day as
  `scripts/bundle.ts`, using the `Bun.build` JS API (`compile.assets` plus an
  in-memory virtual entry module) rather than the CLI flags sketched below.
  Sections referencing `bundle.mjs` or `--asset`/`--asset-naming` CLI flags
  describe the pre-implementation state and the JS API's flag equivalents; the
  Bun behavior they document (recursive directory embedding, `node:fs` over
  `/$bunfs/`, naming semantics) is what remains durable here.
- **Primary sources:** `bun build --help` output (ground truth for flag
  semantics on the pinned binary), https://bun.com/docs/bundler/executables,
  https://bun.com/blog/bun-v1.4, and empirical experiments built and run in
  the scratchpad (`/private/tmp/.../scratchpad/bun-asset-test`) with the exact
  pinned `bun` binary. No secondary write-ups were used.
- **Note on doc convention:** no prior "one-off research note" existed for a
  compiler/runtime question in this shape; this file follows the format
  already used by `docs/research/effect-beta-107-impact.md` (dated, sourced,
  bottom line up front). This is a new file — no existing repo file was
  modified.

## Bottom line

**Yes, with a caveat that changes the diagnosis.** The mechanism that actually
unlocks deleting the `embeddedLensNames`/`Bun.embeddedFiles` special-casing
is **not** the `--asset` flag itself — it's a general Bun 1.4 runtime change:
`node:fs`'s `readdirSync`/`readdir` (and `existsSync`/`statSync`/etc.) now
work on `/$bunfs/` directories, for *any* mechanism that embeds files
(`--asset`, or Gauntlet's current per-file `import ... with { type: "file" }`).
Verified empirically below (Experiment 3): Gauntlet's *existing* embedding
technique, unchanged, already supports `readdirSync` on the embedded
directory under Bun 1.4.0. Since `@effect/platform-node`'s `FileSystem`
service calls `node:fs`/`node:fs/promises` directly with no other logic in
the way (confirmed by reading its source), this means Gauntlet's ordinary
`FileSystem.readDirectory` + `FileSystem.readFileString` path — the same one
used in dev mode — now works unchanged inside the compiled binary too.

`--asset` is still worth adopting for the **directory-embedding ergonomics**
(no more generated entry-module boilerplate for whole trees like
`content/lenses` and `content/prompts`), but it embeds a directory's full
contents with no extension filter and no glob support, so it can't safely
target `src/**` (mixed `.ts`/`.md`) the way today's generated entry module
does. Recommendation: use `--asset` for `content/`, keep per-file
`with { type: "file" }` imports for the one scattered stage-owned `.md` file
under `src/`, and delete the `embeddedLensNames`/`Bun.embeddedFiles`
special-casing and `isCompiledBinary`-gated listing branch in `lens.ts`
entirely — listing can go through the same `fs.readDirectory` call used in
dev mode.

## Q1 — Exact semantics of `--asset`

**Flag surface** (from `bun build --help` on the pinned 1.4.0 binary):

```
--asset=<val>          Embed a file or directory into the compiled executable,
                        preserving its relative path (requires --compile)
--asset-naming=<val>   Customize asset filenames. Defaults to "[name]-[hash].[ext]"
```

- **Directory embedding: yes.** `--asset=./content` recursively embeds every
  regular file under the directory. Verified in Experiment 1 (nested
  `assets/lenses/*.md` and `assets/sub/c.md` all appeared under
  `Bun.embeddedFiles`).
- **Glob patterns: no.** `--asset="./assets/**/*.md"` fails outright:
  `error: failed to read asset "./assets/**/*.md": ENOENT ... (stat())`
  (Experiment 4). Bun treats the value as a literal file-or-directory path,
  not a glob.
- **No extension filtering.** A directory passed to `--asset` embeds *all*
  file types it contains — `.ts` files included, not just `.md` (Experiment
  6: `mixed/other.ts` was embedded alongside `mixed/keep.md`). This is the
  key blocker for pointing `--asset` at `src/` wholesale.
- **Naming / addressing.** Each embedded file's runtime name is the path
  passed to `--asset`, taken as relative to the build's cwd, with that
  relative structure preserved under the virtual bundle root
  (`/$bunfs/root/...`, exposed to userland as `import.meta.dir`/`dirname`).
  Multiple `--asset` flags each contribute their own subtree, keyed by
  whatever relative path was given (Experiment 5: `--asset=./assets
  --asset=./assets2` produced `assets/lenses/a.md` and `assets2/prompts/x.md`
  side by side).
- **Single-file `--asset` flattens directory context.** Passing a single file
  (`--asset=./mixed/deep/nested/z.md`) embeds it as `z.md` at the bundle
  root, not under `mixed/deep/nested/` — the surrounding directory
  structure is not addressable, so a subsequent `readdirSync` on the
  original parent path would fail (Experiment 7). Directory listing only
  works when `--asset` is given the **directory**, not individual files
  inside it.
- **`--asset-naming` does affect embedded files**, including those from
  `--asset` directories: the default template is `[name]-[hash].[ext]`
  (content-hashed, for cache-busting static-asset scenarios per the Bun 1.4
  blog post), but in Experiment 8 (default naming, single directory,
  `--asset=./assets/lenses`, no `--asset-naming` override) the observed
  names were unhashed (`lenses/a.md`, `lenses/b.md`) — so the effective
  default for `--asset` embedding did not hash in this test. Regardless,
  passing `--asset-naming="[dir]/[name].[ext]"` (as `scripts/bundle.mjs`
  already does) reliably preserves the exact original relative path and
  filename, which is what Gauntlet's lens-name-from-filename logic requires.

## Q2 — Visibility via `Bun.embeddedFiles` vs. `node:fs`, and directory listing

Both. Confirmed directly:

- `Bun.embeddedFiles` lists every embedded file (from `--asset` or from
  `with { type: "file" }` imports) as `{ name }` entries, `name` being the
  build-relative path used for embedding (Experiments 1, 2, 3).
- `node:fs` (`readFileSync`, `existsSync`, `statSync`, `readdirSync`) all
  operate on the corresponding `/$bunfs/...` paths (Experiments 1, 2).
- **`readdirSync`/`readdir` on an embedded directory now works, including
  `{ recursive: true }`** (Experiment 1: `readdirSync(lensesDir)` →
  `["b.md", "a.md"]`; recursive form returned the full nested tree). This
  matches the Bun 1.4 blog's explicit claim: *"`node:fs` now treats
  `/$bunfs/` as a real directory tree: `existsSync`, `statSync`, `lstatSync`,
  `accessSync`, `readdirSync`, and `fs.promises.readdir` (including
  `{ withFileTypes: true }` and `{ recursive: true }`) all work on embedded
  paths."* This is the load-bearing fact for Gauntlet: it directly answers
  "can you list a directory of embedded assets with `readdirSync`" — yes.
- **Crucially, this is not specific to `--asset`.** Experiment 3 rebuilt
  Gauntlet's *actual current mechanism* — two files individually imported
  with `with { type: "file" }`, no `--asset` flag at all — and
  `readdirSync(join(import.meta.dir, "typefile", "lenses"))` still returned
  `["a.md", "b.md"]`. The 1.4 `node:fs`/`/$bunfs/` improvement is a runtime
  change independent of which embedding API produced the files.
- Both sync and async (`fs.promises.readdir/readFile/stat`) forms were
  verified working on embedded paths (Experiment 2), which is the API shape
  `@effect/platform-node`'s `NodeFileSystem` actually calls.

## Q3 — Would `@effect/platform-node`'s `FileSystem` read these paths unchanged?

**Yes.** Read directly from
`node_modules/.bun/@effect+platform-node-shared@4.0.0-rc.110.../dist/NodeFileSystem.js`:

```js
import * as NFS from "node:fs";
...
const readDirectory = (path, options) => Effect.tryPromise({
  try: () => NFS.promises.readdir(path, options),
  ...
});
const readFile = path => Effect.callback((resume, signal) => {
  NFS.readFile(path, { signal }, (err, data) => { ... });
  ...
});
```

`FileSystem.readDirectory` and `FileSystem.readFileString`/`readFile` are
thin wrappers over exactly the `node:fs`/`node:fs/promises` calls verified
working on `/$bunfs/` paths in Experiment 2 (async `fsp.readdir`,
`fsp.readFile`, `fsp.stat` all succeeded against an embedded directory).
There is no other indirection (no custom Node bindings, no libuv path
translation) between the Effect `FileSystem` service and plain `node:fs` —
so yes, the same `FileSystem.FileSystem` calls `lens.ts` already uses for the
non-compiled (`checkout`) path would work unchanged for a compiled binary
too, once the target directory's files are embedded by any mechanism.

## What this means for `lens.ts` and `bundle.mjs`

### `src/content/lens.ts`

The entire compiled-binary special case can go:

- Delete `embeddedLensNames` and the `declare const Bun: { embeddedFiles... }`
  ambient declaration.
- Delete the `isCompiledBinary && lensesDirectory.startsWith(...)` branch in
  `listLensNames` — always go through `fs.readDirectory` +
  `path.extname`/`path.basename`, exactly as the non-compiled path does today.
- `isCompiledBinary` and `ContentDirectory` (the `$bunfs`/`~BUN`-detecting
  path-prefix logic that picks `content/` next to the bundle root vs. two
  levels up from `src/content/`) still need to exist — that part isn't about
  listing, it's about *where* the content directory lives relative to
  `import.meta.dirname`, which differs between checkout and compiled binary
  regardless of the `--asset`/`readdirSync` fix. Keep it.
- `loadLens`'s `fs.readFileString(lensPath)` call is already mechanism-
  agnostic and needs no change.

Net effect: `lens.ts` loses roughly the `embeddedLensNames` function, the
`Bun.embeddedFiles` ambient declaration, and one branch in `listLensNames` —
call it ~15–20 lines removed, no new code added, since listing now goes
through the one code path both modes already share.

### `scripts/bundle.mjs`

Two independent things happen in this file today: (1) building the transient
entry module that imports every content `.md` file with
`with { type: "file" }`, and (2) invoking `bun build --compile`. Given the
`.md` glob spans both a clean directory tree (`content/lenses`,
`content/prompts`) and one scattered file under `src/`
(`src/stages/judgment/judge.md`), and `--asset` embeds whole directories with
no extension filter, a full switch to `--asset` for everything isn't safe —
`--asset=./src` would also embed every `.ts` source file.

Sketch of the reduced version:

```js
// Content directory tree: hand it to Bun's own recursive embedder — no
// entry-module generation, no per-file globbing needed for this part.
const buildArgs = [
  "build", "--compile",
  "--no-compile-autoload-bunfig",
  "--asset=content",
  "--asset-naming=[dir]/[name].[ext]",
  entryFile, "--outfile", "dist/gauntlet",
]
```

with `entryFile` shrunk to just:

```js
writeFileSync(entryFile, [
  `import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"`,
  `registerBunOAuthFlows()`,
  // Stage-owned .md templates outside content/ still need explicit
  // type: "file" imports — there's exactly one today.
  `import "./src/stages/judgment/judge.md" with { type: "file" }`,
  `import "./bin/gauntlet.mjs"`,
  "",
].join("\n"))
```

This removes the `readdirSync("content/...")` + `readdirSync("src", {
recursive: true })` glue and the per-file import-statement generation for
`content/`, while leaving the one scattered `src/**/*.md` file on the
existing (already-working, unaffected-by-any-of-this) explicit-import
mechanism. If more scattered stage `.md` files are added later, each needs
its own explicit import line (or a "collect just the .md files" fallback
list can stay for that subset only — it no longer needs to include
`content/`).

## Caveats / open items

- `--asset`'s no-glob, embed-everything-in-the-directory behavior is the one
  hard blocker to treating `--asset` as a full replacement — it works great
  for `content/` (already `.md`-only, plus a harmless `README.md`) but not
  for `src/` as a whole.
  This makes the write-up's title claim ("replace") only partially true: it
  replaces the `content/` half of the mechanism, not the scattered stage
  `.md` file.
- The `readdirSync`-on-`/$bunfs/` fix is what actually removes the
  `embeddedLensNames` special-casing — this holds independent of whether
  `bundle.mjs` adopts `--asset` at all. Even keeping the current per-file
  entry-module generation as-is, `lens.ts` can drop its special case, purely
  because of the Bun 1.4 runtime behavior change confirmed in Experiment 3.
- Default `--asset-naming` behavior around content hashing was ambiguous in
  one experiment (Experiment 8 showed unhashed names for a single-directory
  `--asset` build with no override) — not fully reconciled against the blog's
  `icon-a1b2c3d4.png` example, but irrelevant either way since
  `scripts/bundle.mjs` already pins `--asset-naming=[dir]/[name].[ext]`
  explicitly.
- All experiments were run and the resulting binaries executed on this
  machine's Bun 1.4.0 with the required `codesign --sign - --force` step
  (macOS ad-hoc signature regression noted in `scripts/bundle.mjs`); this is
  the same pinned version and same signing workaround Gauntlet's own build
  already uses, so no version-skew risk in these findings.

## Experiments (scratchpad, all under `bun-asset-test/`)

1. Directory embed + naming template + full `node:fs` surface: `--asset=./assets --asset-naming="[dir]/[name].[ext]"` → `readdirSync`, recursive `readdirSync`, `readFileSync`, `statSync`, and `Bun.embeddedFiles` all succeeded against `/$bunfs/root/assets/lenses`.
2. Same tree, `node:fs/promises` (async) surface: `fsp.readdir`, `fsp.readFile`, `fsp.stat` all succeeded — this is the exact API shape `NodeFileSystem` calls.
3. **Reproduced Gauntlet's current mechanism** (two `with { type: "file" }` imports, no `--asset` flag) and confirmed `readdirSync` on the resulting embedded directory still works under Bun 1.4.0.
4. `--asset="./assets/**/*.md"` → hard failure, `ENOENT`, proving no glob support.
5. Two separate `--asset` directories (`./assets`, `./assets2`) both embedded correctly, each keyed by its own relative path.
6. Mixed-extension directory (`mixed/keep.md`, `mixed/other.ts`, `mixed/deep/nested/z.md`) via `--asset=./mixed` → all three embedded regardless of extension or depth.
7. Single-file `--asset` flags (`--asset=./mixed/deep/nested/z.md`, `--asset=./mixed/keep.md`) → embedded as bare `z.md`/`keep.md`, directory context lost.
8. Single directory, default `--asset-naming` (no override) → unhashed names observed (`lenses/a.md`, `lenses/b.md`).

All binaries were re-signed with `codesign --sign - --force <binary>` before
execution, per the known Bun 1.4.0 macOS ad-hoc-signature regression already
documented in `scripts/bundle.mjs`.
