---
name: Gauntlet Dossier
description: The Case File, one Run's adjudicated findings filed as exhibits in a kraft folder.
colors:
  p1: "#d93b40"
  p2: "#e57a00"
  p3: "#b98f00"
  p1-dark: "#e5484d"
  p2-dark: "#ff8700"
  p3-dark: "#e0b000"
  gauntlet-mark: "#d7875f"
  gauntlet-mark-dark: "#e89a72"
  desk: "#e6e0d3"
  kraft: "#c9a56b"
  kraft-fold: "#b48f55"
  kraft-ink: "#2e2412"
  kraft-ink-soft: "#5b4728"
  bond: "#f8f6f0"
  bond-under: "#f1ede3"
  rule: "#ddd5c4"
  rule-strong: "#c9bfab"
  ink-1: "#1c1b18"
  ink-2: "#47433b"
  ink-3: "#6b6559"
  added-band: "#ebe6d9"
  removed-band: "#f3f0e8"
  desk-dark: "#121110"
  kraft-dark: "#4a3920"
  kraft-fold-dark: "#5e4829"
  kraft-ink-dark: "#f1dfbd"
  kraft-ink-soft-dark: "#c9b089"
  bond-dark: "#1c1b19"
  bond-under-dark: "#232220"
  rule-dark: "#34312c"
  rule-strong-dark: "#47433b"
  ink-1-dark: "#ece8df"
  ink-2-dark: "#c3bcae"
  ink-3-dark: "#958e80"
  added-band-dark: "#34312c"
  removed-band-dark: "#1f1e1b"
typography:
  display:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "clamp(34px, 4.6vw, 58px)"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 68"
  headline:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "clamp(22px, 2.3vw, 30px)"
    fontWeight: 750
    lineHeight: 1.18
    letterSpacing: "-0.005em"
    fontVariation: "'wdth' 80"
  title:
    fontFamily: "Archivo, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "19px"
    fontWeight: 620
    lineHeight: 1.45
    letterSpacing: "-0.005em"
  body:
    fontFamily: "Archivo, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 700
    letterSpacing: "0.07em"
    fontVariation: "'wdth' 72"
  stamp:
    fontFamily: "Archivo, Arial Narrow, system-ui, sans-serif"
    fontSize: "25px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.14em"
    fontVariation: "'wdth' 72"
  code:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.6
    fontFeature: "'liga' 0, 'calt' 0"
rounded:
  sheet: "2px"
  control: "3px"
  stamp: "4px"
  tab: "0 6px 6px 0"
  tag: "3px 12px 12px 3px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "22px"
  xl: "40px"
  gutter-mobile: "16px"
components:
  stamp-p1:
    textColor: "{colors.p1}"
    typography: "{typography.stamp}"
    rounded: "{rounded.stamp}"
    padding: "5px 12px"
  stamp-p2:
    textColor: "{colors.p2}"
    rounded: "{rounded.stamp}"
    padding: "5px 12px"
  stamp-p3:
    textColor: "{colors.p3}"
    rounded: "{rounded.stamp}"
    padding: "5px 12px"
  exhibit-tag:
    backgroundColor: "{colors.bond}"
    textColor: "{colors.ink-1}"
    typography: "{typography.label}"
    rounded: "{rounded.tag}"
    padding: "3px 10px 3px 7px"
  action:
    backgroundColor: "{colors.bond}"
    textColor: "{colors.ink-1}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
  spine-tab:
    backgroundColor: "{colors.kraft-fold}"
    textColor: "{colors.kraft-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.tab}"
    padding: "6px 14px 5px 18px"
  view-switch-on:
    backgroundColor: "{colors.kraft-ink}"
    textColor: "{colors.kraft}"
    rounded: "{rounded.control}"
    padding: "6px 4px"
  exhibit-sheet:
    backgroundColor: "{colors.bond}"
    textColor: "{colors.ink-1}"
    rounded: "{rounded.sheet}"
    padding: "20px 22px 22px"
  evidence-frame:
    backgroundColor: "{colors.bond}"
    textColor: "{colors.ink-1}"
    typography: "{typography.code}"
    rounded: "{rounded.control}"
  brief-sheet:
    backgroundColor: "{colors.bond-under}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.sheet}"
    padding: "16px 20px 20px"
---

# Design System: Gauntlet Dossier

## Overview

**Creative North Star: "The Case File"**

Every finding on this page has already stood before a tribunal: Verification tried to refute it, or Judgment decided to keep it. The page is the file that hearing left behind. A kraft folder with a tabbed spine holds a ruled index sheet and a run of bond-paper exhibit sheets, each carrying its claim on the left and its evidence clipped on the right. Adjudication is a rubber stamp, review is a stamp you press yourself, and what the tribunal threw out hangs in a set-aside sleeve at the back.

The world is dense and quiet. One warm, ruled neutral ramp carries everything; type does the hierarchy work in a single variable grotesk, condensed for anything that reads as a printed form field and set at normal width for prose. Colour is never decoration and never syntax: it appears only as the ink a priority was stamped in. The page refuses the dashboard-plus-card-feed and the GitHub diff clone; it is a file you read, not a console you monitor.

It is one offline HTML file per Run, deterministic from `dossier.json` and git, with an optional agent-authored brief clipped to Judgment-path exhibits. Both are drawn by the same renderer from the same typed blocks.

**Key Characteristics:**
- Kraft spine, bond sheets, desk underneath: three paper layers, no other surfaces.
- One variable grotesk (Archivo) at two widths, plus mono only for code.
- Colour is adjudication ink only: P1, P2, P3 and the Gauntlet mark.
- Priority reads three ways at once: stamp size, the P-label, and ink.
- Every exhibit's tag pins to its cited line by a dashed leader rule.
- One authored motion: the reviewed stamp pressing onto the sheet.

## Colors

A warm paper-and-carbon ramp with three priority inks pressed onto it, and nothing else.

### Primary
- **Verdict Red** (P1): the ink of a P1 stamp, its spine chip, its docket count, its pinned line. Light theme uses the shifted value; dark theme uses the strip's exact `#e5484d` (`p1-dark`).
- **Verdict Orange** (P2): the same roles at P2. Dark theme uses the strip's exact `#ff8700`.
- **Verdict Ochre** (P3): the same roles at P3. Dark theme uses the strip's exact `#e0b000`.

### Secondary
- **Gauntlet Copper** (`gauntlet-mark`): the ◆ in the spine's wordmark and the tape flag marking where you stopped. Lifted to `gauntlet-mark-dark` on dark paper. It is the product's signature, never a state.

### Neutral
- **Desk** (`desk`): the surface the folder lies on; the page background around the sheets.
- **Kraft** / **Kraft Fold** (`kraft`, `kraft-fold`): the spine and its tabs. Kraft Fold is the tab body and the spine's edge rule.
- **Kraft Ink** / **Kraft Ink Soft** (`kraft-ink`, `kraft-ink-soft`): text on kraft; the soft step for exhibit numbers and the reviewed count.
- **Bond** / **Bond Under** (`bond`, `bond-under`): exhibit and index sheets; Bond Under is the evidence header strip, inline code chips, the brief sheet and the set-aside sleeve.
- **Rule** / **Rule Strong** (`rule`, `rule-strong`): form-field rules, evidence borders, the double rule under an exhibit head.
- **Ink 1 / 2 / 3** (`ink-1`, `ink-2`, `ink-3`): carbon for claims and values, the softer body of findings and briefs, and labels, line numbers and comments. Ink 3 is also the ink of an unranked stamp and of every set-aside stamp.
- **Added Band** / **Removed Band** (`added-band`, `removed-band`): neutral tints behind diff rows. Not green, not red.

Every neutral has a `-dark` twin. Dark mode follows `prefers-color-scheme` unless `data-theme="light"` is set, and `data-theme="dark"` forces it.

### Named Rules
**The Adjudication Ink Rule.** Hue appears only where a tribunal ruled: the stamp, the spine's P-chip, the docket count, the cited-line mark and its pin, and the accent strokes of a diagram drawn inside that exhibit. Each exhibit sets one `--ink` from its priority and everything inside it draws from that one variable. If a colour is not a priority's ink or the Gauntlet mark, it is a neutral from the ramp.

**The Hue-Free Evidence Rule.** Syntax highlighting and diff bands carry no hue. Keywords are carbon at weight 650, types at 550, strings a step softer, comments Ink 3 in italic. An added row is a neutral band with a bold `+`; a removed row is a paler band with struck-through Ink 3 text. Green and red would compete with priority, and priority wins.

**The Bond-Paper Ink Rule.** The dark theme uses the Mod strip's priority inks exactly. On light bond paper the inks shift darker (`#d93b40`, `#e57a00`, `#b98f00`) because the strip's values wash out on paper: P1 rises from 3.62:1 to 4.18:1 against Bond, P2 from 2.23:1 to 2.73:1, P3 from 1.87:1 to 2.78:1. That gain is real but P2 and P3 still sit under 3:1, so priority must never rest on hue alone: the stamp size ramp and the printed `P2`/`P3` label carry it too.

## Typography

**Display Font:** Archivo at 68–80% width (fallback Arial Narrow, system-ui)
**Body Font:** Archivo at 100% width (fallback system-ui, -apple-system, Segoe UI)
**Label/Mono Font:** Archivo at 72% width for form labels; ui-monospace (SF Mono, Menlo, Consolas) for code, paths and line numbers

**Character:** One variable grotesk plays both the printed form and the typed entry. Condensed and uppercase, it is the form-header: field labels, spine tabs, exhibit tags, stamps, action buttons. At full width it is the workhorse prose a reviewer reads. Mono appears only where the content is code.

Archivo loads from Google Fonts with its `wdth` and `wght` axes (`wdth 62..125`, `wght 400..800`); offline, the condensed roles fall back to Arial Narrow and the text roles to the system face.

### Hierarchy
- **Display** (800, clamp(34px, 4.6vw, 58px), 0.95, uppercase, 68% width): the subject on the index sheet. The commit range sits beside it in mono at 100% width.
- **Headline** (750, clamp(22px, 2.3vw, 30px), 1.18, 80% width, max 34ch, balanced): a brief's one-line takeaway.
- **Title** (620, 19px, 1.45; 17.5px under 820px): an exhibit's lead sentence, the claim's first line, set heavier than the body so the claim reads before the argument.
- **Body** (400, 16px, 1.6): prose, finding fields at 15px in Ink 2, brief prose capped at 72ch, claim column capped at 68ch.
- **Label** (700–800, 11.5–15px, 0.07em, uppercase, 72% width): field labels, evidence kinds, section heads, spine tabs, actions, tags.
- **Stamp** (800, 0.14em, uppercase, 72% width): the verdict word, sized by priority (see Components).
- **Code** (400, 12.5px, 1.6, ligatures off): evidence rows, line numbers in tabular figures.

### Named Rules
**The Form-Field Rule.** Anything that names a field, files an exhibit or rules on it is condensed uppercase. Anything that argues is full-width sentence case. Never set prose condensed or labels at full width.

**The Tabular Count Rule.** Every count (docket, spine tabs, cost, invocations, reviewed progress, line numbers) uses tabular figures.

## Layout

A two-column folder: a sticky 232px kraft spine at full viewport height on the left, the file on the right with `clamp(16px, 3vw, 44px)` side padding and a 1500px cap. The index sheet runs across the top on a six-column field grid (24px column gap), fields spanning 1, 2, 3, 4 or 6 columns, each a label over a value with a rule under it. Below it, exhibits stack 12px apart; section heads open 40px above.

Inside an exhibit the head runs tag, location, lenses, then the stamp pushed right, closed by a double rule. The body is a 5:7 grid, claim left (min 300px) and evidence right, 30px apart.

- **Under 1180px** the claim and evidence stack, evidence 16px below.
- **Under 820px** the spine becomes a sticky horizontal strip across the top (view switch and P-tabs only, scrolling sideways); the exhibit index and progress are dropped. The file takes a 16px gutter, the index grid drops to three columns with the tribunal, lenses and notes folded behind a disclosure, and the docket becomes a five-column row of stacked counts. Scroll padding grows to 72px so a jumped-to exhibit clears the strip.

Spacing runs on a loose 4 / 8 / 14 / 22 / 40 rhythm: 22px is the sheet inset, 14px the gap inside evidence stacks, 40px between sections.

## Elevation & Depth

Depth is paper stacked on a desk, nothing more. Sheets lift off the desk with one soft two-part shadow; the spine is a fold with an inset shade on its inner edge. There is no hover lift, no floating card, no glass.

### Shadow Vocabulary
- **Sheet** (`box-shadow: 0 1px 2px rgba(40,30,10,.10), 0 6px 18px -6px rgba(40,30,10,.18)`; dark `0 1px 2px rgba(0,0,0,.4), 0 8px 22px -8px rgba(0,0,0,.6)`): every index sheet, exhibit and sleeve.
- **Spine fold** (`box-shadow: inset -8px 0 14px -10px rgba(0,0,0,.25)`): the kraft spine's inner edge. Under 820px it becomes `0 4px 10px -6px rgba(0,0,0,.3)` beneath the top strip.
- **Current exhibit** (the sheet shadow plus `0 0 0 1.5px` of the exhibit's ink at 50%): the exhibit you jumped to or walked to with j/k.

### Named Rules
**The Paper-Only Rule.** Three surfaces exist: desk, kraft, bond. A new surface is one of those or a Bond Under inset inside a sheet.

## Shapes

Paper corners are nearly square (2px on sheets, 3px on controls, evidence frames and code chips). Two silhouettes break the square on purpose: spine tabs are cut flat against the spine and rounded on their free edge (0 6px 6px 0), and an exhibit tag is a luggage tag, square on its punched end and rounded on the other (3px 12px 12px 3px) with a 7px punched hole. Stamps are rectangles with a 3px double border and a 4px corner, rotated −2.5°; the reviewed stamp counter-rotates to +2.5° so the two read as separate hands. Spine P-chips are 9px squares tilted −6°. Rules are the line language: a 2px carbon rule under the index title, a 3px double rule under every exhibit head, 1px rules under form fields, and a dashed leader line from a cited line to its pin.

## Components

### Adjudication stamp (signature)
The tribunal's ruling, pressed in priority ink.
- **Shape:** 3px double border, 4px corner, rotated −2.5°, `mix-blend-mode: multiply` on light paper and `screen` on dark so it reads as ink, not a sticker.
- **Words:** CONFIRMED or PLAUSIBLE (by Verification), KEPT or UNDECIDED (by Judgment), REFUTED or DROPPED in the sleeve. A second line names the ruling stage and the priority (`JUDGMENT · P2`) at 11px.
- **Size ramp:** the verdict word is 25px at P1, 20px at P2, 16px at P3, 14px unranked. Fixed three steps plus the unranked floor; no other sizes.
- **States:** Plausible and Undecided drop to a 2px dashed border; Refuted and Dropped take Ink 3. In the sleeve the stamp shrinks to 82% from its left edge.

### Reviewed stamp
Your own mark, not the tribunal's.
- **Style:** check icon plus REVIEWED, 2px solid Ink 2 border, 3px corner, rotated +2.5°. Hidden until the exhibit is reviewed.
- **Motion:** the only authored animation. Pressing `x` or Stamp reviewed lands it from 1.5× scale, transparent and 2px blurred to rest in 0.32s on `cubic-bezier(.16,1,.3,1)`. Unreviewing removes it without motion. Under `prefers-reduced-motion` it appears instantly.

### Exhibit tag and pin
- **Tag:** luggage-tag shape, 1px Ink 2 border, Bond fill, punched hole, condensed uppercase `EXHIBIT E-01` (or `BRIEF · E-01`).
- **Pin:** the cited line gets a band of its exhibit's ink at 16% over Bond and a 3px inset ink bar on its left edge; a dashed leader runs to a sticky pin (`E-01`, Bond text on solid ink, 2px corner) held 8px from the frame's right edge as the code scrolls.

### Evidence frame
Every typed block that shows code or structure sits in one frame: 1px Rule border, 3px corner, a Bond Under header strip with the block kind in condensed label type (CHANGE, SOURCE, DIAGRAM), the file in mono and the revision pushed right, and an optional caption under a rule. Code scrolls sideways inside the frame; line numbers are Ink 3 at 75%. Folded diff context reads as an italic text-face line ("4 more lines in this hunk").

### Diagram
Inline SVG drawn by the renderer from nodes and edges, never supplied as markup. Nodes are Bond rectangles with an Ink 2 stroke and a mono label; an accent node takes the exhibit's ink with a 2px stroke and a 9% ink fill; a state node is dashed; a muted node drops to Rule Strong. Edges have three kinds, legended in the frame header: calls (solid Ink 3), writes (dashed, exhibit ink), reads (dotted Ink 2).

### Actions
- **Shape:** 3px corner, 1px Rule Strong border on Bond, condensed uppercase 12.5px label with a 14px stroke icon at 1.6 weight and an optional key hint.
- **Hover / Active:** border darkens to Ink 2; press nudges down 1px. Focus is a 2px Ink 1 outline at 2px offset everywhere.
- **Set:** Stamp reviewed (`x`), Copy location, and one of Read the brief / Ask for a brief / Explain. Copy actions swap their label for 1.4s on success.

### Spine
- **Tabs:** one per section (P1, P2, P3, Unranked when present, Unresolved, Set aside) with a tilted ink chip for P-tabs and a tabular count; an empty tab fades to 55%.
- **Index rows:** exhibit number and file:line in mono 11.5px; a paperclip when a brief is attached, a check when reviewed, the copper flag where you stopped. The row in view is shaded with Kraft Ink at 14%, hover at 8%.
- **View switch:** a two-segment radio, All exhibits / Needs thought, the selected segment inverted to Kraft Ink on Kraft.

### Brief
An agent-authored sheet clipped inside its exhibit: Bond Under fill, 1px Rule Strong border, a paperclip icon hanging over its top edge, a `BRIEF · E-01` tag, the takeaway in Headline type, then the agent's blocks.

### Before-after switch
A two-segment tab control, BEFORE and AFTER each with a mono revision label; the selected side inverts to Bond on Ink 1. Each side holds its own blocks.

### Set-aside sleeve
A `details` sheet in Bond Under at the end of the file, closed by default, with a chevron that turns 90° in 0.2s. Rows show a small stamp, the location, the claim and Judgment's or Verification's reason.

### The typed-block vocabulary
The authoring contract for anything an agent writes: `markdown` (paragraphs, lists, inline code, strong, em), `code` (file, revision, line range, marked lines, caption), `diff` (file and optional line, read from git), `snippet` (literal source when no file applies), `diagram` (nodes with optional tone and note, edges with kind and label), and `before-after` (two labelled block lists). Agents supply content and source references; the renderer reads the code from git and draws every pixel. No block accepts markup, colour or layout.

## Do's and Don'ts

### Do:
- **Do** set one `--ink` per exhibit from its priority and draw every hued element inside it from that variable.
- **Do** size stamps only on the ramp: 25px P1, 20px P2, 16px P3, 14px unranked.
- **Do** keep evidence hue-free: weight, italic, Ink 3, neutral bands and strike-through carry syntax and diff meaning.
- **Do** use the strip's exact inks (`#e5484d`, `#ff8700`, `#e0b000`) on dark paper and the shifted bond-paper inks (`#d93b40`, `#e57a00`, `#b98f00`) on light.
- **Do** set field labels, tabs, tags, stamps and actions condensed uppercase, and prose at full width in sentence case.
- **Do** add new agent-authored content as one of the six typed blocks.
- **Do** keep motion to the reviewed-stamp press and the sleeve chevron, and honour `prefers-reduced-motion`.

### Don't:
- **Don't** colour syntax tokens or diff rows; no green additions, no red deletions.
- **Don't** introduce a colour that is not a priority ink, the Gauntlet mark or a ramp neutral.
- **Don't** let an agent supply HTML, CSS, colour or layout; it supplies blocks.
- **Don't** let priority rest on hue alone; every inked element also carries its P-label or its place on the size ramp.
- **Don't** add a surface beyond desk, kraft, bond and a Bond Under inset, and don't lift sheets on hover.
- **Don't** stamp anything decorative; a stamp, flag or clip always marks a state.
