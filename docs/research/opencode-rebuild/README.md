# OpenCode rebuild: decisions and research brief (2026-11-18)

Gauntlet is moving its harness to OpenCode (`@opencode/sdk` / `@opencode/core` 2.3.x, embedded) as a full top-to-bottom implementation. This is John's call: if real problems appear later, we back out. The earlier council plan, which leaned toward Pi plus `claude -p`, is superseded on the harness question only. Its other decisions stand, and are listed below. Spike evidence lives in `/home/silentverdict/Projects/gauntlet-spike-opencode/spike/` (`rebuild-plan.md`, `results/`, `cache/`, `memory/`, `embedded/`).

## The outcome

Gauntlet replicates a code-review workflow that fans out many agents over a change and improves on it. The improvements that matter:
- better caching: tokens and cache hit rate matter, cost does not;
- sensible isolation;
- deliverables that look nice.

It is a learning project that should get simpler. A win is **one program** that:
- runs Claude as seamlessly as OpenAI;
- works in more tools;
- returns a short result inline;
- is a single path to maintain.

## The ladder: how every piece gets built

For each capability, ask in order:
1. **Can OpenCode do it natively?** Use config, built-ins or the SDK.
2. **Can it be done as an OpenCode plugin?** Use transforms, hooks or custom tools, preferring the Effect plugin API.
3. **Does Effect do it out of the box?** See `.claude/skills/effect/SKILL.md`.
4. **Only then, hand-code it.**

Stop at the first yes. Port learnings from the old code, not the old code itself. Don't reimplement anything on the cut list.

## Keep: the behaviour stays, the implementation may change

- **Finders.** Parallel finders, one per lens, over one frozen snapshot of the change. The lens set is unchanged; changing it is out of scope.
- **Shared cache.** All finders share a byte-identical prompt prefix. One finder warms the cache before the rest start; the rest wait for its first response, and that wait now has a timeout. Each run uses one OpenAI `prompt_cache_key` shared by its finders; the cache spike did this with a plugin.
- **Strict emit contracts** with up to 2 corrective turns. A finder's turn ends at its emit.
- **The pipeline**, unchanged: finders, then pool, then verification and judgment. Priority is judged downstream.
- **A read-only fence** on the snapshot for every agent. Emit-only stages (pool) get no tools. A reviewed repo's config, plugins and instructions never load.
- **A harness seam plus a scripted or fake adapter** for tests.
- **Lenses as markdown content.**
- **Related-files prefetch.** Fix it to exclude lockfiles and other huge generated files: it inlined 110 KB of `bun.lock`.
- **A minimal run record**: `plan.json`, `finder-stage.json`, `dossier.json`, `dossier.md`, and `run.log` with tokens and cache. Also keep `page-data.json` for the future MCP App.
- **Coverage gaps** reported in the digest.
- **Recipes with per-stage model and effort overrides.** One catalog for all providers.
- **Seat upgrade** (moving recipes to newer models) and the **CLI self-update**.
- **GitHub PR delivery.** Test it end to end once, time-boxed. If it fails, report to John; don't delete it.
- **`--spec` files** as the specification source.
- **The CLI is the engine**, used for long runs, scripting, config, login and upgrade.

## Cut: don't port or reimplement

- **The Claude Code mod**: `mod/`, `scripts/build-mod.ts`, `scripts/mod-types.sh`, the mod skill, the per-host recipe catalogs, ClaudeSeat/PiSeat/ConfigHost. Supersedes ADR-0009.
- **Pi**: `pi-live`, `pi-login`, `pi-catalog`, `fast-mode`, and the Pi dependencies. OpenCode replaces them.
- **`claude-live`** (`claude -p`). OpenCode's claude-agent provider replaces it.
- **`just-bash`** and `tool-deadline`. OpenCode's tools and permissions replace them.
- **Parts of `invoke.ts`**: the stall retry, startup deadline, salvage of cut-off sessions, and the abort-settle wait. Keep one overall deadline, the corrective turns, usage capture and the first-response signal.
- **The standalone HTML dossier page**, its `page` command, and briefs.
- **The Linear integration.** The calling agent fetches the issue and passes `--spec`.
- **Dollar cost display.** Show tokens and cache hit rate instead.

## New

- **`gauntlet mcp`** (stdio), with three tools:
  - `review` returns a run id once the inputs are frozen;
  - `review_wait` takes `timeout_seconds` (about 45 s by default), reports progress, and answers finished runs from disk;
  - `review_cancel` is idempotent.

  Rules for the server:
  - The run directory records its owner's PID and start time. A run with no terminal record is "interrupted" only when its owner is gone.
  - Stdout is the protocol.
  - No elicitation, MCP Tasks or HTTP in v1.
- **A short inline digest**, grouped by priority with P3s collapsed, showing tokens and cache. It is both the CLI's stdout and the MCP result.
- **Process release.** When a run ends, its `claude` processes are released straight away, not after OpenCode's 5-minute idle timer. No process reuse.
- **A PR CI workflow** (typecheck, lint, tests): an easy guard while several agents merge.

## Decided after the research (2026-11-18)

1. **Recipe names.** `low`, `medium`, `high` (and `quick`) keep their OpenAI meaning. The Claude defaults ship as `claude-low`, `claude-medium` and `claude-high`. A mixed recipe can come later.
2. **The GitHub closing-issue lookup is cut**, like Linear. The caller passes `--spec`, or `spec` text over MCP.
3. **`gauntlet deliver` stays** as the retry path for a failed PR post.
4. **Process release.** Live with OpenCode's 5-minute idle timer for `claude` processes. No `spawn` patch for now. An upstream issue can come later, and the patch (`spike/embedded/release.ts`) only if it bites.
5. **`+fast` stays.** It's native in OpenCode, so `<model>-fast` model IDs replace `fast-mode.ts`.

## Later, not in this rebuild

- The MCP App, which reuses the renderer plus `page-data.json`.
- The experiment merging pool, verification and judgment into one triage stage.
- The cache settle-delay test.

## Known spike findings to build on

- **Cache-key plugin**: `spike/cache/cache-key-plugin/server.ts`, using the `model.request` and `http.request` hooks.
- **Lean host config** (`spike/memory/lean.ts`): a two-provider model catalog file, catalog fetch off, plugins trimmed. It idles at about 237 MB.
- **The claude-agent provider is itself a plugin**, `make(io, registry)` in `packages/core/src/plugin/provider/claude-agent/index.ts`. The release prototype wraps `io` (see `spike/embedded/` when it lands).
- **Compiled binary**: three build plugins are needed (pty stub, NodeWS `ws2` workaround, fff library embed), plus an override that skips the claude-agent-sdk's bundled binaries.
- **Effect version**: OpenCode pins effect 4.1.0 exactly; Gauntlet is on 4.1.4. Using the Effect APIs end to end needs one shared copy.

## Research files (one per area, in this folder)

1. `harness.md`: sessions, agents, prompts, emit, turns and usage.
2. `providers-config.md`: providers, logins, models and recipes.
3. `isolation-tools.md`: isolation, tools and the workspace.
4. `front-ends-output.md`: MCP, digest, run records, delivery and the CLI.
5. `build-test-orchestration.md`: build, distribution, tests and orchestration.
