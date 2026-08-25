---
name: gauntlet
description: >-
  Runs `gauntlet review` through an agent host's managed long-running execution
  and relays the stdout digest verbatim. Use when asked to review uncommitted
  changes, a branch's commits, or a pull request, to configure a Recipe, or to
  deliver a completed Dossier.
---

# Gauntlet

One host-managed command. Stdout is a bounded digest to relay verbatim. The
Dossier lives on disk.

## Review

1. **Aim.** Every review names its target — point the tool at what you mean;
   there is no default and no autodetect.

   | What you mean | Flag |
   | --- | --- |
   | this PR | `--pr N` |
   | these commits | `--commits <base>[..<head>]` |
   | everything uncommitted | `--working-tree` |
   | this branch's work including uncommitted edits | `--commits <base> --working-tree` |

   `--commits` defaults its head end to `HEAD` and accepts any branch, tag, or
   SHA on either end; it reviews `merge-base(base, head)..head`, so
   `--commits main` is the usual "review my branch". Uncommitted edits are not
   part of a plain `--commits` review — they are reported as a warning; add
   `--working-tree` to include them. `--pr` cannot be combined with the other
   target flags. When you cannot tell which the user means, ask before
   launching.
2. **Recipe.** Omit the positional name so the configured Default Recipe is
   used, unless the user named a Recipe.
3. **Lenses.** Omit `--lenses` to use the configured Default Lenses. When the
   user names perspectives for this run, pass one exact comma-separated
   `--lenses a,b` list; it replaces Default Lenses without changing Recipe
   Seats. Adding a Lens file only makes it available. Run `gauntlet config` to
   discover available and Default names.
4. **Destination.** Local artifacts always land. Default is `--destination
   local`. `--destination pr` only when the user asked to post a PR comment; it
   requires `--pr`. `review --pr`, `--destination pr`, and `deliver` need the
   GitHub CLI (`gh`) installed and authenticated.
5. **Specification.** Any target whose current branch contains one Linear
   issue ID tries to resolve it as the current Slice, plus one native parent,
   sibling titles/states, and human comments. This needs `LINEAR_API_KEY`. A
   resolved Linear issue wins over GitHub. When Linear is absent or unreachable, a
   `--pr` review falls back to GitHub closing issues as the current Slices
   (native parent one level;
   owner/member/collaborator comments under a 20,000-character earliest-first
   budget). An unreachable Linear issue still prints and reports its actionable
   diagnostic beside any GitHub material. When the user explicitly chooses
   GitHub for this Run, pass `--github-spec`; it requires `--pr`, skips Linear,
   and fails unless GitHub closing issues produce a specification. Otherwise
   GitHub unavailability or a PR with no closing issues stays quietly
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
6. **Launch** through the agent host's managed long-running execution
   mechanism:

   ```
   gauntlet review [recipe] <target> [--github-spec] [--spec <markdown-file>] [--destination local|pr] [--lenses a,b]
   ```

   Keep `gauntlet review ...` in the foreground inside that facility. Retain
   the process or task handle and any output path returned by the host, then use
   the host's wait or output operation until the command exits. Do not wrap the
   command in `nohup` or append `&`; shell detachment can end the managed shell
   invocation before Gauntlet finishes and lose lifecycle or output tracking.

   - **Codex:** call `exec_command` with a short initial `yield_time_ms`. Retain
     any returned `session_id` and wait with empty `write_stdin` calls until the
     process exits.
   - **Claude Code:** call Bash with `run_in_background: true`. Retain the
     returned task ID and output-file path, then read that file when the task
     completes. A timed initial yield is not needed.
   - **Other agents:** use the equivalent managed process facility. If none
     exists, keep the command in the foreground and wait for it.

   A review takes minutes because it fans out real model invocations and
   streams progress to stderr. Do not kill a run for being slow while progress
   lines still arrive. If a launch exits immediately with no host handle, no
   Gauntlet run ID, and no output, it did not start a review. Launch it once
   more through managed execution. Once Gauntlet prints a run ID, handle any
   interruption with `--resume` as described below.

   Exit 0 means a review was produced (zero findings included). Exit 1 means
   it could not review, or a PR comment failed after the review landed.

   If a run was interrupted (killed shell, crash), do not start a replacement
   review: `gauntlet review --resume` continues the latest incomplete run from
   its frozen inputs — completed stages are reused, and the target, recipe,
   and lenses cannot be re-specified because the plan is frozen. Pass the
   run id (`--resume <run-id>`) to name a specific run.
7. **Relay.** Paste the stdout digest verbatim whenever it printed. Then:
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

## Lenses

Default Lenses are the standing membership for ordinary reviews. Replace them
with `gauntlet config set default-lenses <name...>`; pass no names for a valid
empty selection. `default-lenses` cannot be unset.

Use exact `--lenses a,b` for one targeted run. Recipes choose Seats only. Create
or improve a Lens by editing its Markdown directly, then run `gauntlet config`
to validate and discover it; availability never selects it automatically.

## Standards Manifest

The `standards` Lens reviews the diff against this repository's governing
documents. It is fed by a Standards Manifest: a user-owned, per-repository
file listing those documents, one path per line — repo-relative paths resolve
against the repo root; `~/` and absolute paths are allowed for documents
shared across repositories. It is never a file inside the reviewed
repository. `gauntlet config` prints the manifest's exact path for the
current repository as `standards manifest:`.

When a review will include the `standards` Lens and that path does not exist,
offer to create it: propose the repository's governing documents — typically
the repo-root CLAUDE.md **or** AGENTS.md (whichever exists, not both), plus
any documented style guides or contribution standards the repo carries — and
write the agreed list to the printed path. Nothing is implicit: a document
participates only by being listed. With no manifest the Lens is skipped and
reported, never silently invoked; a listed path that does not exist fails the
review before a Run is created.

## Deliver

`gauntlet deliver <run-id>` posts an already-completed pull-request run's
`dossier.md` as a single PR comment.
