# typescript

Oxlint's own rules for any TypeScript project, with our choices: the plugins, the categories (correctness, suspicious and perf), and how strictly the rules in them run. It holds no rules of its own; Effect's rules, ours and anti-slop's are in their own packs.

- `oxlintrc.json` turns on the plugins and categories, raises some rules to `error`, turns off the ones we don't want, and allows `console` in tests and `scripts/**`, and extraneous classes and triple-slash references in tests and fixtures.
- `typescript/consistent-return` is off by choice: it misreads exhaustive `switch`es. The other rules it turns off would otherwise run in those categories.
- With type-aware linting (the `effect` pack turns it on), the `typescript/*` choices here apply to oxlint's type-aware rules too.

**Convoy manages these files.** They're copied from `config/packs/typescript/` in the convoy repo into `.convoy/packs/typescript/` of every project whose `convoy.toml` lists `typescript`, as uncommitted changes that go in with the project's next commit. An edit here shows in Convoy's Review, to promote to every project or discard.

## Hooking it up

In the project's `.oxlintrc.json`, extend the pack's config first, so the packs after it and the project's own settings win:

```json
{
  "extends": ["./.convoy/packs/typescript/oxlintrc.json"]
}
```

A project's own settings go in its `.oxlintrc.json`, which only that project gets: turning on a rule this pack turns off, its own plugins (such as `react`, which are added to the pack's), and the rules its code doesn't pass yet, turned off as tracked debt.

`ignorePatterns` aren't inherited through `extends`, so each project lists its own, including the shared ones (agent folders, `node_modules`, build output).
