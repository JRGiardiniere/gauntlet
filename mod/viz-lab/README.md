# viz-lab

Prototype views for gc-cli's run visualization. They replay one real review
(`fixture.json`, from PR #641's run), so trying a view spends no tokens.

    sh mod/viz-lab/build.sh                        # after editing viz.ts
    claude --plugin-dir mod/viz-lab/gc-viz
    /viz <run|side|band|findings|timeline|card|off> [seconds | play [speed]]

- `run`: today's run pane. `side`: the docked sidebar (fullscreen layout, 110+
  columns). `band`: two rows above the prompt. `findings`: browser with 1–9,
  `f` to fill a fix prompt, `r` for the HTML report. `timeline`: Raster on the
  terminal, Svg elsewhere. `card`: the command's transcript row.
- `/viz side 90` freezes at 90s; `/viz side play 4` replays at 4×.
- `make-fixture.py <run-dir>` makes a new fixture; `report-cli.ts` writes the
  HTML report outside Claude Code.

Prototype code: lint and the mod typecheck skip this folder.
