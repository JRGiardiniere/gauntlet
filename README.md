# gauntlet

**A provider-neutral code-review workflow.** Gauntlet combines my favorite
parts of Claude's code review, Matt Pocock's code review, and other commands I 
found myself repeating to agents over and over — turned into one repeatable
pipeline you run with a single command. ("Run the gauntlet on medium.")

Multiple subagent **finders** hunt for bugs through different lenses, a pooled
set of adversarial **verifiers** tries to refute every claim before you ever
see it, and a parallel track of **observation finders** looks for cleanup and
structural improvements — judged against general programming principles plus
your own best-practices docs, which you can drop in as plain markdown.

Set combinations of models and reasoning effort, save them as review levels
(`quick`, `low`, `medium`, `high`, whatever), and pick the depth each review deserves.
Findings arrive in a report called a dossier, every bug claim carries a verdict
(confirmed / plausible / refuted) to help steer your review.

Runs on an embedded OpenCode Host, so Claude and OpenAI models mix freely across
a review's stages, and special care was taken to make sure it caches well.
Agents get at most read-only `read`, `grep` and `glob` over a frozen snapshot
of your change: no shell, no writes, no network. That is a permission fence,
not hardened isolation for reviewing a hostile repository.

## How it works

1. **Finders** read your diff through independent lenses (correctness,
   security, concurrency, your own standards, …) and over-generate candidates.
2. **Verifiers** and **Judges** adversarially review every bug claim against your
   codebase — surviving results are ranked by likelihood to cause issues, P1–P3.
3. You get a markdown **dossier** locally, and optionally posted straight to
   the PR as a single comment.

Reviews can be targeted at a PR, a series of commits, or your current working branch. 

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/JRGiardiniere/gauntlet/main/install.sh | sh
```

The installer puts the binary in `~/.local/bin`, installs the Gauntlet agent
skill in `~/.agents/skills/gauntlet-cli`, and links that skill into
`~/.claude/skills/gauntlet-cli`. Linux and macOS, x64 and arm64. Already
installed? `gauntlet upgrade` moves you to the latest release.

Then:

```sh
gauntlet config init     # seeds ~/.gauntlet with recipes + the 13 shipped lenses
gauntlet review          # your uncommitted changes; or 42 for a PR, main for your branch
gauntlet review 42 --recipe high --destination pr   # review PR 42 harder, post it there
```

**OpenAI Seats** (the `quick`, `low`, `medium` and `high` recipes).
`gauntlet login` signs in with ChatGPT into Gauntlet's own store under
`~/.gauntlet/opencode`; your own OpenCode, Codex and Pi logins are never read
or touched. On a machine you reach remotely, paste the URL the browser was
redirected to when it asks. To use an OpenAI API key instead, set
`OPENAI_API_KEY` in the environment; no login is needed.

**Claude Seats** (`claude-low`, `claude-medium`, `claude-high`) need Claude
Code's `claude` installed and logged in (`claude auth login`); Gauntlet runs
it on your Claude plan with all of Claude Code's own tools off. Gauntlet
finds `claude` on your PATH. Set `OPENCODE_CLAUDE_PATH` to the real
executable when it isn't there, or when `claude` is a version-manager shim
(such as mise's) that breaks outside your shell, for example
`OPENCODE_CLAUDE_PATH=~/.local/share/mise/installs/claude/latest/claude`.
OpenAI-only use needs no `claude`.

On an existing, valid configuration, `gauntlet config init` adds the Claude
recipes if they are missing, and never overwrites a recipe you have.

**Output.** A review prints a short digest: findings grouped by Review
Priority (P3s counted, not listed), coverage gaps, and tokens and cache hit
rate per Stage, then the path to the full `dossier.md`.

## Upgrading from v1

v2 is one CLI on an embedded OpenCode Host. Gone in v2:

- The Claude Code Mod (`/gauntlet`). Claude Seats run from the CLI instead.
  Remove the Mod with
  `claude plugin uninstall gauntlet && claude plugin marketplace remove gauntlet`.
- Pi. OpenAI sign-in is `gauntlet login`; your old Pi login is not used.
- The HTML Dossier page and the `page` and `brief` commands. `dossier.md` and
  the digest remain.
- Linear and GitHub issue lookup. Pass requirements with `--spec <file>`.

Your recipes, settings, lenses and runs in `~/.gauntlet` stay. v2 commands
support only Runs made by v2, so deliver any pending v1 Run before upgrading.

`gauntlet --help` is the full flag reference. To customize:

- **Recipes** — one JSON file each in `~/.gauntlet/recipes/`; copy one, edit
  the `provider/model:effort` seats, done. Add `+fast` after an OpenAI seat's
  effort (`openai/gpt-6.1-terra:high+fast`) for Fast mode.
- **Lenses** — drop markdown files in `.gauntlet/lenses/` for project-local
  review standards; `--lenses a,b` selects exactly those for one run.
- **Agent skill** — the installer keeps the shared skill in
  `~/.agents/skills/gauntlet-cli` so coding agents can run reviews from any repo.

## Debugging a review

Run a review with `gauntlet --log-level debug review ...` to include each
invocation's complete session transcript in that Run's existing `run.log`.
The transcript entries include prompts, model messages, tool calls, and tool
results. Normal terminal output stays bounded, and ordinary CLI reviews do not
log or persist transcripts.
