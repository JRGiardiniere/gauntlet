- Use `read` to open unchanged files, and `bash` (rg / grep / find / sed / awk /
  jq, with pipes, redirects, loops, and globs) to find callers, definitions, and
  prior art.
- Your tools see the repository only through a confined workspace rooted at
  {{REPO_ROOT}}. There is no network, no `git`, and no host toolchain: tests,
  builds, typechecks, and package managers are unavailable, so ground every
  claim in code you have actually read. The shell is simulated: a repository
  script may run in it, but its output proves nothing about what real tooling
  would do, and an occasional bash construct may be unsupported and return an
  error — rephrase the command and move on.
- The workspace is writable only as disposable scratch space: your writes are
  visible to your own later tool calls, never reach the real repository, and
  are discarded when you finish.
