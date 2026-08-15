import { eslintCompatPlugin } from "@oxlint/plugins"

import { effectFnGauntletPrefixRule } from "./effect-fn-gauntlet-prefix.ts"
import { effectFnSpanFormatRule } from "./effect-fn-span-format.ts"
import { noEffectPlatformImportsRule } from "./no-effect-platform-imports.ts"
import { noEnvMutationInTestsRule } from "./no-env-mutation-in-tests.ts"
import { noFnUntracedOutsideTestsRule } from "./no-fnuntraced-outside-tests.ts"
import { noImportFromBarrelPackageRule } from "./no-import-from-barrel-package.ts"
import { noInstanceofTaggedErrorRule } from "./no-instanceof-tagged-error.ts"
import { noManualTagCheckRule } from "./no-manual-tag-check.ts"
import { noRawErrorThrowRule } from "./no-raw-error-throw.ts"
import { noRecordStringUnknownRule } from "./no-record-string-unknown.ts"
import { noSchemaClassRule } from "./no-schema-class.ts"
import { noSleepInTestsRule } from "./no-sleep-in-tests.ts"
import { requireTsExtensionImportsRule } from "./require-ts-extension-imports.ts"
import { retryScheduleBoundedRule } from "./retry-schedule-bounded.ts"

// House-style rules for this repository, wrapped like the anti-slop plugin so
// createOnce rules stay ESLint-compatible (RuleTester drives them in tests).
const gauntletPlugin = eslintCompatPlugin({
  meta: {
    name: "gauntlet",
  },
  rules: {
    "effect-fn-gauntlet-prefix": effectFnGauntletPrefixRule,
    "effect-fn-span-format": effectFnSpanFormatRule,
    "no-effect-platform-imports": noEffectPlatformImportsRule,
    "no-env-mutation-in-tests": noEnvMutationInTestsRule,
    "no-fnuntraced-outside-tests": noFnUntracedOutsideTestsRule,
    "no-import-from-barrel-package": noImportFromBarrelPackageRule,
    "no-instanceof-tagged-error": noInstanceofTaggedErrorRule,
    "no-manual-tag-check": noManualTagCheckRule,
    "no-raw-error-throw": noRawErrorThrowRule,
    "no-record-string-unknown": noRecordStringUnknownRule,
    "no-schema-class": noSchemaClassRule,
    "no-sleep-in-tests": noSleepInTestsRule,
    "require-ts-extension-imports": requireTsExtensionImportsRule,
    "retry-schedule-bounded": retryScheduleBoundedRule,
  },
})

export default gauntletPlugin
