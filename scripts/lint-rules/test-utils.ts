import type { CreateRule, Visitor } from "oxlint"

interface ReportedError {
  readonly node: unknown
  readonly message: string
}

interface TestContextOptions {
  readonly sourceCode?: string
  readonly filename?: string
  readonly cwd?: string
  readonly ruleOptions?: ReadonlyArray<unknown>
}

interface VisitorInvocation {
  readonly visitor: keyof Visitor
  readonly node: unknown
}

export const effectFnCall = (spanName?: string | { readonly type: string }) => ({
  type: "CallExpression",
  callee: {
    type: "MemberExpression",
    object: { type: "Identifier", name: "Effect" },
    property: { type: "Identifier", name: "fn" },
  },
  arguments:
    spanName === undefined
      ? []
      : [typeof spanName === "string" ? { type: "Literal", value: spanName } : spanName],
})

const createTestContext = (options: TestContextOptions = {}) => {
  const {
    sourceCode = "",
    filename = "/test/file.ts",
    cwd = "/test",
    ruleOptions = [],
  } = options

  const errors: Array<ReportedError> = []
  const context = {
    id: "test/rule",
    filename,
    physicalFilename: filename,
    options: ruleOptions,
    getFilename: () => filename,
    getCwd: () => cwd,
    report(error: ReportedError) {
      errors.push(error)
    },
    sourceCode: {
      getText() {
        return sourceCode
      },
    },
  }
  return { errors, context }
}

export const runRule = (
  rule: CreateRule,
  visitor: keyof Visitor,
  node: unknown,
  options: TestContextOptions = {},
): ReadonlyArray<ReportedError> =>
  runRuleSequence(rule, [{ visitor, node }], options)

export const runRuleSequence = (
  rule: CreateRule,
  invocations: ReadonlyArray<VisitorInvocation>,
  options: TestContextOptions = {},
): ReadonlyArray<ReportedError> => {
  const { context, errors } = createTestContext(options)
  const visitor = rule.create(context as never)
  for (const invocation of invocations) {
    const handler = visitor[invocation.visitor]
    if (handler !== undefined) {
      ;(handler as (node: unknown) => void)(invocation.node)
    }
  }
  return errors
}
