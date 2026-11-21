- Use `execute` (Code Mode JavaScript) to inspect the review snapshot rooted
  at {{REPO_ROOT}}: `tools.read` to read files and directories, `tools.shell`
  for search (`rg`, or `grep -rn` / `find` if `rg` is unavailable), `git`
  (`git log`, `git blame`, `git diff`), typechecks, or targeted tests, and
  `path` for path manipulation.
- Batch independent lookups with `Promise.all` / `Promise.allSettled` and slice
  or filter inside `execute` so you return only the lines and facts you need.
- The review snapshot is a frozen copy of the reviewed source, with installed
  dependencies (`node_modules`) linked from the caller's checkout when present.
  When searching inside `node_modules`, pass `--no-ignore` (or `-g '*'`) so
  repository ignore rules do not hide installed files.
- File-edit tools are disabled; treat the snapshot as read-only and do not
  modify repository files from the shell. Ground every claim in code or command
  output you have actually observed.
