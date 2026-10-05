# Claude Code is a second Host, running the same review program

`/gc-cli` runs Gauntlet inside Claude Code (#134, #135). We bundle the CLI's
own review program into a Claude Code mod and run it in process: Submission,
the snapshot, `invoke.ts`, the Stages, the Run record and the digest are the
ones `gauntlet review` runs. Only the platform services and the
HarnessSession adapter differ. Each AgentInvocation is a hidden Claude Code
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

- **A Host runs only its own Seats.** `claude-code/` Seats run only on the
  Claude Code Host, which runs no other provider; Submission refuses a Recipe
  whose Seats its Host cannot run, before a Run exists.
- **Claude Code owns transient retry**, as Pi does under ADR-0002. Gauntlet
  adds none on this Host either. The first-response stall retry is
  `invoke.ts`'s and applies on both Hosts.
- **Two plugins.** Claude Code skips the hooks of the plugin that spawned an
  agent, so `gc-cli` (the command and the engine) cannot see its own agents'
  tool calls. `gc-cli-tools` serves the emit tools with the strict
  OutputContract decoders, records each agent's tool calls for the engine,
  and fences Read, Grep and Glob to the Run's snapshot. Its agents get no
  shell, no network and no writes.
- **Agent types are keyed by Seat, tools and system prompt**, so sibling
  Finders share a cached prefix, and spawns refused at Claude Code's
  per-session cap of 20 subagents wait in the mod's own queue.
- **Cost is notional.** Claude Code reports tokens, not dollars, so the
  Dossier prices them with Pi's Anthropic catalog. The real cost is Claude
  plan usage, which is why `/gc-cli` passes `--related-files` by default; the
  CLI keeps it opt-in, since it gave no lift on gpt-6-luna:high.

## Consequences

- A mod reload (any change to its files) wipes a run in flight. The next
  load reports it, stops its orphaned agents and removes its snapshot; the
  Run resumes with `--resume`.
- The mod's FileSystem answers only the methods the review path calls. A CLI
  change that calls another one fails on the next `/gc-cli` run.
