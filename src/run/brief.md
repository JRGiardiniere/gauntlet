Write a brief for Gauntlet finding {{FINDING_ID}} ({{LOCATION}}) in run {{RUN_ID}}.

Every Run writes `dossier.html` beside `dossier.md`: each finding an exhibit
with its claim beside the reviewed code. A brief is your explanation of one
finding, drawn on its exhibit — written for John, who has the claim in front
of him and wants to see the mechanism and the fix. The Dossier already holds
the what and the why; your work is to show them.

The Run reviewed {{REPO_ROOT}} at commit {{HEAD_COMMIT}}. If the checkout
has moved on since, `git show {{HEAD_COMMIT}}:<file>` reads a file as it was.

1. Read the finding's entry in `{{RUN_DIRECTORY}}/dossier.json`: the one in
   `findings` or `unresolved` whose `candidate.id`, or one of whose
   `bugClaims[].id`, is {{FINDING_ID}}. It holds the summary, Judgment's
   reason or Verification's evidence, the failure scenario. Explain that
   reasoning; when the code says otherwise, say so in one line. A Plausible
   claim was never settled: show what input or test would settle it.
2. Read the code it cites, enough to see the shape it describes.
3. Write `{{BRIEF_PATH}}`, creating its directory: a `# ` heading with the
   one-line takeaway (what to do), a few short paragraphs, and for each point
   the smallest view that makes it:
   - ` ```sketch ` — a call tree, file tree or pseudocode; lines starting
     `+` or `-` read as a change to it, so one sketch shows before and after.
   - ` ```code <file>:<from>-<to> [@<commit>] [mark=<lines>] ` with an empty
     body — the page reads the lines. Without `@` they are the reviewed
     lines; `@<commit>` shows another commit's, such as the code before the
     change. `mark=250,254` pins those lines.
   - ` ```ts ` (any language) — an illustration, such as the fix's shape.
   Content only: the page owns layout, and raw HTML shows as text.
4. Read the prose back as plain speech and rewrite each sentence that fails:
   - It names the mechanism: the function, the line, the value, the count.
     A sentence that would read the same in another project's review says
     nothing about this one; cut it.
   - It carries one idea, with a subject and a verb. Spell out arrows and
     abbreviations.
   - It names the actor: "`startClock` sets `drawn`", not "`drawn` is set".
   - It uses the concrete word: "add" over "wedge in", "base" over
     "substrate", "way" over "vector", "use" over "leverage".
   - It is the claim alone, with no lead-in ("it is worth noting that") and
     one hedge at most. An unsettled claim says so once, with what would
     settle it.
5. Run `gauntlet page {{RUN_ID}}`. Done when it prints the page's path and no
   `gauntlet: briefs/…` lines; each such line names a block to fix.
