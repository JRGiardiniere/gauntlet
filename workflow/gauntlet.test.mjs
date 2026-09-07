import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { compileFunction } from "node:vm"

// Execute the built artifact with the host's five callbacks replaced. Only the
// metadata export is adapted to the function body used by this local runner.
const source = readFileSync(new URL("../.claude/workflows/gauntlet.js", import.meta.url), "utf8")
const execute = compileFunction(
  `return (async () => {\n${source.replace("export const meta =", "const meta =")}\n})()`,
  ["args", "agent", "parallel", "phase", "log"],
)

const scope = {
  repoRoot: "/fixture/repo",
  targetDescription: "working tree @ abc1234",
  changedFiles: ["src/a.ts"],
  diffCommand: "git diff -U50 HEAD",
  diffPath: "/fixture/diff.patch",
  warnings: [],
  specification: "## Review Specification\n\nSPECIFICATION-NEEDLE",
  standardsDocuments: [],
}
const finding = (summary, bug = false) => ({
  file: "src/a.ts", line: 1, summary,
  ...(bug ? { failure_scenario: `empty input triggers ${summary}` } : {}),
})
const verdict = (cluster, value = "CONFIRMED") => ({
  cluster, verdict: value, evidence: `evidence for ${cluster}`,
  ...(value === "REFUTED" ? {} : { review_priority: "P2" }),
})

const run = async (args, replies) => {
  const calls = [], logs = []
  const result = await execute(args, async (prompt, options) => {
    calls.push({ prompt, ...options })
    assert.ok(Object.hasOwn(replies, options.label), `unexpected invocation: ${options.label}`)
    const reply = replies[options.label]
    if (reply instanceof Error) throw reply
    return reply
  }, jobs => Promise.all(jobs.map(job => job())), () => {}, text => logs.push(text))
  return { result, calls, logs }
}

for (const args of [
  "42 --lenses=diff-scan,subjective --model=sonnet --effort=low --interpretive-model=opus --interpretive-effort=high --spec=caller prose --literal",
  { target: "42", lenses: ["diff-scan", "subjective"], model: "sonnet", effort: "low", interpretiveModel: "opus", interpretiveEffort: "high", spec: "caller prose --literal" },
]) {
  test(`routes a mixed review with ${typeof args} arguments and preserves model assignments`, async () => {
    const { result, calls } = await run(args, {
      submission: scope,
      "finder:diff-scan": { findings: [finding("bug", true)] },
      "finder:subjective": { findings: [finding("observation")] },
      "verify:bundle-1": { verdicts: [verdict(1)] },
      judge: { decisions: [{ index: 1, decision: "keep", review_priority: "P3", reason: "call sites confirm it", goodFind: true, cleanlyExplained: true, merge: [] }] },
    })
    assert.deepEqual(result.dossier.findings.map(entry => [entry.tag, entry.candidate.summary]), [
      ["confirmed", "bug"], ["judgment", "observation"],
    ])
    assert.deepEqual(result.dossier.accounting, { finders: 2, candidates: 2, bugClaims: 1, observations: 1, clusters: 1 })
    assert.deepEqual(result.dossier.coverageGaps, [])
    assert.deepEqual(calls.map(call => [call.label, call.model, call.effort]).sort(), [
      ["finder:diff-scan", "sonnet", "low"], ["finder:subjective", "opus", "high"],
      ["judge", "opus", "high"], ["submission", "sonnet", "low"], ["verify:bundle-1", "sonnet", "low"],
    ])
    assert.match(calls[0].prompt, /caller prose --literal/)
    const specific = calls.find(call => call.label === "finder:diff-scan").prompt
    const interpretive = calls.find(call => call.label === "finder:subjective").prompt
    assert.doesNotMatch(specific, /SPECIFICATION-NEEDLE/)
    assert.match(interpretive, /SPECIFICATION-NEEDLE/)
    for (const [name, prompt] of [["diff-scan", specific], ["subjective", interpretive]]) {
      const lens = readFileSync(new URL(`../content/lenses/${name}.md`, import.meta.url), "utf8")
        .replace(/^---\n[\s\S]*?\n---\n/, "").trim()
      assert.ok(prompt.includes(lens), `${name} receives its complete lens instructions`)
    }
    for (const prompt of [specific, interpretive]) assert.match(prompt, /\/fixture\/diff\.patch/)
    assert.match(result.markdown, /bug/)
    assert.match(result.digest, /1 confirmed · 1 kept/)
  })
}

test("invalid selections stop before any paid submission", async () => {
  for (const args of ["--lenses=missing-lens", "--lenses=", "--unknown=value"]) {
    const { result, calls } = await run(args, {})
    assert.ok(result.error)
    assert.deepEqual(calls, [])
  }
})

test("an empty diff spends only on submission and reports why no review ran", async () => {
  const { result, calls } = await run("", { submission: { ...scope, changedFiles: [] } })
  assert.deepEqual(calls.map(call => call.label), ["submission"])
  assert.deepEqual(result.dossier.accounting, { finders: 0, candidates: 0, bugClaims: 0, observations: 0, clusters: 0 })
  assert.match(result.digest, /diff is empty/)
})

test("missing specification and standards skip only their own Finders", async () => {
  const { result, calls } = await run("--lenses=spec-conformance,standards,diff-scan", {
    submission: { ...scope, specification: "" },
    "finder:diff-scan": { findings: [] },
  })
  assert.deepEqual(calls.map(call => call.label), ["submission", "finder:diff-scan"])
  assert.deepEqual(result.dossier.skipped.map(entry => entry.lens), ["spec-conformance", "standards"])
  assert.deepEqual(result.dossier.coverageGaps, [])
})

const poolReplies = {
  submission: scope,
  "finder:diff-scan": { findings: [1, 2, 3, 4, 5].map(n => finding(`bug ${n}`, true)) },
  pool: { clusters: [{ indexes: [1, 2], summary: "same bug" }, { indexes: [2, 3, 99], summary: "overlap" }] },
}

test("Pool repairs preserve every claim once across findings, unresolved, and refuted results", async () => {
  const { result } = await run("--lenses=diff-scan", {
    ...poolReplies,
    "verify:bundle-1": { verdicts: [verdict(1), verdict(2, "PLAUSIBLE"), verdict(3, "REFUTED"), verdict(4)] },
  })
  assert.deepEqual(result.dossier.findings.map(entry => entry.members.map(member => member.summary)), [["bug 1", "bug 2"], ["bug 5"]])
  assert.deepEqual(result.dossier.unresolved.map(entry => entry.candidate.summary), ["bug 3"])
  assert.deepEqual(result.dossier.rejected.refutedClaims.map(entry => entry.candidate.summary), ["bug 4"])
  assert.deepEqual(result.dossier.coverageGaps, [])
})

test("incomplete verifier labels preserve the entire bundle as unresolved", async () => {
  const { result } = await run("--lenses=diff-scan", {
    ...poolReplies, "verify:bundle-1": { verdicts: [verdict(1)] },
  })
  assert.deepEqual(result.dossier.findings, [])
  assert.deepEqual(result.dossier.unresolved.flatMap(entry => entry.members.map(member => member.summary)), ["bug 1", "bug 2", "bug 3", "bug 4", "bug 5"])
  assert.deepEqual(result.dossier.coverageGaps.map(gap => gap.stage), ["Verification"])
})

test("failed agents leave claims and observations visible with explicit coverage gaps", async () => {
  const { result } = await run("--lenses=diff-scan,subjective", {
    submission: scope,
    "finder:diff-scan": { findings: [finding("bug 1", true), finding("bug 2", true), finding("bug 3", true), finding("observation")] },
    "finder:subjective": new Error("provider failed"),
    pool: new Error("pool failed"),
    judge: new Error("judge failed"),
  })
  assert.deepEqual(result.dossier.unresolved.map(entry => [entry.tag, entry.candidate.summary]), [
    ["plausible", "bug 1"], ["plausible", "bug 2"], ["plausible", "bug 3"], ["undecided", "observation"],
  ])
  assert.deepEqual(result.dossier.coverageGaps.map(gap => gap.stage).sort(), ["Finders", "Judgment", "Verification"])
  assert.deepEqual(result.dossier.coverageGaps.map(gap => gap.reason).sort(), [
    "finder invocation threw: provider failed",
    "stage threw before completing: judge failed",
    "stage threw before completing: pool failed",
  ])
})

test("the candidate cap retains the first six findings rather than merely returning six", async () => {
  const { result } = await run("--lenses=diff-scan", {
    submission: scope,
    "finder:diff-scan": { findings: Array.from({ length: 8 }, (_, n) => finding(`observation ${n + 1}`)) },
    judge: { decisions: [] },
  })
  assert.deepEqual(result.dossier.unresolved.map(entry => entry.candidate.summary), [
    "observation 1", "observation 2", "observation 3", "observation 4", "observation 5", "observation 6",
  ])
})
