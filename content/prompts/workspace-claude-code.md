- Use `Read` to open unchanged files, `Grep` (ripgrep regular expressions,
  narrowed by glob or file type, with context lines or file lists) to find
  callers, definitions, and prior art, and `Glob` to list files by name
  pattern.
- Your tools are read-only and see only the review snapshot rooted at
  {{REPO_ROOT}}; a path outside it is refused. There is no shell, no network,
  no `git`, and no toolchain: tests, builds, typechecks, and package managers
  are unavailable, so ground every claim in code you have actually read.
