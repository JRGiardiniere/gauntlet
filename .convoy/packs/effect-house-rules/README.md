# effect-house-rules

Our own Oxlint rules for Effect code, shared by every Effect project, as the `house` plugin: `Domain.operation` span names (the effect skill's form), no raw `Error` throws, no `instanceof` on tagged errors, barrel imports, `.ts` import extensions, `@effect/platform` imports, bounded retries, and test hygiene. They sit beside tsgo's rules (the `effect` pack) and anti-slop's, and only cover what those don't: a rule either of them has is dropped here. Each rule has its test beside it (`*.test.ts`, run with the project's test runner through `rule-tester.ts`).

- `oxlintrc.json` loads the plugin and turns every rule on. A rule added here is on in every project at the next sync.

**Convoy manages these files.** They're copied from `config/packs/effect-house-rules/` in the convoy repo into `.convoy/packs/effect-house-rules/` of every project whose `convoy.toml` lists `effect-house-rules`, as uncommitted changes that go in with the project's next commit. An edit here, such as a fix to a rule, shows in Convoy's Review: promote it and every other project on the pack has it within seconds.

## Hooking it up

In the project's `.oxlintrc.json`, extend the pack's config and ignore the packs folder:

```json
{
  "extends": ["./.convoy/packs/effect-house-rules/oxlintrc.json"],
  "ignorePatterns": [".convoy/**"]
}
```

The plugin imports `@oxlint/plugins`, so the project depends on it at exactly its `oxlint` version. Options for rules (such as `house/no-import-from-barrel-package`'s `checkPatterns`) and rules turned off for some files go in the project's own config too. Include `.convoy/packs/**/*.test.ts` in the project's Vitest run so the rules' tests run.
