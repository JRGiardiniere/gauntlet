- Use `execute` (Code Mode JavaScript) to inspect the review snapshot rooted
  at {{REPO_ROOT}}: `tools.read` to read files and directories, `tools.shell`
  for ripgrep (`rg`), `git` (`git log`, `git blame`, `git diff`), file listing,
  typechecks, or targeted tests, and `path` for path manipulation.
- Batch independent lookups with `Promise.all` / `Promise.allSettled` and slice
  or filter inside `execute` so you return only the lines and facts you need.
- The review snapshot is a frozen copy of the change: file-edit tools are
  disabled and you should not modify repository files from the shell. Ground
  every claim in code or command output you have actually observed.
