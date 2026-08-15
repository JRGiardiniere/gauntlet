import { requireTsExtensionImportsRule as rule } from "./require-ts-extension-imports.ts"
import { productionFile, ruleTester } from "./rule-tester.ts"

const allowedImport = (name: string, source: string) => ({
  name,
  code: `import { value } from "${source}"`,
  filename: productionFile,
})

ruleTester.run("require-ts-extension-imports", rule, {
  valid: [
    allowedImport("an explicit .ts extension", "./module.ts"),
    allowedImport("an explicit .tsx extension", "./component.tsx"),
    allowedImport("an explicit .mts extension", "./module.mts"),
    allowedImport("an explicit .cts extension", "./module.cts"),
    allowedImport("an .mjs runtime boundary import", "./module.mjs"),
    allowedImport("a .cjs runtime boundary import", "./module.cjs"),
    allowedImport("a .json resource import", "./module.json"),
    allowedImport("a .css asset import", "./theme.css"),
    allowedImport("an .svg asset import", "./banner.svg"),
    allowedImport("a .wasm asset import", "./decoder.wasm"),
    allowedImport("a .txt asset import", "./notes.txt"),
    allowedImport("a resource import with a loader query", "./schema.sql?raw"),
    allowedImport("a bare package import", "effect"),
    allowedImport("a package subpath import", "effect/Effect"),
    allowedImport("a package import that names a JavaScript file", "some-package/utils.js"),
    {
      name: "an import of a JavaScript file that physically exists",
      code: `import { value } from "./fixtures/runtime-boundary.js"`,
      filename: import.meta.filename,
    },
    {
      name: "a local named-export declaration with no source",
      code: `export const value = 1`,
      filename: productionFile,
    },
    {
      name: "a sourced export with an explicit .ts extension",
      code: `export { value } from "./module.ts"`,
      filename: productionFile,
    },
    {
      name: "an export-all with an explicit .ts extension",
      code: `export * from "./module.ts"`,
      filename: productionFile,
    },
    {
      name: "a JavaScript file, which must keep runtime-resolvable imports",
      code: `import { value } from "./module.js"`,
      filename: "/gauntlet/src/publisher.js",
    },
  ],
  invalid: [
    {
      name: "an extensionless relative import",
      code: `import { value } from "./module"`,
      filename: productionFile,
      errors: [{
        message: `Use an explicit ".ts" extension for relative import "./module"`,
      }],
      output: `import { value } from "./module.ts"`,
    },
    {
      name: "a .js import whose file does not physically exist",
      code: `import { value } from "./fixtures/missing.js"`,
      filename: import.meta.filename,
      errors: [{
        message: `Use ".ts" extension instead of ".js" for relative imports`,
      }],
      output: `import { value } from "./fixtures/missing.ts"`,
    },
    {
      name: "a .js extension on a relative import",
      code: `import { value } from "./module.js"`,
      filename: productionFile,
      errors: [{
        message: `Use ".ts" extension instead of ".js" for relative imports`,
      }],
      output: `import { value } from "./module.ts"`,
    },
    {
      name: "a .jsx extension on a relative import",
      code: `import { value } from "./component.jsx"`,
      filename: productionFile,
      errors: [{
        message: `Use ".tsx" extension instead of ".jsx" for relative imports`,
      }],
      output: `import { value } from "./component.tsx"`,
    },
    {
      name: "a deeply nested relative JavaScript import",
      code: `import { value } from "../../lib/utils.js"`,
      filename: productionFile,
      errors: [{
        message: `Use ".ts" extension instead of ".js" for relative imports`,
      }],
      output: `import { value } from "../../lib/utils.ts"`,
    },
    {
      name: "an export-all declaration",
      code: `export * from "./module"`,
      filename: productionFile,
      errors: 1,
      output: `export * from "./module.ts"`,
    },
    {
      name: "a sourced named-export declaration",
      code: `export { value } from "./module.js"`,
      filename: productionFile,
      errors: 1,
      output: `export { value } from "./module.ts"`,
    },
  ],
})
