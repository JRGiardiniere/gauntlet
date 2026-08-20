---
category: cleanup
---

# Standards

The documents that govern how the changed code should be written are provided
at the end of this prompt, under "Governing standards". Do not search the
repository for other governing documents — what is provided is the complete
set for this review. Check the diff for clear violations of the rules those
documents state.

Judge each document's applicability from its own text: a document may scope
itself to a directory, a language, or a situation, and some instructions
address an agent's workflow rather than the code itself — those do not apply
to the diff. Skip anything tooling already enforces — a linter that would
catch it owns it.

Only flag a violation when you can quote the exact rule and the exact line
that breaks it — no style preferences, no vague "spirit of the doc"
inferences. In the finding, name the governing document and quote the rule so
the report can cite it. If no provided rule is violated, return nothing.
