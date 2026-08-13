# The next real run is the test for instantly-loud behavior

After the suite moved onto Stage seams (ADR 0007) and shed its TestClock
choreography, a further class of test remained whose only job was proving
that the next real invocation would fail loudly: help still prints, a clean
tree still exits 1 with a message, git-less directories still refuse, config
verbs still echo their result. Gauntlet is a personal tool that is actually
run — every one of those behaviors is re-verified at the terminal each time
it is used, faster and more honestly than a test re-verifies it. We decided:
**a test does not earn its keep when a regression in what it covers would
fail loudly at the invocation surface the next time the tool is used.** The
next real run is that test. Applied in the cull of #45 (0fd5a40).

"Loud" is a narrow claim: a nonzero exit with a message, or terminal output
that is obviously wrong on sight, on the next ordinary use. It is not
satisfied by evidence in run artifacts — those require going to look, and
nothing prompts the look (artifacts are the debugger for *noticed* failures,
ADR 0007) — and it is not satisfied by degraded output quality, extra spend
under a successful-looking Dossier, or silently missing candidates. Those
failures are quiet, and quiet failures keep their tests, in the cheapest
pure form available.

The canonical boundary case is the JSON Schema projection of the emit-tool
contracts: if the projection leaked definitions or dropped the normative
descriptions, agents would quietly get worse guidance and no run would fail
anywhere. Those tests stay (one collapsed tripwire per contract family),
even though they can only fire on a deliberate Effect bump — the pin is
exact — because that is precisely the moment the tripwire is for.

This amends ADR 0007's proportionality clause: "tests cover the happy path"
now applies to quiet surfaces. A happy path that is exercised loudly by
every real use — the CLI's own command surface — is not owed a test.

## Consequences

- Deleting a test under this rule requires naming the loud channel: which
  command, and what visible failure the regression produces at the terminal.
  If the answer routes through a run artifact or through output quality, the
  rule does not apply and the test stays.
- Happy-path tests of the CLI command surface (help, exit codes, refusal
  messages, config verbs) are not maintained; the next invocation is the
  regression test.
- Guards against quiet failures — silent candidate loss, prompt or tool-
  schema degradation, spend without a corresponding loud outcome — are
  written as pure unit tests where possible, never as pipeline choreography.
- Duplicate coverage is deleted on its own merits, not under this rule: a
  stage-level assertion already proven by a pure unit test (e.g. Judgment
  repair in resolution.test.ts) goes because it is a duplicate, whether or
  not its failure would be loud.
