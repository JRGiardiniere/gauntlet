# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
John alone, the author of Gauntlet and of the code it reviews. He reads a Dossier
right after a review finishes: opened from the Mod's strip in Claude Code
(desktop or terminal) or from the CLI, in a browser or the desktop app's pane,
occasionally on his phone through a private Artifact link. Not routinely shared
with coworkers or pull-request reviewers.

## Product Purpose
Gauntlet is a personal, provider-neutral code-review pipeline: Finders read a
diff through independent Lenses, Verification tries to refute every BugClaim,
Judgment keeps or drops every Observation, and the surviving findings are
ranked P1–P3 into a Dossier. The Dossier page is the HTML reading of that
result. Success: in a few minutes John knows what to fix now, what to argue
with, and what to skip, and can hand a finding to his coding agent.

## Positioning
Every finding on the page has already survived an adversarial pass: a
Confirmed BugClaim carries a checked failure scenario, a kept Observation
carries Judgment's reason. The page presents adjudicated findings with their
evidence, not raw lint output.

## Operating Context
- Written per Run into the run directory beside `dossier.md` (canonical,
  kept form) and `dossier.json` (the structured Dossier). The markdown stays
  the base form; the page is a reading of it.
- Two views from one renderer over typed blocks (markdown, code, diff,
  diagram, before-after), after cloudflare-hub's PR Tour ADR-0024:
  - the default view, deterministic from dossier.json plus git, every finding;
  - an optional Judgment view, agent-authored on request, for the findings
    that need thought: kept Observations and Plausible BugClaims.
- Typical run: 0–20 findings; about half are Judgment-path.

## Capabilities and Constraints
- One self-contained HTML file per run; works offline from `file://`.
  Optional Google Fonts only. Diagrams render with no CDN (inline SVG from
  the renderer, or a library bundled with the Mod).
- Actions are light: move between findings, mark one reviewed, copy its
  location, hand it to the agent (Explain). No editing.
- Domain terms in CONTEXT.md are binding: Dossier, Finding, BugClaim,
  Observation, Verification, Judgment (never "decision"), Review Priority,
  Lens, Coverage Gap, Confirmed / Plausible / Refuted, kept / dropped /
  undecided.

## Brand Commitments
- Review Priority colours from the Mod's strip: P1 #e5484d, P2 #ff8700,
  P3 #e0b000, unranked #8b8b8b, clean #30a46c.
- The "◆ Gauntlet" mark in #d7875f.

## Evidence on Hand
Real run: `~/.gauntlet/runs/2026-10-10T03-05-46-670Z-167e/` (14 findings,
4 unresolved, 2 refuted, 6 dropped; commits a2a3797..a1acde9 of the gauntlet
repo). Prior art: the card-feed prototype in this folder (anti-reference) and
the agent-authored explainer in `../explainer/index.html`.

## Product Principles
1. The claim and its proof read as one unit.
2. Priority orders attention; nothing else competes with it.
3. Deterministic first: the default view costs no model tokens.
4. Agents supply content, never layout.
5. Personal tool: no speculative safeguards or dashboard chrome.
