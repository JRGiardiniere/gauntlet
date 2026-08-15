import { describe, expect, it } from "@effect/vitest"
import { Candidate } from "../domain/candidate.ts"
import { Dossier } from "../domain/dossier.ts"
import { Judgment } from "../domain/judgment.ts"
import { FrozenLens, ReviewPlan } from "../domain/review-plan.ts"
import { ReviewTarget, targetIdentityOf } from "../domain/review-target.ts"
import { Verdict } from "../domain/verdict.ts"
import { renderDigest } from "./digest.ts"
import { renderDossierMarkdown } from "./dossier-markdown.ts"
import type { RunPaths } from "../run/run-record.ts"

const bugClaim = (
  id: string,
  summary: string,
  file = "src/alpha.ts",
  lens = "fixture-lens",
) =>
  Candidate.cases.BugClaim.make({
    id,
    lens,
    file,
    line: 3,
    summary,
    failureScenario: "input of length zero loops forever",
  })

const observation = (id: string, summary: string) =>
  Candidate.cases.Observation.make({
    id,
    lens: "fixture-lens",
    file: "src/beta.ts",
    summary,
  })

const target = ReviewTarget.cases.WorkingTree.make({
  repoRoot: "/repo",
  headCommit: "abcdef0123456789",
  changedFiles: ["src/alpha.ts", "src/beta.ts"],
  diff: "+needle",
  untrackedFiles: [],
  warnings: ["2 untracked file(s) not included in the diff: stray.txt, x.txt"],
})

const confirmedVerdict = Verdict.cases.Confirmed.make({
  reviewPriority: "P1",
  evidence: "reproduced with an empty input",
})

// One entry in every partition of the taxonomy: confirmed / unverified
// (tiered and untiered) / refuted BugClaims, kept / undecided / dropped
// Observations. The confirmed claim shares its Pool cluster with a second
// lens's shorter statement of the same bug.
const dossier = Dossier.make({
  runId: "run-fixture",
  target: targetIdentityOf(target),
  bugClaims: [
    {
      candidate: bugClaim(
        "fixture-lens/1",
        "first line\nreport: /tmp/forged-path",
        "src/alpha.ts\nreport: /tmp/forged-location",
      ),
      cluster: 1,
      verdict: confirmedVerdict,
    },
    {
      candidate: bugClaim(
        "fixture-other/1",
        "same bug, terser",
        "src/alpha.ts",
        "fixture-other",
      ),
      cluster: 1,
      verdict: confirmedVerdict,
    },
    {
      candidate: bugClaim("fixture-lens/2", "tiered but unverified claim"),
      cluster: 2,
      verdict: Verdict.cases.Unverified.make({ reviewPriority: "P2" }),
    },
    {
      candidate: bugClaim("fixture-lens/3", "untiered unverified claim"),
      cluster: 3,
      verdict: Verdict.cases.Unverified.make({}),
    },
    {
      candidate: bugClaim("fixture-lens/4", "refuted claim"),
      cluster: 4,
      verdict: Verdict.cases.Refuted.make({ evidence: "guarded two lines above" }),
    },
  ],
  // The confirmed cluster's suggestion maps to both mates' stable ids, so the
  // sub-bullet renders no matter which mate presentation picked.
  testSuggestions: [
    {
      tests: ["src/alpha.test.ts", "the empty-input suite"],
      reason: "the empty-input suite exercises the exact boundary",
      bugClaimIds: ["fixture-lens/1", "fixture-other/1"],
    },
  ],
  observations: [
    {
      candidate: observation("fixture-lens/5", "k".repeat(400)),
      judgment: Judgment.cases.Kept.make({
        reviewPriority: "P2",
        reason: "checked the call sites;\n## the coupling is real",
        goodFind: true,
        cleanlyExplained: true,
        mergedCandidateIds: [],
      }),
    },
    {
      candidate: observation("fixture-lens/6", "undecided observation"),
      judgment: Judgment.cases.Undecided.make({}),
    },
    {
      candidate: observation("fixture-lens/7", "dropped observation"),
      judgment: Judgment.cases.Dropped.make({ reason: "style preference only" }),
    },
  ],
  coverageGaps: [],
})

const plan = ReviewPlan.make({
  runId: "run-fixture",
  target,
  seats: { judgment: "fixture/default-model:low" },
  lenses: [
    FrozenLens.make({
      name: "fixture-lens",
      promptText: "fixture tail",
      seat: "fixture/override-model:high",
      candidateCap: 6,
    }),
    FrozenLens.make({
      name: "fixture-other",
      promptText: "fixture tail",
      seat: "fixture/default-model:low",
      candidateCap: 6,
    }),
  ],
})

const accounting = { costUsd: 1.23, invocationCount: 7, wallTimeSeconds: 42 }

const paths: RunPaths = {
  root: "/runs/run-fixture",
  plan: "/runs/run-fixture/plan.json",
  journalDirectory: "/runs/run-fixture/journal",
  dossier: "/runs/run-fixture/dossier.json",
  dossierMarkdown: "/runs/run-fixture/dossier.md",
  receipt: "/runs/run-fixture/receipt.json",
  runLog: "/runs/run-fixture/run.log",
}

describe("dossier markdown rendering", () => {
  const markdown = renderDossierMarkdown(plan, dossier, accounting)

  it("orders findings by Review Priority with unverified and undecided tagged in the main section", () => {
    const findings = markdown.split("## Findings")[1]?.split("## Appendix")[0] ?? ""
    const confirmedAt = findings.indexOf("first line")
    const keptAt = findings.indexOf("kkkk")
    const tieredUnverifiedAt = findings.indexOf("tiered but unverified claim")
    const untieredUnverifiedAt = findings.indexOf("untiered unverified claim")
    const undecidedAt = findings.indexOf("undecided observation")
    // P1 confirmed → P2 kept → P2 unverified (tagged) → untiered → undecided.
    expect(confirmedAt).toBeGreaterThanOrEqual(0)
    expect(confirmedAt).toBeLessThan(keptAt)
    expect(keptAt).toBeLessThan(tieredUnverifiedAt)
    expect(tieredUnverifiedAt).toBeLessThan(untieredUnverifiedAt)
    expect(untieredUnverifiedAt).toBeLessThan(undecidedAt)
    expect(findings).toContain("`[unverified]`")
    expect(findings).toContain("`[undecided]`")
    // Refuted and dropped stay out of the main section.
    expect(findings).not.toContain("refuted claim")
    expect(findings).not.toContain("dropped observation")
  })

  it("keeps refuted claims and dropped observations as appendices", () => {
    expect(markdown).toContain("## Appendix: refuted claims")
    expect(markdown).toContain("refuted claim")
    expect(markdown).toContain("guarded two lines above")
    expect(markdown).toContain("## Appendix: dropped observations")
    expect(markdown).toContain("dropped observation")
    expect(markdown).toContain("style preference only")
  })

  it("surfaces scope-degradation warnings in the header", () => {
    expect(markdown).toContain("- Warnings: ")
    expect(markdown).toContain("stray.txt")
  })

  it("flattens model-authored text so one finding stays one list item", () => {
    // Both the confirmed claim's summary and the kept judgment's reason embed
    // newlines with Markdown-significant prefixes; neither may start a line.
    expect(markdown).toContain("first line report: /tmp/forged-path")
    expect(markdown).toContain("checked the call sites; ## the coupling is real")
    expect(markdown.split("\n").filter((line) => line.startsWith("report:")))
      .toHaveLength(0)
    expect(markdown.split("\n").filter((line) => line.startsWith("##")))
      .toEqual(expect.arrayContaining(["## Findings"]))
    expect(markdown).not.toContain("\n## the coupling is real")
  })

  it("renders one cluster as one finding attributed to every lens that raised it", () => {
    const findings = markdown.split("## Findings")[1]?.split("## Appendix")[0] ?? ""
    expect(findings.match(/reproduced with an empty input/g)).toHaveLength(1)
    // The fuller mate carries the finding; the terser one only adds its lens.
    expect(findings).toContain("first line report: /tmp/forged-path")
    expect(findings).not.toContain("same bug, terser")
    expect(findings).toContain("_(found by: fixture-lens, fixture-other)_")
    expect(findings).toContain("_(fixture-lens)_")
  })

  it("prints one explanation per finding", () => {
    const findings = markdown.split("## Findings")[1]?.split("## Appendix")[0] ?? ""
    // The confirmed claim states its verified framing only — the failure
    // scenario it restates stays in dossier.json.
    const confirmed = findings
      .split("\n- ")
      .find((entry) => entry.includes("first line")) ?? ""
    expect(confirmed).toContain("reproduced with an empty input")
    expect(confirmed).not.toContain("input of length zero loops forever")
    // Without evidence there is nothing to prefer, so the claim speaks for itself.
    expect(findings).toContain("input of length zero loops forever")
  })

  it("renders a cluster's test suggestion once, next to its finding", () => {
    const findings = markdown.split("## Findings")[1]?.split("## Appendix")[0] ?? ""
    const confirmed = findings
      .split("\n- ")
      .find((entry) => entry.includes("first line")) ?? ""
    expect(confirmed).toContain(
      "suggested tests: src/alpha.test.ts, the empty-input suite — the empty-input suite exercises the exact boundary",
    )
    expect(markdown.match(/suggested tests:/g)).toHaveLength(1)
  })

  it("shows the effective seat frozen onto each lens", () => {
    expect(markdown).toContain(
      "fixture-lens (fixture/override-model:high)",
    )
  })
})

describe("digest rendering", () => {
  const digest = renderDigest(plan, dossier, accounting, paths)
  const lines = digest.split("\n")

  it("tallies every partition plus cost and wall time", () => {
    expect(lines[0]).toContain("1 confirmed · 1 kept · 2 unverified · 1 undecided")
    expect(lines[0]).toContain("$1.23 · 42s")
  })

  it("keeps candidate text from breaking the line-oriented contract", () => {
    // The confirmed claim's location and summary both embed a newline plus a
    // forged "report:" prefix; flattened, it cannot mint a digest path line.
    expect(lines.filter((line) => line.startsWith("dossier.md: "))).toHaveLength(
      1,
    )
    expect(digest).toContain(
      "src/alpha.ts report: /tmp/forged-location:3",
    )
    expect(digest).toContain("first line report: /tmp/forged-path")
    // The kept observation's 400-char summary is capped, ellipsis-marked.
    const keptLine = lines.find((line) => line.includes("kkkk")) ?? ""
    expect(keptLine.length).toBeLessThan(280)
    expect(keptLine).toContain("…")
  })

  it("lists candidates retained in the main findings section", () => {
    expect(digest).not.toContain("refuted claim")
    expect(digest).not.toContain("dropped observation")
    expect(digest).toContain("tiered but unverified claim")
    expect(digest).toContain("untiered unverified claim")
    expect(digest).toContain("undecided observation")
  })
})
