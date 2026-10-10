# Claude Code is a second Host, running the same review program

The Mod, `/gauntlet`, runs Gauntlet inside Claude Code (#134, #135). We bundle the CLI's
own review program into a Claude Code mod and run it in process: Submission,
the snapshot, `invoke.ts`, the Stages, the Run record and the digest are the
ones `gauntlet review` runs. Only the platform services and the
HarnessSession adapter differ. Amended per #159: both Hosts parse the one
review syntax (`src/syntax/`) into a request for the Run module
(`src/run/run.ts`), which answers data each Host words itself; the Mod reads
no CLI output. Amended per #181: each AgentInvocation is a headless
`claude -p` child process of the running Claude Code, on a
`claude-code/<model>:<effort>` Seat, one process per turn
(`src/harness/claude-live.ts`). Pi is not involved.

## Considered Options

- **The CLI as a subprocess** (Idea 1): `gauntlet review --host=claude-code`
  serves a Unix socket that the mod long-polls for invocation requests.
  Rejected for in process: that needs a bridge adapter, a JSON protocol and
  30-second polls between two processes that reload independently, while in
  process the core's commands and the mod's reports are plain calls. The
  price is a bundle and a FileSystem answered by `$` (`mod/platform.ts`).
- **A Claude-shaped pipeline** (Ideas 2 and 2b): a second review pipeline
  written for Claude Code. Rejected: with the same context it scored the same
  (5.3 of 7 on seeded-bugs-2), and two pipelines would drift.
- **Session subagents** (#134 to #179): each invocation a hidden subagent the
  mod spawned. Replaced per #181: under auto mode every subagent sends a
  `SubagentHandback` report and a resumed one a task notification, each a row
  and a turn for the main agent, which the mod could only drop by heuristic.
  A `claude -p` child sends neither, appears in no agent list, and does not
  depend on the permission mode.
- **The Agent SDK, or one long-lived child per invocation** over the
  stream-json control protocol. Rejected: `$.process.spawn` takes stdin as one
  string and closes it, so the mod cannot hold a multi-turn stdin, serve SDK
  MCP tools or answer `can_use_tool`; and the SDK is a runtime dependency.

## Decisions

- **The Mod takes the plain name; the CLI carries the qualifier.** The Mod's
  command, plugin and review tool are `/gauntlet`, `gauntlet` and
  `mcp__gauntlet__review`; the CLI's agent skill is
  `gauntlet-cli`, since Claude Code lists skills as slash commands and the two
  cannot share `gauntlet` there. Someone using only the Mod sees Gauntlet;
  with both installed, the `-cli` one is the one that is a CLI. Rejected:
  `gc-cli` (says "cli" on the version that isn't), `/gauntlet-review` (one
  character from the CLI's `gauntlet review`), and `/gauntlet-claude` or
  `/gauntlet-mod` (a qualifier on the name Mod-only users see). The Mod's own
  skill, which only teaches agents the review tool, is hidden from the slash
  menu (`user-invocable: false`) so it adds no third name there (#155).
- **A Host runs only its own Seats.** `claude-code/` Seats run only on the
  Claude Code Host, which runs no other provider. Amended per #177: each Host
  keeps its own Recipe Catalog and settings, and its Recipe schema admits
  only its own Seats, so a foreign Seat is an invalid Recipe in the listing
  rather than a refusal at Submission.
- **Claude Code owns transient retry**, as Pi does under ADR-0002. Gauntlet
  adds none on this Host either. The first-response stall retry is
  `invoke.ts`'s and applies on both Hosts.
- **One plugin; each invocation is a `claude -p` child** (amended per #181).
  The engine starts every turn through `$.process.spawn`, with the same argv
  on every turn but for `--session-id` on turn 0 and `--resume` after it: a
  resumed session keeps its system prompt and model and nothing else. The
  argv pins `--permission-mode default --permission-prompts none` (with
  telemetry off an unpinned child starts in auto mode), `--setting-sources ""`
  and `--strict-mcp-config`; `--tools Read,Grep,Glob` (or `""` for a no-tools
  Stage) with the child's cwd at the snapshot is the fence, since a read
  outside the cwd is refused. The child loads no plugins
  (`CLAUDE_CODE_PLUGIN_DIRS=""`), no CLAUDE.md and no Agent tool, and gets no
  shell, no network and no writes. The adapter reads the child's
  `--output-format stream-json` with Effect Schema listing only the fields it
  uses, so a Claude Code update that adds to the stream cannot break a run.
- **Each contract is the child's `--json-schema`** (amended per #181). Claude
  Code serves it as a `StructuredOutput` tool, retries in-band violations, and
  ends the turn on a valid call with the object in `result.structured_output`,
  which then passes the strict OutputContract decode before it is captured.
  A missing or retry-exhausted output is a missing emit, which gets
  `invoke.ts`'s corrective turn.
- **Cost is the turn's `total_cost_usd`** (amended per #181): Claude Code's
  list price for the child's turn, put on its last response's usage row; a
  killed turn costs $0. The real cost is Claude plan usage, which is why
  `/gauntlet` passes `--related-files` by default; the CLI keeps it opt-in,
  since it gave no lift on gpt-6-luna:high.
- **A child's Claude transcript moves into the run directory** (#181), under
  `transcripts/<invocation id>.<session id>.jsonl`, when its invocation is
  disposed. It is found by its session's file name under Claude Code's
  projects folder: a snapshot is a git worktree, whose auto-memory path names
  the main repository's project folder, not the one holding the transcript.

## Consequences

- A mod reload (any change to its files) wipes a run in flight, and kills its
  children with it (amended per #181). The next load reports the run, removes
  its snapshot, and says to run `/gauntlet` again. The killed children's
  transcripts stay under `~/.claude/projects/`.
- Each child costs about 273 MB at peak and 0.4s to start; sibling Finders
  with the same system prompt still share a cached prefix.
- The mod's FileSystem answers only the methods the review path calls. A CLI
  change that calls another one fails on the next `/gauntlet` run.
