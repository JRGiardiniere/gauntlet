import { eslintCompatPlugin } from "@oxlint/plugins"

import { effectFnSpanFormatRule } from "./effect-fn-span-format.ts"
import { noEffectPlatformImportsRule } from "./no-effect-platform-imports.ts"
import { noFnUntracedOutsideTestsRule } from "./no-fnuntraced-outside-tests.ts"
import { noImportFromBarrelPackageRule } from "./no-import-from-barrel-package.ts"
import { noInstanceofTaggedErrorRule } from "./no-instanceof-tagged-error.ts"
import { noRawErrorThrowRule } from "./no-raw-error-throw.ts"
import { noSchemaClassRule } from "./no-schema-class.ts"
import { noSleepInTestsRule } from "./no-sleep-in-tests.ts"
import { requireTsExtensionImportsRule } from "./require-ts-extension-imports.ts"
import { retryScheduleBoundedRule } from "./retry-schedule-bounded.ts"

// The Effect house-style rules shared by every project on the house style,
// wrapped like the anti-slop plugin so createOnce rules stay ESLint-compatible
// (RuleTester drives them in tests). Project-specific values reach the rules
// as options in the project's lint config.
const housePlugin = eslintCompatPlugin({
  meta: {
    name: "house",
  },
  rules: {
    "effect-fn-span-format": effectFnSpanFormatRule,
    "no-effect-platform-imports": noEffectPlatformImportsRule,
    "no-fnuntraced-outside-tests": noFnUntracedOutsideTestsRule,
    "no-import-from-barrel-package": noImportFromBarrelPackageRule,
    "no-instanceof-tagged-error": noInstanceofTaggedErrorRule,
    "no-raw-error-throw": noRawErrorThrowRule,
    "no-schema-class": noSchemaClassRule,
    "no-sleep-in-tests": noSleepInTestsRule,
    "require-ts-extension-imports": requireTsExtensionImportsRule,
    "retry-schedule-bounded": retryScheduleBoundedRule,
  },
})

export default housePlugin
