# gauntlet-claude: Gauntlet as a Claude workflow

The Gauntlet CLI is the default way to review code. Use `gauntlet review`, or
ask an agent with the `gauntlet` skill installed to run it. `gauntlet-claude`
is an alternative that runs the same pipeline, lenses, and prompts on Claude
subagents. Use it when you want Claude models, or to compare the two on the
same change. Run it by name:

```text
run the gauntlet-claude workflow with args "42 --level=medium"
```

It lives on `codex/claude-workflow`, not `main`. CLI releases come from `main`,
and the workflow is not part of the compiled binary, installer, or release
assets.

## Install

```sh
bun install --frozen-lockfile
bun run build-workflow
cp .claude/workflows/gauntlet-claude.js ~/.claude/workflows/
```

Rebuild and copy again after pulling changes to the workflow or to shared
lens and prompt content.

`gauntlet.body.js` is the maintained orchestration source. The build embeds
Gauntlet's shared lenses, prompts, and constants into
`.claude/workflows/gauntlet-claude.js`. That generated file is ignored by Git; rebuild
it when source or content changes. Ignoring the source itself would lose review
history without creating a useful release boundary.

## Args

```text
[target] [--level=low|medium|high] [--finders=standard|extra] [--lenses=a,b] [--spec=<prose>]
```

The target comes first: empty for the working tree, a PR number,
`base..head`, or a branch.

`--level` picks one seat for every stage. The default is `medium`.

| Level | Seat |
| --- | --- |
| `low` | sonnet, medium effort |
| `medium` | opus, medium effort |
| `high` | opus, high effort |

`--finders` picks the lens set. The default is `standard`.

- `standard` runs eight lenses: subjective, spec-conformance,
  presentation-environment, standards, absence, diff-scan, removed-behavior,
  and cleanup.
- `extra` adds cross-file, language-pitfalls, security,
  refactoring-checklist, and wrapper-proxy. Together these five found 32 of
  396 unique P1/P2 findings across 192 CLI runs, Aug 18 to Oct 1 2026, for a
  third of finder spend. A unique finding is one that no other lens also
  found.

`--lenses` names an exact list instead of a set.

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
to `~/.claude/workflows/gauntlet-claude.js`, then use a disposable Git repository with
a small known defect:

```text
run the gauntlet-claude workflow with args "--lenses=diff-scan"
```

Inspect the invocation journal and returned Dossier for completed Finder and
verifier work, the intended diff, and explicit coverage gaps. An exit or a
returned report alone is insufficient. Confirm the repository is unchanged.
Repeat against a clean tree and verify that only Submission runs and the
result explains that there is nothing to review.

The workflow's subagents see the real checkout. It has no CLI ReviewWorkspace
confinement, run-directory resume, project-local lenses, or user Recipe Catalog.
Keep those differences visible when assessing whether to promote it.
