# OpenCode is the single Host, embedded in the CLI

Supersedes ADR-0009. Spec: #195 and its amendments; built in #196–#201.

Gauntlet v2 is one CLI that embeds OpenCode as its only Host. Claude and
OpenAI Seats run through the same agent loop, tools, permission fence and
usage accounting, so a Recipe can mix them across Stages. The Claude Code Mod,
Pi, `claude -p` and `just-bash` are deleted.

## Considered Options

- **Keep two Hosts** (the CLI on Pi, the Mod on Claude Code). Rejected: the
  Mod broke with Claude Code releases and took more than half of all commits
  from October, and the two drifted apart.
- **Pi for both providers.** Rejected: Claude Seats on Pi need an API key or a
  second login path; OpenCode's `claude-agent` provider runs the installed
  `claude` on the person's own login.
- **OpenCode as a separate server process.** Rejected: an embedded SDK Host
  needs no port, no lifecycle of its own, and its plugins are in-process
  Effect code.

## Decisions

- **One embedded Host per Gauntlet process**, loaded lazily through
  `src/host/live-host.ts`, so commands that never use it never load OpenCode.
- **Isolated from the person's OpenCode.** Its store and every OpenCode global
  path live under `~/.gauntlet/opencode`; project, global and Claude-compat
  config and instructions are off, and a reviewed repository's agent
  configuration never loads.
- **Logins.** `gauntlet login` signs in with ChatGPT into that store; an API
  key comes from `OPENAI_API_KEY`. Claude Seats use the installed `claude`
  login (`OPENCODE_CLAUDE_PATH` overrides where `claude` is found). Gauntlet
  never reads or copies another tool's login.
- **One Gauntlet plugin** holds the host-side policy: per-Run agents, the emit
  tools, the symlink check, stop-after-emit and tool description overrides.
- **The ReviewWorkspace is a permission fence** (deny all, then allow `read`,
  `grep`, `glob` and the Stage's emit tool, then deny `.env*`, `.git` and
  outside paths), not hardened isolation. Amended per #189: the snapshot
  links the Caller's installed `node_modules` (repository root and beside
  each tracked `package.json`), and the fence admits a path whose real path
  lies in one of them, apart from the tool state kept there (`.cache`, `.mf`
  and other dot-entries that are not a package store); everything else it
  refuses stays refused. The tools
  stay read-only, so nothing can write there or run code from there.
- **No session resume.** A claim on a shared store has no owner, so resuming
  at start would re-run another process's live turns; each invocation removes
  its own session.
- **The model catalog is OpenCode's own fetch**, cached in the store; tests
  and the compile smoke pass a fixture catalog file.
- **The Host owns provider retries** (ADR-0002 amended); Gauntlet keeps one
  overall deadline and up to two corrective turns per invocation.

## Consequences

- `claude` is a prerequisite for Claude Seats only; OpenAI Seats and installs
  work without it.
- The binary carries OpenCode: about 160–180 MB per target, built with
  bundler plugins that stub the persistent PTY and fff and fix the NodeWS
  re-export (`scripts/compile.ts`).
- A lean Host idles at about 345 MB, against about 112 MB for Pi.
- A v1 Mod user removes it with
  `claude plugin uninstall gauntlet && claude plugin marketplace remove gauntlet`.
