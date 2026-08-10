---
category: spec
needs-spec: true
---

# Spec conformance

The originating spec for this change is quoted at the end of this prompt.
Check the diff against it and report:

- Requirements the spec asks for that are missing or only partly implemented.
- Requirements that look implemented but where the implementation does the
  wrong thing.

For each of these, quote the exact spec line the claim rests on — a finding
that cannot quote its spec line is not a finding on this lens. Include a
`failure_scenario`: the user-visible way the delivered behaviour differs from
the asked-for behaviour.

- Separately, behaviour in the diff the spec never asked for (scope creep).
  These are judgment calls, not refutable claims: report them with the spec
  section they exceed, and omit `failure_scenario`.
