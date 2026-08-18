---
category: correctness
finder-class: interpretive
---

# Spec conformance

Check the delivered change against the frozen Review Specification. Current
Slices define the obligations of this change. Parent material, sibling work,
and other broader context explain the intended system but are not automatically
requirements this change failed to implement.

Report these as refutable claims with a `failure_scenario`:

- a Current-Slice requirement that is missing or only partly implemented;
- a Current-Slice requirement whose implementation does the wrong thing.

For every such claim, begin `summary` with an exact, verbatim quote of the
requirement text from the Review Specification, then state the mismatch. A
claim that cannot quote its requirement exactly is not a finding on this lens.
The `failure_scenario` must name the concrete input or state in which delivered
behaviour differs from the requirement.

Separately, report behaviour added by the diff that no Current Slice asks for
when it creates meaningful scope creep. Scope creep is a judgment call: cite
the relevant specification boundary in `summary` and omit `failure_scenario`
so Judgment, rather than Verification, evaluates it.
