import { noEnvMutationInTestsRule as rule } from "./no-env-mutation-in-tests.ts"
import { productionFile, ruleTester, testFile } from "./rule-tester.ts"

const message =
  /test layers or ConfigProvider.*house-style rule 20.*docs\/effect-house-style\.md/

const mutation = (name: string, code: string) => ({
  name,
  code,
  filename: testFile,
  errors: [{ message }],
})

ruleTester.run("no-env-mutation-in-tests", rule, {
  valid: [
    {
      name: "reading process.env",
      code: `const token = process.env.HUB_TOKEN`,
      filename: testFile,
    },
    {
      name: "assignment to an ordinary object",
      code: `config.HUB_TOKEN = "test"`,
      filename: testFile,
    },
    {
      name: "Object.assign onto an ordinary object",
      code: `Object.assign(config, { HUB_TOKEN: "test" })`,
      filename: testFile,
    },
    {
      name: "process.env mutation outside a unit test",
      code: `process.env.HUB_TOKEN = "test"`,
      filename: productionFile,
    },
  ],
  invalid: [
    mutation("static assignment into process.env", `process.env.HUB_TOKEN = "test"`),
    mutation("computed assignment into process.env", `process.env["HUB_TOKEN"] = "test"`),
    mutation("deletion from process.env", `delete process.env.HUB_TOKEN`),
    mutation("wholesale reassignment of process.env", `process.env = {}`),
    mutation("Object.assign onto process.env", `Object.assign(process.env, { HUB_TOKEN: "test" })`),
  ],
})
