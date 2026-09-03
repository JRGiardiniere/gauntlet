# gauntlet

**A provider-neutral code-review workflow.** Gauntlet combines my favorite
parts of Claude's code review, Matt Pocock's code review, and other commands I 
found myself repeating to agents over and over — turned into one repeatable
pipeline you run with a single command. ("Run the gauntlet on medium.")

Multiple subagent **finders** hunt for bugs through different lenses, a pooled
set of adversarial **verifiers** tries to refute every claim before you ever
see it, and a parallel track of **observation finders** looks for cleanup and
structural improvements — judged against general programming principles plus
your own best-practices docs, which you can drop in as plain markdown.

Set combinations of models and reasoning effort, save them as review levels
(`quick`, `low`, `medium`, `high`, whatever), and pick the depth each review deserves.
Findings arrive in a report called a dossier, every bug claim carries a verdict
(confirmed / plausible / refuted) to help steer your review.

Built on the Pi Agent SDK. Works out of the box with all models, And special care was
taken to make sure it caches well with OpenAI, Deepseek and other popular providers.

## How it works

1. **Finders** read your diff through independent lenses (correctness,
   security, concurrency, your own standards, …) and over-generate candidates.
2. **Verifiers** and **Judges** adversarially review every bug claim against your
   codebase — surviving results are ranked by likelihood to cause issues, P1–P3.
3. You get a markdown **dossier** locally, and optionally posted straight to
   the PR as a single comment.

Reviews can be targeted at a PR, a series of commits, or your current working branch. 

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/JRGiardiniere/gauntlet/main/install.sh | sh
```

The installer puts the binary in `~/.local/bin`, installs the Gauntlet agent
skill in `~/.agents/skills/gauntlet`, and links that skill into
`~/.claude/skills/gauntlet`.

Then:

```sh
gauntlet config init     # seeds ~/.gauntlet with recipes + the 13 shipped lenses
gauntlet review --pr 42  # or --commits main, or --working-tree
```

`gauntlet --help` is the full flag reference. To customize:

- **Recipes** — one JSON file each in `~/.gauntlet/recipes/`; copy one, edit
  the `provider/model:effort` seats, done.
- **Lenses** — drop markdown files in `.gauntlet/lenses/` for project-local
  review standards; `--lenses a,b` selects exactly those for one run.
- **Agent skill** — the installer keeps the shared skill in
  `~/.agents/skills/gauntlet` so coding agents can run reviews from any repo.

## Also available as a Claude Code workflow

The same pipeline runs as a Claude Code workflow, for anyone who wants to try
Gauntlet's lenses and stages without the CLI, Pi, or a provider account. The
finder system prompt, shared block, pool, verifier, judge, and all 13 shipped
lenses are embedded verbatim, along with the pipeline constants, so the two
surfaces review with the same lens text and the same caps.

```sh
cp .claude/workflows/gauntlet.js ~/.claude/workflows/   # or run it from this checkout
```

Then in a Claude Code session in the repository you want reviewed:

```
run the gauntlet workflow                       # working tree vs HEAD
run the gauntlet workflow with args "42"        # PR #42 (GitHub closing issues become the spec)
run the gauntlet workflow with args "main..HEAD --lenses=diff-scan,security --model=opus --effort=high"
```

It returns the dossier as markdown and JSON. What differs from the CLI:
subagents see the real checkout instead of a confined workspace, seats are
Claude Code model/effort pairs, specification comes from GitHub only, there is
no run directory or resume, and only the 13 embedded lenses exist — project
`.gauntlet/lenses/` and the `default-lenses` setting are not read, so
`--lenses=` is the one way to narrow a run. The target goes before the first
`--name=` flag; `--spec=` runs to the next such flag or the end of the string,
so it may carry prose, a bare `--word` included. `.claude/workflows/gauntlet.js` is generated —
edit `workflow/gauntlet.body.js` or the content files, then run
`bun run build-workflow`.
