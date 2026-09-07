# Experimental Claude workflow

This implementation stays on `codex/claude-workflow` while it is tested.
CLI releases come from `main`. The workflow is not part of the compiled binary,
installer, or release assets. Keeping its commits off `main` also keeps the
workflow source out of release source archives.

`gauntlet.body.js` is the maintained orchestration source. The build embeds
Gauntlet's shared lenses, prompts, and constants into
`.claude/workflows/gauntlet.js`. That generated file is ignored by Git; rebuild
it when source or content changes. Ignoring the source itself would lose review
history without creating a useful release boundary.

## Local tests

```sh
bun install --frozen-lockfile
bun run test:workflow
```

This builds and executes the real generated artifact with scripted `agent`,
`parallel`, `phase`, and `log` callbacks. It makes no provider calls. The cases
cover both argument forms, model assignments, complete lens instructions,
specification routing, no-work selection, candidate caps, Pool repairs,
incomplete verdicts, and preservation after agent failures.

These tests are separate from `bun run test` and `bun run lint`. A dedicated
pull-request workflow runs them when workflow source, shared content, or build
dependencies change. Assertions cover the port's observable results because
the CLI tests cannot validate this separate orchestration implementation.

## Native host check before promotion

Scripted tests do not prove Claude's native workflow loader, structured-output
handling, journaling, permissions, model availability, or review accuracy.
Keep the implementation experimental until a real Claude session has exercised
the generated artifact. A native run uses the session's model quota.

Build with `bun run build-workflow`. For an opt-in native check, copy the output
to `~/.claude/workflows/gauntlet.js`, then use a disposable Git repository with
a small known defect:

```text
run the gauntlet workflow with args "--lenses=diff-scan"
```

Inspect the invocation journal and returned Dossier for completed Finder and
verifier work, the intended diff, and explicit coverage gaps. An exit or a
returned report alone is insufficient. Confirm the repository is unchanged.
Repeat against a clean tree and verify that only Submission runs and the
result explains that there is nothing to review.

The workflow's subagents see the real checkout. It has no CLI ReviewWorkspace
confinement, run-directory resume, project-local lenses, or user Recipe Catalog.
Keep those differences visible when assessing whether to promote it.
