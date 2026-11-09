import { eslintCompatPlugin } from "@oxlint/plugins"

import { directiveReasonRule } from "./directive-reason.ts"
import { noEffectPromiseRule } from "./no-effect-promise.ts"
import { noModuleLevelMutableStateRule } from "./no-module-level-mutable-state.ts"
import { requireTsExtensionImportsRule } from "./require-ts-extension-imports.ts"
import { retryScheduleBoundedRule } from "./retry-schedule-bounded.ts"

// Our own Effect lint rules, shared by every Effect project, kept only where
// tsgo and oxlint have nothing equivalent (README.md says why each one is here).
// Wrapped like the anti-slop plugin so createOnce rules stay ESLint-compatible
// (RuleTester drives them in tests).
const housePlugin = eslintCompatPlugin({
  meta: {
    name: "house",
  },
  rules: {
    "directive-reason": directiveReasonRule,
    "no-effect-promise": noEffectPromiseRule,
    "no-module-level-mutable-state": noModuleLevelMutableStateRule,
    "require-ts-extension-imports": requireTsExtensionImportsRule,
    "retry-schedule-bounded": retryScheduleBoundedRule,
  },
})

export default housePlugin
