---
name: gauntlet
description: >-
  Runs Gauntlet as a background `gauntlet review` and relays the stdout digest
  verbatim. Use when asked to review uncommitted changes, review a pull
  request, configure a Recipe, or deliver a completed Dossier.
---

# Gauntlet

One background command. Stdout is a bounded digest to relay verbatim. The
Dossier lives on disk.

## Review

1. **Aim.** A named PR takes `--pr N`. Otherwise assume the working tree. If
   `git diff HEAD` is empty, ask which PR before launching.
2. **Recipe.** Omit the positional name so the configured Default Recipe is
   used, unless the user named a Recipe.
3. **Destination.** Local artifacts always land. Default is `--destination
   local`. `--destination pr` only when the user asked to post a PR comment; it
   requires `--pr`. `review --pr`, `--destination pr`, and `deliver` need the
   GitHub CLI (`gh`) installed and authenticated.
4. **Specification.** Any target whose current branch contains one Linear
   issue ID resolves it as the current Slice, plus one native parent, sibling
   titles/states, and human comments. This needs `LINEAR_API_KEY`. A matching
   branch wins over GitHub; a missing/invalid key or unreachable issue keeps
   the review running while an actionable diagnostic prints and lands in the
   report. With no Linear binding, a `--pr` review resolves GitHub closing
   issues as the current Slices (native parent one level;
   owner/member/collaborator comments under a 20,000-character earliest-first
   budget). GitHub unavailability or a PR with no closing issues stays quietly
   specification-less. When you hold
   additional requirements context — acceptance criteria, explicit deferrals,
   local notes — write it as a Markdown Caller Addendum and pass
   `--spec <path>`. Write the file to a temporary location **outside the
   reviewed repository** (a scratch or temp directory), never into the
   worktree under review: an addendum inside the repo becomes an untracked
   review input by accident. The addendum is carried beside fetched material
   and labeled caller-provided; fetched text remains the authority. The file
   is read once and frozen into the plan; a missing, unreadable, or empty file
   fails before any run is created, and `--spec` cannot be combined with
   `--resume`.
5. **Launch** as a background shell task:

   ```
   gauntlet review [recipe] [--pr N] [--spec <markdown-file>] [--destination local|pr]
   ```

   Exit 0 means a review was produced (zero findings included). Exit 1 means
   it could not review, or a PR comment failed after the review landed.
6. **Relay.** Paste the stdout digest verbatim whenever it printed. Then:
   local delivery → link `dossier.md` from the digest paths. A PR destination
   that posted (stderr `posted <url>`) → say the review was delivered as a
   comment on the PR.

## Dossier

Human detail: read `dossier.md` on disk, and only for findings you will act on.
Machine truth: parse `dossier.json` on disk. Stdout is the digest, not the
Dossier.

A finding may carry a "suggested tests" line — existing repository tests the
verifier believes would increase confidence. Running them is optional: run a
relevant one with the repository's own instructions, ask the user, or leave it
as follow-up. Investigate a failure in the context of the suggestion's stated
reason. A pass is supporting evidence only to the extent the existing test
actually covers the suspected behavior — never automatic refutation of a
scenario it may not cover. Verdicts stand either way; Gauntlet never runs
suggested tests itself.

## Recipe

When configuration or a new Recipe is needed:

1. Run `gauntlet config` — it prints the settings path and the Recipe Catalog.
2. Inspect or copy a nearby Recipe.
3. Write one lowercase-kebab JSON file in the displayed Recipe Catalog.
4. Run `gauntlet config` again to validate it.

`gauntlet config init` only for a genuinely fresh setup.

## Deliver

`gauntlet deliver <run-id>` posts an already-completed pull-request run's
`dossier.md` as a single PR comment.
