import { noManualTagCheckRule as rule } from "./no-manual-tag-check.ts"
import { productionFile, ruleTester } from "./rule-tester.ts"

const message =
  /Effect\.catchTag, Effect\.catchTags, or Predicate\.isTagged.*docs\/effect-house-style\.md rule 7/

ruleTester.run("no-manual-tag-check", rule, {
  valid: [
    {
      name: "narrowing an unknown with a _tag membership check",
      code: `const tagged = "_tag" in failure`,
      filename: productionFile,
    },
    {
      name: "reading an error tag for boundary serialization",
      code: `const payload = { tag: error._tag, message: error.message }`,
      filename: productionFile,
    },
    {
      name: "comparing the tag of a state union rather than an error",
      code: `const ready = prepared._tag === "Prepared"`,
      filename: productionFile,
    },
    {
      name: "a JavaScript file, which sits outside the Effect error seam",
      code: `const isDomain = error._tag === "DomainError"`,
      filename: "/gauntlet/src/publisher.js",
    },
  ],
  invalid: [
    {
      name: "an equality check against an error tag",
      code: `const isDomain = error._tag === "DomainError"`,
      filename: productionFile,
      errors: [{ message }],
    },
    {
      name: "a computed tag comparison on a cause",
      code: `const notDomain = cause["_tag"] !== "DomainError"`,
      filename: productionFile,
      errors: [{ message }],
    },
    {
      name: "a tag comparison reached through an error-named property",
      code: `const isDomain = result.failure._tag === "DomainError"`,
      filename: productionFile,
      errors: [{ message }],
    },
  ],
})
