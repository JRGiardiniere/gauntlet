# anti-slop

Opinionated Oxlint rules that reject low-evidence TypeScript and JavaScript patterns, from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at `c44ef22`: its `src/` without the tests, and its `LICENSE` (MIT). It carries a few fixes of our own, listed below. To update it, copy upstream's `src/` again, then put back any of these fixes that upstream hasn't made.

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

## Our fixes

- `rules/no-shape-in-symbol-names.ts`: checks quoted keys (`{ "shape": 1 }`) like unquoted ones, doesn't report the right side of a qualified type (`External.Shape`), which another package names, and reports a name once where an unrenamed import, export or shorthand property visits it twice.
- `rules/no-runtime-typeof.ts`: `typeof x === "undefined"` is allowed only when `x`, or the start of a chain like `globalThis.crypto`, may be absent at runtime: an undeclared or configured global, or an ambient declaration (`declare`, or inside `declare global` or `declare module`). On a declared value it's reported like any other `typeof` check.
- `shared/dictionary-types.ts`: for `no-unsafe-dictionary-type`, the nearest declaration of a name wins. A type alias in scope beats a same-named interface elsewhere in the file, and a local class, type or type parameter hides a top-level interface.
- `shared/type-alias-resolution.ts`: a named class expression's name (`const C = class Input {}`) is visible only inside the class, so it no longer hides a real `Input` type from the rules that resolve aliases.
- `vendor/eslint-stylistic/UPSTREAM.md`: says where the tests and scripts it mentions are, since the pack leaves them out.
