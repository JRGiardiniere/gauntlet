- Use `execute` (Code Mode JavaScript) to inspect and test claims against the
  review snapshot rooted at {{REPO_ROOT}}: `tools.read` to read files and
  directories, `tools.grep` to search code with ripgrep, `tools.glob` to list
  files, and `tools.shell` for read-only `git` history (`git log`, `git blame`,
  `git show` — the snapshot is checked out at the review head), typechecks, or
  targeted read-only repro checks.
- Batch independent lookups with `Promise.all` / `Promise.allSettled` and slice
  or filter inside `execute` so you return only the lines and facts you need.
- File-edit and web-fetch tools are disabled; treat the snapshot as read-only
  and do not modify repository files from the shell. Ground every claim in code
  or command output you have actually observed.
- Installed dependencies, when present, are readable by explicit path under
  `node_modules/` (for example `node_modules/<package>/`); a search from the
  snapshot root does not include them. They are the versions installed in
  the caller's checkout, which may differ from what this change expects, so
  treat them as evidence about the library, not as part of the change.
