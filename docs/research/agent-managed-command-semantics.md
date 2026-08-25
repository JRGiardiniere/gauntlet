# Managed command semantics across Codex and Claude Code

Date: 2026-08-25

## Conclusion

Keep one shared Gauntlet skill, but split its launch guidance into a universal
rule and short host-specific notes. The current requirements to use a managed
facility, keep the Gauntlet command itself in the foreground, retain the
returned handle, and avoid `nohup` or `&` are portable. The one-second yield,
`session_id`, and session-wait wording describe Codex, not Claude Code.

Do not promise that completion "wakes the agent." The model-facing Codex tool
contract documents polling through `write_stdin`. Claude Code documents both
background task output files and event delivery for its separate `Monitor`
tool. Those are different behaviors.

## Documented facts

### Codex

- OpenAI's first-party Codex source defines `exec_command` as a PTY command
  that returns output or a session ID for an ongoing process. Its
  `yield_time_ms` input controls when a still-running command yields, with a
  250 to 30,000 ms effective range on non-Windows systems.
  [Codex `shell_spec.rs`](https://github.com/openai/codex/blob/1d64085e67adec1506665e6861c03c1a78b947bb/codex-rs/core/src/tools/handlers/shell_spec.rs#L21-L30),
  [tool description](https://github.com/openai/codex/blob/1d64085e67adec1506665e6861c03c1a78b947bb/codex-rs/core/src/tools/handlers/shell_spec.rs#L91-L100)
- The same source defines `write_stdin` as the follow-up operation for a live
  unified-exec session. Empty input polls without writing, and an empty poll
  may wait 5,000 to 300,000 ms. The `exec_command` result explicitly labels
  `session_id` as the value to pass to `write_stdin` while the process runs.
  [Codex `write_stdin` contract](https://github.com/openai/codex/blob/1d64085e67adec1506665e6861c03c1a78b947bb/codex-rs/core/src/tools/handlers/shell_spec.rs#L113-L153),
  [result schema](https://github.com/openai/codex/blob/1d64085e67adec1506665e6861c03c1a78b947bb/codex-rs/core/src/tools/handlers/shell_spec.rs#L194-L213)
- Codex's lower-level exec server has stable managed process IDs, buffered
  reads, streamed output, and explicit exit notifications. It also terminates
  remaining managed processes when the client connection closes. This proves
  the lifecycle is host-managed, but it does not say that a model turn wakes
  automatically when a process exits.
  [OpenAI exec-server lifecycle and process API](https://github.com/openai/codex/blob/1d64085e67adec1506665e6861c03c1a78b947bb/codex-rs/exec-server/README.md#L270-L349),
  [read and exit API](https://github.com/openai/codex/blob/1d64085e67adec1506665e6861c03c1a78b947bb/codex-rs/exec-server/README.md#L350-L378),
  [exit notification](https://github.com/openai/codex/blob/1d64085e67adec1506665e6861c03c1a78b947bb/codex-rs/exec-server/README.md#L424-L460)

### Claude Code

- Claude Code's Bash tool runs commands in separate processes. For a
  long-running command, Claude can set `run_in_background: true`. Claude Code
  returns a task ID and output-file path, and `/tasks` lists or stops managed
  background work.
  [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference#background-commands)
- The documented Bash schema exposes `run_in_background` and returns a
  `backgroundTaskId` for background work.
  [Claude Agent SDK Bash schema](https://code.claude.com/docs/en/agent-sdk/python#bash)
- Claude Code writes background output to a file and assigns a unique task ID.
  The current tool reference marks `TaskOutput` as deprecated and recommends
  reading the task's output file instead.
  [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode#background-bash-commands),
  [Claude Code tool list](https://code.claude.com/docs/en/tools-reference)
- Claude Code has agent-specific lifetime rules. Main-conversation and
  background-subagent commands keep running, while a foreground subagent's
  background command ends when that subagent returns. Non-interactive `-p`
  background tasks also end shortly after the final result.
  [Claude Code background command lifetime](https://code.claude.com/docs/en/tools-reference#background-commands)
- Claude Code's separate `Monitor` tool can deliver output events without
  polling. That is not the Bash background-task contract and should not be
  generalized to Codex.
  [Claude Code Monitor tool](https://code.claude.com/docs/en/tools-reference#monitor-tool)

## Inferences and limits

- Neither first-party source reviewed here explicitly says "never use
  `nohup`" or "never append `&`." Avoiding them is a design recommendation.
  Shell-level detachment can let the shell invocation finish before Gauntlet,
  so the host-managed handle and captured output may describe the wrapper
  shell rather than the review process.
- The reported empty `nohup` launch is evidence about the observed Codex host,
  not a documented guarantee that every agent host reaps detached children.
- A one-second initial yield is a sound Codex tactic. It is not a universal
  agent instruction. Claude Code has an explicit background flag and returns a
  task ID rather than requiring a timed yield.
- "Use managed waiting rather than manual polling" should mean no `ps`, log
  scraping, or home-grown shell loop. Codex's documented `write_stdin` calls
  are themselves the supported polling mechanism.

## Recommended skill shape

Use this universal rule:

> Launch through the agent host's managed long-running or background execution
> facility. Keep `gauntlet review ...` itself in the foreground inside that
> facility. Retain the host's process or task handle and any output path, then
> use the host's supported wait or output operation until the command exits.
> Do not wrap the command in `nohup` or append `&`; shell detachment can end the
> managed shell invocation before Gauntlet finishes and lose lifecycle or
> output tracking.

Then add host notes:

- **Codex:** Call `exec_command` with a short initial `yield_time_ms`. If it
  returns a `session_id`, retain it and call `write_stdin` with empty input and
  a long wait until the process exits.
- **Claude Code:** Call Bash with `run_in_background: true`. Retain the returned
  background task ID and output-file path. Read the output file to follow the
  run and collect the final stdout digest. Do not require a timed initial
  yield.
- **Other agents:** Use their equivalent managed process facility and returned
  handle. If none exists, keep the command in the foreground and wait for it
  rather than inventing shell detachment.

This belongs in one skill. Separate Codex and Claude copies would duplicate all
review, recipe, target, resume, and relay rules just to vary three launch lines.
