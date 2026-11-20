import { describe, expect, it } from "@effect/vitest"
import * as Array from "effect/Array"
import * as Option from "effect/Option"
import { Candidate } from "../domain/candidate.ts"
import {
  Dossier,
  DossierFinding,
  DossierUnresolved,
  DroppedObservation,
  RefutedClaim,
} from "../domain/dossier.ts"
import { Judgment } from "../domain/judgment.ts"
import { FrozenLens, ReviewPlan } from "../domain/review-plan.ts"
import { ReviewTarget, targetIdentityOf } from "../domain/review-target.ts"
import { Verdict } from "../domain/verdict.ts"
import { describeTokens, type RunAccounting } from "../run/run-accounting.ts"
import { renderDigest } from "./digest.ts"
import { renderDossierMarkdown } from "./dossier-markdown.ts"

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

// One entry in every partition of the taxonomy: confirmed / plausible
// (tiered and untiered) / refuted BugClaims, kept / undecided / dropped
// Observations. The confirmed claim shares its Pool cluster with a second
// lens's shorter statement of the same bug.
const dossier = Dossier.make({
  runId: "run-fixture",
  target: targetIdentityOf(target),
  findings: [
    DossierFinding.cases.Confirmed.make({
      bugClaims: [
        bugClaim(
        "fixture-lens/1",
        "first line\ndossier.md: /tmp/forged-path",
        "src/alpha.ts\ndossier.md: /tmp/forged-location",
        ),
        bugClaim(
          "fixture-other/1",
          "same bug, terser",
          "src/alpha.ts",
          "fixture-other",
        ),
      ],
      cluster: 1,
      verdict: confirmedVerdict,
      testSuggestion: {
        tests: ["src/alpha.test.ts", "the empty-input suite"],
        reason: "the empty-input suite exercises the exact boundary",
        bugClaimIds: ["fixture-lens/1", "fixture-other/1"],
      },
    }),
    DossierFinding.cases.Judgment.make({
      candidate: observation("fixture-lens/5", "k".repeat(400)),
      judgment: Judgment.cases.Kept.make({
        reviewPriority: "P2",
        reason: "checked the call sites;\n## the coupling is real",
        goodFind: true,
        cleanlyExplained: true,
        mergedCandidateIds: [],
      }),
    }),
  ],
  unresolved: [
    DossierUnresolved.cases.Plausible.make({
      bugClaims: [bugClaim("fixture-lens/2", "tiered but plausible claim")],
      cluster: 2,
      verdict: Verdict.cases.Plausible.make({
        reviewPriority: "P2",
        evidence: "the runtime branch was unreachable in the verifier",
      }),
    }),
    DossierUnresolved.cases.Plausible.make({
      bugClaims: [bugClaim("fixture-lens/3", "untiered plausible claim")],
      cluster: 3,
      verdict: Verdict.cases.Plausible.make({}),
    }),
    DossierUnresolved.cases.Undecided.make({
      candidate: observation("fixture-lens/6", "undecided observation"),
      judgment: Judgment.cases.Undecided.make({}),
    }),
  ],
  rejected: {
    refutedClaims: [RefutedClaim.make({
      bugClaims: [bugClaim("fixture-lens/4", "refuted claim")],
      cluster: 4,
      verdict: Verdict.cases.Refuted.make({
        evidence: "guarded two lines above",
      }),
    })],
    droppedObservations: [DroppedObservation.make({
      candidate: observation("fixture-lens/7", "dropped observation"),
      judgment: Judgment.cases.Dropped.make({
        reason: "style preference only",
      }),
    })],
  },
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
    FrozenLens.make({
      name: "spec-conformance",
      promptText: "specification tail",
      seat: "fixture/default-model:low",
      candidateCap: 6,
      finderClass: "interpretive",
    }),
  ],
})

const accounting: RunAccounting = {
  stageTokens: {
    finders: { input: 10_000, output: 2_000, cacheRead: 80_000, cacheWrite: 0 },
    pool: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    verification: { input: 1_500, output: 900, cacheRead: 6_000, cacheWrite: 500 },
    judgment: { input: 500, output: 500, cacheRead: 2_000, cacheWrite: 0 },
  },
  invocationCount: 7,
  wallTimeSeconds: 42,
  finderCacheHealth: undefined,
  finderToolHealth: undefined,
}

const lowCacheAccounting: RunAccounting = {
  ...accounting,
  finderCacheHealth: {
    reuse: 0.1,
    eligibleFollowerCount: 2,
    healthyFollowerCount: 0,
  },
}

const quietToolAccounting: RunAccounting = {
  ...accounting,
  finderToolHealth: { calls: 30, errored: 2 },
}

const deadToolAccounting: RunAccounting = {
  ...accounting,
  finderToolHealth: { calls: 24, errored: 24 },
}

const dossierMarkdownPath = "/runs/run-fixture/dossier.md"

describe("dossier markdown rendering", () => {
  const markdown = renderDossierMarkdown(plan, dossier, accounting)

  it("renders the Findings, Unresolved, and Rejected hierarchy with domain tags and reasons", () => {
    const findings = markdown.split("## Findings")[1]?.split("## Unresolved")[0] ?? ""
    const unresolved = markdown.split("## Unresolved")[1]?.split("## Rejected")[0] ?? ""
    const confirmedAt = findings.indexOf("first line")
    const keptAt = findings.indexOf("kkkk")
    expect(confirmedAt).toBeGreaterThanOrEqual(0)
    expect(confirmedAt).toBeLessThan(keptAt)
    expect(findings).toContain("`[confirmed]`")
    expect(findings).toContain("`[judgment]`")
    expect(unresolved).toContain("`[plausible]`")
    expect(unresolved).toContain("the runtime branch was unreachable")
    expect(unresolved).toContain("`[undecided]`")
    expect(findings).not.toContain("refuted claim")
    expect(findings).not.toContain("dropped observation")
    expect(markdown).toContain("## Rejected")
    expect(markdown).toContain("### Refuted Claims")
    expect(markdown).toContain("`[refuted]`")
    expect(markdown).toContain("refuted claim")
    expect(markdown).toContain("guarded two lines above")
    expect(markdown).toContain("### Dropped Observations")
    expect(markdown).toContain("`[dropped]`")
    expect(markdown).toContain("dropped observation")
    expect(markdown).toContain("style preference only")
    expect(markdown).toContain(
      "- Skipped: spec-conformance — no ReviewSpecification",
    )
  })

  it("surfaces scope-degradation warnings in the header", () => {
    expect(markdown).toContain("- Warnings: ")
    expect(markdown).toContain("stray.txt")
  })

  it("flattens model-authored text so one finding stays one list item", () => {
    // Both the confirmed claim's summary and the kept judgment's reason embed
    // newlines with Markdown-significant prefixes; neither may start a line.
    expect(markdown).toContain("first line dossier.md: /tmp/forged-path")
    expect(markdown).toContain("checked the call sites; ## the coupling is real")
    expect(Array.filter(markdown.split("\n"), (line) => line.startsWith("dossier.md:")))
      .toHaveLength(0)
    expect(Array.filter(markdown.split("\n"), (line) => line.startsWith("##")))
      .toEqual([
        "## Findings",
        "## Unresolved",
        "## Rejected",
        "### Refuted Claims",
        "### Dropped Observations",
      ])
  })

  it("renders one cluster as one finding attributed to every lens that raised it", () => {
    const findings = markdown.split("## Findings")[1]?.split("## Unresolved")[0] ?? ""
    expect(findings.match(/reproduced with an empty input/g)).toHaveLength(1)
    // The fuller mate carries the finding; the terser one only adds its lens.
    expect(findings).toContain("first line dossier.md: /tmp/forged-path")
    expect(findings).not.toContain("same bug, terser")
    expect(findings).toContain("_(found by: fixture-lens, fixture-other)_")
    expect(findings).toContain("_(fixture-lens)_")
  })

  it("prints one explanation per finding", () => {
    const findings = markdown.split("## Findings")[1]?.split("## Unresolved")[0] ?? ""
    const unresolved = markdown.split("## Unresolved")[1]?.split("## Rejected")[0] ?? ""

    // The confirmed claim states its verified framing only — the failure
    // scenario it restates stays in dossier.json.
    const confirmed = Option.getOrElse(
      Array.findFirst(findings.split("\n- "), (entry) => entry.includes("first line")),
      () => "",
    )

    expect(confirmed).toContain("reproduced with an empty input")
    expect(confirmed).not.toContain("input of length zero loops forever")
    // Without evidence there is nothing to prefer, so the claim speaks for itself.
    expect(unresolved).toContain("input of length zero loops forever")
  })

  it("renders a cluster's test suggestion once, next to its finding", () => {
    const findings = markdown.split("## Findings")[1]?.split("## Unresolved")[0] ?? ""

    const confirmed = Option.getOrElse(
      Array.findFirst(findings.split("\n- "), (entry) => entry.includes("first line")),
      () => "",
    )

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

  it("renders Run notes only for measured low reuse", () => {
    expect(markdown).not.toContain("## Run notes")

    const withCacheNote = renderDossierMarkdown(
      plan,
      dossier,
      lowCacheAccounting,
    )

    expect(withCacheNote).toContain("## Run notes")
    expect(withCacheNote).toContain(
      "Finder cache 10% reuse across 2 eligible followers; 0/2 at or above 80%.",
    )
  })

  it("records finder tool call counts in Run notes whenever calls were made", () => {
    const withToolNote = renderDossierMarkdown(plan, dossier, quietToolAccounting)
    expect(withToolNote).toContain("## Run notes")
    expect(withToolNote).toContain(
      "Finder tools: 2/30 finder tool calls errored.",
    )
  })
})

const tokenLines = [
  "Tokens:",
  "- Finders: 90k in (80k cache read, 89%) · 2k out",
  "- Pool: 0 in · 0 out",
  "- Verification: 8k in (6k cache read, 75%) · 900 out",
  "- Judgment: 2.5k in (2k cache read, 80%) · 500 out",
  "- Total: 100.5k in (88k cache read, 88%) · 3.4k out",
]

const keptP3 = (id: string) =>
  DossierFinding.cases.Judgment.make({
    candidate: observation(id, `minor observation ${id}`),
    judgment: Judgment.cases.Kept.make({
      reviewPriority: "P3",
      reason: "small but real",
      goodFind: true,
      cleanlyExplained: true,
      mergedCandidateIds: [],
    }),
  })

describe("digest rendering", () => {
  const digest = renderDigest(plan, dossier, accounting, dossierMarkdownPath)
  const lines = digest.split("\n")

  it("groups findings by Review Priority, leaves entries with none to dossier.md, and counts tokens per Stage", () => {
    expect(digest).toBe(Array.join([
      "1 confirmed · 1 kept · 2 plausible · 1 undecided — working tree @ abcdef0 — recipe: none — 42s",
      "Not run: spec-conformance (no ReviewSpecification)",
      "",
      "P1 (1)",
      "- [confirmed] src/alpha.ts dossier.md: /tmp/forged-location:3 — first line dossier.md: /tmp/forged-path",
      "",
      "P2 (2)",
      `- [judgment] src/beta.ts — ${"k".repeat(199)}…`,
      "- [plausible] src/alpha.ts:3 — tiered but plausible claim",
      "",
      "No priority (2) in dossier.md: 1 plausible, 1 undecided",
      "",
      ...tokenLines,
      "",
      "dossier.md: /runs/run-fixture/dossier.md",
    ], "\n"))
  })

  it("collapses P3s to a count and names coverage gaps under the tally", () => {
    const gapped = renderDigest(
      plan,
      Dossier.make({
        ...dossier,
        findings: [
          ...Array.take(dossier.findings, 1),
          keptP3("fixture-lens/8"),
          keptP3("fixture-lens/9"),
        ],
        unresolved: [],
        coverageGaps: [
          {
            stage: "finders",
            lens: "fixture-lens",
            reason: "finder provider failed",
          },
          { stage: "pool", reason: "pool emitted nothing" },
        ],
      }),
      accounting,
      dossierMarkdownPath,
    )

    expect(gapped).toBe(Array.join([
      "1 confirmed · 2 kept · 0 plausible · 0 undecided — working tree @ abcdef0 — recipe: none — 42s",
      "coverage gaps: 2 — fixture-lens (finder provider failed); pool (pool emitted nothing)",
      "Not run: spec-conformance (no ReviewSpecification)",
      "",
      "P1 (1)",
      "- [confirmed] src/alpha.ts dossier.md: /tmp/forged-location:3 — first line dossier.md: /tmp/forged-path",
      "",
      "P3 (2) in dossier.md: 2 judgment",
      "",
      ...tokenLines,
      "",
      "dossier.md: /runs/run-fixture/dossier.md",
    ], "\n"))
    expect(gapped).not.toContain("minor observation")
  })

  it("says so when a review found nothing", () => {
    const clean = renderDigest(
      plan,
      Dossier.make({ ...dossier, findings: [], unresolved: [] }),
      accounting,
      dossierMarkdownPath,
    )

    expect(clean.split("\n").slice(2, 5)).toEqual(["", "No findings.", ""])
  })

  it("never prints dollars, and counts millions of tokens", () => {
    expect(digest).not.toContain("$")
    expect(describeTokens({ input: 40_000, output: 12_000, cacheRead: 1_800_000, cacheWrite: 0 }))
      .toBe("1.84M in (1.8M cache read, 98%) · 12k out")
  })

  it("keeps candidate text from breaking the line-oriented contract", () => {
    // The confirmed claim's location and summary both embed a newline plus a
    // forged "dossier.md:" prefix; flattened, it cannot mint a digest path line.
    expect(Array.filter(lines, (line) => line.startsWith("dossier.md: "))).toHaveLength(
      1,
    )
    expect(digest).toContain(
      "src/alpha.ts dossier.md: /tmp/forged-location:3",
    )
    expect(digest).toContain("first line dossier.md: /tmp/forged-path")
    // The kept observation's 400-char summary is capped, ellipsis-marked.
    const keptLine = Option.getOrElse(Array.findFirst(lines, (line) => line.includes("kkkk")), () => "")
    expect(keptLine.length).toBeLessThan(280)
    expect(keptLine).toContain("…")
  })

  it("leaves rejected entries to dossier.md", () => {
    expect(digest).not.toContain("refuted claim")
    expect(digest).not.toContain("dropped observation")
  })

  it("leaves measured low cache reuse to dossier.md", () => {
    expect(renderDigest(plan, dossier, lowCacheAccounting, dossierMarkdownPath)).toBe(digest)
  })

  it("names the lenses skipped by design on one line, and prints none when every lens ran", () => {
    expect(lines).toContain("Not run: spec-conformance (no ReviewSpecification)")

    const everyLensRan = renderDigest(
      ReviewPlan.make({
        ...plan,
        lenses: Array.filter(plan.lenses, ({ name }) => name !== "spec-conformance"),
      }),
      dossier,
      accounting,
      dossierMarkdownPath,
    )

    expect(everyLensRan).not.toContain("Not run:")
  })

  it("adds a tool-health line only for an error cascade", () => {
    expect(digest).not.toContain("tool health:")
    expect(renderDigest(plan, dossier, quietToolAccounting, dossierMarkdownPath)).not.toContain(
      "tool health:",
    )
    const cascade = renderDigest(plan, dossier, deadToolAccounting, dossierMarkdownPath)
    expect(cascade.split("\n")[1]).toBe(
      "tool health: 24/24 finder tool calls errored",
    )
  })
})

