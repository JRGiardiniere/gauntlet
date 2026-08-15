import rule from "./no-import-from-barrel-package.js"
import { productionFile, ruleTester } from "./rule-tester.ts"

const effectBarrel = [{ checkPatterns: ["^effect$"] }]

ruleTester.run("no-import-from-barrel-package", rule, {
  valid: [
    {
      name: "a named import from a specific Effect module",
      code: `import { Effect } from "effect/Effect"`,
      filename: productionFile,
      options: effectBarrel,
    },
    {
      name: "a namespace import from a specific Effect module",
      code: `import * as Effect from "effect/Effect"`,
      filename: productionFile,
      options: effectBarrel,
    },
    {
      name: "a type-only import declaration from a barrel",
      code: `import type { Effect } from "effect"`,
      filename: productionFile,
      options: effectBarrel,
    },
    {
      name: "a type-only specifier from a barrel",
      code: `import { type Effect } from "effect"`,
      filename: productionFile,
      options: effectBarrel,
    },
    {
      name: "a default import from a barrel",
      code: `import Effect from "effect"`,
      filename: productionFile,
      options: effectBarrel,
    },
    {
      name: "a relative index import once the check is disabled",
      code: `import { value } from "./index.ts"`,
      filename: productionFile,
      options: [{ checkRelativeIndexImports: false }],
    },
    {
      name: "a package outside the configured patterns",
      code: `import { helper } from "@example/tools"`,
      filename: productionFile,
      options: effectBarrel,
    },
  ],
  invalid: [
    {
      name: "every named value imported from an Effect barrel",
      code: `import { Effect, Option, Either } from "effect"`,
      filename: productionFile,
      options: effectBarrel,
      errors: 3,
    },
    {
      name: "an aliased barrel import, suggesting the specific module",
      code: `import { Effect as Eff } from "effect"`,
      filename: productionFile,
      options: effectBarrel,
      errors: [{ message: `Use import * as Eff from "effect/Effect" instead` }],
    },
    {
      name: "a namespace import from a barrel",
      code: `import * as Effect from "effect"`,
      filename: productionFile,
      options: effectBarrel,
      errors: [{ message: /namespace import from barrel file "effect"/ }],
    },
    {
      name: "a relative index import by default",
      code: `import { value } from "./index.ts"`,
      filename: productionFile,
      options: effectBarrel,
      errors: [{ message: /barrel file "\.\/index\.ts"/ }],
    },
    {
      name: "an additional configured package pattern",
      code: `import { helper } from "@example/tools"`,
      filename: productionFile,
      options: [{ checkPatterns: ["^@example/"] }],
      errors: 1,
    },
    {
      name: "an exact configured package pattern",
      code: `import { map } from "lodash"`,
      filename: productionFile,
      options: [{ checkPatterns: ["^lodash$"] }],
      errors: 1,
    },
  ],
})
