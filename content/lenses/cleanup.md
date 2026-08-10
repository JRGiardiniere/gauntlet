---
category: cleanup
---

# Citable cleanup

Every finding on this lens must carry its own proof. If you cannot name the
existing helper, cite the dead invariant, quote the rule, or point at the
repeated work, it is not a finding — say nothing rather than offer a preference.

## Reuse

Flag new code that re-implements something the codebase already has — grep
shared/utility modules and files adjacent to the change, and name the existing
helper to call instead.

## Over-defensiveness

Flag defensive code guarding against states the program's own invariants
already exclude: null/undefined checks on values the type system or an
upstream validation guarantees, try/catch around code that cannot throw (or
that swallows errors it should let propagate), fallback values and default
branches with no realistic trigger, handling for enum/state combinations the
construction sites make impossible, re-validation of data already validated
at the boundary. This pattern compounds: a function defending against every
theoretical input often ends up 30-50% longer than the honest version and
buries its actual logic. For each finding, name the specific invariant (type,
upstream check, construction site — cite the line) that makes the guard dead,
and the leaner form. Do NOT flag guards at genuine trust boundaries —
external input, I/O, API responses, deserialization, cross-service data —
where defensiveness is correct; if you cannot cite the invariant that makes
a guard unreachable, it is not a finding.

## Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or
hot paths. Also flag long-lived objects built from closures or captured
environments — they keep the entire enclosing scope alive for the object's
lifetime (a memory leak when that scope holds large values); prefer a
class/struct that copies only the fields it needs. Name the cheaper
alternative.

## Conventions

Find the documents that govern how the changed code should be written. Two
kinds:

- CLAUDE.md files: the user-level ~/.claude/CLAUDE.md, the repo-root
  CLAUDE.md, plus any CLAUDE.md or CLAUDE.local.md in a directory that is an
  ancestor of a changed file (a directory's CLAUDE.md only applies to files
  at or below it).
- The repo's own documented standards: CONTRIBUTING.md, CODING_STANDARDS.md,
  a style guide under docs/, or anything the README points at as "how we
  write code here".

Read each one that exists, then check the diff for clear violations of the
rules they state. Skip anything tooling already enforces — a linter that
would catch it owns it.

Only flag a violation when you can quote the exact rule and the exact line
that breaks it — no style preferences, no vague "spirit of the doc"
inferences. In the finding, name the document's path and quote the rule so
the report can cite it. If no such document applies, return nothing for this
angle.
