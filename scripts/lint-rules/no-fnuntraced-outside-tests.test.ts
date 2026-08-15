import rule from "./no-fnuntraced-outside-tests.js"
import { productionFile, ruleTester, testFile } from "./rule-tester.ts"

ruleTester.run("no-fnuntraced-outside-tests", rule, {
  valid: [
    {
      name: "Effect.fnUntraced inside a unit test",
      code: `const publish = Effect.fnUntraced(function* () {})`,
      filename: testFile,
    },
    {
      name: "a traced Effect.fn in production",
      code: `const publish = Effect.fn("gauntlet.publisher.publish")(function* () {})`,
      filename: productionFile,
    },
  ],
  invalid: [
    {
      name: "Effect.fnUntraced in a production TypeScript file",
      code: `const publish = Effect.fnUntraced(function* () {})`,
      filename: productionFile,
      errors: [{
        message:
          /Effect\.fn\("gauntlet\.\.\.\."\).*house-style rule 25.*docs\/effect-house-style\.md/,
      }],
    },
  ],
})
