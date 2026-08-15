import { effectFnSpanFormatRule as rule } from "./effect-fn-span-format.ts"
import { productionFile, ruleTester } from "./rule-tester.ts"

const malformedNameMessage =
  /dotted, non-empty segments.*gauntlet\.<snake_case_module>\.<snake_case_method>.*house-style rules 17\/25.*docs\/effect-house-style\.md/

const uncheckableNameMessage =
  /static string literals.*house-style rules 17\/25.*docs\/effect-house-style\.md/

const malformed = (spanName: string) => ({
  name: `the malformed span name ${spanName}`,
  code: `Effect.fn("${spanName}")`,
  filename: productionFile,
  errors: [{ message: malformedNameMessage }],
})

ruleTester.run("effect-fn-span-format", rule, {
  valid: [
    {
      name: "a dotted span name",
      code: `Effect.fn("Publisher.publish")`,
      filename: productionFile,
    },
    {
      name: "a dotted, gauntlet-prefixed span name",
      code: `Effect.fn("gauntlet.publisher.publish")`,
      filename: productionFile,
    },
    {
      name: "a JavaScript file, which carries no span vocabulary",
      code: `Effect.fn("publish")`,
      filename: "/repo/publisher.js",
    },
  ],
  invalid: [
    malformed("publish"),
    malformed(".publish"),
    malformed("Publisher."),
    malformed("Publisher..publish"),
    {
      name: "a template-literal span name",
      code: "Effect.fn(`Publisher.publish`)",
      filename: productionFile,
      errors: [{ message: uncheckableNameMessage }],
    },
    {
      name: "a constant-reference span name",
      code: `Effect.fn(SPAN_NAME)`,
      filename: productionFile,
      errors: [{ message: uncheckableNameMessage }],
    },
    {
      name: "a name-less Effect.fn call",
      code: `Effect.fn(function* () {})`,
      filename: productionFile,
      errors: [{ message: uncheckableNameMessage }],
    },
  ],
})
