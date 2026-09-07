# Test suite cleanliness audit

Audited September 7, 2026, on `codex/cleanliness-effect-rc112`, with Effect
4.0.0-rc.112. The parent and three subagents reviewed all 48 Vitest files,
both shell test scripts, shared fixtures, and the optional live gates.
The previously shelved authentication changes are outside this audit.

## Result

The suite had real duplication and false confidence, concentrated in CLI
journeys, synthetic domain fixtures, and assertions weaker than their test
names. The remaining suite largely protects useful behavior.

| Measure | Before | After |
| --- | ---: | ---: |
| Vitest cases | 339 | 318 |
| Vitest files | 48 | 48 |
| Test source lines, including two shell scripts | 9,718 | 8,982 |

Removed 21 cases and 736 net lines, or 7.6% of test source. Changed 26 test
files. Strengthened existing scenarios without adding test dependencies or
changing application behavior. Counts use the committed tests at `52f9c57`
as the before state, after authentication work was shelved. Test support,
configuration, and optional live-gate source are excluded from line totals.

## What did not earn its place

- The conformance test asserted that parent-only text was absent from findings
  that never contained that text. Its specification fixture never influenced
  the decoded findings. It proved neither model reasoning nor scope filtering.
- The lens freezing test constructed its own `FrozenLens` and later confirmed
  that this object still held its original string. Actual submission and resume
  tests exercise freezing through the production boundary.
- CLI artifact and confinement journeys duplicated the same pipeline. They
  now share one journey with real workspace tool calls and persisted results.
- A GitHub specification resume journey duplicated the stronger retained case
  that changes source material and makes the original PR unavailable.
- Delivery tests separately recreated initial posting, idempotency, failure
  preservation, and retry. Two journeys now cover those transitions, including
  reading the persisted receipt and comparing preserved artifacts exactly.
- Two negative CLI subcases used a nonexistent resume Run. That alone stopped
  execution, independently of the invalid specification flags being tested.
- The unresolved-target test's no-Run-directory assertion duplicated the shared
  submission ordering covered by retained invalid-manifest and missing-source
  cases. Stray directories would be quiet; that assertion was removed as
  duplicate coverage, independently of the loud target refusal.
- The empty Dossier decoding smoke test duplicated populated persisted journeys.
  Historical schema fixtures and repeated Plausible decoding added little
  beyond current contract and resolution tests.
- Three prompt-prefix fixtures became one case preserving literal diff text,
  per-lens cap placement, and shared-prefix equality. Repeated unknown lens
  fields and invalid class spellings exercised the same validation path.
- Three arbitrary asset extensions duplicated the CSS lint fixture's generic
  asset exemption. A nonexistent `.js` import duplicated the existing
  filesystem-anchored missing-file case. Extension replacements, parent paths,
  actual JavaScript files, export forms, and loader queries remain covered.
- Exact progress narration, redundant membership checks after complete array
  equality, constant-value assertions, and assertions against another production
  helper were removed or replaced with observable results.

ADR 0008 explicitly excludes tests whose failures are obvious on the next
ordinary command. Removed refusal-only checks have concrete loud channels:
`gauntlet review --commits no-such-ref`, empty `--commits HEAD`, empty
`--commits HEAD --working-tree`, and resume with an unavailable worktree commit
all report errors at the terminal. Retired recipe display errors are visible
through `gauntlet config`; progress text is visible during `gauntlet review`.
Quiet selection, spend, and artifact guarantees remain tested.

## False confidence corrected

| Existing scenario | Weakness | Revised proof |
| --- | --- | --- |
| Candidate cap | Checked only the retained count | Checks the identities and order of retained candidates |
| Candidate routing | Checked union tags | Checks stable IDs, content, failure scenarios, and complete partitions |
| Pool fallback | Expected output came from another production helper | Literal expected clusters and accounting |
| Dossier assembly | Mostly counted entries | Checks advice, associated claims, dropped content, and gaps |
| Recoverable emit salvage | Newest entry was valid | Places malformed output last, requiring selection of the newest valid entry |
| Finder cache partitioning | Every Finder used the same Seat | Uses a distinct Seat and checks three groups, actual shared prefixes, and each Finder's own lens assignment |
| Comment byte limit | ASCII could not distinguish bytes from characters | Uses multibyte text and checks encoded size |
| Installer rerun | Identical release inputs could conceal a skipped update | Changes binary and skill inputs, checks both installed outputs and untouched legacy target |
| Document ordering | `indexOf` could compare missing text as `-1` | Requires all bodies to exist in the expected order |
| Linear issue decoding | Counted internal requests while barely checking content | Verifies returned title, body, state, parent, siblings, and authors |
| Digest path protection | Forged text used obsolete `report:` label | Uses the actual `dossier.md:` label |

Test names now describe their actual reach. The artifact test proves sequential
replacement without leftover suffixes or temp files, not atomicity under
interruption. TestSuggestion cases cover missing and empty contents, not every
possible malformed value. The missing-key test does not claim rejected-key
coverage.

## Coverage retained after file-by-file review

All names below end in `.test.ts` unless marked otherwise.

| Directory | Files reviewed | Retained purpose |
| --- | --- | --- |
| `src/cli` | `main`, `config`, `update-check` | CLI wiring, frozen resume, paid-work prevention, persisted configuration, update decisions |
| `src/run` | `artifact`, `finder-cache-health`, `finder-execution`, `review-working-directory`, `submission` | Artifact replacement, cache accounting, grouping and scheduling, snapshot fidelity, source precedence and frozen inputs |
| `src/workspace` | `review-workspace` | Host-data confinement, isolated writes, byte bounds, cancellation and tool behavior |
| `src/delivery` | `delivery` | Byte-safe posting, correct destination, receipts, idempotency and preservation |
| `src/harness` | `invoke`, `output-contract` | Lifecycle, deadlines, cancellation provenance, retry limits, output salvage and schema projection |
| `src/assembly` | `finders`, `pool`, `verification`, `dossier` | Candidate accounting, deterministic repairs, verdicts, advice and complete results |
| `src/domain` | `domain`, `finder-selection`, `lens-selection` | Valid locations, Seat grammar, exact selections and deliberate omissions |
| `src/content` | `lens`, `evaluation-prompt`, `specification-section` | Selected content, prompt structure, literal injected text and authority ordering |
| `src/specification` | `combine`, `comment-budget`, `github-source`, `linear-source` | Material preservation, comment accounting, authority, source selection and diagnostics |
| `src/target` | `commits`, `pull-request`, `working-tree` | Correct frozen diff, committed versus dirty state, exclusions and size bounds |
| `src/linear` | `linear` | Actual HTTP adapter decoding and source failure handling |
| `src/render` | `render` | Complete result partitions, line-safe output, honest diagnostics and digest paths |
| `src/stages/judgment` | `judgment`, `output-contract`, `resolution` | Stage wiring, degraded output, schema guidance and deterministic decision precedence |
| `scripts/lint-rules` | All 14 rule suites | Each rule's violations, false-positive boundaries, exemptions and fixes |
| `scripts` | `install.test.sh`, `upgrade-compiled.test.sh` | Managed installation and the separate compiled release-lookup gate |

Negative assertions remain where absence is the actual contract: no duplicate
paid invocation or delivery, no disposal while work is active, no host credential
in tool output, no dirty checkout content in a committed target, and no rejected
claim presented as a finding. Valid/invalid lint pairs prevent both missed
violations and false positives. Removing them solely for being negative would
make the suite less useful.

The compiled updater smoke test remains a release-workflow check for the actual
binary's HTTP layer wiring, following the self-updater regression fixed in
`95bbd32`. It only proves release lookup. It does not prove binary replacement
or a complete download. Optional provider live gates remain separate from the
default suite; no paid live calls were made for this audit.

## Verification

Three temporary production mutations demonstrated improved detection. For each,
the old targeted test passed and the revised test failed:

1. Keep six candidates starting at the second candidate instead of the first.
2. Use character count instead of UTF-8 byte length in the truncation shortcut.
3. Silently skip installation when a binary already exists.

Independent final review caught a lost assertion during CLI consolidation:
every Finder must receive its own lens assignment. The assertion now lives at
the Finder stage. A fourth temporary mutation, dropping all lens assignments
from execution prompts, failed this retained check.

All temporary mutations were restored before the final gates. This was targeted
fault injection, not a whole-suite mutation score or an exhaustive coverage claim.

- `bun run lint`: passed; Oxlint and official Effect diagnostics report zero
  errors and warnings. Madge still reports its existing 46 resolver warnings;
  no import cycles were found.
- `bun run typecheck`: passed.
- `bun run test`: 48 files and 318 Vitest tests passed, followed by the installer
  test. No before/after speed claim is made.
- `git diff --check`: passed.

The suite checks deterministic orchestration and contracts. It does not measure
the model's finding accuracy. Changes are local and uncommitted; the earlier
Effect upgrade and authentication stash remain intact.
