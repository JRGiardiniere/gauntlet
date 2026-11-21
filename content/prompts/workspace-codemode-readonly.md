- Use `execute` (Code Mode JavaScript) to inspect the review snapshot rooted
  at {{REPO_ROOT}}: `tools.read` to open unchanged files and directories,
  `tools.grep` (ripgrep regular expressions, narrowed by path or include glob)
  to find callers, definitions, and prior art, and `tools.glob` to list files
  by name pattern.
- Batch independent lookups with `Promise.all` / `Promise.allSettled` and slice
  or filter inside `execute` so you return only the lines and facts you need.
- Your tools are read-only and see only the review snapshot rooted at
  {{REPO_ROOT}}; a path outside it is refused. There is no shell, no network,
  no `git`, and no toolchain: tests, builds, typechecks, and package managers
  are unavailable, so ground every claim in code you have actually read.
- Installed dependencies, when present, are readable by explicit path under
  `node_modules/` (for example `node_modules/<package>/`); a search from the
  snapshot root does not include them. They are the versions installed in
  the caller's checkout, which may differ from what this change expects, so
  treat them as evidence about the library, not as part of the change.
