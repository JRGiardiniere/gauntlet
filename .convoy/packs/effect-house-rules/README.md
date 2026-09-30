# effect-house-rules

The custom Oxlint rules gauntlet and cloudflare-hub share for Effect house style, as the `house` plugin: span names and format, no raw `Error` throws, no `instanceof` on tagged errors, no manual tag checks, barrel imports, `.ts` import extensions, bounded retries, and test hygiene. Each rule has its test beside it (`*.test.ts`, run with the project's test runner through `rule-tester.ts`).

- `oxlintrc.json` loads the plugin and turns every rule on. A rule added here is on in every project at the next sync.
- `house/effect-fn-prefix` needs the project's span prefix as an option; without it, each span the rule checks is reported with a message saying how to set it.

**Convoy manages these files.** They're copied from `config/packs/effect-house-rules/` in the convoy repo into `.convoy/packs/effect-house-rules/` of every project whose `convoy.toml` lists `effect-house-rules`, as uncommitted changes that go in with the project's next commit. An edit here, such as a fix to a rule, shows in Convoy's Review: promote it and every other project on the pack has it within seconds.

## Hooking it up

In the project's `.oxlintrc.json`, extend the pack's config, ignore the packs folder, and pass the prefix:

```json
{
  "extends": ["./.convoy/packs/effect-house-rules/oxlintrc.json"],
  "ignorePatterns": [".convoy/**"],
  "rules": { "house/effect-fn-prefix": ["error", { "prefix": "<project>" }] }
}
```

Options for other rules (such as `house/no-import-from-barrel-package`'s `checkPatterns`) and rules turned off for some files go in the project's own config too. Include `.convoy/packs/**/*.test.ts` in the project's tests so the rules' tests run.
