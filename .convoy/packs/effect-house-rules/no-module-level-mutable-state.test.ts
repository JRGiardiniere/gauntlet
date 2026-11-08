import { noModuleLevelMutableStateRule as rule } from "./no-module-level-mutable-state.ts"
import { productionFile, ruleTester, testFile } from "./rule-tester.ts"

ruleTester.run("no-module-level-mutable-state", rule, {
  valid: [
    {
      name: "a module-level const",
      code: `const timeout = "30 seconds"`,
      filename: productionFile,
    },
    {
      name: "a let inside a function",
      code: `const count = (items: ReadonlyArray<number>) => {
  let total = 0
  for (const item of items) total += item
  return total
}`,
      filename: productionFile,
    },
    {
      name: "a mutable field on a class instance",
      code: `class Agent { private processing = false }`,
      filename: productionFile,
    },
    {
      name: "an ambient global declaration",
      code: `declare var caches: CacheStorage`,
      filename: productionFile,
    },
    {
      name: "a module-level let in a test",
      code: `let calls = 0`,
      filename: testFile,
    },
  ],
  invalid: [
    {
      name: "a module-level let",
      code: `let cachedKey: CryptoKey | undefined`,
      filename: productionFile,
      errors: [{ message: /module-level `let` is shared by every request/ }],
    },
    {
      name: "an exported module-level var",
      code: `export var requests = 0`,
      filename: productionFile,
      errors: [{ message: /module-level `var` is shared by every request/ }],
    },
  ],
})
