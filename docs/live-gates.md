# Live gates

Checks that need real providers, run by hand and never in CI: before a
release, and when `claude`, the Claude Agent SDK or `@opencode/*` changes.
They use cheap Seats (`gpt-6-luna:low`, `haiku:low`). The offline checks
(`bun run test`, `bun run test:compile-smoke`) run in CI.

## Logins

- **OpenAI:** the store under `$HOME/.gauntlet/opencode`, from
  `gauntlet login`. To use a different store, run with that `HOME` (or
  `GAUNTLET_LIVE_HOME` for the compiled gate). `OPENAI_API_KEY` also works.
- **Claude:** the installed `claude` and its own login. When `HOME` is not
  your own, set `CLAUDE_CONFIG_DIR=~/.claude` so `claude` finds its login.
  When `claude` is a mise shim, set `OPENCODE_CLAUDE_PATH` to the real
  executable: the shim hangs under a different `HOME`.

No gate copies a login.

## Commands

| Command | Proves |
| --- | --- |
| `bun run live-gate openai gpt-6-luna:low` | Real OpenAI login and model routing: one emit round-trip, usage decoded |
| `bun run live-gate claude-code haiku:low` | The same for Claude |
| `bun run live-hostile-probe claude-code/haiku:low` | The fence on the real `claude`: every escape in the hostile fixture is refused and nothing it planted loads or runs |
| `bun run live-gate-compiled` | A compiled binary from a fresh `HOME`: an OpenAI review cold then warm (cache hit rate in the digest), and a mixed Recipe with Claude Finders and OpenAI Pool, Verification and Judgment. `openai` or `mixed` runs one half |

Each prints its checks or digests and exits non-zero on a failure; a review
with a coverage gap fails the compiled gate.

## Cache hit rate

The digest's Finders line reports the cache hit rate. The v1 baselines are
94–95% cold and 99.4–99.5% warm on OpenAI, and about 95% cold on Claude,
measured on a 215 KB diff with 12 Lenses. The compiled gate's fixture is a
few lines, so its rates sit far lower; compare against the baselines with a
review of a real change, for example `gauntlet review <base>..<head>
--recipe <a luna:low recipe>` run twice.
