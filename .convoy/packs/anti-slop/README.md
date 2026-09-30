# anti-slop

Opinionated Oxlint rules that reject low-evidence TypeScript and JavaScript patterns, from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at `c44ef22`: its `src/` without the tests, and its `LICENSE` (MIT). The pack follows upstream as it is: update it by copying upstream's `src/` again, not by editing the rules here.

- `index.ts` is the `anti-slop` plugin (18 generic rules); `effect/index.ts` is `anti-slop-effect` (5 rules for Effect code).
- `oxlintrc.json` loads both and turns every rule on, with upstream's `oxc/no-accumulating-spread`. A rule upstream adds is on in every project at the next sync.

**Convoy manages these files.** They're copied from `config/packs/anti-slop/` in the convoy repo into `.convoy/packs/anti-slop/` of every project whose `convoy.toml` lists `anti-slop`, as uncommitted changes that go in with the project's next commit. An edit here shows in Convoy's Review, to promote to every project or discard.

## Hooking it up

In the project's `.oxlintrc.json`, extend the pack's config and ignore the packs folder:

```json
{
  "extends": ["./.convoy/packs/anti-slop/oxlintrc.json"],
  "ignorePatterns": [".convoy/**"]
}
```

The plugin imports `@oxlint/plugins`, so the project depends on it at exactly its `oxlint` version. To turn a rule off or pass it options, do it in the project's own `.oxlintrc.json`, e.g. `"anti-slop-effect/prefer-effect-match": "off"` in a project without Effect.
