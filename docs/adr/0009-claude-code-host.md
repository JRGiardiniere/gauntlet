# Claude Code is a second Host, running the same review program

The Mod, `/gauntlet`, runs Gauntlet inside Claude Code (#134, #135). We bundle the CLI's
own review program into a Claude Code mod and run it in process: Submission,
the snapshot, `invoke.ts`, the Stages, the Run record and the digest are the
ones `gauntlet review` runs. Only the platform services and the
HarnessSession adapter differ. Amended per #159: both Hosts parse the one
review syntax (`src/syntax/`) into a request for the Run module
(`src/run/run.ts`), which answers data each Host words itself; the Mod reads
no CLI output. Each AgentInvocation is a hidden Claude Code
subagent on a `claude-code/<model>:<effort>` Seat. Pi is not involved.

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

## Decisions

- **The Mod takes the plain name; the CLI carries the qualifier.** The Mod's
  command, plugins and review tool are `/gauntlet`, `gauntlet` and
  `gauntlet-tools`, and `mcp__gauntlet__review`; the CLI's agent skill is
  `gauntlet-cli`, since Claude Code lists skills as slash commands and the two
  cannot share `gauntlet` there. Someone using only the Mod sees Gauntlet;
  with both installed, the `-cli` one is the one that is a CLI. Rejected:
  `gc-cli` (says "cli" on the version that isn't), `/gauntlet-review` (one
  character from the CLI's `gauntlet review`), and `/gauntlet-claude` or
  `/gauntlet-mod` (a qualifier on the name Mod-only users see). The Mod's own
  skill, which only teaches agents the review tool, is hidden from the slash
  menu (`user-invocable: false`) so it adds no third name there (#155).
- **A Host runs only its own Seats.** `claude-code/` Seats run only on the
  Claude Code Host, which runs no other provider; Submission refuses a Recipe
  whose Seats its Host cannot run, before a Run exists.
- **Claude Code owns transient retry**, as Pi does under ADR-0002. Gauntlet
  adds none on this Host either. The first-response stall retry is
  `invoke.ts`'s and applies on both Hosts.
- **Two plugins.** Claude Code skips the hooks of the plugin that spawned an
  agent, so `gauntlet` (the command and the engine) cannot see its own agents'
  tool calls or responses. `gauntlet-tools` serves the emit tools with the strict
  OutputContract decoders, records each agent's tool calls and responses
  (Claude's own stop reason and usage, #172) for the engine,
  and fences Read, Grep and Glob to the Run's snapshot. Its agents get no
  shell, no network and no writes.
- **Agent types are keyed by Seat, tools and system prompt**, so sibling
  Finders share a cached prefix, and spawns refused at Claude Code's
  per-session cap of 20 subagents wait in the mod's own queue.
- **Cost is notional.** Claude Code reports tokens, not dollars, so the
  Dossier prices them with Pi's Anthropic catalog. The real cost is Claude
  plan usage, which is why `/gauntlet` passes `--related-files` by default; the
  CLI keeps it opt-in, since it gave no lift on gpt-6-luna:high.

## Consequences

- A mod reload (any change to its files) wipes a run in flight. The next
  load reports it, stops its orphaned agents and removes its snapshot, and
  says to run `/gauntlet` again.
- The mod's FileSystem answers only the methods the review path calls. A CLI
  change that calls another one fails on the next `/gauntlet` run.
