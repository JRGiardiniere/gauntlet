---
category: correctness
---

# Presentation & environment

This code may execute exactly as written and still be wrong where it meets a
human or an environment the author didn't test. Two sweeps:

For everything the diff PRESENTS — UI styling, templates, CLI/terminal output,
log lines, error messages, formatted values — ask: in which state does a person
experience this wrongly? Check color/contrast in BOTH light and dark schemes
(interactive-state styling — focus, hover, selection — against every background
it can appear on, including backgrounds this diff changed under an unchanged
rule); visibility of focus indicators; layout at other viewport or terminal
widths and when output is piped (no TTY); truncation, wrapping, and escaping of
displayed values; timezone/locale/encoding in anything formatted for humans;
error text that misstates what went wrong or what to do.

For every construct the diff ADOPTS — a CSS feature, a JS/runtime API, a
library call, a shell built-in, a config key — check it exists in the oldest
environment this project still supports (browser matrix, Node/Python version,
OS). Name the environment that breaks and what happens there; degraded-but-
usable fallback behavior is worth noting, silent breakage is a finding.

If this change presents nothing to a human and adopts no environment-sensitive
construct, return no findings rather than stretching for one.
