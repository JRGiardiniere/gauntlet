import { RuleTester } from "oxlint/plugins-dev"
import { describe, it } from "vitest"

RuleTester.describe = describe
RuleTester.it = it

// Several rules branch on the filename, so every case names an absolute
// path. The paths are fictional; cases that exercise real filesystem
// resolution anchor themselves at import.meta.filename instead.
export const productionFile = "/project/src/publisher.ts"
export const testFile = "/project/src/publisher.test.ts"

export const ruleTester = new RuleTester()
