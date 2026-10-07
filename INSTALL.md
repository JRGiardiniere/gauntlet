# Install the Gauntlet beta (`/gc-cli`)

You are a coding agent installing the `/gc-cli` beta for the person you work
with. `/gc-cli` runs a Gauntlet review inside Claude Code: progress shows in a
strip above the prompt, the digest lands in the transcript, and **Open
dossier** opens the full report.

The beta is two Claude Code plugin folders, `gc-cli` and `gc-cli-tools`, built
from a git checkout. They stay bound to that checkout: they read lenses and
prompts from it, and rebuild themselves from it with the `bun` that built them.
So the clone stays where you put it, and `bun` must be a real command.

Work through **Install** in order. Each step ends on its done-when check; reach
it before moving on. Every change outside the clone (installing `bun`, editing
`~/.claude/settings.json`) waits for the person's approval.

## What the beta needs

- **Claude Code that loads mods.** The beta was built and checked against
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
git checkout gc-cli-beta.1
```

Done when `git -C <clone> describe --tags` prints `gc-cli-beta.1`.

### 3. Build

In `<clone>`:

```sh
bun install
bun run build-mod
```

Done when `build-mod` prints `gc-cli built at <clone>/mod/dist/gc-cli` and
`gc-cli-tools built at <clone>/mod/dist/gc-cli-tools`.

### 4. A Claude recipe

A review runs on a recipe from `~/.gauntlet/recipes/`. `/gc-cli` runs its
agents inside Claude Code, so its recipe names `claude-code/` seats.

- `~/.gauntlet/settings.json` missing (no Gauntlet config yet): in `<clone>`,
  run `bun bin/gauntlet.ts config init`, then write the recipe below and make
  it the default with `bun bin/gauntlet.ts config set default-recipe claude-sonnet-low`.
- `~/.gauntlet/settings.json` present (the person already uses Gauntlet):
  leave their settings alone. Write the recipe below unless one of that name
  exists, and remember to tell them to pass `--recipe=claude-sonnet-low`.

The recipe, `~/.gauntlet/recipes/claude-sonnet-low.json`:

```json
{"default":"claude-code/sonnet:low"}
```

Done when `bun bin/gauntlet.ts config` (in `<clone>`) lists
`claude-sonnet-low — default claude-code/sonnet:low`.

### 5. Load the mod in every session

Claude Code loads plugin folders named in `env.CLAUDE_CODE_PLUGIN_DIRS` of
`~/.claude/settings.json`: absolute paths joined by `:`.

1. Read `~/.claude/settings.json` (treat a missing file as `{}`).
2. Add `<clone>/mod/dist/gc-cli` and `<clone>/mod/dist/gc-cli-tools` to
   `env.CLAUDE_CODE_PLUGIN_DIRS`, after any paths already there, skipping one
   already listed. Every other key and value stays as it was.
3. Show the person the diff and wait for their approval.
4. Write the file.

Done when the file parses as JSON and `env.CLAUDE_CODE_PLUGIN_DIRS` holds the
earlier paths plus both new ones.

### 6. Validate

```sh
claude plugin validate <clone>/mod/dist/gc-cli
claude plugin validate <clone>/mod/dist/gc-cli-tools
```

Done when both end `Validation passed`; warnings about gating hooks and missing
author information are expected. A failure here usually means this Claude Code
is too old to load mods: report its version and the output to the person.

### 7. Hand over

Tell the person:

- Restart Claude Code (every terminal session, and the desktop app): it reads
  `env` only at startup.
- In a repository with a small uncommitted change, run `/gc-cli`, or
  `/gc-cli --recipe=claude-sonnet-low` if step 4 left their default recipe
  alone. The review uses their Claude plan.
- `/gc-cli 42` reviews pull request 42; `/gc-cli main` reviews the commits
  since `main`.

## Update

In `<clone>`:

```sh
git fetch --tags
git tag --list 'gc-cli-beta.*' --sort=-v:refname   # newest first
git checkout <newest tag>
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
2. Tell the person to restart Claude Code.
3. Ask before deleting `<clone>`. `~/.gauntlet` holds their settings, recipes,
   review runs and the mod's log (`~/.gauntlet/gc-cli`), and the Gauntlet CLI
   shares it: delete it only if they ask.
