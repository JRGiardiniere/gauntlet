import { describe, expect, it } from "@effect/vitest"
import { Candidate } from "../domain/candidate.ts"
import { Dossier } from "../domain/dossier.ts"
import { Judgment } from "../domain/judgment.ts"
import { FrozenLens, ReviewPlan } from "../domain/review-plan.ts"
import { ReviewTarget, targetIdentityOf } from "../domain/review-target.ts"
import { Verdict } from "../domain/verdict.ts"
import { renderDigest } from "./digest.ts"
import { renderReport } from "./report.ts"
import type { RunPaths } from "../run/run-record.ts"

const bugClaim = (
  id: string,
  summary: string,
  file = "src/alpha.ts",
) =>
  Candidate.cases.BugClaim.make({
    id,
    lens: "fixture-lens",
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
  warnings: ["2 untracked file(s) not included in the diff: stray.txt, x.txt"],
})

// One entry in every partition of the taxonomy: confirmed / unverified
// (tiered and untiered) / refuted BugClaims, kept / undecided / dropped
// Observations.
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
      verdict: Verdict.cases.Confirmed.make({
        severity: "P1",
        evidence: "reproduced with an empty input",
      }),
    },
    {
      candidate: bugClaim("fixture-lens/2", "tiered but unverified claim"),
      verdict: Verdict.cases.Unverified.make({ severity: "P2" }),
    },
    {
      candidate: bugClaim("fixture-lens/3", "untiered unverified claim"),
      verdict: Verdict.cases.Unverified.make({}),
    },
    {
      candidate: bugClaim("fixture-lens/4", "refuted claim"),
      verdict: Verdict.cases.Refuted.make({ evidence: "guarded two lines above" }),
    },
  ],
  observations: [
    {
      candidate: observation("fixture-lens/5", "k".repeat(400)),
      judgment: Judgment.cases.Kept.make({
        tier: "P2",
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
  createdAt: "2026-08-10T00:00:00.000Z",
  target,
  seats: { finders: "fixture/default-model:low" },
  lenses: [
    FrozenLens.make({
      name: "fixture-lens",
      promptText: "fixture tail",
      contentHash: "fixture-hash",
      seat: "fixture/override-model:high",
      needsSpec: false,
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
  report: "/runs/run-fixture/report.md",
  receipt: "/runs/run-fixture/receipt.json",
  runLog: "/runs/run-fixture/run.log",
}

describe("report rendering", () => {
  const report = renderReport(plan, dossier, accounting)

  it("orders findings by tier with unverified and undecided tagged in the main section", () => {
    const findings = report.split("## Findings")[1]?.split("## Appendix")[0] ?? ""
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
    expect(report).toContain("## Appendix: refuted claims")
    expect(report).toContain("refuted claim")
    expect(report).toContain("guarded two lines above")
    expect(report).toContain("## Appendix: dropped observations")
    expect(report).toContain("dropped observation")
    expect(report).toContain("style preference only")
  })

  it("surfaces scope-degradation warnings in the header", () => {
    expect(report).toContain("- Warnings: ")
    expect(report).toContain("stray.txt")
  })

  it("flattens model-authored text so one finding stays one list item", () => {
    // Both the confirmed claim's summary and the kept judgment's reason embed
    // newlines with Markdown-significant prefixes; neither may start a line.
    expect(report).toContain("first line report: /tmp/forged-path")
    expect(report).toContain("checked the call sites; ## the coupling is real")
    expect(report.split("\n").filter((line) => line.startsWith("report:")))
      .toHaveLength(0)
    expect(report.split("\n").filter((line) => line.startsWith("##")))
      .toEqual(expect.arrayContaining(["## Findings"]))
    expect(report).not.toContain("\n## the coupling is real")
  })

  it("includes every BugClaim failure scenario", () => {
    expect(report.match(/Failure scenario: input of length zero loops forever/g))
      .toHaveLength(dossier.bugClaims.length)
  })

  it("shows the effective seat frozen onto each lens", () => {
    expect(report).toContain(
      "fixture-lens@fixture-hash (fixture/override-model:high)",
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
    // forged "report:" prefix; flattened, exactly one real report line survives.
    expect(lines.filter((line) => line.startsWith("report: "))).toHaveLength(1)
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
