---
name: gauntlet-code-review
description: >-
  Runs a Gauntlet code review inside Claude Code with the gc-cli mod's review
  tool and carries on with the findings when its digest arrives. Use when asked
  to run Gauntlet, or a Gauntlet review of uncommitted changes, a branch's
  commits, or a pull request, and when asked to update Gauntlet, the gc-cli
  plugin or the beta.
---

# Gauntlet

A review is one call to `mcp__gc-cli__review` (load it with ToolSearch when
only its name is listed). It returns at once; the review takes minutes, and its
agents run on the person's Claude plan.

## Start

`args` names the target, then any flags:

| What the person means | `args` |
| --- | --- |
| their uncommitted changes | nothing |
| pull request 42 | `42` |
| this branch's commits | `main` (the commits since its merge-base with `main`) |
| a commit range | `abc123..def456` |

When you cannot tell which they mean, ask before starting.

- `--recipe claude-sonnet-low|medium|high` when they name an effort or model
  ("gauntlet medium"); left out, their default recipe.
- `--spec <file>`: requirements context you hold (acceptance criteria, notes),
  written as Markdown to a temporary file outside the repository.
- `--lenses a,b` only when they name perspectives; `--no-related-files` only
  when they ask.

## While it runs

Carry on with other work, or end your turn. The digest arrives as a message:
between your tool calls while you work, or as a new turn once you stop. One
review runs per session at a time; the person stops one with **Stop** above the
prompt.

## The digest

It lists the findings by priority (P1 first) and the path of `dossier.md`,
which holds each finding in full. Relay the findings to the person, then go on
with what they asked the review for. A digest that says the review could not
run says why; an interrupted run's digest names the `--resume <run id>` that
continues it.

## Update

The beta is built from a git checkout, `<clone>`: the folder two levels above
`mod/dist/gc-cli` in `env.CLAUDE_CODE_PLUGIN_DIRS` of `~/.claude/settings.json`.
It sits on a release tag, not a branch, so don't `git pull`. Follow the
**Update** section of `<clone>/INSTALL.md`, then tell the person to restart
Claude Code.
