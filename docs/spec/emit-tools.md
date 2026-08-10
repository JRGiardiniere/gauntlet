# Emit-tool contracts

The four structured-output tools, as specifications (not code). Each stage
agent must call its emit tool exactly once, as its final action, and never
answer in prose instead; an empty array is a legitimate result. Field
descriptions below are tuned prompt content — port them into tool definitions
verbatim at implementation.

Decoder policy: **strict, fail-closed**. One off-spec field fails the stage
result, surfacing the affected candidates as unverified/undecided rather than
silently rewriting a label. (The old repo's loose one-candidate bench twins
are not ported.)

## `emit_findings` — Finders

Tool description: "Report the findings from your review pass. Call this
exactly once, as your final action, even if you found nothing (pass an empty
array). Do not describe findings in prose instead of calling this tool."

`findings`: array of objects —

| field | type | req | description |
|---|---|---|---|
| `file` | string | yes | Path of the file the finding is in, as it appears in the changed-file list. |
| `line` | integer | no | 1-indexed line in the new version of the file. Omit only when the finding is about the change as a whole rather than a location. |
| `summary` | string | yes | One sentence stating the defect or issue. |
| `failure_scenario` | string | no | Concrete inputs or state that produce the wrong behaviour. Required for any claim a reviewer could refute; omit only for judgment calls with no refutable fact. |

`failure_scenario` optionality is the routing discriminator (ADR 0004):
present → BugClaim, absent → Observation. It stays optional by design.

## `emit_pool` — Pool

Tool description: "Report the organized clusters for the verifier stage. Call
this exactly once, as your final action. Every candidate index must appear in
exactly one cluster. Do not answer in prose instead."

`clusters`: array of objects —

| field | type | req | description |
|---|---|---|---|
| `indexes` | integer[] | yes | Candidate indexes in this cluster (1+ members). |
| `summary` | string | yes | Canonical one-sentence statement of the defect. |

## `emit_verdicts` — Verification (batched per bundle)

Tool description: "Report one verdict per cluster in this verifier bundle.
Call this exactly once, as your final action. Do not answer in prose instead."

`verdicts`: array of objects —

| field | type | req | description |
|---|---|---|---|
| `cluster` | integer | yes | The [cN] label of the cluster. |
| `verdict` | enum | yes | `CONFIRMED` \| `UNVERIFIED` \| `REFUTED` — see the ladder in the verifier prompt. |
| `severity` | enum | for confirmed/unverified | `P1` \| `P2` \| `P3`. Judged on reachability × consequence. |
| `evidence` | string | yes | One line: the inputs/state and wrong output, or the line that refutes it. |

## `emit_judgments` — Judgment

Tool description: "Report one keep/drop decision per candidate index. Call
this exactly once, as your final action. Do not answer in prose instead."

`decisions`: array of objects (exactly one entry per candidate index, no
duplicates, none omitted) —

| field | type | req | description |
|---|---|---|---|
| `index` | integer | yes | The [i] label of the candidate this decision is about. |
| `decision` | enum | yes | `keep` = warranted criticism worth reporting; `drop` = not worth the author's time. |
| `tier` | enum | keeps | `P1` \| `P2` \| `P3`. Required when keep, omitted when drop — a dropped candidate has no tier at all; "not actually a problem" is a drop with a reason, never a severity. |
| `merge` | integer[] | no | Indexes of duplicate candidates folded into this kept one — same root observation arriving at two altitudes. Merge duplicates, not themes. |
| `reason` | string | yes | One line. Keeps: why it is warranted AND what was checked in the tree to confirm the premise. Drops: which failure it is — false premise / disproportionate / taste, not cost / repo convention / BugClaim-path claim / no nameable payer. |
| `goodFind` | boolean | keeps | Was this genuinely worth catching, as opposed to merely admissible? Admissible but obvious is `false`. |
| `cleanlyExplained` | boolean | keeps | Reading ONLY the finder's own summary, are the problem and the better shape clear enough to act on? Judge the text as written. |
| `qualityNote` | string | no | Keeps only, when either rating is false: one line on what is weak. |

The `goodFind` / `cleanlyExplained` ratings are the Observation path's only
quality record (it is deliberately not scored against an answer key — keys
produced systematic disagreement on exactly these findings, 2026-08-04). They
persist per run in the journal/Dossier; there is no aggregate corpus
(ADR 0006).
