import { effectFnPrefixRule as rule } from "./effect-fn-prefix.ts"
import { productionFile, ruleTester } from "./rule-tester.ts"

const projectPrefix = [{ prefix: "project" }]

const prefixMessage =
  /start with project\. Rename the span to project\.<snake_case_module>\.<snake_case_method>.*house-style rule 17.*docs\/effect-house-style\.md/

const missingOptionMessage =
  /house\/effect-fn-prefix has no prefix.*"house\/effect-fn-prefix": \["error", \{ "prefix": "<prefix>" \}\].*house-style rule 17.*docs\/effect-house-style\.md/

ruleTester.run("effect-fn-prefix", rule, {
  valid: [
    {
      name: "a production span carrying the configured prefix",
      code: `Effect.fn("project.publisher.publish")`,
      filename: productionFile,
      options: projectPrefix,
    },
    {
      name: "a production span carrying another configured prefix",
      code: `Effect.fn("other.publisher.publish")`,
      filename: productionFile,
      options: [{ prefix: "other" }],
    },
    {
      name: "a non-dotted span, which effect-fn-span-format owns",
      code: `Effect.fn("publish")`,
      filename: productionFile,
      options: projectPrefix,
    },
    {
      name: "a non-literal span, which effect-fn-span-format owns",
      code: "Effect.fn(`Publisher.publish`)",
      filename: productionFile,
      options: projectPrefix,
    },
    {
      name: "the sanctioned Fake test surface",
      code: `Effect.fn("Publisher.Fake.build")`,
      filename: productionFile,
      options: projectPrefix,
    },
    {
      name: "the sanctioned Test test surface",
      code: `Effect.fn("Publisher.Test.build")`,
      filename: productionFile,
      options: projectPrefix,
    },
    {
      name: "an exempt unit test file",
      code: `Effect.fn("Publisher.publish")`,
      filename: "/project/src/publisher.test.ts",
      options: projectPrefix,
    },
    {
      name: "an exempt fake file",
      code: `Effect.fn("Publisher.publish")`,
      filename: "/project/src/publisher.fake.ts",
      options: projectPrefix,
    },
    {
      name: "an exempt integration file",
      code: `Effect.fn("Publisher.publish")`,
      filename: "/project/src/publisher.integration.ts",
      options: projectPrefix,
    },
    {
      name: "a JavaScript file, which carries no span vocabulary",
      code: `Effect.fn("Publisher.publish")`,
      filename: "/project/src/publisher.js",
      options: projectPrefix,
    },
    {
      name: "an exempt file when no prefix is configured",
      code: `Effect.fn("Publisher.publish")`,
      filename: "/project/src/publisher.test.ts",
    },
  ],
  invalid: [
    {
      name: "a production span without the configured prefix",
      code: `Effect.fn("Publisher.publish")`,
      filename: productionFile,
      options: projectPrefix,
      errors: [{ message: prefixMessage }],
    },
    {
      name: "a production span carrying another project's prefix",
      code: `Effect.fn("other.publisher.publish")`,
      filename: productionFile,
      options: projectPrefix,
      errors: [{ message: prefixMessage }],
    },
    {
      name: "a first segment that only starts with the configured prefix",
      code: `Effect.fn("projects.publisher.publish")`,
      filename: productionFile,
      options: projectPrefix,
      errors: [{ message: prefixMessage }],
    },
    {
      name: "a production span when no prefix is configured",
      code: `Effect.fn("project.publisher.publish")`,
      filename: productionFile,
      errors: [{ message: missingOptionMessage }],
    },
  ],
})
