import { RuleTester } from "oxlint/plugins-dev"
import { describe, it } from "vitest"

RuleTester.describe = describe
RuleTester.it = it

// Several rules branch on the filename, and two resolve imports against the
// real filesystem, so every case names an absolute path.
export const productionFile = "/repo/platform/operations/publisher.ts"
export const testFile = "/repo/platform/operations/publisher.test.ts"

export const ruleTester = new RuleTester()
