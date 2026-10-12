---
name: gauntlet-code-review
description: >-
  Runs a Gauntlet code review inside Claude Code through the Mod's review tool
  (`mcp__gauntlet__review`), not the `gauntlet` command, and carries on with
  the findings when its digest arrives. Use when asked to run Gauntlet, or a
  Gauntlet review of uncommitted changes, a branch's commits, or a pull
  request; to write a brief for a finding; and to update Gauntlet.
user-invocable: false
---

# Gauntlet

A review is one call to `mcp__gauntlet__review` (load it with ToolSearch when
only its name is listed). It returns at once; the review takes minutes, and its
agents run on the person's Claude plan. They are headless `claude -p`
processes, not subagents: they show only on the strip above the prompt, and
the digest is the one message the review sends you.

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

- `--recipe low|medium|high` when they name an effort ("gauntlet high");
  left out, their default recipe.
- `--spec <file>`: requirements context you hold (acceptance criteria, notes),
  written as Markdown to a temporary file outside the repository.
- `--lenses a,b` only when they name perspectives; `--no-related-files` only
  when they ask.
- `--destination pr` only when they ask to post the review on the pull request:
  a pull-request review also posts `dossier.md` as a PR comment. The digest
  arrives without waiting for the post, and a second message follows with
  `posted <url>` or why the post failed.

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

The Mod keeps its own settings and recipes in `~/.gauntlet/mod/`, apart from
the Gauntlet CLI's. The review tool with `args` `config` answers at once with
them: the settings, the Default Recipe and every recipe, each invalid one with
why.

- To change the default ("make high my default"), set `"default-recipe"` in
  `~/.gauntlet/mod/settings.json` to one of its recipes, keeping the file's
  other keys.
- A recipe is one JSON file in `~/.gauntlet/mod/recipes/`, named for the
  recipe, with a `default` Seat and optional `finders`,
  `interpretive-finders`, `pool`, `verification` and `judgment` overrides.
  Seats are `claude-code/<model>:<effort>`: `{"default":"claude-code/opus:medium"}`.
  After editing settings or a recipe, run `config` and fix anything it
  lists as invalid.

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

## Briefs

Every review writes `dossier.html` beside `dossier.md`: a page with each
finding beside the code it cites. A brief is your explanation of one finding,
drawn on the page. The page's "Ask for a brief" prompt names CLI commands;
here each is the review tool with the same words as `args`, answered at once:

1. `brief <run id> <finding id>` answers with the instructions for that
   finding's brief. Follow them: they say what to read and where to write it.
2. Their last step, `gauntlet page <run id>`, is `args` `page <run id>`. It
   redraws the page and answers with its path, plus a `gauntlet: briefs/…`
   line for each block the page could not draw. Fix those and redraw until
   there are none.

## Update

The Mod is a Claude Code plugin from the `gauntlet` marketplace. Run
`claude plugin update gauntlet` in a shell, then tell the person to run
`/reload-plugins`.
