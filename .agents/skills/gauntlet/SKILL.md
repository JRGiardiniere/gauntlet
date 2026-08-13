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
4. **Launch** as a background shell task:

   ```
   gauntlet review [recipe] [--pr N] [--destination local|pr]
   ```

   Exit 0 means a review was produced (zero findings included). Exit 1 means
   it could not review.
5. **Relay.** Paste the stdout digest verbatim. Then: local delivery → link
   `dossier.md` from the digest paths; PR destination → say the review was
   delivered as a comment on the PR.

## Dossier

Human detail: read `dossier.md` on disk, and only for findings you will act on.
Machine truth: parse `dossier.json` on disk. Stdout is the digest, not the
Dossier.

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
