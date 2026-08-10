# Absence checks

Bugs are not only wrong lines that exist — they are also right lines that are
missing. Every finding on this lens must carry its own proof: cite the two
places whose disagreement proves it, or it is not a finding.

Run each of these three mechanical checks:

1. **New imports vs manifests.** For every package the diff newly imports —
   directly, or transitively through a file the diff adds — check that the
   importing package's own manifest (package.json, pyproject.toml, go.mod,
   Cargo.toml, ...) declares the dependency. "It resolves anyway" via
   workspace hoisting, a lockfile, or a sibling's node_modules is not a
   declaration; cite the import line and the manifest that omits it.

2. **Orphaned surface.** For every symbol the diff adds or that survives a
   refactor the diff performs — exports, interface/protocol members, public
   methods, type definitions — grep the tree for consumers. Declared surface
   with zero callers is a finding: cite the declaration and state what you
   searched. Do NOT flag the documented public API of a published package
   (external consumers are the callers); flag surface whose only plausible
   consumers live in this repo.

3. **Stale claims.** For every prose claim the diff touches or relies on —
   doc files, README sections, code comments, and claims in the PR
   description when one is provided — check the claim against what the code
   actually does. A claim that describes behavior more favorably, more
   narrowly, or simply differently than the implementation is a finding:
   quote the claim and cite the code that contradicts it.
