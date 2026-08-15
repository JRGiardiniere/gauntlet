import rule from "./no-instanceof-tagged-error.js"
import { productionFile, ruleTester } from "./rule-tester.ts"

ruleTester.run("no-instanceof-tagged-error", rule, {
  valid: [
    {
      name: "instanceof against the built-in Error",
      code: `const message = cause instanceof Error ? cause.message : String(cause)`,
      filename: productionFile,
    },
    {
      name: "instanceof against a non-error class",
      code: `const isResponse = value instanceof Response`,
      filename: productionFile,
    },
    {
      name: "an equality comparison rather than instanceof",
      code: `const same = error === DomainError`,
      filename: productionFile,
    },
    {
      name: "a JavaScript file, which sits outside the Effect error seam",
      code: `const isDomain = error instanceof DomainError`,
      filename: "/repo/publisher.js",
    },
  ],
  invalid: [
    {
      name: "instanceof against a tagged error name",
      code: `const isDomain = error instanceof DomainError`,
      filename: productionFile,
      errors: [{
        message:
          /Effect\.catchTag, Effect\.catchTags, or a tag predicate.*docs\/effect-house-style\.md rule 7/,
      }],
    },
  ],
})
