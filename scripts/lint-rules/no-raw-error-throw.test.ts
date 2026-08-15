import { noRawErrorThrowRule as rule } from "./no-raw-error-throw.ts"
import { productionFile, ruleTester } from "./rule-tester.ts"

ruleTester.run("no-raw-error-throw", rule, {
  valid: [
    {
      name: "throwing a tagged error construction",
      code: `throw new DomainError({ reason: "missing" })`,
      filename: productionFile,
    },
    {
      name: "constructing a raw Error without throwing it",
      code: `const cause = new Error("boom")`,
      filename: productionFile,
    },
    {
      name: "a JavaScript file, which sits outside the Effect error seam",
      code: `throw new Error("boom")`,
      filename: "/gauntlet/src/publisher.js",
    },
  ],
  invalid: [
    {
      name: "throwing a raw Error",
      code: `throw new Error("boom")`,
      filename: productionFile,
      errors: [{
        message:
          /Fail with a tagged error.*docs\/effect-house-style\.md rule 7/,
      }],
    },
  ],
})
