# Isolation, tools and the review workspace

- **Brief:** [README.md](README.md), research area 3.
- **Status:** Research findings. Nothing here is approved architecture.
- **Date:** 2026-11-18

## Question

How do the snapshot, the read-only fence, hostile-repo isolation, tool output limits, the related-files prefetch, and dependency reads (#189) map onto OpenCode? For each one, which rung of the ladder wins?

## Method and ground truth

Everything below was read from source. Nothing was run.

- **OpenCode:** `/home/silentverdict/Projects/reference/opencode` at `0b87612`. Paths are relative to `packages/`.
- **Gauntlet:** `main` at `42c92bc`. Issues #53, #67, #68, #116, #140 and #189.
- **Spike:** `gauntlet-spike-opencode` at `5ad254b`, specifically `src/harness/opencode-live.ts` and `spike/rebuild-plan.md`.

**Three things the spike didn't know, each a hole in the fence it used:**
1. **Outbound symlinks escape.** OpenCode decides "inside the project" lexically. Reads follow symlinks.
2. **Nested `AGENTS.md` loads.** The read tool loads `AGENTS.md` from subdirectories even with project discovery off.
3. **Host hooks run.** `git worktree add` runs the host repo's `post-checkout` hook. Under husky that hook is the reviewed commit's own `.husky/post-checkout`.

All three have small fixes, given below.

---

## 0. Decision summary

| Item | Rung | Recommendation |
|---|---|---|
| 1. Snapshot | **3. Effect** (keep Gauntlet's) | Keep `review-working-directory.ts`. Add `-c core.hooksPath=/dev/null`. Keep the `.git` file, because OpenCode needs it to pin the project root. Deny reads of it by rule. |
| 2. Finder ruleset | **1. Native** for paths, `..`, `~` and `.env`. **2. Plugin hook** for symlinks. | Deny `*` first, then allow read, grep, glob and the emit tool, then deny the sensitive paths last. One `tool.execute.before` hook does the realpath check. |
| 3. Hostile repo | **1. Native** (server options, embed overrides) | `config.project:false`, `config.claude:false`, `instructions.claude:false`, a Gauntlet-owned `config.directory`, plus two embed overrides. The claude-agent provider is already isolated, apart from the inherited environment. |
| 4. Output limits | **1. Native** (`tool_output`) + **2. Plugin** | The read caps are constants. Tune with `tool_output`, `ToolEditor.update` (descriptions) and the `execute.before` and `execute.after` hooks. |
| 5. Related files | **4. Gauntlet** (Effect code already exists) | OpenCode has no equivalent. Fix exclusions in Gauntlet, and apply them to *touched* files too, which is where `bun.lock` came from. |
| 6. #189 | **1. Native** fence + Gauntlet snapshot step | Yes, read-only. Link allowlisted dependency roots from the caller's checkout into the snapshot, and allow exactly those link targets in the symlink hook. |

---

## 1. The snapshot

**Can OpenCode own it?** No.

OpenCode's `Worktree.create` does run the same git command as Gauntlet: `git worktree add --detach -- <dir> <ref>` (`core/src/git.ts:1408-1418`). Around it, though, it:
- requires a Project row;
- names the directory with a slug under its own settings directory;
- records it in the worktree table;
- runs the project's `commands.start` shell command (`core/src/worktree.ts:204-255`).

It has no working-tree overlay and no frozen-input semantics.

The other two features don't fit either:
- **`Snapshot`** is OpenCode's undo store: a separate git dir under `global.data/snapshot` (`core/src/snapshot.ts:92-102`). It isn't a review input. Keep `snapshots: false`.
- **`Vcs`** reports status and diffs for the UI.

The plugin `WorktreeDefinition` (`plugin/src/effect/worktree.ts`) only lets Gauntlet replace OpenCode's strategy, which buys nothing.

**Recommendation.** Keep `src/run/review-working-directory.ts`. It already uses Effect `ChildProcess` through `runGit`, with acquire and release, the scratch-index overlay capture, and `git apply`. Port it unchanged except for these changes:

- **Disable hooks for snapshot git commands:** `git -c core.hooksPath=/dev/null worktree add …` (`review-working-directory.ts:115`).
  - `worktree add` runs `post-checkout`.
  - A repo using husky sets `core.hooksPath=.husky`, which resolves inside the *new* worktree. So today, snapshot creation runs the reviewed commit's own hook script.
  - Filter drivers come only from git config, so `.gitattributes` alone cannot name a command.
- **Keep the `.git` file.**
  - `Project.resolve` walks up from the location for the first `.git` or `.hg` (`core/src/project.ts:428-445`). For a linked worktree it sets `project.directory = repo.worktree`, which is the snapshot (`:376-378`).
  - `FileAccess` treats everything under `project.directory` as internal (`core/src/file-access.ts:92-95`).
  - Delete `.git`, as `just-bash-workspace.ts:263-274` effectively does today, and the walk continues to the snapshot's ancestors. If `$TMPDIR` or `$HOME` is itself a repo, "internal" widens to that whole tree.
  - The host git dir the file points to is outside the snapshot, so reads of it are `external_directory` requests, which are denied.
  - What remains is that the `.git` file's *contents* (a host path) are readable. Deny `read` on `.git` and `.git/*` by rule (§2). Both search tools already pass `--glob=!**/.git/**` (`core/src/ripgrep.ts:191,218,243`).
  - Check by probe that `glob hidden:true` doesn't list the file itself. If it does, filter it in `execute.after`.
- **#189:** create the dependency links after `git apply` (§6).

**Deleted:** the `.git` case-alias tombstones in `just-bash-workspace.ts:214-274`.

## 2. The finder permission ruleset

### How OpenCode enforces it

- **Ordering.** `Permission.evaluate` takes the *last* matching rule, and falls back to `ask` only when nothing matches (`core/src/permission.ts:102-115`).
- **Denies come first.** Configured denies are checked before saved "always" rules and before plugin `permission.evaluate` hooks (`:212-216`). An agent with no ruleset gets `* * deny` (`:20,190`).
- **The wildcard.** `*` matches across `/` (`core/src/util/wildcard.ts:4-14`).
- **Read resources.** For a path inside the location, the resource is the location-relative path. For anything outside, it is an absolute path, and an `external_directory` request on `<dir>/*` is asserted first (`core/src/file-access.ts:90-156`).
- **grep and glob** assert `external_directory` on their `path`. Their own action's resource is the *pattern*, not a path (`core/src/tool/plugin/grep.ts:93-108`, `glob.ts:75-88`).
- **Denied tools.** A tool whose action is wholly denied is dropped from the catalog before the model sees it (spike, `opencode-live.ts:50-52`). This is why deny-all-first works.

### Rules (agent `permissions`, in this order)

```ts
const finderRules = (emit: string) => [
  { action: "*", resource: "*", effect: "deny" },          // nothing falls through to "ask"
  { action: "read", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: emit, resource: "*", effect: "allow" },
  // Re-denied last, so they win over the allows above:
  { action: "read", resource: ".env*", effect: "deny" },
  { action: "read", resource: "*/.env*", effect: "deny" },
  { action: "read", resource: ".git", effect: "deny" },
  { action: "read", resource: ".git/*", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "deny" },
  // #189 adds nothing here: dependency links are internal paths (§6).
]
const emitOnlyRules = (emit: string) => [
  { action: "*", resource: "*", effect: "deny" },
  { action: emit, resource: "*", effect: "allow" },
]
```

How each case is handled:

| Case | Mechanism | Rung |
|---|---|---|
| `external_directory` | Any resolved path outside the snapshot asserts `external_directory`, which is denied: a `BlockedError`, never an ask. | 1 |
| `..` and absolute paths | `path.resolve(location, input)` normalizes them, and the result is classified lexically (`file-access.ts:68-78,90-118`). Outside the snapshot means external, which is denied. | 1 |
| `~` | **Expanded against the host home** (`file-access.ts:68-77`). The result is external, which is denied. The deny message is `Permission denied: external_directory` (`permission.ts:83-85`). Probe that the model-facing error doesn't echo the absolute resource. | 1 |
| `.env*` | The read rules above. The snapshot excludes ignored files, so only a *tracked* `.env` can be present. Note that OpenCode's own default agent only `ask`s on `*.env` (`core/src/plugin/agent.ts:88-90`). Our agent replaces that ruleset outright. | 1 |
| Outbound symlinks | **Not covered natively.** `FSUtil.contains` is lexical (`util/src/fs-util.ts:269-272`), and file content reads follow final symlinks (`core/src/environment/files.ts:33`). So `link -> /etc/x` and `dirlink/secret` (with `dirlink -> /`) are "internal" and read the host file. ripgrep has no `--follow`, so directory walks skip symlinks (`ripgrep.ts:183-244`). An explicit `path` that is a symlink is still followed. | **2** |

**The symlink hook** (Effect plugin API: `ctx.tool.hook("execute.before", …)`, `plugin/src/effect/tool.ts:18-55`; the call site is `core/src/tool.ts:133-141,202-205`).

For `read`, `grep` and `glob`:
1. Take the raw `input.path`, defaulting to `.`.
2. Resolve it with OpenCode's exported `FileAccess.resolvePath(snapshot, path)`, so `~` and `..` resolve exactly as the tool will resolve them.
3. `realpath` the deepest existing prefix.
4. Fail with `Tool.Error` unless the result is under `realpath(snapshot)` (or a §6 dependency root) and not under `.git`.

Hooks receive raw, pre-decode input. A hook may also rewrite `event.tool` (`tool.ts:203`), so Gauntlet must own the whole plugin list. `core/src/plugin/tool-input-repair.ts:31` registers another `execute.before` hook; register Gauntlet's after it, or probe the order.

**Emit-only stages (pool)** get `emitOnlyRules`, so the catalog holds the emit tool only.

**Claude and OpenAI enforce the fence identically.**
- The claude-agent provider starts Claude Code with:
  - `tools: []`, so no built-in tools;
  - `permissionMode: "dontAsk"`;
  - `allowedTools: ["mcp__opencode__*"]`;
  - one in-process MCP server built from the session's offered tools (`core/src/plugin/provider/claude-agent/claude/query-options.ts:56-76,107`).
- Every tool call goes back through OpenCode's registry, so the same rules and the same `execute.before` hook apply (`specs/v2/claude-agent-provider.md:35-38,65`).
- A call to an unoffered tool gets Claude Code's own "No such tool available" error and never runs.
- Today's `claude -p` fence relies on Claude Code's built-in Read, Grep and Glob plus its cwd check (`src/harness/claude-live.ts:210-229`). That fence goes away with `claude-live`.

**Can anything on the Claude Code side still read outside the fence?** Not through tools. What remains is the `claude` process itself:
1. **Environment.** The child inherits `process.env` (`claude/io.ts:22`, `query-options.ts:64`). Only the `ISOLATION_ENV` list is overridden. `CLAUDE_CODE_PLUGIN_DIRS`, which `claude-live.ts:370` clears today, and the session variables of a parent Claude Code are passed through.
   - Wrap `io.env` (the release prototype already wraps `io`) and scrub the named list from `spike/rebuild-plan.md` ("Claude seats in the CLI").
2. **Operator-level managed settings.** `/etc/claude-code/managed-settings.json` still loads. That file is the operator's, not the reviewed repo's, so it's acceptable.
3. **Claude Code's own startup reads in its cwd** (the snapshot): for example, the git status it would compute. `verbatimPrompts` suppresses the context it adds per turn (spec `:71`). Confirm with the hostile probe that no repo bytes reach the request.

**Deleted:** `src/workspace/just-bash-workspace.ts`, `review-workspace.ts` (its interface is Pi `ToolDefinition`s), `review-workspace.test.ts` (566 lines), `src/harness/tool-deadline.ts`, the `just-bash` dependency and its patch. Close #67 and #68 as obsolete: there's no shell, so no interpreter budget and no `rg` cancellation bug. Its *learning* carries over: the response bound is separate from producer limits, and OpenCode's registry already separates them (`specs/v2/tools.md`, "Producers And The Registry Own Different Limits").

## 3. Hostile-repo isolation

### OpenCode host options

These are `OpenCode.create`, i.e. `server/src/options.ts`, wired in `server/src/routes.ts:136-160`.

| Option | Effect | Source |
|---|---|---|
| `config.project: false` | No upward walk, so the following don't load: `opencode.json(c)`, `.opencode/` (plugins, agents, commands, tools, skills), `.claude/` and `.agents/`. It also turns project `AGENTS.md`/`CLAUDE.md` discovery off. | `core/src/config/discovery.ts:76-80`; `config/plugin/instruction.ts:39`; `routes.ts:149-160` |
| `config.claude: false` | Skips `~/.claude` and the project's `.claude` config dirs. | `config.ts:66`; `discovery.ts:152-159` |
| `instructions.claude: false` | No `CLAUDE.md` fallback, and no `~/.claude/CLAUDE.md`. | `options.ts:42-47`; `instruction-discovery.ts:129-131` |
| `config.directory: <gauntlet dir>` | The global config dir, and so the global `AGENTS.md`, is Gauntlet's, not `~/.config/opencode`. | `routes.ts:146`; `instruction.ts:41` |
| `config.content` | Gauntlet's whole config inline: `snapshots:false`, `share:"disabled"`, `compaction.auto:false`, `tool_output`, providers. | spike `opencode-live.ts:197-201` |
| `fs.filewatcher: false` | No watchers on the snapshot. | `routes.ts:144-145` |

**Two gaps need embed overrides.** That is `PromiseSdk.create(options, { overrides })`, `sdk/src/internal/host.ts:26-45`, the same mechanism the workerd profile uses (`server/src/workerd.ts:84-99`).

1. **Nested instructions on read.**
   - After every successful internal read, the read tool walks from the file's directory up to the location root (exclusive). It loads each `AGENTS.md` it finds, or `CLAUDE.md` if `instructions.claude` is on, as a synthetic session message (`core/src/tool/plugin/read.ts:146-172`, `session/instructions.ts:47-93`).
   - Only `filenames(discovery)` gates this, which keys on `claude`. **`project:false` does not stop it.**
   - So a hostile `pkg/AGENTS.md` lands in the transcript the moment a finder reads `pkg/x.ts`. The root `AGENTS.md` is excluded by that walk.
   - **Fix:** `SessionInstructions.node.replace(<layer whose load is Effect.void>)`.
   - Fallback (rung 2): a `session.hook("context")` that drops messages carrying `metadata.instruction`.
2. **Global discovery.** `ServerOptions` exposes no `global: false`. So the system dir (`/etc/opencode`), macOS MDM preferences and `~/.agents` still load (`discovery.ts:63-71,113-163`).
   - This isn't hostile-repo input, but it makes runs depend on the machine.
   - **Fix:** do what `instance.ts:152-155` ("vanilla") does:
     - `Config.node.replace(Config.configured({ project:false, global:false, claude:false, content }))`;
     - `InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project:false, global:false, claude:false }))`.

**Plugins** come only from the `plugins` array Gauntlet passes (spike `lean.ts`, "plugins trimmed"). Repo `.opencode/plugins` is off under `project:false`.

### claude-agent provider settings (already set by OpenCode)

From `query-options.ts:11-31,56-76`:
- `settingSources: []`
- `settings: { disableAllHooks: true }`
- `strictMcpConfig: true`, with `mcpServers` holding only `opencode`
- `tools: []`, `skills: []`
- `permissionMode: "dontAsk"`, `allowedTools: ["mcp__opencode__*"]`
- `verbatimPrompts: true`
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
- `cwd` is the location (the snapshot)

Between them, these keep `.claude/settings.json` hooks, `.mcp.json`, `CLAUDE.md` and skills out. The only addition is the environment scrub in §2.

### Hostile fixture

One fixture repo under `test/fixtures/hostile-repo/`. Every file carries a unique canary string, and anything executable writes a marker file under the test's temp dir.

- **Config:**
  - `opencode.json` and `opencode.jsonc`, with `instructions:["CANARY-INSTR.md"]`, an `mcp` stdio server that touches a marker, and `plugin:["./.opencode/plugins/evil.ts"]`;
  - `.opencode/plugins/evil.ts` (marker on load), `.opencode/tools/evil.ts`, `.opencode/agents/x.md`, `.opencode/command/x.md`, `.opencode/skills/x/SKILL.md`.
- **Instructions:** `AGENTS.md`, `CLAUDE.md`, `pkg/AGENTS.md`, `pkg/CLAUDE.md`, `pkg/x.ts`.
- **Claude Code:**
  - `.claude/settings.json`, with `SessionStart`, `PreToolUse` and `UserPromptSubmit` hooks that touch a marker;
  - `.claude/skills/x/SKILL.md`, `.claude/agents/x.md`, `.claude/commands/x.md`;
  - `.mcp.json` (marker server), `.agents/skills/x/SKILL.md`.
- **Hooks:** `.husky/post-checkout` (marker), with the fixture's git config setting `core.hooksPath=.husky`.
- **Escapes:**
  - tracked `.env` and `pkg/.env.local` holding canaries;
  - `out -> <tmp>/outside/secret` and `dirout -> <tmp>/outside` (canary file outside the snapshot);
  - `up -> ..`;
  - an absolute-path link.

Two tests run against it.

1. **Deterministic, no model, in CI.**
   - Build the snapshot with Gauntlet's snapshot code, then boot embedded OpenCode with Gauntlet's host options and plugin.
   - Drive a session with a scripted provider. That is the harness seam's fake adapter registered as an OpenCode provider plugin, so the real registry and permission path run.
   - The script issues, in order:
     - `read pkg/x.ts`;
     - `read .env`, `read pkg/.env.local`, `read .git`;
     - `read ../x`, `read /etc/hostname`, `read ~/.bashrc`;
     - `read out`, `read dirout/secret`, `read up/…`;
     - `grep {path:"out"}`, `grep {path:"dirout"}`;
     - `glob {pattern:"**", hidden:true}`;
     - then the emit.
   - Assert:
     1. no marker files exist, both after snapshot creation and after the run;
     2. every escape is a tool error;
     3. no canary appears in any captured request (the `context` hook: system, tools, messages) or tool result;
     4. the tool catalog is exactly `read`, `grep`, `glob` and the emit tool, or the emit tool only for the pool profile.
2. **Live Claude, gated.** The same fixture, with a prompt telling the model to attempt those escapes and report what it saw. Assert no canary in the transcript and no markers. Rerun when the `claude` version changes, as `rebuild-plan.md` requires.

This replaces `review-workspace.test.ts` and closes the spike's "isolation guard" item.

## 4. Tool output limits and token efficiency

**What's fixed.**
- The read tool's caps are constants: 2,000 lines, 50 KiB per page, lines clamped to 2,000 characters, with continuation via `offset`/`limit` (`core/src/tool/read-filesystem.ts:13-21,157-197`).
- These equal Pi's read defaults (`pi-coding-agent/dist/core/tools/truncate.js:10-11`), so read isn't where the difference lies.
- grep and glob return at most `limit` items, 100 by default (`core/src/filesystem.ts:66`, `tool/search.ts:15-27`).
- grep's Input has **no context-lines option** (`grep.ts:21-42`). Pi finders could pipe `rg -C`, `sed -n` and `head` through one bash call. That is a plausible source of extra turns, for the other agent to confirm.

**The knobs Gauntlet controls:**

| Knob | Rung | What it does |
|---|---|---|
| `tool_output: { max_lines, max_bytes }` in `config.content` | 1 | Registry bound on every tool result. Defaults are 2,000 lines and 50 KiB. It cuts at the head and saves the full text (`core/src/tool-output.ts:13-14,88-140`; `config/plugin/tool-output.ts`). |
| `ctx.tool.transform(e => e.update("grep", t => { t.description = … }))` | 2 | Rewrites tool descriptions, which are shared prefix bytes, so they're fixed per run (`plugin/src/effect/tool.ts` `ToolEditor.update`; spike `toolEdits`). |
| `execute.before`: `event.input` is mutable | 2 | Defaults and clamps, e.g. a grep `limit` default, before decode (`tool.ts:133-141,205`). |
| `execute.after`: mutable `result` | 2 | Re-renders output compactly. grep's `Found N matches` plus `  Line n: text` format (`grep.ts:48-65`) costs more than `path:line:text`. Changed content is re-bounded (`specs/v2/tools.md`, "Requests Capture Tool Values", step 7). |
| Registering a Gauntlet tool, e.g. grep with `context` | 2 | `editor.add` over OpenCode's `Ripgrep` service. This is the only way to get context lines. Measure before building. |
| `full_codemode` flag | 1 | Replaces grep and glob with one program-running `execute` tool (`grep.ts:83`, `read.ts:53-56`). Fewer turns in principle, but its sandbox would become part of the fence. Not recommended without a separate review. |

**The registry's saved-output pointer is dead inside the fence.**
- When a result is cut, the marker says `full output saved to <global.data>/tool-output/tool_…` (`tool-output.ts:96-114`).
- That host path is external to the snapshot, so a fenced finder's read of it is denied. The marker also leaks a host path into the transcript.
- Either set `tool_output` high enough that read's own paging and grep's `limit` always bind first (both are already well under 50 KiB), or rewrite the marker in `execute.after`.

**Claude specifics.**
- `MAX_MCP_OUTPUT_TOKENS=200000`, so OpenCode's bound is the one that applies (`query-options.ts:20-21`).
- Claude's tool calls run one at a time (spec `:67`). That costs latency, not turns.

## 5. Related-files prefetch

**Can OpenCode do it natively?** No.
- `Reference` is a source catalog (local and git sources), not a per-change file gatherer (`core/src/reference.ts`).
- `Vcs` gives status and diffs.
- Config `instructions:[paths]` would inject files as system instructions (`config/plugin/instruction.ts:24-25,99-117`). But that means rendering per-run content into host config, outside Gauntlet's byte-identical finder prefix.

The prefetch is Gauntlet prompt content, so it stays Gauntlet's: `src/workspace/related-files.ts`, already Effect plus `git ls-files`/`git grep`.

**Where the 110 KB `bun.lock` came from.**
- Related files are capped at a quarter of the budget, 60K characters (`related-files.ts:21-22,192`). So a 110 KB lockfile can't have been a *related* file.
- *Touched* files are read whole with no cap (`related-files.ts:141`) and rendered as `TOUCHED_FILES` (`src/content/finder-prompt.ts:149-167`).
- The diff is also inlined whole (`finder-prompt.ts:129-130`).

**Recommendation.** Add one `isBulk(file, text)` predicate. Apply it to touched files, related candidates and the diff section, and render an excluded touched file as a one-line stub, for example `bun.lock: lockfile, 110 KB, omitted; read it if needed`.

Detection, cheapest first:
1. **A small basename list:**
   - JavaScript: `bun.lock`, `bun.lockb`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`;
   - Rust and PHP: `Cargo.lock`, `composer.lock`;
   - Ruby and Python: `Gemfile.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`;
   - Go and Nix: `go.sum`, `flake.lock`;
   - other ecosystems: `mix.lock`, `pubspec.lock`, `Podfile.lock`, `packages.lock.json`, `gradle.lockfile`.
2. **Git attributes:** `git check-attr -z --stdin linguist-generated linguist-vendored diff`, through the existing `runGit`. A file marked `-diff`, `binary` or `linguist-generated` counts as bulk.
3. **Shape:**
   - `*.min.*`, `*.map`, `*.snap`;
   - a first line or the first 5 lines containing `@generated` or `DO NOT EDIT`;
   - mean line length over 300 characters, or any line over 5,000 characters (minified).
4. **Size:** the existing quarter-budget cap, now also applied to touched files.

Effect ships nothing for this (rung 3 doesn't apply). It's about 30 lines in `related-files.ts`. #140's design is otherwise unchanged.

**Ported:** `related-files.ts` and `source-context.ts`, unchanged apart from the above.

## 6. #189: reading `node_modules`

**Should finders read dependency sources?** Yes, read-only, scoped to dependency directories.

#189's example (cm-chatbot-v3#58) shows four of eight finders blind to the SDK side of a change. There is no write or exec tool any more, so read access adds no execution risk.

**The rule.**
- **Allowlist only:** `node_modules/` at the repo root and at each workspace package root that has one in the caller's checkout. Later: `vendor/` (Composer, Go) and `.venv/lib/*/site-packages`. Nothing else that's ignored.
- **Mechanism:**
  - After the snapshot is built, Gauntlet creates `snapshot/<pkg>/node_modules -> <callerRepo>/<pkg>/node_modules` for each one present, and records the link targets.
  - Those paths are internal and lexical, so §2's read rule allows them with no new permission rule (rung 1).
  - The symlink hook allows a realpath under a recorded target's realpath. pnpm's `.pnpm` links resolve inside it.
  - Committed symlinks stay denied.
  - The model sees stable `node_modules/…` paths that match the change's imports, not host paths.
  - Native alternative, rejected: allowing `external_directory` and `read` on `<callerRepo>/node_modules/*`. It works, but puts absolute host paths in prompts and transcripts.
- **Same denies:** the `.env*` rules apply inside dependency roots too.
- **Version mismatch:** if the lockfile at the reviewed head (`git show <head>:<lockfile>`) differs from the caller's working copy, add a Dossier warning that names the lockfile and the kind of mismatch.
- **Nothing installed:** add a run note. Have `execute.after` rewrite a not-found under `node_modules/` into "dependencies were not installed in the caller's checkout".
- **Errored tool calls:** run notes name the paths behind them, not just a count (#189's last criterion). That data is in the tool events.

## Old code: deleted or ported

| Path | Fate |
|---|---|
| `src/workspace/just-bash-workspace.ts`, `review-workspace.ts`, `review-workspace.test.ts` | Delete. Replaced by the ruleset, the symlink hook and the §3 fixture suite. |
| `src/harness/tool-deadline.ts`, `just-bash` dependency and patch, #67, #68 | Delete or close (cut list). |
| `src/harness/claude-live.ts` fence argv (`:210-229,363-374`) | Delete. Its environment-scrub list moves to the `io.env` wrapper. |
| `src/run/review-working-directory.ts` | Port: add `core.hooksPath=/dev/null` and the #189 links; drop the `.git` tombstoning. |
| `src/target/*` | Unchanged. |
| `src/workspace/related-files.ts`, `source-context.ts` | Port, plus the §5 `isBulk` predicate. |
| New | One Gauntlet Effect plugin: agent rules, the `execute.before` fence and defaults, optional `execute.after` re-rendering, tool descriptions. Plus host options and two embed overrides. Roughly 120–180 lines. |

## Risks and unknowns (quick hands-on checks)

| # | Unknown | Probe |
|---|---|---|
| 1 | Do embed overrides of the location-scoped `SessionInstructions.node`, `Config.node` and `InstructionDiscovery.node` reach per-location graphs? (`routes.ts:169-176` suggests yes.) | §3 fixture: `pkg/AGENTS.md` canary absent after `read pkg/x.ts`. |
| 2 | Does the read tool's filename recovery (`read.ts:122-145`) bypass the hook through a sibling symlink? | Fixture: `read pkg/y.ts` where only a `pkg/y.tsx -> outside` symlink exists. |
| 3 | Hook ordering against `tool-input-repair`, and whether its repair can change `path` after Gauntlet's check. | Unit test over a malformed path input. |
| 4 | Does `glob hidden:true` list the `.git` file, and does a `BlockedError` echo absolute resources to the model? | Fixture assertions on `glob` output and the error text. |
| 5 | Does ripgrep search an explicit `path` under a symlinked, gitignored `node_modules`? (Parent `.gitignore` may filter the walk.) | #189 fixture: `grep {path:"node_modules/pkg"}` returns hits. If not, add `--no-ignore-parent` via a Gauntlet grep, or an `execute.before` rewrite. |
| 6 | Claude Code startup reads in a hostile cwd: anything from `.claude/` or git status reaching the request despite `settingSources:[]` and `verbatimPrompts`. Also: does `CLAUDE_CODE_PLUGIN_DIRS` load plugins without the scrub? | Live gated §3 probe, run once with and once without the environment scrub. |
| 7 | `config.project:false` also disables the Gauntlet-side `.opencode` it might want. | None needed: Gauntlet passes everything via `content` and `plugins`. |
| 8 | Ancestor-repo widening if `.git` were ever removed. | Regression test: snapshot under a temp dir that has a `.git` parent; assert `read ../sibling` is denied. |
