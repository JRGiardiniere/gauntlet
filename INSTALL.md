# Install Gauntlet for Claude Code (`/gauntlet`)

You are a coding agent installing Gauntlet's Claude Code mod, `/gauntlet`, for
the person you work with. `/gauntlet` runs a Gauntlet review inside Claude Code: progress shows in a
strip above the prompt, the digest lands in the transcript, and **Open
dossier** opens the full report.

The mod is two Claude Code plugin folders, `gauntlet` and `gauntlet-tools`, built
from a git checkout. They stay bound to that checkout: they read lenses and
prompts from it, and rebuild themselves from it with the `bun` that built them.
So the clone stays where you put it, and `bun` must be a real command.

Work through **Install** in order. Each step ends on its done-when check; reach
it before moving on. Every change outside the clone (installing `bun`, editing
`~/.claude/settings.json`) waits for the person's approval.

## What it needs

- **Claude Code that loads mods.** The mod was built and checked against
  Claude Code 2.1.291 (`claude --version`). Install step 6 is the real test:
  `claude plugin validate` reads the mod the way this Claude Code will.
- **git**, and **bun 1.4.0 or newer** (step 1 installs it).
- **macOS** for **Open dossier**, which runs `open`. Reviews run anywhere.
- **gh**, signed in, only to review pull requests.

## Install

### 1. bun

Run `bun --version`. Claude Code's bundled runtime is not a `bun` command, so a
`bun` must exist on its own: the mod builds with it now and rebuilds with it
whenever the checkout changes.

- Missing: ask the person which installer to use, then run it.
  - bun.sh: `curl -fsSL https://bun.sh/install | bash`. It installs to
    `~/.bun/bin`; run `export PATH="$HOME/.bun/bin:$PATH"` so this shell finds it.
  - Homebrew: `brew install oven-sh/bun/bun`.
- Older than 1.4.0: `bun upgrade` (bun.sh) or `brew upgrade bun` (Homebrew).

Done when `bun --version` prints 1.4.0 or newer.

### 2. Clone

Clone to `~/gauntlet`. If that path exists, ask the person where to clone
instead; everything below calls the clone's absolute path `<clone>`.

```sh
git clone https://github.com/JRGiardiniere/gauntlet.git ~/gauntlet
cd ~/gauntlet
git checkout "$(git tag --list 'v[0-9]*' --sort=-v:refname | head -n 1)"   # the newest release
```

Done when `git -C <clone> describe --tags` prints that release's tag (`vX.Y.Z`).

### 3. Build

In `<clone>`:

```sh
bun install
bun run build-mod
```

Done when `build-mod` prints `gauntlet built at <clone>/mod/dist/gauntlet` and
`gauntlet-tools built at <clone>/mod/dist/gauntlet-tools`.

### 4. Load the mod in every session

Claude Code loads plugin folders named in `env.CLAUDE_CODE_PLUGIN_DIRS` of
`~/.claude/settings.json`: absolute paths joined by `:`.

1. Read `~/.claude/settings.json` (treat a missing file as `{}`).
2. Add `<clone>/mod/dist/gauntlet` and `<clone>/mod/dist/gauntlet-tools` to
   `env.CLAUDE_CODE_PLUGIN_DIRS`, after any paths already there, skipping one
   already listed. Every other key and value stays as it was.
3. Show the person the diff and wait for their approval.
4. Write the file.

Done when the file parses as JSON and `env.CLAUDE_CODE_PLUGIN_DIRS` holds the
earlier paths plus both new ones.

### 5. The gauntlet-code-review skill

The skill tells Claude when and how to start a review with the mod's tool.

- `gauntlet` on the PATH (`command -v gauntlet`): the person uses the Gauntlet
  CLI, whose own `gauntlet-cli` skill covers both. Leave their skills alone.
- Otherwise: link the mod's skill, so it follows the checkout:
  `mkdir -p ~/.claude/skills && ln -s <clone>/mod/skills/gauntlet-code-review ~/.claude/skills/gauntlet-code-review`.
  A `~/.claude/skills/gauntlet` or `~/.claude/skills/gauntlet-cli` without the
  CLI is left from an earlier CLI install and sends Claude to a command that
  isn't there: show the person its path and ask before removing it.

Done when `~/.claude/skills/gauntlet-code-review/SKILL.md` exists, or the CLI
is installed.

### 6. Validate

```sh
claude plugin validate <clone>/mod/dist/gauntlet
claude plugin validate <clone>/mod/dist/gauntlet-tools
```

Done when both end `Validation passed`; warnings about gating hooks and missing
author information are expected. A failure here usually means this Claude Code
is too old to load mods: report its version and the output to the person.

### 7. Hand over

Tell the person:

- Restart Claude Code (every terminal session, and the desktop app): it reads
  `env` only at startup.
- In a repository with a small uncommitted change, ask Claude to run a
  Gauntlet review ("run gauntlet on my changes", "gauntlet medium on PR 42").
  Claude starts it, carries on or waits, and gets the digest when it lands.
  The review uses their Claude plan, on the Mod's `medium` recipe (Opus,
  medium effort) unless they name `low` (Sonnet) or `high` (Opus, high
  effort). The Mod writes these recipes into `~/.gauntlet/mod/` the first
  time it loads; `/gauntlet config` shows them.
- They can also type `/gauntlet` (`/gauntlet 42` for pull request 42, `/gauntlet main`
  for the commits since `main`, `--recipe high` for more effort,
  `/gauntlet deliver <run-id>` to post a finished pull-request review).

## Update

In `<clone>`:

```sh
git fetch --tags
git checkout "$(git tag --list 'v[0-9]*' --sort=-v:refname | head -n 1)"   # the newest release
bun install
bun run build-mod
```

Then tell the person to restart Claude Code. Rebuild the same way after
upgrading `bun`: the build records the `bun` it ran with, and an upgrade can
move it.

## Uninstall

1. Remove the two `<clone>/mod/dist/...` paths from
   `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, keeping any
   other paths; drop the key once it is empty. Show the diff and wait for
   approval before writing.
2. Remove the `~/.claude/skills/gauntlet-code-review` link step 5 made.
3. Tell the person to restart Claude Code.
4. Ask before deleting `<clone>`. `~/.gauntlet/mod` holds the Mod's settings,
   recipes and log; `~/.gauntlet` also holds review runs, and the Gauntlet CLI
   shares it: delete either only if they ask.
