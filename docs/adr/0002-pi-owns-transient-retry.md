# Pi owns transient-error retry; Gauntlet retries only the first-response stall

Pi already retries transient provider errors inside `prompt()` (agent-level,
3 attempts, exponential backoff), and its own docs warn that provider-level
retries above 0 can absorb quota errors invisibly — so agent-level retry stays
on, provider-level stays 0. We decided Gauntlet layers **no** retry of its own
on those errors: an Effect `Schedule` wrapped around the same failures would
multiply attempts and silently inflate wall-clock past the invocation budget
(one `prompt()` call already hides up to three backoffs). The only
invocation-level retry Gauntlet performs is on a **first-response stall** —
which includes a hang during session construction, folded into the same
termination mode — because a stall partway into a large budget is exactly the
transient failure a retry exists to absorb, and it is the one case Pi's retry
cannot see.

Retryability is a pure function of the termination mode:

| Termination | Retryable | Why |
| --- | --- | --- |
| completed | no | nothing to retry |
| missing emit | no | corrective turns re-prompt the *same* session; never a fresh invocation |
| first-response timeout (incl. startup hang) | **yes**, if remaining budget clears the minimum | the transient stall retry exists for |
| budget exhausted | no | an identical-budget retry is futile by definition |
| context limit | no | `"length"` leaves no room; a retry is paid waste |
| provider failed | no | Pi already retried it 3× internally |
| interrupted | no | someone chose that |

## Consequences

- Invocation budgets must absorb Pi's hidden backoff time; deadline tests
  cannot assume one `prompt()` equals one provider request.
- The retry decision is decidable from the Termination enum alone — testable
  offline, no provider needed.
- A future reader must not "add" Effect retry on provider errors; that is the
  rejected alternative, not an omission.

## Finder prefix preloads

Finder cache preloads are normal bounded AgentInvocations and use the same one
fresh-session retry for a first-response stall. They do not use corrective
turns: their requested terminal response is inert prose, not an emit. A tool
attempt invalidates the prefix and is rejected by the adapter before execution.
Only the exact configured acknowledgment makes the captured prefix replayable.
An unavailable preload never changes Finder retry or coverage policy; followers
run with their complete one-turn prompt when no replayable prefix exists.
