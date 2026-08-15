import rule from "./no-schema-class.js"
import { productionFile, ruleTester } from "./rule-tester.ts"

const messageFor = (name: string) =>
  new RegExp(
    `Schema\\.${name} is banned by the Effect skill's SCHEMA\\.md.*no numbered house-style rule covers this.*plain Schema\\.Struct models and Data\\.TaggedError`,
  )

ruleTester.run("no-schema-class", rule, {
  valid: [
    {
      name: "a plain Schema.Struct model",
      code: `const Value = Schema.Struct({ value: Schema.String })`,
      filename: productionFile,
    },
    {
      name: "Data.TaggedError for errors",
      code: `class DomainError extends Data.TaggedError("DomainError") {}`,
      filename: productionFile,
    },
    {
      name: "a JavaScript file, which sits outside the schema seam",
      code: `const Value = Schema.Class("Value")({ value: Schema.String })`,
      filename: "/repo/publisher.js",
    },
  ],
  invalid: [
    {
      name: "Schema.Class",
      code: `const Value = Schema.Class("Value")({ value: Schema.String })`,
      filename: productionFile,
      errors: [{ message: messageFor("Class") }],
    },
    {
      name: "Schema.TaggedClass",
      code: `const Value = Schema.TaggedClass("Value")("Value", { value: Schema.String })`,
      filename: productionFile,
      errors: [{ message: messageFor("TaggedClass") }],
    },
  ],
})
