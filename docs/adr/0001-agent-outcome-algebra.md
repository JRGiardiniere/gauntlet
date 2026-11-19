# AgentOutcome carries expected bad endings as data; the error channel means "no outcome exists"

An agent invocation can end badly and still yield paid value — a valid emit
followed by a late timeout, usable output from a budget-exhausted session,
usage/diagnostics from a provider error. We decided that every *expected*
terminal condition (completed, missing emit, first-response timeout, budget
exhausted, context limit, provider failed, interrupted) is data on
`AgentOutcome`, and the Effect typed error channel is reserved for the
inability to truthfully produce an outcome at all (invalid configuration,
adapter contract violation, corrupted session). Defects stay defects.

Amended per #198 (v2, OpenCode Host, ADR-0010): the terminations are
completed, missing emit, budget exhausted, context limit, provider failed and
interrupted; first-response timeout went with the stall retry (ADR-0002). The
rule is unchanged: a provider ending, an overall-deadline hit or a missing emit
is `AgentOutcome.termination` data, with the usage and output available beside
it. Pi is gone; the salvage of pre-validation emit arguments went with it,
since an emit that fails strict decoding goes back to the model in the same
turn.

Why: a binary success/failure branch erases the legitimate coexistence of
output, usage, and error — the `better-result` research names "flattening rich
durable outcomes into an error channel" as the primary risk of going
full-Effect, and its guardrail is to use the error channel only for
recoverable in-process control flow with a caller decision. The shape also
matches Pi's actual surface one-to-one: provider failures never throw
(`stopReason: "error"` in the message; `prompt()` resolving proves nothing),
so lifting them into typed errors would mean the adapter *inventing* throws.
Ben Davis's production workflow runner follows the same rule ("intentionally
never throws; all failures settle into a rich `AgentOutcome`").

## Considered options

- Provider failures as typed Effect errors, siblings harvested via `Exit` —
  rejected: discards the output/usage/error coexistence by construction.
- A stream of agent events with the outcome derived separately — rejected as
  the *primary* contract; the adapter may bridge events internally, but ports
  consume one terminal `AgentOutcome`.
- No salvage: only validated structured output counts — rejected: throws away
  recoverable paid work Pi demonstrably exposes (pre-validation emit args).

## Consequences

- The glossary word **failure** refers exclusively to the typed error channel;
  bad endings are **terminations**, missing work is a **coverage gap**.
- One agent's bad ending can never kill a fan-out by throwing; sibling
  outcomes survive by construction.
- Callers must inspect termination modes rather than relying on the error
  channel to signal "something went wrong" — the type system will not force
  the check, tests must.
