import { directiveReasonRule as rule } from "./directive-reason.ts"
import { productionFile, ruleTester, testFile } from "./rule-tester.ts"

ruleTester.run("directive-reason", rule, {
  valid: [
    {
      name: "a next-line disable with a reason",
      code: `// oxlint-disable-next-line no-console -- the CLI prints its refusal
console.error("no")`,
      filename: productionFile,
    },
    {
      name: "a file-level block disable with a reason",
      code: `/* oxlint-disable effecttsgo/strict-effect-provide -- each method is an entry point */
const a = 1`,
      filename: productionFile,
    },
    {
      name: "an Effect diagnostics override with a reason",
      code: `// @effect-diagnostics-next-line floatingEffect:off -- the runtime awaits it
const a = 1`,
      filename: productionFile,
    },
    {
      name: "an Effect diagnostics override that only raises checks to error",
      code: `// @effect-diagnostics-next-line floatingEffect:error missingReturnYieldStar:error
const a = 1`,
      filename: productionFile,
    },
    {
      name: "a re-enable needs no reason",
      code: `// oxlint-enable no-console
const a = 1`,
      filename: productionFile,
    },
    {
      name: "an ordinary comment that mentions disabling",
      code: `// Callers that disable retries pass times: 0.
const a = 1`,
      filename: productionFile,
    },
  ],
  invalid: [
    {
      name: "a next-line disable with no reason",
      code: `// oxlint-disable-next-line no-console
console.error("no")`,
      filename: productionFile,
      errors: [{ message: /Say why this check is off/ }],
    },
    {
      name: "an ESLint disable with an empty reason",
      code: `/* eslint-disable no-console -- */
console.error("no")`,
      filename: productionFile,
      errors: [{ message: /Say why this check is off/ }],
    },
    {
      name: "a same-line disable in a test with no reason",
      code: `const a = 1 // oxlint-disable-line no-unused-vars`,
      filename: testFile,
      errors: [{ message: /Say why this check is off/ }],
    },
    {
      name: "an Effect diagnostics override that raises one check and turns another off",
      code: `// @effect-diagnostics floatingEffect:error newPromise:off
const a = 1`,
      filename: productionFile,
      errors: [{ message: /Say why this check is off/ }],
    },
    {
      name: "an Effect diagnostics override to warning, which can lower a check",
      code: `// @effect-diagnostics-next-line floatingEffect:warning
const a = 1`,
      filename: productionFile,
      errors: [{ message: /Say why this check is off/ }],
    },
    {
      name: "an Effect diagnostics override with no reason",
      code: `// @effect-diagnostics-next-line floatingEffect:off
const a = 1`,
      filename: productionFile,
      errors: [{ message: /Say why this check is off/ }],
    },
  ],
})
