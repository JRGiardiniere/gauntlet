---
name: gauntlet-code-review
description: >-
  Runs a Gauntlet code review inside Claude Code with Gauntlet's review tool
  and carries on with the findings when its digest arrives. Use when asked to
  run Gauntlet, or a Gauntlet review of uncommitted changes, a branch's
  commits, or a pull request, and when asked to update Gauntlet.
user-invocable: false
---

# Gauntlet

A review is one call to `mcp__gauntlet__review` (load it with ToolSearch when
only its name is listed). It returns at once; the review takes minutes, and its
agents run on the person's Claude plan.

## Start

`args` names the target, then any flags:

| What the person means | `args` |
| --- | --- |
| their uncommitted changes | nothing |
| pull request 42 | `42` |
| this branch's commits | `main` (the commits since its merge-base with `main`) |
| this branch's work including uncommitted edits | `main --working-tree` |
| a commit range | `abc123..def456` (`abc~1..abc` is one commit) |

It's the CLI's `gauntlet review` syntax, the same words.

When you cannot tell which they mean, ask before starting.

The review runs in the session's repository. For another local checkout, add
`--repo <path>` (absolute, `~/…`, or from the session's folder): "PR 42 in
creativemarket.com" is `42 --repo ~/projects/creativemarket.com`. A repository
that isn't cloned on this machine can't be reviewed.

- `--recipe claude-sonnet-low|medium|high` when they name an effort or model
  ("gauntlet medium"); left out, their default recipe.
- `--spec <file>`: requirements context you hold (acceptance criteria, notes),
  written as Markdown to a temporary file outside the repository.
- `--lenses a,b` only when they name perspectives; `--no-related-files` only
  when they ask.
- `--destination pr` only when they ask to post the review on the pull request:
  a pull-request review also posts `dossier.md` as a PR comment. The digest
  arrives before the post, and a second message follows with `posted <url>` or
  why the post failed.

To post a finished pull-request review the person asks to post afterwards,
`args` is `deliver <run id>` (the run id is the run directory's name in the
digest's `dossier.md` path). When a post fails, the message says to check the
pull request for the comment before delivering again; do that check first.

## Standards

The `standards` lens checks the diff against the repository's own rules: the
documents listed in its Standards Manifest, one path per line, kept outside the
repository (repo-relative paths resolve against the repo root; `~/` and
absolute paths are allowed). With no manifest the lens is skipped.

When the review tool's answer says the repository has no Standards Manifest,
offer to set it up while the review runs; the next review includes it:

- Propose a list from the repository: the repo-root `CLAUDE.md` **or**
  `AGENTS.md` (whichever exists, not both), plus documented style guides or
  contribution standards. Or ask whether they want you to dig further first.
- The list is theirs: write what they agree to, at the path the answer names.
- If they don't want standards for this repository, write an empty file there
  so they aren't asked again.

## Settings

`~/.gauntlet/settings.json` holds `"default-recipe"`, the recipe a review uses
when it names none. To change it ("make medium my default"), set that key to one
of the recipes the review tool lists, keeping the file's other keys.

## While it runs

Carry on with other work, or end your turn. The digest arrives as a message:
between your tool calls while you work, or as a new turn once you stop. One
review runs per session at a time; the person stops one with **Stop** above the
prompt.

## The digest

It lists the findings by priority (P1 first) and the path of `dossier.md`,
which holds each finding in full. Relay the findings to the person, then go on
with what they asked the review for. A digest that says the review could not
run says why. If a review was interrupted, run it again if the person still
wants it.

## Update

The mod is built from a git checkout, `<clone>`: in `env.CLAUDE_CODE_PLUGIN_DIRS`
of `~/.claude/settings.json`, the path that ends in `/mod/dist/gauntlet`, minus
that ending.
It sits on a release tag, not a branch, so don't `git pull`. Follow the
**Update** section of `<clone>/INSTALL.md`, then tell the person to restart
Claude Code.
