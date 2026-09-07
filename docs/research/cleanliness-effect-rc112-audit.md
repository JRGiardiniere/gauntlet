# Gauntlet cleanliness and Effect audit

Audited September 7, 2026 by the primary agent and three independent agents
covering runtime behavior, Effect use, and source/documentation cleanliness.

## Assessment

Gauntlet's review engine is well structured for its job. Its complexity mainly
comes from preserving paid work, controlling model sessions, and reporting
incomplete coverage honestly. No blocking core runtime defect was substantiated.
A broad rewrite would have little demonstrated benefit.

The source is not buried in comments. Across the 75 committed non-test `src`
TypeScript files, 853 of 10,932 lines are standalone comments, about 7.8%.
Only 18 of 292 contiguous line-comment blocks exceed five lines; the longest
has eleven. These are approximate lexical counts, excluding inline comments.
The useful comments explain lifecycle ownership, schema projection, filesystem
behavior, and review contracts. The largest maintenance burden was the active
Effect documentation copied from Cloudflare Hub.

## What was actually audited

| Target | Evidence and limitation |
| --- | --- |
| Published release | GitHub latest release `v1.0.2`, published August 25, 2026, commit `95bbd32cc469a94d84efc8ddbdf4450baffbfda0`; pins Effect rc.110. |
| Committed checkout | `52f9c578355dd88170a799b5813181b62fa5a806`; core pipeline, harness, persistence, and delivery code matches v1.0.2. Later commits principally add the Claude workflow and its configuration/plan bridge. |
| Installed local command | `~/.local/bin/gauntlet` links to this checkout's `dist/gauntlet`. It reports `v0.0.0-dev`, includes `auth`, and cannot be attributed to an exact commit from its version. Its behavior differs from the published release. |
| Pending source | Auth onboarding plus two research notes. Examined separately and preserved in a named stash. |

The audit does not assert that every machine runs this revision. No remote
deployment inventory or public release was performed. The installed development
binary was preserved; the upgraded build is `dist/gauntlet-rc112`.

## Runtime effectiveness

The audit traced target capture, frozen ReviewPlans, workspace reconstruction,
submission, invocation cancellation and disposal, Finder checkpoints, Pool
repair, Verification, Judgment, Assembly, resume, and delivery receipts.

- Frozen inputs and invocation-local workspaces preserve review identity.
- Finder checkpointing and resume reuse completed stages instead of repeating
  paid work. Resume remains stage-granular where the contract says so.
- Provider endings become explicit outcomes and coverage gaps. Configuration
  and adapter-contract failures remain typed failures.
- Verification preserves refutations; Judgment retains dropped observations.
  Deterministic assembly accounts for missing or inconsistent model output.
- Delivery is recorded separately from review completion.

The latest 20 local persisted Runs, August 30 through September 7, provide a
small observational sample from 108 run directories:

| Observed result | Count |
| --- | ---: |
| Dossier and Finder checkpoint present | 20/20 |
| Runs without coverage gaps | 14/20 |
| Latest consecutive Runs without gaps | 8 |
| Completed Finder invocations | 205/230 |
| Finder provider failures | 24 |
| Finder budget/deadline exhaustion | 1 |
| Refuted claims retained | 22 |
| Dropped observations retained | 91 |
| Delivery receipts in this sample | 0 |

Two Runs had twelve provider failures each and correctly retained twelve
coverage gaps. One failure group explicitly reported rate limiting. Other gaps
included Verification timeout/incomplete labels and Judgment merge repairs.
Producing a Dossier therefore does not mean every requested check succeeded.
This sample supports operational reliability and honest degradation, not
measured precision or recall. No new paid model review was run, and this sample
does not establish successful live PR delivery.

## Findings and disposition

1. **P2, existing: self-upgrade does not bound the download body.**
   `src/cli/upgrade.ts:61-83` applies a 30-second timeout to the response headers,
   then awaits `response.arrayBuffer` without a Gauntlet-owned deadline. The
   comment implies progress-aware transfer handling, but there is no idle timer.
   A stalled body can remain pending beyond the header deadline. A focused
   follow-up should add an explicit body or inactivity deadline and exercise a
   stalled response. This is unrelated to rc.112 and remains unchanged.
2. **P2, pending auth work: preflight examines unused recipe seats.**
   In the saved changes, `src/cli/auth.ts` checks every raw recipe field, including
   an overridden default and an unused interpretive-finder seat. It can demand
   OpenAI login even when the resolved execution uses another provider. The CLI
   also resolves the recipe twice. The feature is useful, but should validate
   resolved seats once before creating a Run. It is shelved intact for that work.
3. **P3, fixed: stale active Effect guidance.**
   The house style and patterns guide contained nonexistent Hub paths, old beta
   API claims, and runtime restrictions that contradict this Bun project. They
   now use Gauntlet examples and the current pin. Rule numbers remain stable for
   existing lint diagnostics. Historical text remains in Git.
4. **P3, fixed: entrypoint chains layer provisioning.**
   `bin/gauntlet.ts` now provides one combined graph for the independent Pi,
   Linear, and GitHub layers, with Node services supplied and exposed downstream.
   This removes the official `multipleEffectProvide` warning.
5. **P3, existing: test-suggestion tolerance is overstated.**
   `src/harness/output-contract.ts:104`, `src/assembly/verification.ts:72`, and
   `docs/spec/emit-tools.md:61` broadly promise that malformed suggestions cannot
   invalidate verdicts. The decoder tolerates missing/empty contents, but null,
   wrong-typed fields, and excess keys still reject the output. No sampled
   incident establishes a need for broader recovery. Clarify the intended
   tolerance before changing either the normative specification or decoder.
6. **P3, existing: GitHub traversal lacks Linear's explicit bounds.**
   `src/github/github.ts:375-433` paginates without an application page cap and
   can stop silently if GitHub says another page exists but supplies no cursor.
   Its subprocess output collection is also unbounded. These are differences
   from the project's stated I/O rules, not observed incidents in the sample.
   Avoid presenting GitHub as the bounded-pagination example; a runtime change
   should be justified separately from this dependency upgrade.

## Effect upgrade

The npm `rc` tag was checked live for `effect`, `@effect/platform-node`, and
`@effect/vitest`; all resolve to `4.0.0-rc.112`. All three direct dependencies
are pinned exactly to that version, with `@effect/platform-node-shared` updated
through the lockfile. `@effect/tsgo` keeps its independent version.

Gauntlet already uses Effect v4 substantively: scoped acquisition and fibers,
`raceFirst` deadlines, typed errors, Schema boundary decoding, bounded HTTP
retries, and deterministic TestClock tests. Promise crossings in the Pi adapter
serve actual external callback interfaces. There is no demonstrated reason to
replace Pi or introduce Effect RPC, Workflow, Pool, or AI modules.

No mandatory application API migration was needed. rc.111 fixes Deferred/fiber
cleanup behavior; rc.112 improves Schema parsing and scoped acquisition. Those
improvements apply through the dependency upgrade. Upstream changes to RPC,
Pool/Scope state representations, and CLI prompt themes do not affect the
interfaces used here. Sources: [rc.111 release notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.111)
and [rc.112 release notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.112).

## Preservation and verification

Work is on `codex/cleanliness-effect-rc112`, based on `52f9c57`.
The original 13 changed/untracked files are preserved as stash commit
`c45d24c4b97bcf7b37483f3f7a94e31d93a96e3c`, named
`auth onboarding and research before Effect rc.112 cleanliness audit`.
Apply that commit on a suitable branch when resuming auth work; the entrypoint
layer cleanup may need reconciliation. A separate copy of the original patch,
untracked files, and installed binary is in `/tmp/gauntlet-cleanliness-1wimXN`.
The Git stash is the durable source backup; the temporary copies are supplementary.

- Before shelving: typecheck, 341 tests, and installer checks passed on rc.110.
- After upgrading and the layer cleanup: typecheck, all 339 tests in 48 files,
  and installer checks passed. The two-test reduction is the shelved auth tests.
- Lint passed with zero Oxlint warnings/errors and zero official Effect
  diagnostics. Import-cycle checking found no cycles; Madge still reports its
  existing 46 resolver warnings in the gate output.
- Compiled `dist/gauntlet-rc112`, checked help, and passed the compiled updater
  release-lookup test. That test does not exercise asset replacement or a
  streamed binary download.
- The installed `dist/gauntlet` remained byte-identical to its saved copy.
- Logs are in `/tmp/gauntlet-cleanliness-1wimXN`; no commit, push, or release was made.
