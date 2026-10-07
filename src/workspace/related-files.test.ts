import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { commitAll, makeGitFixture } from "../test-support/git.fixture.ts"
import { gatherRelatedFiles } from "./related-files.ts"

// Commits `files` to a fresh repository and gathers for `changed`; returns
// the related files in rendered order.
const relatedTo = (
  files: Record<string, string>,
  changed: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { repo } = yield* makeGitFixture()
    for (const [file, text] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(repo, file)), { recursive: true })
      yield* fs.writeFileString(path.join(repo, file), text)
    }
    yield* commitAll(repo, "fixture")
    const { related } = yield* gatherRelatedFiles(repo, changed)
    return related.map(({ file }) => file)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe("gatherRelatedFiles", () => {
  it.effect("resolves quoted relative specifiers against the touched file's directory", () =>
    Effect.gen(function* () {
      const related = yield* relatedTo({
        "src/app.ts": `import { x } from "./util.js"\nimport "../lib"\n`,
        "src/util.ts": "export const x = 1\n",
        "lib/index.ts": "export {}\n",
        "src/unused.ts": "export {}\n",
      }, ["src/app.ts"])
      expect(related).toEqual(["lib/index.ts", "src/util.ts"])
    }))

  it.effect("resolves qualified names by their trailing path segments", () =>
    Effect.gen(function* () {
      const related = yield* relatedTo({
        "app/Http/Controllers/UserController.php":
          "<?php\nnamespace App\\Http\\Controllers;\nuse App\\Models\\Invoice;\n\nreturn \\App\\Support\\Money::of(5);\n",
        "app/Models/Invoice.php": "<?php\nnamespace App\\Models;\nclass Invoice {}\n",
        "app/Support/Money.php": "<?php\nnamespace App\\Support;\nclass Money {}\n",
        "billing/report.py": "import billing.tax_rates\n\nbilling.tax_rates.apply(1)\n",
        "billing/tax_rates.py": "def apply(x): return x\n",
      }, ["app/Http/Controllers/UserController.php", "billing/report.py"])
      expect(related).toEqual([
        "app/Models/Invoice.php",
        "app/Support/Money.php",
        "billing/tax_rates.py",
      ])
    }))

  it.effect("finds referrers among the files that mention the touched stem", () =>
    Effect.gen(function* () {
      const related = yield* relatedTo({
        "app/Models/Invoice.php": "<?php\nnamespace App\\Models;\nclass Invoice {}\n",
        "routes/web.php": "<?php\nuse App\\Models\\Invoice;\n",
        "docs/notes.md": "The invoice flow is described elsewhere.\n",
      }, ["app/Models/Invoice.php"])
      expect(related).toEqual(["routes/web.php"])
    }))

  it.effect("links same-directory files by name only for type-like stems", () =>
    Effect.gen(function* () {
      const related = yield* relatedTo({
        "src/Billing/InvoiceTotal.php": "<?php\nclass InvoiceTotal { use TaxTable; }\n",
        "src/Billing/TaxTable.php": "<?php\ntrait TaxTable {}\n",
        "src/Billing/Ledger.php": "<?php\nclass Ledger { private InvoiceTotal $total; }\n",
        "docs/database.md": "Run the setup first.\n",
        "docs/setup.md": "Create the database.\n",
      }, ["src/Billing/InvoiceTotal.php", "docs/database.md"])
      expect(related).toEqual(["src/Billing/Ledger.php", "src/Billing/TaxTable.php"])
    }))

  it.effect("ignores a qualified name whose suffix names more than three files", () =>
    Effect.gen(function* () {
      const related = yield* relatedTo({
        "app/main.py": "from models.user import load\nfrom models.account import open\n",
        ...Object.fromEntries(["a", "b", "c", "d"].map((dir) => [`${dir}/models/user.py`, "x = 1\n"])),
        ...Object.fromEntries(["a", "b", "c"].map((dir) => [`${dir}/models/account.py`, "x = 1\n"])),
      }, ["app/main.py"])
      expect(related).toEqual(["a/models/account.py", "b/models/account.py", "c/models/account.py"])
    }))

  it.effect("keeps the most-linked files within the budget and renders them in path order", () =>
    Effect.gen(function* () {
      const filler = "x".repeat(55_000)
      const related = yield* relatedTo({
        "hub.ts": "export {}\n",
        "other.ts": "export {}\n",
        // Linked to both touched files, so ranked ahead of the rest.
        "e.ts": `import "./hub.ts"\nimport "./other.ts"\n${filler}`,
        ...Object.fromEntries(["a", "b", "c", "d"].map((name) => [`${name}.ts`, `import "./hub.ts"\n${filler}`])),
        // Over a quarter of the budget: skipped, and the fill goes on.
        "big.ts": `import "./hub.ts"\n${"x".repeat(70_000)}`,
      }, ["hub.ts", "other.ts"])
      expect(related).toEqual(["a.ts", "b.ts", "c.ts", "e.ts"])
    }))
})
