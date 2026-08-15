import { effectFnGauntletPrefixRule as rule } from "./effect-fn-gauntlet-prefix.ts"
import { productionFile, ruleTester } from "./rule-tester.ts"

const prefixMessage =
  /gauntlet\.<snake_case_module>\.<snake_case_method>.*house-style rule 17.*docs\/effect-house-style\.md/

ruleTester.run("effect-fn-gauntlet-prefix", rule, {
  valid: [
    {
      name: "a production span carrying the gauntlet prefix",
      code: `Effect.fn("gauntlet.publisher.publish")`,
      filename: productionFile,
    },
    {
      name: "a non-dotted span, which effect-fn-span-format owns",
      code: `Effect.fn("publish")`,
      filename: productionFile,
    },
    {
      name: "a non-literal span, which effect-fn-span-format owns",
      code: "Effect.fn(`Publisher.publish`)",
      filename: productionFile,
    },
    {
      name: "the sanctioned Fake test surface",
      code: `Effect.fn("Publisher.Fake.build")`,
      filename: productionFile,
    },
    {
      name: "the sanctioned Test test surface",
      code: `Effect.fn("Publisher.Test.build")`,
      filename: productionFile,
    },
    {
      name: "an exempt unit test file",
      code: `Effect.fn("Publisher.publish")`,
      filename: "/repo/publisher.test.ts",
    },
    {
      name: "an exempt fake file",
      code: `Effect.fn("Publisher.publish")`,
      filename: "/repo/publisher.fake.ts",
    },
    {
      name: "an exempt integration file",
      code: `Effect.fn("Publisher.publish")`,
      filename: "/repo/publisher.integration.ts",
    },
    {
      name: "a JavaScript file, which carries no span vocabulary",
      code: `Effect.fn("Publisher.publish")`,
      filename: "/repo/publisher.js",
    },
  ],
  invalid: [
    {
      name: "a production span without the gauntlet prefix",
      code: `Effect.fn("Publisher.publish")`,
      filename: productionFile,
      errors: [{ message: prefixMessage }],
    },
  ],
})
