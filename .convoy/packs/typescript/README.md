# typescript

Oxlint's own rules for any TypeScript project, with our choices: the plugins, the categories (correctness, suspicious and perf), and how strictly the rules in them run. It holds no rules of its own; Effect's rules, ours and anti-slop's are in their own packs.

- `oxlintrc.json` turns on the plugins and categories, raises some rules to `error`, turns off the ones we don't want, and allows `console` in tests and `scripts/**`, and extraneous classes and triple-slash references in tests and fixtures.
- Four type-aware correctness rules outside those categories are on: `strict-boolean-expressions` (no strings or numbers as conditions, where `""`, `0` and `NaN` are the bugs; nullable objects and booleans are fine), `switch-exhaustiveness-check`, `no-unnecessary-condition` (constant loop conditions such as `while (true)` allowed) and `prefer-nullish-coalescing`.
- Keep `noUncheckedIndexedAccess` on in the project's `tsconfig.json` (`tsc --init` sets it). Without it, `xs[i]` and a regex group are typed as always present, so `no-unnecessary-condition` calls a real absence check unnecessary, and clearing its findings deletes the check.
- `typescript/consistent-return` is off by choice: it misreads exhaustive `switch`es. The other rules it turns off would otherwise run in those categories.
- With type-aware linting (the `effect` pack turns it on), the `typescript/*` choices here apply to oxlint's type-aware rules too.

**Convoy manages these files.** They're copied from `config/packs/typescript/` in the convoy repo into `.convoy/packs/typescript/` of every project whose `convoy.toml` lists `typescript`, as uncommitted changes that go in with the project's next commit. An edit here shows in Convoy's Review, to promote to every project or discard.

## In a project

`convoy project init --pack typescript` adds `typescript`, `oxlint` and `oxlint-tsgolint`, and Convoy puts the pack first in the project's `.oxlintrc.json` `extends` (packs that bring it, such as `effect`, list it first), so the packs after it and the project's own settings win.

A project's own settings go in its `.oxlintrc.json`, which only that project gets: turning on a rule this pack turns off, its own plugins (such as `react`, which are added to the pack's), and the rules its code doesn't pass yet, turned off as tracked debt. A pack's `overrides` beat the project's top-level `rules`, so to change a rule for files a pack's override names, the project uses its own `overrides`.

`ignorePatterns` aren't inherited through `extends`, so each project lists its own; `convoy project init` adds the shared ones (`.convoy/**` and the agents' folders) once.
