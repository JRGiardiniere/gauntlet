import { noSleepInTestsRule as rule } from "./no-sleep-in-tests.ts"
import { productionFile, ruleTester, testFile } from "./rule-tester.ts"

const inGenerator = (body: string) => `const run = function* () { ${body} }`

ruleTester.run("no-sleep-in-tests", rule, {
  valid: [
    {
      name: "driving the TestClock instead of sleeping",
      code: inGenerator(`yield* TestClock.adjust("1 second")`),
      filename: testFile,
    },
    {
      name: "Effect.sleep outside a unit test",
      code: inGenerator(`yield* Effect.sleep("1 second")`),
      filename: productionFile,
    },
  ],
  invalid: [
    {
      name: "Effect.sleep in a unit test",
      code: inGenerator(`yield* Effect.sleep("1 second")`),
      filename: testFile,
      errors: [{
        message:
          /TestClock\.adjust.*it\.live.*house-style rule 18.*docs\/effect-house-style\.md/,
      }],
    },
  ],
})
