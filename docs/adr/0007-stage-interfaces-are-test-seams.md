# Stage interfaces are test seams; run artifacts are the debugger

The original expectation put every test at the topmost seam: CLI command in,
stdout/exit/run-directory out. That rule bought realism but concentrated the
entire pipeline's test surface in one 1,100-line file, forced TestClock and
concurrency choreography onto every Stage behavior, and produced two real
flakes whose only cause was asserting concurrent internals through a
positional top-level view (fixed in 5d2660f). We decided the seam moves down
one level: **a Stage module's public interface is a sanctioned test surface.**
Stage tests drive the real interface callers use — scripted HarnessSession
adapter, real temp filesystem, real shipped prompt text — and the CLI suite
shrinks to contracts that are genuinely CLI-shaped: exit codes, stdout,
run-directory layout, resume, plus a small number of end-to-end journeys.

The second half of the decision is proportionality. Gauntlet is a personal
tool that emits a complete reportable chain on every run — frozen ReviewPlan,
per-invocation journal artifacts (ADR 0003), run log, Dossier. Rare failure
modes are diagnosable from those artifacts after the fact, which is cheaper
than maintaining pre-emptive edge-case tests for them. Tests cover the happy
path, load-bearing invariants (candidate accounting, journal reuse, degraded
seats), and pure decision logic where cases are cheap; they do not chase
exhaustiveness. This is the testing corollary of the no-speculative-safeguards
directive (#8).

## Consequences

- When a Stage gains a deep module, the CLI assertions it supersedes are
  deleted in the same change — never kept in parallel. The CLI retains one
  journey-level check that the Stage's output reaches the Dossier.
- Stage tests assert the real prompt templates structurally (placeholders
  filled, required sections present), never exact wording — a prompt edit that
  preserves structure must not break tests.
- Pure decision logic (e.g. Judgment resolution precedence) keeps dedicated
  unit tests; the module seam does not mandate testing through the outermost
  interface available.
- TestClock never auto-advances and fixture lenses remain mandatory —
  unchanged by this ADR.
- A new edge-case test needs the same justification as a new safeguard: if a
  run-directory artifact would already surface the failure, prefer the
  artifact.
