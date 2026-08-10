import effectFnGauntletPrefix from "./effect-fn-gauntlet-prefix.js"
import effectFnSpanShape from "./effect-fn-span-shape.js"
import noEffectPlatformImports from "./no-effect-platform-imports.js"
import noEnvMutationInTests from "./no-env-mutation-in-tests.js"
import noFnUntracedOutsideTests from "./no-fnuntraced-outside-tests.js"
import noImportFromBarrelPackage from "./no-import-from-barrel-package.js"
import noInstanceofTaggedError from "./no-instanceof-tagged-error.js"
import noManualTagCheck from "./no-manual-tag-check.js"
import noRawErrorThrow from "./no-raw-error-throw.js"
import noRecordStringUnknown from "./no-record-string-unknown.js"
import noSchemaClass from "./no-schema-class.js"
import noSleepInTests from "./no-sleep-in-tests.js"
import requireTsExtensionImports from "./require-ts-extension-imports.js"
import retryScheduleBounded from "./retry-schedule-bounded.js"

export default {
  meta: {
    name: "gauntlet",
  },
  rules: {
    "effect-fn-gauntlet-prefix": effectFnGauntletPrefix,
    "effect-fn-span-shape": effectFnSpanShape,
    "no-effect-platform-imports": noEffectPlatformImports,
    "no-env-mutation-in-tests": noEnvMutationInTests,
    "no-fnuntraced-outside-tests": noFnUntracedOutsideTests,
    "no-import-from-barrel-package": noImportFromBarrelPackage,
    "no-instanceof-tagged-error": noInstanceofTaggedError,
    "no-manual-tag-check": noManualTagCheck,
    "no-raw-error-throw": noRawErrorThrow,
    "no-record-string-unknown": noRecordStringUnknown,
    "no-schema-class": noSchemaClass,
    "no-sleep-in-tests": noSleepInTests,
    "require-ts-extension-imports": requireTsExtensionImports,
    "retry-schedule-bounded": retryScheduleBounded,
  },
}
