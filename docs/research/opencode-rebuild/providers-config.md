# OpenCode rebuild: providers, logins, models and recipes

- **Status:** Research findings for the rebuild in `README.md`. Nothing here is approved architecture.
- **Date:** 2026-11-18
- **Area:** `gauntlet login`, Seat grammar, the one Recipe Catalog, Seat upgrade, `+fast`, Effect version alignment, and config isolation.

## Method and ground truth

Everything below comes from reading source, not memory:

- **OpenCode** `/home/silentverdict/Projects/reference/opencode` at `0b87612` (2026-11-18, v2.3.0 in the tree; shallow clone, one commit). Paths are relative to `packages/`.
- **Published packages:** the spike's installed `@opencode/{sdk,core,plugin}@2.3.2` `package.json` files, and `npm view` for release dates and each SDK version's `effect` dependency.
- **Gauntlet** `main`: `src/domain/recipe.ts`, `src/config/*`, `src/cli/{login,upgrade}.ts`, `src/harness/{pi-login,pi-catalog,fast-mode}.ts`, and ADR-0005.
- **Spike** `gauntlet-spike-opencode` (read only): `spike/auth/login.sh`, `spike/embedded/env.sh`, `spike/memory/{lean.ts,models-mini.json}`, and `src/harness/opencode-live.ts`.

Nothing was run, installed or logged into. Item 7 notes that `~/.agents/skills` exists on this machine; nothing else outside the sources was opened.

## Decision summary

| # | Capability | Rung that wins | Recommendation |
|---|---|---|---|
| 1 | `gauntlet login` | **1. Native SDK** (`integration.*` APIs) | Gauntlet's CLI boots the embedded host and calls `integration.oauth.connect/status/complete` (ChatGPT) and `integration.connect.key` (API key). Claude: `integration.connect.external` runs automatically. The store is `~/.gauntlet/opencode/gauntlet.db`. Don't shell out to `opencode auth login`. |
| 2 | Seat grammar to OpenCode IDs | **4. Hand-code** (about 15 lines) | Keep `provider/model:effort[+fast]` as the stored and recorded form. One pure function maps it to `{providerID, id, variant}` at the harness edge. |
| 3 | One catalog, per-stage overrides | **4. Hand-code** (it already exists) | Recipes stay Gauntlet-owned JSON. OpenCode config carries only host-wide settings, never recipes or agent models. Options for low/medium/high are below. |
| 4 | Seat upgrade | **1. Native** (`model.list`) plus Gauntlet's file | Gauntlet owns a two-provider models.dev file and refreshes it in `gauntlet upgrade`. Upgrade picks from the host's `model.list`. Claude seats use aliases and need no upgrade. |
| 5 | `+fast` | **1. Native** (`-fast` model IDs from models.dev modes) | `+fast` maps to `<model>-fast`. No hook or plugin is needed. Keep it; it costs one string rule. |
| 6 | Effect version | Packaging, not code | Pin Gauntlet to OpenCode's exact Effect version (4.1.0 today, which means going **down** from 4.1.4), with `overrides` so only one copy is installed. Bump Effect only together with `@opencode/sdk`. |
| 7 | Config isolation | **1. Native** options plus one `embed.overrides` entry | Set the server options, and override `Global` (all roots under `~/.gauntlet/opencode`) and `Config` (`global:false, system:false`). Details are in item 7. |

---

## 1. `gauntlet login`

**Where credentials live.** The `Credential` service stores rows in OpenCode's SQLite `Database`, in `CredentialTable` (`core/src/credential.ts:86-110`). The embedded host defaults that database to **`:memory:`** (`sdk/src/internal/host.ts:41`). A relative `database.path` resolves under `Global.data` (`core/src/database/database.ts:80`). The spike passed an absolute file path, `databasePath` (`gauntlet-spike-opencode/src/harness/opencode-live.ts:205`), into XDG dirs it had redirected (`spike/embedded/env.sh`).

**Recommendation: one Gauntlet-owned store.**
- Set `database: { path: "~/.gauntlet/opencode/gauntlet.db" }`, with an absolute path.
- Point `Global`'s data, state, cache, config, log, bin and repos at `~/.gauntlet/opencode/*` (see item 7). Credential refresh locks live under `Global.state/locks` (`util/src/effect-flock.ts:109`), so every Gauntlet process must share the same state dir to share the lock.
- A file-backed store also keeps the claude-agent model list between runs, so runs don't have to probe `claude` each time. That list sits in plugin storage (`core/src/plugin/provider/claude-agent/provider.ts:47-48, 87`).

**Drive it from Gauntlet's own CLI (rung 1). Don't shell out.** OpenCode's own `opencode auth login` is only a client of public SDK endpoints:

| Login | SDK call | OpenCode reference |
|---|---|---|
| ChatGPT OAuth | `integration.oauth.connect({integrationID:"openai", methodID:"chatgpt-token-sharing"})`. Print `url`/`instructions`, then poll `integration.oauth.status` every 500 ms. If `attempt.paste` is set, race a prompt that passes the pasted redirect URL to `integration.oauth.complete({code})`. Call `oauth.cancel` in a finalizer. | `cli/src/commands/handlers/auth/login.ts:167-231, 276-311` |
| OpenAI API key | `integration.connect.key({integrationID:"openai", key})`. Alternatively, `OPENAI_API_KEY` in the environment shows up as an `env` connection with no stored row. | `login.ts:150-165`, `core/src/integration.ts:396-399` |
| Claude | `integration.connect.external({integrationID:"claude-agent", methodID:"claude-login"})`. This only records the choice; `claude` owns the login. | `claude-agent/integration.ts:11-26`, `specs/v2/claude-agent-provider.md:15-19` |

- The endpoints are in `protocol/src/groups/integration.ts:62-222`, and the Effect client has them too (`client/src/effect/generated/client.ts:1047-1070`).
- **ChatGPT method.** `chatgpt-token-sharing` ("Sign in with ChatGPT") is the current one (`core/src/plugin/provider/chatgpt.ts:31, 101-108`). `chatgpt-browser` and `chatgpt-headless` are labelled "(legacy)" (`openai.ts:26-27, 62, 182`).
- **Remote login.** The callback listens on `127.0.0.1:<random>` (`chatgpt.ts:209-220`). On this server, reached over Tailscale, the paste-the-redirect-URL path is the one that works. Port it.
- **Claude.** Make it implicit. At host start, if `integration.get("claude-agent")` has no connection, call `connect.external`, as the spike does (`opencode-live.ts:234-241`). `gauntlet login claude` then only reports the connection `status`. When `claude` is missing or logged out, that status is `needs_auth` with a ready message (`claude-agent/integration.ts:47-60`). `OPENCODE_CLAUDE_PATH` sets the binary (`claude-agent/claude/io.ts:21`).
- **Why not `opencode auth login`.** It needs a separately installed `opencode` whose version can drift from the embedded core. Its file name also depends on the channel (`opencode-<channel>.db`, `cli/src/database-path.ts:4-12`). And it adds an XDG-env wrapper, the spike's `login.sh`, for no gain.

**Token refresh safety (rung 1).**
- Refreshes go through `Credential.refresh` from `integration.ts:711-713`, with a 5-minute margin (`credential.ts:33`).
- In-process callers share one refresh fiber (`credential.ts:142-155`).
- Across processes, a file lock serializes them: `flock.withLock("credential-refresh:<id>")` at `:150`.
- The row is re-read under the lock, the refresh call is capped at 30 s, and a row changed meanwhile wins (`:160-180`).
- So the CLI, an MCP server and a long run can safely share one DB, **as long as they share the state dir**.

**Rules:**
- **Never import or copy the user's OpenCode, Codex or Pi tokens.** OpenAI refresh tokens rotate, so two stores holding one refresh token log each other out. A separate sign-in is a separate grant, and nothing races.
- **Watch out for an automatic import.** Migration `20260805200742_import_legacy_credentials` reads `<Global.data>/auth.json` into a fresh DB (`core/src/database/migration/20260805200742_import_legacy_credentials.ts:39`). If `Global.data` is left at `~/.local/share/opencode`, a fresh Gauntlet store **silently imports the user's legacy OpenCode tokens**. Item 7's `Global` override prevents this.

**Old code:**
- Delete `src/harness/pi-login.ts` (98 lines).
- Rewrite `src/cli/login.ts` (26 lines) around the calls above. Expect about 80 lines, ported from OpenCode's `login.ts` flow, not from Pi's.
- Provider argument: `openai` (ChatGPT by default, or `--api-key`) and `claude` (status only).

## 2. Seat grammar to OpenCode model IDs

**OpenCode's form.** OpenCode references are `provider/model#variant` (`schema/src/config/model.ts:8-18`). `Model.Ref.parse` splits at the first `/` and then the first `#` (`schema/src/model.ts:20-35`). On the SDK prompt the reference goes as `{providerID, id, variant}`, which is how the spike sends it (`opencode-live.ts:259`).

**Where variants come from:**
- **OpenAI.** From models.dev `capabilities.reasoning.effort`; a variant ID is the effort name and sets `reasoningEffort` (`core/src/variant.ts:29-50, 111-117`; `models-dev.ts:215-218`). In the bundled snapshot:
  - `gpt-6-luna` and `gpt-6.1-terra` offer `none, low, medium, high, xhigh, max`;
  - `gpt-6.1-sol` offers `low` through `max`.
- **Claude (`claude-agent`).** From the installed `claude`'s own `supportedEffortLevels`, probed and saved (`claude-agent/provider.ts:114, 144`). Model IDs are Claude Code's own values (`opus`, `sonnet`, `haiku`, …, with `default` dropped; `:106-108`), not models.dev IDs.

**Mapping:**

| Gauntlet Seat (stored, recorded) | OpenCode reference |
|---|---|
| `openai/gpt-6.2-sol:high` | `openai/gpt-6.2-sol#high` |
| `openai/gpt-6.1-terra:high+fast` | `openai/gpt-6.1-terra-fast#high` (item 5) |
| `claude-code/opus:medium` | `claude-agent/opus#medium` |
| `claude-agent/opus:medium` | `claude-agent/opus#medium` |

**Recommendation: keep Gauntlet's grammar.**
- Recorded `plan.json` files hold Seat strings, and ADR-0005 says runs record only the Seat (ADR-0005 §Recipes, #121 amendment).
- The `Seat` pattern stays as loose as it is (`src/domain/recipe.ts:8-10`), so every recorded run decodes unchanged.
- Add one pure `toModelRef(seat)` at the harness edge:
  - split at the first `/` and the last `:`;
  - strip `+fast` and append `-fast` to the model ID;
  - alias the provider `claude-code` to `claude-agent`.
- New Claude recipes are written with `claude-agent/`, OpenCode's real ID; `claude-code/` stays accepted for old files.
- **Validate at plan time.** Look the Seat up in the host's `model.list`. If the model or variant is missing, fail and list the variants it offers. This replaces the ClaudeSeat/PiSeat schema split.

**Rejected: adopting `#` outright.** It would change the Seat schema, every shipped recipe, seat upgrade and the docs, and the old grammar would still need decoding forever for recorded runs. It buys only copy-paste from `opencode models`.

## 3. One Recipe Catalog with per-stage overrides

**What stays Gauntlet-owned:**
- Recipe files: `default` plus `finders`, `interpretive-finders`, `pool`, `verification` and `judgment` (`recipe.ts:58-66`).
- Resolution (`finderSeat` and `stageSeat`, `:74-83`), favorites, `default-recipe`, and the run's freeze of the resolved seats.

**What OpenCode config could carry.** OpenCode config does have `agent.<name>.model` (`core/src/config/plugin/agent.ts:166-176`). Don't use it for seats:
- Seats are chosen per run and per stage, and frozen in the plan.
- Gauntlet already creates one agent per invocation and passes the model on each prompt.
- A second home for model choice would make recipes no longer the single source.

OpenCode config carries only host-wide settings: plugins `-*` plus the keep list, `tool_output` limits, `snapshots:false`, `share:"disabled"` and `compaction`. These are all fixed by Gauntlet, not chosen by the user.

**Drop the per-host split.** That means `ConfigHost`, `~/.gauntlet/mod`, `ClaudeRecipe` and `PiRecipe`. There is one schema, `Recipe = recipeOf(Seat)`.

**Open question for John: what do `low`, `medium` and `high` mean across two providers?**

The current values are:
- CLI: quick = `gpt-6.1-terra:high+fast`, low = `gpt-6-luna:high`, medium = `gpt-6.2-sol:medium`, high = `gpt-6.2-sol:high` (`src/config/initial-config.ts:22-30`).
- Mod: low = `sonnet:medium`, medium = `opus:medium`, high = `opus:high` (`:31-38`).

The options:
- **A. Names keep their OpenAI meaning, and Claude ships under its own names** (`claude-low`, `claude-medium`, `claude-high`). This is the spike plan's default (`rebuild-plan.md:126`). Nothing moves for existing CLI users, and the names say what runs. The cost is six or seven recipes in the seed.
- **B. Names mean a cost or depth tier, and the seed follows the logins.** `config init` writes low/medium/high for whichever provider is connected (OpenAI first if both). The names stay short, but the same name means different models on different machines, so recorded runs need their Seat strings to be read.
- **C. Mixed tiers.** For example, medium runs OpenAI finders, then Claude verification and judgment. This exercises "Claude as seamlessly as OpenAI", but it's an untested quality claim, so ship it as one extra seeded recipe (`mixed`), not as the meaning of `medium`.

**Recommendation:** A now, and add C's `mixed` recipe once the mixed-provider milestone runs. Hold B unless John wants a one-provider user to see only three names.

**Old code:**
- `recipe.ts`: keep `Seat` (unchanged), `RecipeName`, `Recipe`, `finderSeat` and `stageSeat`. Delete `ClaudeSeat`, `PiSeat`, `PiRecipe`, `ClaudeRecipe` and `seatSpeed` (replaced by `toModelRef`).
- `initial-config.ts`: merge into one seed.
- `settings.ts`: delete `ConfigHost` and the mod paths (`:57-70`).
- `recipe-catalog.ts`: keep it, minus the host branching.
- ADR-0005: amend it; the #177 per-host amendment is superseded.

## 4. Seat upgrade

**What the host offers.**
- **OpenAI.** The models come from the catalog, and a ChatGPT sign-in further filters them to a **hard-coded `fallbackModels` list** inside OpenCode (`chatgpt.ts:33-56, 318`). A new GPT model therefore needs both a catalog entry *and* an OpenCode release that lists it.
- **Claude.** The models are whatever the installed `claude` reports.

**Finding: the catalog the lean config uses already lags.**
- The 2.3.x bundled snapshot has no `gpt-6.2-sol`. Its newest are `gpt-6-*`, `gpt-6.1-sol` and `gpt-6.1-terra` (`core/src/models-dev/snapshot.txt`).
- The spike's `models-mini.json` was cut from that snapshot and lacks it too.
- So today's `medium` and `high` defaults (`gpt-6.2-sol`) would not resolve under `lean.ts`'s `models: {fetch:false, snapshot:false, file}`.
- OpenCode itself expects `gpt-6.2-sol` from the live catalog (it is in `fallbackModels`, `chatgpt.ts:55`).

**How the catalog loads.** The order is `file`, then the KV cache, then the bundled snapshot, then a fetch (`models-dev.ts:650-664`). `fetch:true` also forks a refresh every 5 minutes (`:701-704`) and parses the full ~8 MB catalog, which is the memory cost the lean config avoids.

**Recommendation: Gauntlet ships and refreshes its own two-provider file.**
- **Source.** The OpenAI and Anthropic entries of `https://models.opencode.ai/experimental/v2.0/api.json` (`models-dev.ts:505-508`). Anthropic matters only for prices, which aren't displayed, so it can be dropped if the file must stay tiny.
- **Build.** `scripts/` fetches and trims it into an embedded default at release time.
- **Upgrade.** `gauntlet upgrade` refetches with Effect's `HttpClient`, trims, and writes `~/.gauntlet/opencode/models.json` atomically. The host always runs `models: {fetch:false, snapshot:false, file}`, with the embedded copy as fallback when the file is missing.
- **Picking the upgrade.** Seat upgrade boots the lean host on the new file and takes model IDs from `model.list`, which is rung 1 and already applies the ChatGPT filter. It then runs the existing pure `newerSeat` over those IDs. That way upgrade never moves a recipe to a model the host would refuse.
- **Claude.** Claude Seats use Claude Code's aliases (`opus`, `sonnet`), which `claude` itself moves forward, so the family-upgrade regex stays OpenAI-only. If John wants a Claude Seat pinned to an exact model, that's a later option, and the run record should then carry the resolved model (see the risks).

**Old code:**
- Delete `src/harness/pi-catalog.ts` and `successorProviders` (`openai-codex`, `seat-upgrade.ts:15-20`).
- Keep `familyModel`, `newerSeat` and `upgradeRecipeSeats` (`seat-upgrade.ts:12-121`), and their tests, with the catalog source swapped.
- `src/cli/upgrade.ts:61-75` gets a `ModelCatalogRefreshError` from the new fetch.

## 5. `+fast` (OpenAI Fast mode)

**This is native (rung 1).**
- models.dev `experimental.modes.fast = {service_tier:"priority", body:{service_tier:"priority"}}` becomes a separate model, `<id>-fast`, with the same variants (`models-dev.ts:91-96, 220-226`).
- The snapshot carries it for `gpt-6-luna`, `gpt-6.1-terra` and `gpt-6.1-sol`, and the trimmed mini file keeps it.
- ChatGPT sign-in lists `-fast` IDs explicitly (`chatgpt.ts:35-55`).
- So `openai/gpt-6.1-terra:high+fast` maps to `openai/gpt-6.1-terra-fast#high`.

**Recommendation:**
- Keep `+fast` in the Seat grammar, since recorded runs and the `quick` recipe use it. Map it in `toModelRef`, and delete `src/harness/fast-mode.ts` and its test.
- Writing `gpt-6.1-terra-fast:high` directly would also work, but then seat upgrade's family regex misses it. Keeping the `+fast` suffix avoids touching the regex.
- If the hands-on check below fails, dropping `+fast` costs only the `quick` recipe's seed line.

## 6. Effect version alignment

**What OpenCode pins:**
- The root catalog pins `effect` and every `@effect/*` at exactly `4.1.0` (root `package.json` workspaces catalog).
- The published `@opencode/sdk`, `core` and `plugin` 2.3.2 all depend on `"effect": "4.1.0"` exactly, with no peer dependency. The spike's install has both `effect@4.1.0` and `effect@4.1.4`, so two copies.

**Bump cadence (npm):**
- `@opencode/sdk` shipped 15 releases between 2026-10-20 and 2026-11-18.
- Its Effect dependency moved `4.0.0-rc.112` (2.0.0) → `4.0.1` (2.1.0) → `4.0.6` (2.2.5) → `4.1.0` (2.3.0, 2026-11-13). That's about one bump every two weeks, adopting an upstream release about two weeks after it ships (upstream 4.1.0 was 2026-10-29). It never ran ahead of upstream.

**The APIs are usable.**
- `@opencode/sdk/effect` gives `OpenCode.create`, `layer` and `Service` (`sdk/src/effect/opencode.ts:37-74`).
- `@opencode/plugin/effect` gives `define` for Effect plugins (`plugin/package.json` exports `./effect`), the same API OpenCode's own providers use (`claude-agent/index.ts:20-46`).
- Embedded host `plugins` take Effect plugins directly (`sdk/src/internal/host.ts:20-25`).
- They all assume one shared `effect` module. The spike's `effect-compat.ts` probe exists, but no result was recorded.

**Recommendation:**
- Pin `effect`, `@effect/platform-node` and `@effect/vitest` to the exact version `@opencode/sdk` declares (4.1.0 now).
- Add an `overrides` entry for `effect` so Bun dedupes to one copy.
- Bump only in the same commit as `@opencode/sdk`.
- Add a CI check that fails if the lockfile holds more than one `effect` version.
- Downgrading from 4.1.4 to 4.1.0 is the cost. Check Gauntlet compiles and tests pass on 4.1.0. There's nothing to port.
- If ever forced to run ahead, the escape hatch is the Promise SDK plus Promise plugins, which works across copies but gives up rung 2's Effect API.

## 7. Config isolation from the user's own OpenCode

Pass all of these:

| Option | What it stops | Source |
|---|---|---|
| `config.directory: ~/.gauntlet/opencode/config` | `~/.config/opencode` (its `opencode.json`, plugins, `AGENTS.md`). Note that `OPENCODE_CONFIG_DIR` isn't read once options replace `Global`. | `server/src/routes.ts:147`; `util/src/global.ts:76-79` |
| `config.project: false` | Project `.opencode`, `.claude`, `.agents` and `opencode.json` walking up from the snapshot | `core/src/config/discovery.ts:79` |
| `config.claude: false` and `instructions.claude: false` | `~/.claude`, project `.claude`, and `~/.claude/CLAUDE.md` | `discovery.ts:153-160`; `server/src/options.ts:46-50` |
| `config.content: <Gauntlet JSON>` | Puts the whole host config in code: `plugins:["-*", …keep]`, `snapshots:false`, `share:"disabled"` | `spike/memory/lean.ts:38-40` |
| `database.path: ~/.gauntlet/opencode/gauntlet.db` | The user's sessions DB. The embedded default is `:memory:`; never point it at `~/.local/share/opencode`. | `sdk/src/internal/host.ts:41` |
| `models: {fetch:false, snapshot:false, file}` | The network catalog and the shared KV cache | `models-dev.ts:481-486, 650-664` |
| `events.persist:false`, `fs.filewatcher:false`, `fs.fff:false` | Memory and watchers | `lean.ts:43-45` |
| **Override** `Global.node` with `Global.layerWith({data, state, cache, config, log, bin, repos, tmp})`, all under `~/.gauntlet/opencode` | Three leaks. (a) The legacy `auth.json` import into the fresh DB (`migration/20260805200742…:39`). (b) The v1 session migration reading `<data>/opencode-next.db`, which runs at every host start (`database/v1-migration.bun.ts:512-527, 798-802`; `server/src/routes.ts:219`). (c) Locks and caches in `~/.local/state/opencode`. Options only set `config` (`routes.ts:147`). | `sdk/src/internal/host.ts:27-30` (`embed.overrides` apply last) |
| **Override** `Config.node` with `Config.configured({global:false, system:false, project:false, claude:false, content})` | `~/.agents` (loaded as a global root unless `global:false`; this machine has `~/.agents/skills`), `/etc/opencode`, and macOS MDM plists. `ServerOptions` doesn't expose `global` or `system`. | `core/src/config.ts:60-70`; `discovery.ts:64-71, 119-131, 162-167` |
| Clear `OPENCODE_FLAGS` from the environment (or set it) | User experimental flags | `core/src/flag.ts:30-32` |
| Leave `XDG_*` alone in the process env | `git.ts:272` reads `XDG_CONFIG_HOME` for git config, and child `claude` processes inherit the env. Use the `Global` override instead of the spike's XDG trick. | `core/src/git.ts:272` |

**Notes:**
- Well-known remote config (`config.ts:183-226`) only comes from documents or integrations, so with `-*` plugins and Gauntlet's own content it is empty. The hostile-fixture test should still assert this.
- The claude-agent plugin adds OpenCode's instructions (`AGENTS.md`, skills) on top of Claude Code's prompt (`specs/v2/claude-agent-provider.md:29`). With the options above those sources are empty, and `isolation-tools.md` owns Claude's own `~/.claude` reads.
- The `Global` and `Config` overrides import core internals by absolute path, as `lean.ts:4-6` does. That becomes a normal import once Effect and core resolve to one copy (item 6).

## What old code is deleted or ported

| File | Fate |
|---|---|
| `src/harness/pi-login.ts` | Delete |
| `src/harness/pi-catalog.ts` | Delete; replaced by the models.dev fetch plus `model.list` |
| `src/harness/fast-mode.ts` and its test | Delete; `+fast` becomes a `-fast` model ID |
| `src/cli/login.ts` | Rewrite on `integration.*`; port OpenCode's login flow |
| `src/cli/upgrade.ts` | Keep the binary step; swap the catalog source in `upgradeSeats` |
| `src/config/seat-upgrade.ts` | Keep the pure logic; drop `successorProviders` |
| `src/domain/recipe.ts` | Keep `Seat` and `Recipe`; drop the Claude/Pi split and `seatSpeed`; add `toModelRef` |
| `src/config/initial-config.ts` | One seed (see the options in item 3) |
| `src/config/settings.ts` | Drop `ConfigHost` and the mod paths |
| ADR-0005 | Amend: one catalog, Seat-to-OpenCode mapping, `+fast` mapping. Supersede the #177 amendment. |

## Risks and unknowns: quick hands-on checks

1. **ChatGPT login from Gauntlet's CLI over Tailscale.** Run `oauth.connect` for `chatgpt-token-sharing` and complete it with a pasted redirect URL. Confirm the row lands in `~/.gauntlet/opencode/gauntlet.db`, and that `integration.get("openai")` shows an active connection from a second process.
2. **Refresh across processes.** Force `expires` into the past, then run two Gauntlet processes on one DB. Expect exactly one token POST and both runs succeeding.
3. **Fresh-store import.** Confirm that a new store under the `Global` override imports nothing: no credentials and no sessions.
4. **`+fast` with ChatGPT sign-in.** Run `gpt-6.1-terra-fast#high` and check that the response's usage or service tier says `priority`. Pi's `+fast` worked on ChatGPT, but OpenCode's token-sharing route rejects some capabilities (`chatgpt.ts:58-67`).
5. **`gpt-6.2-sol` in the trimmed file.** Build the file from live models.dev and confirm `model.list` shows `gpt-6.2-sol` and `gpt-6.2-sol-fast` under ChatGPT sign-in.
6. **Claude model IDs and variants.** List `claude-agent` models after one probe and confirm `opus`, `sonnet` and `haiku` with `low`/`medium`/`high`. Also check whether a full ID like `claude-opus-5-5` is accepted. If aliases are the only choice, record the resolved model in `run.log`, because ADR-0005's "exact model ids" rule otherwise loses which model ran.
7. **Effect 4.1.0 downgrade.** Run typecheck and tests on 4.1.0 and assert there is one `effect` in the lockfile. Then rerun the spike's `effect-compat.ts` against the pinned tree and record the result.
8. **The `Config`/`Global` override in a compiled binary.** Confirm the override module is the same instance the SDK uses after `bun build --compile`. This is the known spike risk, shared with `build-test-orchestration.md`.
