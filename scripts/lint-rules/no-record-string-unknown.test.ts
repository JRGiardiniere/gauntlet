import { noRecordStringUnknownRule as rule } from "./no-record-string-unknown.ts"
import { productionFile, ruleTester } from "./rule-tester.ts"

const unknownMessage =
  /authoritative domain type or schema.*surface the missing model to the user/

const anyMessage = /disables type checking/

ruleTester.run("no-record-string-unknown", rule, {
  valid: [
    {
      name: "a record whose value type is modeled",
      code: `type Values = Record<string, AppRecord>`,
      filename: productionFile,
    },
    {
      name: "an interface with declared members",
      code: `interface Values { readonly value: string }`,
      filename: productionFile,
    },
    {
      name: "a numerically keyed index signature",
      code: `interface Values { readonly [index: number]: unknown }`,
      filename: productionFile,
    },
    {
      name: "a line comment mentioning the banned shape",
      code: `// Record<string, unknown> is what this replaces\nexport const values = {}`,
      filename: productionFile,
    },
  ],
  invalid: [
    {
      name: "an unknown-valued string record",
      code: `type Values = Record<string, unknown>`,
      filename: productionFile,
      errors: [{ message: unknownMessage }],
    },
    {
      name: "an any-valued string record, reported more strongly",
      code: `type Values = Record<string, any>`,
      filename: productionFile,
      errors: [{ message: anyMessage }],
    },
    {
      name: "the equivalent string index signature",
      code: `interface Values { readonly [key: string]: unknown }`,
      filename: productionFile,
      errors: [{ message: unknownMessage }],
    },
    {
      name: "the banned shape hidden in a JSDoc annotation",
      code: `/** @param {Record<string, unknown>} values */\nexport const publish = (values) => values`,
      filename: productionFile,
      errors: [{ message: unknownMessage }],
    },
    {
      name: "a JSDoc annotation in a JavaScript file, still scanned",
      code: `/** @param {Record<string, unknown>} values */\nexport const publish = (values) => values`,
      filename: "/gauntlet/src/publisher.js",
      errors: [{ message: unknownMessage }],
    },
  ],
})
