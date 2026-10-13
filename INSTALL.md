# Install Gauntlet for Claude Code (`/gauntlet`)

`/gauntlet` runs a Gauntlet review inside Claude Code: progress shows in a
strip above the prompt, the digest lands in the transcript, and **Open
dossier** opens the full report. It is one Claude Code plugin, built for each
release and installed from this repository's marketplace. A review's agents
are headless `claude -p` processes it starts, on the person's Claude plan.

## What it needs

- **Claude Code 2.1.296 or newer** (`claude --version`), which loads mods.
- **git.**
- **macOS** for **Open dossier**, which runs `open`. Reviews run anywhere.
- **gh**, signed in, only to review pull requests.

## Install

```sh
claude plugin marketplace add JRGiardiniere/gauntlet
claude plugin install gauntlet@gauntlet
```

A Linear API key is optional: with one, a review of a branch named for a
Linear issue (`CM-123-…`) reads that issue as the change's requirements. The
person sets it themselves, kept in secure storage, with
`/plugin configure gauntlet@gauntlet` in Claude Code (or
`--config linear_api_key=<key>` on the install command). Without it the Mod
uses `LINEAR_API_KEY` from Claude Code's environment, if set.

Done when `claude plugin list` shows `gauntlet@gauntlet` enabled. Then tell the
person:

- Run `/reload-plugins` in an open Claude Code session, or start a new one.
- In a repository with a small uncommitted change, ask Claude to run a
  Gauntlet review ("run gauntlet on my changes", "gauntlet medium on PR 42").
  Claude starts it, carries on or waits, and gets the digest when it lands.
  The review uses their Claude plan, on the Mod's `medium` recipe (Opus,
  medium effort) unless they name `low` (Sonnet) or `high` (Opus, high
  effort). The Mod writes these recipes into `~/.gauntlet/mod/` the first
  time it loads; `/gauntlet config` shows them.
- They can also type `/gauntlet` (`/gauntlet 42` for pull request 42,
  `/gauntlet main` for the commits since `main`, `--recipe high` for more
  effort, `/gauntlet deliver <run-id>` to post a finished pull-request review).

### Coming from a checkout install

An install from before the marketplace loaded the Mod from a clone. Undo
that too, or Claude Code loads two copies:

1. Remove the `<clone>/mod/dist/gauntlet` path, and
   `<clone>/mod/dist/gauntlet-tools` from an install before #181, from
   `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, keeping any
   other paths; drop the key once it is empty. Show the diff and wait for
   approval before writing.
2. Remove the `~/.claude/skills/gauntlet-code-review` link: the plugin ships
   that skill now.
3. The Mod no longer needs `<clone>`; ask before deleting it.

## Update

```sh
claude plugin update gauntlet
```

Then `/reload-plugins`. Claude Code doesn't say when a release is out unless
auto-update is on: in `/plugin`, **Marketplaces** → `gauntlet` → **Enable
auto-update**. From the next session it updates by itself and says to run
`/reload-plugins`.

## Uninstall

```sh
claude plugin uninstall gauntlet
claude plugin marketplace remove gauntlet
```

`~/.gauntlet/mod` holds the Mod's settings, recipes and log; `~/.gauntlet`
also holds review runs, and the Gauntlet CLI shares it. Delete either only if
the person asks.
