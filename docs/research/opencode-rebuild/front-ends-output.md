# Front ends and output: MCP, digest, run records, delivery, spec sources, CLI

- **Date:** 2026-11-18
- **Scope:** item 4 of the rebuild brief (`README.md` in this folder): `gauntlet mcp`, the run directory, the digest, PR delivery, `--spec`, and the CLI surface.
- **Baseline:** Gauntlet `main` at `42c92bc`; effect 4.1.4 (`node_modules/effect/src/ai`); OpenCode reference checkout `0b87612` (2.3.x); installed clients Claude Code 2.1.327, codex-cli 0.170.0 and OpenCode 2.3.2.
- **Evidence from `~/.gauntlet/runs`** (read only): 211 runs, 685 MB; 53 pull-request runs; 0 `receipt.json` files.

## Bottom line

| # | Item | Winning rung | Recommendation |
|---|---|---|---|
| 1 | `gauntlet mcp` | 3, Effect `McpServer.layerStdio` | OpenCode has no MCP server, and its ACP server exposes chat sessions. Build three tools on Effect's toolkit, and run reviews in the server's scope. |
| 2 | Run records | Mostly 4, with OpenCode for usage | Keep the six files and add a `run.json` (owner, terminal state, usage, session ids). Use one OpenCode database per machine under `~/.gauntlet/opencode/`, and remove each run's sessions when the run ends. |
| 3 | Digest | 4, with one renderer kept | Rewrite `digest.ts`. Keep `dossier-markdown`, `dossier-view`, `target-text` and the `page-data.json` writer. Delete the HTML page, `page`, `brief`, and `markdown-it`. OpenCode artifacts don't help. |
| 4 | PR delivery | 4, Gauntlet's `gh` code | OpenCode 2.x has no GitHub PR integration. Delivery never posted because nobody asked it to (0 receipts in 53 PR runs), not because of a bug. Fix one latent bug: posting depends on `repoRoot` still existing. |
| 5 | Spec sources | 4 (cutting is the simplest path) | Delete Linear (about 1,060 lines). The GitHub lookup is about 700 lines plus tests, and gave a spec in 8 of 53 PR runs. I lean toward cutting it, but it's John's call. |
| 6 | CLI | 3, `effect/cli` as today | `review`, `deliver`, `config`, `login`, `upgrade`, `mcp`. Delete `page` and `brief`. Fold `src/syntax/` into the CLI and a shared request parser. |

---

## 1. `gauntlet mcp`

### What OpenCode offers: nothing usable

- **MCP is client-only.** `packages/core/src/mcp/` (`client.ts`, `stdio.ts`, `pool.ts`) connects to servers. The CLI's `opencode mcp` command manages client config: `list`, `add` and `auth` (`packages/cli/src/commands/commands.ts:238-262`). Nothing in core or the CLI serves MCP.
- **ACP is the wrong shape.** `opencode acp` ("Start an Agent Client Protocol server", `commands.ts:100-108`) wraps an `OpenCodeClient` in `@agentclientprotocol/sdk`'s `agent` (`packages/cli/src/acp/agent.ts:1-30`). It exposes prompt turns of a chat agent to editors such as Zed. Gauntlet's pipeline isn't a chat turn, and Codex, Claude Code and T3 Code don't speak ACP to tools.
- **No plugin route.** The Effect plugin API's `mcp.ts` transforms OpenCode's MCP client config (`packages/plugin/src/effect/`). Plugins can't publish a server.

### Rung 3: Effect has it all

- **Transport:** `McpServer.layerStdio({ name, version, protocols, registrations })` (`effect/src/ai/McpServer.ts:2644`). It needs the `Stdio` service, from `NodeStdio`/`BunStdio`.
- **Tools:** `McpServer.toolkit(Toolkit.make(...))` registers `Tool.make` definitions with Schema input and output (`McpServer.ts:3463`).
- **Progress:** a handler reads `McpRequestContext.requestMetadata.progressToken` (`McpSchema.ts:3203-3214`). It sends updates with `McpServer.notifications["notifications/progress"]` (`McpServer.ts:980-981`, `McpSchema.ts:1025`). Delivery goes only to the originating request's client (`McpServer.ts:2397-2412`).
- **Tests:** `McpTest.makeClient` runs the real JSON-RPC encoding in memory (`McpTest.ts:1-12`, `:102-113`), which fits the scripted-harness tests.
- **Protocols:** `McpProtocol` ships `v2024_11_05` through `v2025_11_25`, all stateful, plus `v2026_07_28`, which is stateless (`McpProtocol.ts:27`, `:211-254`). A runtime may mix several stateful adapters with at most one stateless one (`internal/mcpRuntime.ts:218-238`). On stdio, an `initialize` frame picks the stateful version (`mcpRuntime.ts:210-215`, `McpServer.ts:2715-2718`). A request that names a version in `_meta` routes to the stateless adapter (`mcpRuntime.ts:337-346`).

### Client protocol versions (installed binaries, by string scan)

| Client | Versions present | Behaviour seen in the binary |
|---|---|---|
| Claude Code 2.1.327 | 2024-11-05 … 2026-07-28 | Probes stdio servers with `server/discover`, then falls back to `initialize` ("speaks the new protocol … not remembering it as a legacy …"). The tool timeout is a "hard wall-clock limit per call; progress [does not] extend it." |
| codex-cli 0.170.0 | 2024-11-05 … 2026-07-28 | Also probes `server/discover` and falls back to legacy initialization. Its error strings include "server/discover method-not-found response did not match its request ID". Tool calls time out under `tool_timeout_sec`, which defaults to 60 s per Codex's docs. |
| OpenCode 2.3.2 | 2024-11-05 … 2026-07-28 | Uses `@modelcontextprotocol/client` 2.4.0 (`packages/core/package.json:110`). |
| T3 Code | Not a client itself | Its threads run on Claude Code or Codex, so the MCP client is that provider's. |

**Recommendation:** use `protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25, McpProtocol.v2025_06_18]`, so modern clients get the stateless revision and older ones can still `initialize`. If the hands-on check (risk 1) shows that `server/discover` misbehaves, drop `v2026_07_28`. The 60 s Codex timeout and Claude Code's hard per-call limit together justify the `review` + `review_wait` split, with a default of about 45 s and a cap of 55 s.

### Lifecycle

- **`review` returns once the inputs are frozen.**
  - Split `Run.review` (`src/run/run.ts:166-188`) into `prepare` and `execute`. `prepare` loads the addendum, then runs `submit`, which writes `plan.json` and freezes the snapshot. `execute` is `executeReviewPlan`.
  - The handler awaits `prepare`, so every refusal (bad target, no config, a bad spec) comes back as a tool error before any run exists. It then forks `execute` and returns the run id.
- **The run forks into the server's scope**, not the handler's.
  - Capture the layer's `Scope` once and use `Effect.forkIn(execute, serverScope)`.
  - The Effect runtime interrupts a handler fiber on client `notifications/cancelled` or a request timeout. That must end only the *wait*, never the run.
  - Keep each live run in a `Map<runId, { fiber, progress: SubscriptionRef, done: Deferred }>`.
  - When stdin closes, the server scope closes, so its runs are interrupted. Their finalizers write the terminal record and release the `claude` processes. That release is the README's "process release" requirement, and it lives in `harness.md`.
- **`review_wait` waits with progress.**
  - It races the run's `Deferred` against `timeout_seconds`.
  - While waiting, it sends `notifications/progress` only when the request carried a `progressToken`.
  - Every result also carries a one-line status, so a client that ignores progress still sees it.
  - The progress source already exists: the `RunMilestones` reference (`src/run/run-milestones.ts:16-55`), whose only consumer today is the mod. Provide it per run, and add one `FinderFinished { lens, candidates, cacheHitRate }` variant. Today that fact is only a stderr string (`progress-text.ts:11-17`).
  - For a run this process doesn't own, poll the run directory every 2 s for the terminal record, which answers "finished runs from disk".
- **`review_cancel` is idempotent.**
  - For a live owned run, it calls `Fiber.interrupt` and then returns the terminal state.
  - For a run already terminal, it returns that state with no error.
  - For a run owned by another live PID, it refuses with the owner's PID and doesn't signal it.
  - For an unknown id, it returns an error.
- **Runs are owned by PID.**
  - Write `run.json.owner = { pid, startedAt, host: "cli" | "mcp" }` before `plan.json` returns.
  - A run with no terminal state is **running** only if the PID is alive and its process start time matches. Otherwise it is **interrupted**.
  - Liveness is `process.kill(pid, 0)`. The start time comes from `/proc/<pid>/stat` field 22 on Linux and `ps -o lstart= -p` on macOS. Neither Effect nor OpenCode has this, so it is about 20 hand-coded lines (rung 4).
- **Stdout is the protocol.**
  - Progress already goes to stderr (`progress-text.ts:16`).
  - The OpenCode SDK logger is silent unless you pass `log.emit` (`packages/sdk/src/logging.ts:36-38`). Route it to `run.log`.
  - In `mcp` mode, override `Console` so `log` goes to stderr, as a guard against a stray `Console.log`, such as the config verbs' (`src/cli/config.ts:181` and others).
  - Skip the update notice for `mcp`, the same as for `upgrade` (`src/cli/main.ts:74`).
  - No elicitation (`McpServer.elicit`, `:4170`), Tasks or HTTP.

### Tool schemas (sketch)

```ts
review: {
  repo: string                      // absolute path to the checkout; required (MCP cwd is unreliable)
  target?: string                   // "42" = PR, "main" = merge-base..HEAD, "a..b"; omitted = uncommitted
  working_tree?: boolean
  recipe?: string                   // omitted = default-recipe
  lenses?: string[]                 // omitted = default lenses
  spec?: string                     // Markdown requirements TEXT, frozen into plan (no temp file needed)
  related_files?: boolean           // default true for agents (today's Mod default)
  destination?: "local" | "pr"      // "pr" only when the user asked to post
} -> { run_id, run_dir, target, lenses, skipped: {lens, reason}[] }

review_wait: { run_id: string, timeout_seconds?: number /* 45, max 55 */ }
  -> structuredContent: {
       run_id, state: "running" | "completed" | "failed" | "cancelled" | "interrupted",
       progress?: { stage, finders_done, finders_total, elapsed_s },
       digest?: string, dossier_md?: string, posted_url?: string, reason?: string }
     content[0].text: the digest when completed, else one status line

review_cancel: { run_id: string } -> { run_id, state }
```

`review_wait` is the tool that later gets `_meta.ui.resourceUri` for the MCP App (`ext-apps/docs/quickstart.md:204-216`). Giving it `structuredContent` now means the App needs no schema change.

## 2. Run records

**Keep** `plan.json`, `finder-stage.json`, `dossier.json`, `dossier.md`, `run.log` and `page-data.json`. Keep `receipt.json` too: it exists only once a post is attempted, and it carries delivery idempotency (`delivery.ts:113-165`).

**Add `run.json`**, written at freeze and finalised at the end:

```
{ owner: {pid, startedAt, host}, state, endedAt?, reason?,
  usage: { input, output, cacheRead, cacheWrite, cacheHitRate } (total + per stage),
  sessions: [{ stage, lens?, sessionID }] }
```

- `run.json` is both the terminal record that `review_wait` reads and the source of the digest's token line.
- The digest is stored there too, so a finished run is answered from disk without re-rendering.
- Drop `dossier.html`.
- `workspace-overlay.patch` belongs to isolation; see `isolation-tools.md`.

**Point at OpenCode for transcripts; don't copy them.**
- The pre-OpenCode `transcripts/` directories were up to 48 MB per run, which is most of the 685 MB.
- Session rows already hold token totals with cache read and write (`packages/core/src/session/info.ts:39-40`, `session/projector.ts:80-81`).
- Read them into `run.json.usage` before cleanup.

**Where the database lives: one per machine, at `~/.gauntlet/opencode/`.**
- The embedded SDK host defaults to `database: { path: ":memory:" }` (`packages/sdk/src/internal/host.ts:41`).
- Credentials are stored in that database (`core/src/credential.ts:8,12`). Only a file database imports the legacy `auth.json` (`core/src/database/database.ts:33-35`).
- So `:memory:` loses OpenAI logins on every run, and a per-run file can't hold logins either.
- Point the host's database path *and* its XDG roots at `~/.gauntlet/opencode/`. That keeps Gauntlet out of the user's own OpenCode store; the spike did the same with `env.sh` and `databasePath`.
- A relative path resolves under `Global.data` (`database.ts:77-79`), and the file is chmod 600.
- Concurrent CLI and MCP processes share the file under WAL with `busy_timeout = 5000` (`database.ts:44-46`).
- (Login storage itself is `providers-config.md`'s question.)

**Cleanup**
- When a run ends, in a finalizer, call `session.remove` for each of its sessions (`core/src/session.ts:404-417`; `client/src/effect/generated/client.ts:488`). That removal also interrupts the session and closes its transport, which helps release processes.
- At startup, sweep sessions that no live run's `run.json` lists, for crashed runs.
- Add a `keep-sessions` setting for debugging. Off by default.
- Run directories keep ADR 0006's rule: no retention machinery.

## 3. The digest

**Shape** (stdout for the CLI, and `content[0].text` over MCP):

```
Gauntlet · PR #42 · recipe medium · 4m00s · 1.84M tokens · cache 87%
P1 (3)
- [confirmed] app/x.php:86 — summary (≤200 chars)
P2 (2)
- [kept] src/y.ts:12 — summary
P3: 4 more · unprioritized: 1 plausible — in dossier.md
Coverage gaps: security (timed out)
Not run: spec-conformance (no spec)
dossier.md: /…/runs/<id>/dossier.md
```

**Survives**
- `render/digest.ts`: rewritten, but keep `boundedLine`, the coverage-gap and "Not run" lines, and the tool-health line (`digest.ts:15-96`).
- `render/dossier-view.ts`, `render/target-text.ts`, and `delivery/comment-body.ts`.
- `render/dossier-markdown.ts`, changing the cost line at `:122` to tokens and cache.
- From `render/dossier-page.ts`, only `DossierPageData`, `dossierPageData` and `dossierPageFiles` (`:47-67`, `:135`), moved to `render/page-data.ts`. Drop `costUsd` and add usage. `readReviewedFiles` stays with them, because `page-data.json` stays.

**Deleted**
- The rest of `render/dossier-page.ts`, plus `dossier-page-assets.ts`, `page-frames.ts`, `code-text.ts` and `brief.ts`.
- `run/dossier-page-redraw.ts`, `run/brief-request.ts` and `run/brief.md`.
- `cli/page.ts`, `cli/brief.ts`, `Run.page`, `Run.brief`, `PageError` and `BriefError`.
- `RunAccounting.costUsd`, and the `markdown-it` dependency (used only by `page-frames.ts` and `brief.ts`).
- The matching parts of `render.test.ts`.

**OpenCode artifacts: confirmed, not worth using.** The local provider writes HTML under `global.data/artifacts`. It serves the page from the OpenCode server: "Only people who can reach this server can open them" (`core/src/artifact.ts:213-232`). An embedded host that exits when the run ends has nothing to serve from.

## 4. GitHub PR delivery

- **The rung is 4: keep Gauntlet's code.** OpenCode 2.x "integrations" are credential connectors: claude-agent, github-copilot, databricks, modal, neon, opencode and xai (`core/src/integration.ts`, `core/src/integration/connection.ts`). Nothing posts to pull requests.
- **What to keep:**
  - `GitHub.postComment`, which writes the body to a temp file and runs `gh pr comment N --body-file` (`src/github/github.ts:320-352`);
  - `viewPullRequest`;
  - `delivery.ts`, which writes a Posted/NotPosted receipt and is idempotent;
  - `comment-body.ts`, which fits the body to 60 KB.

### Why it never posted

- `deliverCompletedRun` writes `receipt.json` on success *and* on any `gh` failure (`delivery.ts:126-150`). There are 0 receipts across 53 PR runs, so delivery was **never invoked**.
- The only ways in are `--destination pr` and `deliver`.
  - The destination defaults to `local` (`src/syntax/syntax.ts:185-186`).
  - Both skills say to use it "only when the user asked" (`.agents/skills/gauntlet-cli/SKILL.md:48-51`; `mod/gauntlet/skills/gauntlet-code-review/SKILL.md:47`).
- Nobody asked. The cause is the default, not a bug.

### Latent bug a later `deliver` would hit

- `postComment` runs `gh` with `cwd = plan.target.repoRoot` (`delivery.ts:128`).
- The plan stores no PR URL (`domain/review-target.ts:34-43`).
- 24 of the 53 PR runs reviewed clones under `/tmp/…` or T3 worktrees that are probably gone now.
- Spawning in a missing cwd most likely surfaces as a `NotFound` `PlatformError`, which `runGh` words as "gh is not installed" (`github.ts:146-150`). That message is misleading.
- **Fix:**
  - freeze `url` from `PullRequestView`, which already fetches it (`github.ts:24-30`), into the `PullRequest` target;
  - post with `gh pr comment <url> --body-file …`, with no repo cwd;
  - tell a missing cwd apart from a missing `gh`.

### Time-boxed end-to-end check

`gauntlet deliver <run-id>` posts an *existing* completed run and calls no models. Choose a completed run on one of John's repos whose checkout still exists, such as `~/Projects/convoy` (17 runs). That's one command, but it posts publicly, so John should confirm which PR first.

## 5. Spec sources

- **Delete Linear:**
  - `src/linear/` (482 + 253 test lines);
  - `specification/linear-source.ts` (144 + 183);
  - its branch in `submission.ts:163-221`;
  - `LINEAR_API_KEY`;
  - skill item 5's Linear text.
- **Usage across 211 runs:** Linear gave **0** specs. `--spec` gave 69 (49 commit-range, 16 working-tree, 4 PR). The GitHub closing-issue lookup gave **8** of 53 PR runs a spec, all as `slice` documents.

### Facts on the GitHub lookup, for John's decision

| | Lines |
|---|---|
| `github.ts`: GraphQL schemas, queries, paging, comment completion (`:37-56`, `:157-252`, `:378-470`) | about 230 of 473 |
| `specification/github-source.ts` + test | 94 + 150 |
| `specification/comment-budget.ts` + test (shared with Linear, deletable only if both go) | 64 + 56 |
| `specification/combine.ts` + test | 31 + 41 |
| `submission.ts` `acquireSpecification`, the `--github-spec` flag (`syntax.ts:53,100,112,173`), and parent/slice/comment roles in `review-specification.ts` | about 80 |
| Total, with tests | about 700 |

- **Complexity:**
  - It runs on *every* PR review, quietly: one or more `gh api graphql` calls with cursor paging over closing issues and their comments, plus one level of native parent.
  - Comments are admitted by author association (`github-source.ts:12`) and trimmed to a 20,000-character budget, earliest first.
  - It has a "quiet when unavailable / loud under `--github-spec`" policy (`submission.ts:193-216`).
  - The plan has to carry source provenance.
- **Without it,** the spec path is one file read (`caller-addendum.ts`, 47 lines). `ReviewSpecification` shrinks to a single caller document, and `combine` and `comment-budget` go.
- **My lean: cut it.** It's the same reasoning as for Linear: one path, and the caller already has `gh` and fetches better context on purpose. It's John's call.

### How callers are told to fetch and pass the spec

- **MCP `review` description:**

  > "If the change implements an issue or ticket (a GitHub issue the PR closes, a Linear or Jira ticket the user mentions), fetch it yourself first (e.g. `gh issue view N --comments`, or your Linear tool) and pass its requirements, acceptance criteria and relevant maintainer comments as Markdown in `spec`. Leave `spec` out when there is none; Gauntlet fetches nothing."

  `spec` is **inline text** over MCP. That avoids writing temp files, which sandboxed clients may not be allowed to do, and the "outside the repo" rule.
- **`gauntlet-cli` skill:** replace item 5 (`SKILL.md:52-75`) with the same instruction. It writes the Markdown to a temp file outside the repo and passes `--spec <path>`. Keep the existing rules on placement, freezing, and failing when the file is empty.

## 6. The CLI after the rebuild

```
gauntlet review [target] [--working-tree] [--recipe] [--lenses] [--spec <file>] [--related-files] [--destination local|pr] [--repo]
gauntlet deliver <run-id>        # keep: the retry path for a PR post (not in the README's list; flag for John)
gauntlet config [init|set|unset]
gauntlet login <provider>        # re-pointed at OpenCode credentials (providers-config.md)
gauntlet upgrade                 # binary self-update + seat upgrade; drop pi-catalog dependency
gauntlet mcp                     # new: stdio server
```

Changes in `src/cli/`:
- **Delete:** `page.ts`, `brief.ts`, and their wiring in `main.ts:21-30` and `run.ts:207-229`.
- **Add:** `mcp.ts`, the toolkit and handlers, in about 150 lines, plus a small `run-registry.ts` for the live-run map and owner checks.
- **Fold `src/syntax/syntax.ts` in.** Its "one syntax both Hosts parse" abstraction (`HostVerbs`) existed for the mod, which is cut. Move `reviewRequestOf` (`syntax.ts:77-127`) into a shared `review-request.ts`. Both the CLI flags and the MCP input schema decode to `ReviewRequest`. Drop `--github-spec` if the lookup goes.
- **`login.ts`** loses `pi-login`. **`upgrade.ts`** loses `refreshedModelCatalog` from `pi-catalog` (`upgrade.ts:15`). Both are `providers-config.md` territory.
- **Change the description in `main.ts:29`.** "Effect-native, Pi-harnessed code-review agent" is out of date.
- **`review.ts`:** the CLI keeps its contract (digest on stdout, `gauntlet:` lines on stderr, exit 0/1). It also writes `run.json.owner` so MCP's `review_wait` can see CLI runs.

## Risks and unknowns for a quick hands-on check

1. **The `server/discover` probe against Effect stdio.**
   - Connect `gauntlet mcp` from Claude Code, Codex and OpenCode, once with and once without `v2026_07_28` in `protocols`.
   - Confirm each one initializes, lists the three tools, and that a stateful-only server answers `server/discover` with method-not-found *and the right id*. The Codex error strings mention exactly that failure.
2. **`progressToken`.** Check whether Claude Code and Codex send `_meta.progressToken` on `tools/call`, and whether they show progress. If they don't, the status line in `review_wait`'s result is the only progress.
3. **Codex's tool timeout.** Confirm the default `tool_timeout_sec` (60 s per the docs) and whether progress resets it. Set the `review_wait` cap from the result.
4. **Wait cancellation.** Check that a client cancelling `review_wait` interrupts only the handler and the forked run keeps going. Effect's `forkIn` should handle it; confirm with `McpTest`.
5. **Stdout pollution.** Run a full review under `gauntlet mcp` with a validator that fails on any non-JSON-RPC stdout line. That catches OpenCode plugin or `claude` subprocess output.
6. **Token semantics.** Check whether OpenCode normalises `tokens.input` the same way across providers. Anthropic excludes cached tokens and OpenAI includes them. The cache-hit-rate formula depends on it; see also `harness.md`.
7. **Session removal.** Confirm `session.remove` works on the embedded host. Check whether SQLite file growth needs a periodic `VACUUM`, and whether sessions removed mid-run release `claude` processes at once.
8. **The delivery check.** Run one `gauntlet deliver` on an existing PR run, with John's chosen PR. Also confirm the missing-cwd error wording against a deleted `/tmp` clone.
