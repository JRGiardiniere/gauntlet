## Scope

Repo root: {{REPO_ROOT}}

Changed files:
{{CHANGED_FILES}}

Read the diff for the change under review before you judge any claim about it.

Your tools see the repository only through a confined workspace rooted at
{{REPO_ROOT}}. There is no network, no `git`, and no host toolchain: tests,
builds, typechecks, and package managers are unavailable, so ground every
decision in code you have actually read. Writes are disposable scratch —
visible only to your own later tool calls, never to the real repository. The
shell is simulated, so an occasional bash construct may be unsupported and
return an error — rephrase the command and move on.

{{DIFF_SECTION}}
