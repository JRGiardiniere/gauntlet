import { describe, expect, it } from "vitest"
import rule from "./retry-schedule-bounded.js"
import { runRuleSequence } from "./test-utils.ts"

const call = (
  object: string,
  property: string,
  args: ReadonlyArray<unknown> = [],
) => ({
  type: "CallExpression",
  callee: {
    type: "MemberExpression",
    object: { type: "Identifier", name: object },
    property: { type: "Identifier", name: property },
  },
  arguments: args,
})

const boundedSchedule = () => ({
  type: "CallExpression",
  callee: {
    type: "MemberExpression",
    object: call("Schedule", "spaced"),
    property: { type: "Identifier", name: "pipe" },
  },
  arguments: [call("Schedule", "take", [{ type: "Literal", value: 2 }])],
})

const options = (entries: ReadonlyArray<readonly [string, unknown]>) => ({
  type: "ObjectExpression",
  properties: entries.map(([name, value]) => ({
    type: "Property",
    key: { type: "Identifier", name },
    value,
  })),
})

const retryCall = (retryOptions: unknown) =>
  call("HttpClient", "retryTransient", [retryOptions])

const programExit = {
  visitor: "Program:exit" as const,
  node: { type: "Program", body: [] },
}

const runRetryRule = (
  retry: unknown,
  declarations: ReadonlyArray<unknown> = [],
) =>
  runRuleSequence(rule, [
    { visitor: "CallExpression", node: retry },
    ...declarations.map((node) => ({
      visitor: "VariableDeclarator" as const,
      node,
    })),
    programExit,
  ])

describe("retry-schedule-bounded", () => {
  it("reports retryTransient without a bound", () => {
    const errors = runRetryRule(retryCall(options([])))

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain(
      "Schedule.spaced(...).pipe(Schedule.take(...))",
    )
    expect(errors[0]?.message).toContain("house-style rules 13/23")
    expect(errors[0]?.message).toContain("docs/effect-house-style.md")
  })

  it.each([
    [
      "the shared schedule",
      options([
        [
          "schedule",
          { type: "Identifier", name: "transientRetrySchedule" },
        ],
      ]),
    ],
    ["an inline bounded schedule", options([["schedule", boundedSchedule()]])],
    ["a numeric times option", options([["times", { type: "Literal", value: 2 }]])],
  ])("allows %s", (_description, retryOptions) => {
    expect(runRetryRule(retryCall(retryOptions))).toHaveLength(0)
  })

  it("allows the shared schedule imported under an alias", () => {
    const errors = runRuleSequence(rule, [
      {
        visitor: "ImportSpecifier",
        node: {
          type: "ImportSpecifier",
          imported: { type: "Identifier", name: "transientRetrySchedule" },
          local: { type: "Identifier", name: "retrySchedule" },
        },
      },
      {
        visitor: "CallExpression",
        node: retryCall(
          options([["schedule", { type: "Identifier", name: "retrySchedule" }]]),
        ),
      },
      programExit,
    ])

    expect(errors).toHaveLength(0)
  })

  it("allows a same-file identifier initialized with a bounded schedule", () => {
    const scheduleIdentifier = { type: "Identifier", name: "retrySchedule" }
    const declaration = {
      type: "VariableDeclarator",
      id: scheduleIdentifier,
      init: boundedSchedule(),
    }

    expect(
      runRetryRule(
        retryCall(options([["schedule", scheduleIdentifier]])),
        [declaration],
      ),
    ).toHaveLength(0)
  })

  it.each([
    [
      "an unknown schedule identifier",
      options([["schedule", { type: "Identifier", name: "retrySchedule" }]]),
    ],
    [
      "an inline unbounded schedule",
      options([["schedule", call("Schedule", "spaced")]]),
    ],
    [
      "an unbounded schedule even when times is also present",
      options([
        ["schedule", call("Schedule", "spaced")],
        ["times", { type: "Literal", value: 2 }],
      ]),
    ],
  ])("reports %s", (_description, retryOptions) => {
    expect(runRetryRule(retryCall(retryOptions))).toHaveLength(1)
  })
})
