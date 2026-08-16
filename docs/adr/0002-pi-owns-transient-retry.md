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

## Finder prefix warmup

For each multi-Finder Seat/context partition, one ordinary Finder starts first
and uses this ADR's unchanged invocation policy. Its first successfully decoded
usage-bearing assistant response produces a total scheduling signal: observed,
or not observed if the invocation settles or fails first. An observed signal
starts a 1,500 ms best-effort cache-settle delay; the other ordinary Finders
then start while the first can continue tool use and corrective turns.

Every Finder independently receives the complete byte-identical shared prompt
prefix and the same provider-neutral cache-group hint. The signal does not
claim global provider cache propagation, and a missing signal skips only the
delay. Cache behavior never changes retry, coverage, termination, or output.
