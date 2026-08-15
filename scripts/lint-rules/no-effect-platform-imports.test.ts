import { noEffectPlatformImportsRule as rule } from "./no-effect-platform-imports.ts"
import { productionFile, ruleTester } from "./rule-tester.ts"

const message = /house-style rule 2.*docs\/effect-house-style\.md/

const forbidden = (source: string) => ({
  name: `an import from ${source}`,
  code: `import * as Platform from "${source}"`,
  filename: productionFile,
  errors: [{ message }],
})

const sanctioned = (source: string) => ({
  name: `the sanctioned package ${source}`,
  code: `import * as Platform from "${source}"`,
  filename: productionFile,
})

ruleTester.run("no-effect-platform-imports", rule, {
  valid: [
    sanctioned("@effect/platform-node"),
    sanctioned("@effect/platform-node/NodeRuntime"),
    sanctioned("@effect/opentelemetry"),
    {
      name: "a JavaScript file, which sits outside the Effect platform seam",
      code: `import * as Platform from "@effect/platform"`,
      filename: "/gauntlet/src/publisher.js",
    },
  ],
  invalid: [
    forbidden("@effect/platform"),
    forbidden("@effect/platform/HttpClient"),
    forbidden("@effect/platform-bun"),
    forbidden("@effect/platform-bun/BunRuntime"),
    forbidden("@effect/platform-browser"),
    forbidden("@effect/platform-browser/BrowserHttpClient"),
    forbidden("@effect/platform-node-shared"),
  ],
})
