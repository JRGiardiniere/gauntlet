// ../run-pane.ts
var rowOf = (invocationId) => {
  const finder = /-finder-([^/]+)$/.exec(invocationId)?.[1];
  if (finder !== undefined)
    return { stage: "Finders", name: finder };
  if (invocationId.endsWith("-pool"))
    return { stage: "Pool", name: "Pool" };
  const bundle = /-verification-(\d+)$/.exec(invocationId)?.[1];
  if (bundle !== undefined)
    return { stage: "Verification", name: `bundle ${bundle}` };
  if (invocationId.endsWith("-judgment"))
    return { stage: "Judgment", name: "Judgment" };
  return;
};
var paneRows = (view) => {
  const rows = view.lenses.map((lens) => ({ stage: "Finders", name: lens, activity: undefined }));
  for (const activity of view.activity) {
    const row = rowOf(activity.invocationId);
    if (row === undefined)
      continue;
    const at = rows.findIndex((each) => each.stage === row.stage && each.name === row.name);
    if (at === -1)
      rows.push({ ...row, activity });
    else
      rows[at] = { ...row, activity };
  }
  const order = ["Finders", "Pool", "Verification", "Judgment"];
  return order.flatMap((stage) => rows.filter((row) => row.stage === stage));
};
var clock = (millis) => {
  const seconds = Math.max(0, Math.round(millis / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
};
var kilo = (count) => count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1000 ? `${String(Math.round(count / 1000))}K` : String(count);
var tokenText = (tokens) => {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  if (prompt === 0)
    return "";
  return `${kilo(prompt)} in (${String(Math.round(tokens.cacheRead / prompt * 100))}% cached) · ${kilo(tokens.output)} out`;
};
var sum = (activity) => activity.reduce((total, each) => ({
  input: total.input + each.tokens.input,
  output: total.output + each.tokens.output,
  cacheRead: total.cacheRead + each.tokens.cacheRead,
  cacheWrite: total.cacheWrite + each.tokens.cacheWrite
}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
var itemNoun = { Finders: "found", Pool: "clusters", Verification: "verdicts", Judgment: "decisions" };
var lookOf = (row, view, now) => {
  const activity = row.activity;
  if (activity === undefined) {
    return view.findersFinished || view.endedAt !== undefined ? { mark: "–", color: undefined, detail: "not run", time: "" } : { mark: "○", color: undefined, detail: "not started", time: "" };
  }
  const since = activity.spawnedAt;
  const took = since === undefined ? "" : clock((activity.endedAt ?? view.endedAt ?? now) - since);
  const calls = activity.toolCalls === 0 ? "" : ` · ${String(activity.toolCalls)} calls`;
  switch (activity.state) {
    case "opening":
      return { mark: "○", color: undefined, detail: "starting", time: "" };
    case "waiting":
      return { mark: "○", color: "yellow", detail: "waiting for an agent slot", time: "" };
    case "running":
      return {
        mark: "●",
        color: "cyan",
        detail: `${activity.lastTool ?? (activity.turns > 0 ? "correcting its emit" : "reading the diff")}${calls}`,
        time: took
      };
    case "answered":
      return {
        mark: "✓",
        color: "green",
        detail: [activity.items === undefined ? "no emit" : `${String(activity.items)} ${itemNoun[row.stage]}`, tokenText(activity.tokens)].filter((part) => part !== "").join(" · "),
        time: took
      };
    case "failed":
      return { mark: "✗", color: "red", detail: `failed${calls}`, time: took };
    case "stopped":
      return { mark: "■", color: "yellow", detail: `stopped${calls}`, time: took };
  }
};
var renderRunPane = (view, el, width, now, actions) => {
  const Box = (props) => el.Box(props);
  const Text = (props) => el.Text(props);
  const Button = (props) => el.Button(props);
  if (view === undefined) {
    return Box({
      flexDirection: "row",
      width,
      children: [
        Box({ flexGrow: 1, children: [Text({ dimColor: true, children: "No review in this session yet. Run /gc-cli [target]." })] }),
        Button({ key: "close", label: "Close", hotkey: "c", onPress: actions.close })
      ]
    });
  }
  const rows = paneRows(view);
  const live = view.activity.filter((each) => each.state === "running").length;
  const target = view.argv.slice(1).filter((word) => !word.startsWith("--related-files")).join(" ");
  const status = view.exitCode === undefined ? `running · ${String(live)} live` : view.exitCode === 0 ? "finished" : `ended (exit ${String(view.exitCode)})`;
  const header = [target, view.runId?.replace(/^.*-/, "run ") ?? "", clock((view.endedAt ?? now) - view.startedAt), status].filter((part) => part !== "").join(" · ");
  const lines = [];
  const headings = [];
  for (const stage of ["Finders", "Pool", "Verification", "Judgment"]) {
    const inStage = rows.filter((row) => row.stage === stage);
    const looks = inStage.map((row) => ({ row, look: lookOf(row, view, now) }));
    if (looks.length === 1) {
      const [{ look, row }] = looks;
      lines.push({ key: stage, name: stage === "Finders" ? row.name : stage, look });
      continue;
    }
    if (looks.length === 0)
      continue;
    const ran = inStage.flatMap((row) => row.activity === undefined ? [] : [row.activity]);
    const done = ran.filter((activity) => activity.state === "answered").length;
    const count = `${stage} ${String(done)}/${String(inStage.length)}`;
    if (looks.every(({ look }) => look.mark !== "●" && look.mark !== "○")) {
      const failed = looks.some(({ look }) => look.mark === "✗");
      const stopped = looks.some(({ look }) => look.mark === "■");
      const items = ran.reduce((total, activity) => total + (activity.items ?? 0), 0);
      const starts = ran.flatMap((activity) => activity.spawnedAt === undefined ? [] : [activity.spawnedAt]);
      const ends = ran.flatMap((activity) => activity.endedAt === undefined ? [] : [activity.endedAt]);
      const notRun = inStage.length - ran.length;
      lines.push({
        key: stage,
        name: stage,
        look: {
          mark: failed ? "✗" : stopped ? "■" : "✓",
          color: failed ? "red" : stopped ? "yellow" : "green",
          detail: [
            `${String(ran.length)} ran`,
            notRun === 0 ? "" : `${String(notRun)} not run`,
            `${String(items)} ${itemNoun[stage]}`,
            tokenText(sum(ran))
          ].filter((part) => part !== "").join(" · "),
          time: starts.length === 0 || ends.length === 0 ? "" : clock(Math.max(...ends) - Math.min(...starts))
        }
      });
      continue;
    }
    headings.push({ before: lines.length, text: count });
    for (const { look, row } of looks)
      lines.push({ key: `${stage}-${row.name}`, name: row.name, look });
  }
  const nameWidth = Math.min(26, Math.max(12, ...lines.map((line) => line.name.length + 1)));
  const children = [
    Box({
      flexDirection: "row",
      width,
      children: [
        Box({ flexGrow: 1, flexShrink: 1, children: [Text({ bold: true, wrap: "truncate-end", children: header })] }),
        view.exitCode === undefined ? Button({ key: "stop", label: "Stop review", hotkey: "s", onPress: actions.stop }) : Button({ key: "close", label: "Close", hotkey: "c", onPress: actions.close })
      ]
    })
  ];
  lines.forEach((line, at) => {
    for (const heading of headings) {
      if (heading.before === at)
        children.push(Text({ bold: true, children: heading.text }));
    }
    const { look } = line;
    children.push(Box({
      key: line.key,
      flexDirection: "row",
      width,
      children: [
        Box({ width: 2, flexShrink: 0, children: [Text(look.color === undefined ? { dimColor: true, children: look.mark } : { color: look.color, children: look.mark })] }),
        Box({ width: nameWidth, flexShrink: 0, children: [Text({ wrap: "truncate-end", children: line.name })] }),
        Box({ flexGrow: 1, flexShrink: 1, children: [Text({ dimColor: look.mark !== "●", wrap: "truncate-end", children: look.detail })] }),
        Box({ width: 7, flexShrink: 0, justifyContent: "flex-end", children: [Text({ dimColor: true, children: look.time })] })
      ]
    }));
  });
  const tokens = tokenText(sum(view.activity));
  if (tokens !== "")
    children.push(Text({ dimColor: true, wrap: "truncate-end", children: `Tokens: ${tokens}` }));
  if (view.latest !== undefined) {
    const latest = view.latest.replace(/^gauntlet: /, "").replace(/ · \$[\d.]+/g, "");
    children.push(Text({ dimColor: true, wrap: "truncate-end", children: latest }));
  }
  return Box({ flexDirection: "column", children });
};

// viz.ts
var BASE = 1e6;
var viewAt = (fx, t) => {
  const activity = fx.invocations.filter((each) => each.spawnedAt <= t).map((each) => {
    const done = t >= each.endedAt;
    const tools = each.tools.filter((tool) => tool.at <= t);
    return {
      id: `agent-${each.invocationId}`,
      invocationId: each.invocationId,
      state: done ? "answered" : "running",
      spawnedAt: BASE + each.spawnedAt,
      ...done ? { endedAt: BASE + each.endedAt, items: each.items } : {},
      turns: done ? 1 : 0,
      toolCalls: done ? each.toolCalls : tools.length,
      ...tools.length > 0 && !done ? { lastTool: tools[tools.length - 1].tool } : {},
      tokens: done ? each.tokens : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
  });
  const lines = fx.progress.filter((each) => each.at <= t);
  const latest = [...lines].reverse().find((each) => !/^gauntlet: (invoking|loading|run \S+ executing$)/.test(each.line));
  const ended = t >= fx.endedAt;
  return {
    argv: fx.argv,
    runId: fx.runId,
    startedAt: BASE,
    endedAt: ended ? BASE + fx.endedAt : undefined,
    lenses: fx.lenses,
    findersFinished: lines.some((each) => each.line.startsWith("gauntlet: Finders finished")),
    activity,
    latest: ended ? `Result: ${fx.result}` : latest?.line,
    exitCode: ended ? 0 : undefined
  };
};
var nowAt = (t) => BASE + t;
var clock2 = (millis) => {
  const seconds = Math.max(0, Math.round(millis / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
};
var noDollars = (line) => line.replace(/ · \$[\d.]+/g, "").replace(/ · cache \d+%/g, "").replace(/^gauntlet: /, "");
var kilo2 = (count) => count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1000 ? `${String(Math.round(count / 1000))}K` : String(count);
var tokenTotals = (view) => {
  const t = view.activity.reduce((sum2, each) => ({
    prompt: sum2.prompt + each.tokens.input + each.tokens.cacheRead + each.tokens.cacheWrite,
    cached: sum2.cached + each.tokens.cacheRead,
    out: sum2.out + each.tokens.output
  }), { prompt: 0, cached: 0, out: 0 });
  return t.prompt === 0 ? "" : `${kilo2(t.prompt)} in · ${String(Math.round(t.cached / t.prompt * 100))}% cached · ${kilo2(t.out)} out`;
};
var STAGES = ["Finders", "Pool", "Verification", "Judgment"];
var STAGE_COLOR = {
  Finders: "#5fafff",
  Pool: "#af87ff",
  Verification: "#ffaf5f",
  Judgment: "#5fd787"
};
var SHORT = { Finders: "Find", Pool: "Pool", Verification: "Verify", Judgment: "Judge" };
var stageState = (view) => STAGES.map((stage) => {
  const ran = view.activity.filter((each) => rowOf(each.invocationId)?.stage === stage);
  const total = stage === "Finders" ? view.lenses.length : ran.length;
  const done = ran.filter((each) => each.state === "answered").length;
  const started = ran.length > 0;
  const finished = started && done === ran.length && (stage !== "Finders" || view.findersFinished || view.exitCode !== undefined);
  return { stage, total, done, started, finished };
});
var renderBand = (view, fx, el, width, now, actions) => {
  const { Box, Text, Button } = el;
  const ended = view.exitCode !== undefined;
  const cells = [Text({ color: "#d7875f", bold: true, children: "◆ Gauntlet " })];
  if (ended) {
    const counts = fx.findings.reduce((sum2, each) => ({ ...sum2, [each.verdict]: (sum2[each.verdict] ?? 0) + 1 }), {});
    cells.push(Text({ color: "green", bold: true, children: `${String(counts["confirmed"] ?? 0)} confirmed` }), Text({ children: ` · ${String(counts["kept"] ?? 0)} kept · ` }), Text({ color: "yellow", children: `${String(counts["plausible"] ?? 0)} plausible` }), Text({ dimColor: true, children: ` · ${String(fx.dropped)} dropped · ${clock2((view.endedAt ?? now) - view.startedAt)}` }));
  } else {
    for (const [at, each] of stageState(view).entries()) {
      if (at > 0)
        cells.push(Text({ dimColor: true, children: " → " }));
      if (each.total > 1 && each.started && !each.finished) {
        cells.push(Text({ color: STAGE_COLOR[each.stage], bold: true, children: `${SHORT[each.stage]} ` }));
        cells.push(Box({ width: Math.max(6, each.total), flexShrink: 0, children: [meter(el, 0, each.done / each.total, STAGE_COLOR[each.stage], Math.max(6, each.total))] }));
        cells.push(Text({ color: STAGE_COLOR[each.stage], children: ` ${String(each.done)}/${String(each.total)}` }));
      } else if (each.finished) {
        cells.push(Text({ color: "green", children: `✓ ${SHORT[each.stage]}` }));
      } else if (each.started) {
        cells.push(Text({ color: STAGE_COLOR[each.stage], bold: true, children: `● ${SHORT[each.stage]}` }));
      } else {
        cells.push(Text({ dimColor: true, children: SHORT[each.stage] }));
      }
    }
    cells.push(Text({ dimColor: true, children: `  ${clock2(now - view.startedAt)}` }));
  }
  return Box({
    flexDirection: "column",
    width: "100%",
    children: [
      Box({
        flexDirection: "row",
        width: "100%",
        children: [
          Box({ flexGrow: 1, flexShrink: 1, flexDirection: "row", children: cells }),
          Button({ key: "open", label: ended ? "Findings" : "Details", hotkey: "o", onPress: actions.open }),
          ...ended ? [Button({ key: "dismiss", label: "Dismiss", hotkey: "d", onPress: actions.dismiss })] : []
        ]
      }),
      Text({ dimColor: true, wrap: "truncate-end", children: ended ? tokenTotals(view) : noDollars(view.latest ?? "") })
    ]
  });
};
var surface = "terminal";
var drawOn = (name) => {
  surface = name;
};
var stretches = (_el) => surface !== "terminal";
var meter = (el, from, to, color, cells) => {
  const { Box, Text } = el;
  const lo = Math.max(0, Math.min(1, from));
  const hi = Math.max(lo, Math.min(1, to));
  const svg = el["Svg"];
  if (stretches(el)) {
    const x = (lo * 1000).toFixed(1);
    const w = Math.max(4, (hi - lo) * 1000).toFixed(1);
    return Box({ flexGrow: 1, flexDirection: "column", justifyContent: "center", children: [svg({
      source: `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="8" viewBox="0 0 1000 8" preserveAspectRatio="none"><rect x="0" y="3" width="1000" height="2" fill="${color}" fill-opacity="0.15"/><rect x="${x}" y="1" width="${w}" height="6" fill="${color}"/></svg>`,
      alt: `${String(Math.round(lo * 100))}% to ${String(Math.round(hi * 100))}% of the run`,
      height: 8
    })] });
  }
  const lead = Math.round(lo * cells);
  const run = Math.max(1, Math.round(hi * cells) - lead);
  return Box({ flexDirection: "row", height: 1, children: [Text({ children: " ".repeat(lead) }), Text({ color, children: "━".repeat(run) })] });
};
var lane = (el, cells, child) => el["Box"]({ ...stretches(el) ? { flexGrow: 1, flexShrink: 1, minWidth: 8 } : { width: cells, flexShrink: 0 }, children: [child] });
var bar = (el, from, to, span, color, cells) => meter(el, from / span, to / span, color, cells);
var renderDock = (view, fx, el, width, now, selected, actions) => {
  const { Box, Text, Button } = el;
  const ended = view.exitCode !== undefined;
  const elapsed = (view.endedAt ?? now) - view.startedAt;
  const span = Math.max(elapsed, 30000);
  const children = [
    Box({
      flexDirection: "row",
      width: "100%",
      children: [
        Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: "column", children: [
          Text({ bold: true, wrap: "truncate-end", children: fx.target }),
          Text({ dimColor: true, wrap: "truncate-end", children: `${fx.recipe} · run ${fx.runId.slice(-4)} · ${clock2(elapsed)}` })
        ] }),
        ended ? Button({ key: "close", label: "Close", hotkey: "c", onPress: actions.close }) : Button({ key: "stop", label: "Stop", hotkey: "s", onPress: actions.stop })
      ]
    })
  ];
  const steps = [];
  for (const [at, each] of stageState(view).entries()) {
    if (at > 0)
      steps.push(Text({ dimColor: true, children: " › " }));
    const mark = each.finished ? "✓" : each.started ? "●" : "○";
    steps.push(Text(each.started ? { color: each.finished ? "green" : STAGE_COLOR[each.stage], bold: !each.finished, children: `${mark} ${SHORT[each.stage]}` } : { dimColor: true, children: `${mark} ${SHORT[each.stage]}` }));
  }
  children.push(Box({ flexDirection: "row", marginTop: 1, children: steps }));
  const nameWidth = 16;
  const timeWidth = 6;
  const cells = Math.max(8, width - nameWidth - timeWidth - 2 - 2);
  for (const stage of STAGES) {
    const rows = stage === "Finders" ? view.lenses.map((lens) => ({ name: lens, activity: view.activity.find((each) => rowOf(each.invocationId)?.name === lens && rowOf(each.invocationId)?.stage === "Finders") })) : view.activity.filter((each) => rowOf(each.invocationId)?.stage === stage).map((activity) => ({ name: rowOf(activity.invocationId)?.name ?? stage, activity }));
    if (rows.length === 0)
      continue;
    const ran = rows.filter((row) => row.activity !== undefined);
    if (ended) {
      const noun2 = { Finders: "found", Pool: "clusters", Verification: "verdicts", Judgment: "decisions" }[stage];
      const items2 = ran.reduce((sum2, row) => sum2 + (row.activity?.items ?? 0), 0);
      const from = Math.min(...ran.map((row) => row.activity?.spawnedAt ?? now)) - view.startedAt;
      const to = Math.max(...ran.map((row) => row.activity?.endedAt ?? now)) - view.startedAt;
      const label = rows.length > 1 ? `${String(ran.length)} ${stage === "Finders" ? "lenses" : "bundles"}` : "";
      children.push(Box({ flexDirection: "row", alignItems: "center", width: "100%", ...stage === "Finders" ? { marginTop: 1 } : {}, children: [
        Box({ width: 2, flexShrink: 0, children: [Text({ color: "green", children: "✓" })] }),
        Box({ width: nameWidth, flexShrink: 0, children: [Text({ bold: true, color: STAGE_COLOR[stage], children: stage })] }),
        lane(el, cells, bar(el, from, to, span, STAGE_COLOR[stage], cells)),
        Box({ width: timeWidth, flexShrink: 0, justifyContent: "flex-end", children: [Text({ dimColor: true, children: clock2(to - from) })] })
      ] }));
      children.push(Box({ flexDirection: "row", children: [Box({ width: 2 + nameWidth, flexShrink: 0 }), Text({ dimColor: true, children: [label, `${String(items2)} ${noun2}`].filter((part) => part !== "").join(" · ") })] }));
      continue;
    }
    const items = ran.reduce((sum2, row) => sum2 + (row.activity?.items ?? 0), 0);
    const noun = { Finders: "found", Pool: "clusters", Verification: "verdicts", Judgment: "decisions" }[stage];
    children.push(Box({ flexDirection: "row", marginTop: 1, children: [
      Text({ bold: true, color: STAGE_COLOR[stage], children: stage.toUpperCase() }),
      Text({ dimColor: true, children: items > 0 ? `  ${String(items)} ${noun}` : "" })
    ] }));
    for (const row of rows) {
      const activity = row.activity;
      const live = activity?.state === "running";
      const mark = activity === undefined ? "○" : live ? "●" : "✓";
      const color = activity === undefined ? undefined : live ? "cyan" : "green";
      const from = (activity?.spawnedAt ?? now) - view.startedAt;
      const to = (activity?.endedAt ?? (ended ? view.endedAt ?? now : now)) - view.startedAt;
      children.push(Box({ flexDirection: "row", alignItems: "center", width: "100%", children: [
        Box({ width: 2, flexShrink: 0, children: [Text(color === undefined ? { dimColor: true, children: mark } : { color, children: mark })] }),
        Box({ width: nameWidth, flexShrink: 0, children: [Text({ wrap: "truncate-end", dimColor: activity === undefined, children: row.name })] }),
        lane(el, cells, activity === undefined ? Box({}) : bar(el, from, to, span, live ? "cyan" : STAGE_COLOR[stage], cells)),
        Box({ width: timeWidth, flexShrink: 0, justifyContent: "flex-end", children: [Text({ dimColor: true, children: activity === undefined ? "" : clock2(to - from) })] })
      ] }));
      if (live && activity.lastTool !== undefined) {
        children.push(Box({ flexDirection: "row", children: [Box({ width: 2 + nameWidth, flexShrink: 0 }), Text({ dimColor: true, wrap: "truncate-end", children: `↳ ${activity.lastTool}` })] }));
      }
    }
  }
  const tokens = tokenTotals(view);
  if (tokens !== "")
    children.push(Box({ marginTop: 1, children: [Text({ dimColor: true, children: `Tokens  ${tokens}` })] }));
  if (!ended) {
    children.push(Text({ dimColor: true, wrap: "truncate-end", children: noDollars(view.latest ?? "") }));
    return Box({ flexDirection: "column", paddingRight: 2, children });
  }
  children.push(Box({ marginTop: 1, children: [Text({ bold: true, children: `FINDINGS  ` }), Text({ dimColor: true, children: fx.result })] }));
  children.push(...findingRows(el, fx.findings, width, selected, actions.select));
  const pick = fx.findings[selected];
  if (pick !== undefined)
    children.push(findingDetail(el, pick, width, actions.fix));
  return Box({ flexDirection: "column", paddingRight: 2, children });
};
var stageSpans = (view, now) => stageState(view).map((each) => {
  const ran = view.activity.filter((activity) => rowOf(activity.invocationId)?.stage === each.stage);
  const from = Math.min(...ran.map((activity) => activity.spawnedAt)) - view.startedAt;
  const to = Math.max(...ran.map((activity) => activity.endedAt ?? now)) - view.startedAt;
  return { ...each, from, to };
});
var agentMarks = (el, view, stage, now) => {
  const { Text } = el;
  const ran = view.activity.filter((activity) => rowOf(activity.invocationId)?.stage === stage);
  const states = stage === "Finders" ? view.lenses.map((lens) => ran.find((activity) => rowOf(activity.invocationId)?.name === lens)?.state) : ran.map((activity) => activity.state);
  const pulse = Math.floor(now / 500) % 2 === 0 ? "●" : "◉";
  if (states.length === 0)
    return [Text({ dimColor: true, children: "○" })];
  const order = (state) => state === undefined ? 2 : state === "running" ? 1 : 0;
  return [...states].sort((a, b) => order(a) - order(b)).map((state) => state === undefined ? Text({ dimColor: true, children: "○" }) : state === "running" ? Text({ color: STAGE_COLOR[stage], bold: true, children: pulse }) : Text({ color: STAGE_COLOR[stage], children: "✓" }));
};
var resultCells = (el, fx) => {
  const { Text } = el;
  const counts = fx.findings.reduce((sum2, each) => ({ ...sum2, [each.priority]: (sum2[each.priority] ?? 0) + 1 }), {});
  const cells = [];
  for (const priority of ["P0", "P1", "P2", "P3"]) {
    const count = counts[priority] ?? 0;
    if (count === 0)
      continue;
    if (cells.length > 0)
      cells.push(Text({ dimColor: true, children: " · " }));
    cells.push(Text({ color: PRIORITY_COLOR[priority], bold: priority !== "P3", children: `${priority} ${String(count)}` }));
  }
  if (cells.length === 0)
    cells.push(Text({ color: "green", children: "no findings" }));
  return cells;
};
var renderProgress = (view, fx, el, width, now, actions) => {
  const { Box, Text, Button } = el;
  const ended = view.exitCode !== undefined;
  const elapsed = (view.endedAt ?? now) - view.startedAt;
  const children = [
    Box({ flexDirection: "row", width: "100%", children: [
      Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: "column", children: [
        Text({ bold: true, wrap: "truncate-end", children: fx.target }),
        Text({ dimColor: true, wrap: "truncate-end", children: `${fx.recipe} · ${clock2(elapsed)}` })
      ] }),
      ended ? Button({ key: "close", label: "Close", hotkey: "c", onPress: actions.close }) : Button({ key: "stop", label: "Stop", hotkey: "s", onPress: actions.stop })
    ] })
  ];
  for (const [at, each] of stageSpans(view, now).entries()) {
    const color = STAGE_COLOR[each.stage];
    const mark = each.finished ? "✓" : each.started ? "●" : "○";
    children.push(Box({ flexDirection: "row", width: "100%", ...at === 0 ? { marginTop: 1 } : {}, children: [
      Box({ width: 2, flexShrink: 0, children: [Text(each.started ? { color: each.finished ? "green" : color, children: mark } : { dimColor: true, children: mark })] }),
      Box({ width: 14, flexShrink: 0, children: [Text(each.started ? { color, bold: !each.finished, wrap: "truncate-end", children: each.stage } : { dimColor: true, wrap: "truncate-end", children: each.stage })] }),
      Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", children: agentMarks(el, view, each.stage, now) }),
      Box({ width: 6, flexShrink: 0, justifyContent: "flex-end", children: [Text({ dimColor: true, children: each.started ? clock2(each.to - each.from) : "" })] })
    ] }));
  }
  if (!ended) {
    children.push(Box({ marginTop: 1, children: [Text({ dimColor: true, wrap: "truncate-end", children: noDollars(view.latest ?? "") })] }));
    return Box({ flexDirection: "column", paddingRight: 2, children });
  }
  children.push(Box({ flexDirection: "row", marginTop: 1, children: resultCells(el, fx) }));
  children.push(Box({ flexDirection: "row", marginTop: 1, children: [Button({ key: "dossier", label: "Open dossier", hotkey: "o", onPress: actions.dossier })] }));
  return Box({ flexDirection: "column", paddingRight: 2, children });
};
var plural = (count, one, many) => `${String(count)} ${count === 1 ? one : many}`;
var doing = (view, fx, now) => {
  const t = now - view.startedAt;
  const routed = fx.progress.filter((each) => each.at <= t).map((each) => /(\d+) BugClaims → Verification · (\d+) Observations → Judgment/.exec(each.line)).find((match) => match !== null);
  const [finders, pool, verification, judgment] = stageState(view);
  const finderRuns = view.activity.filter((each) => rowOf(each.invocationId)?.stage === "Finders");
  const candidates = finderRuns.reduce((sum2, each) => sum2 + (each.items ?? 0), 0);
  if (finderRuns.length === 0)
    return "Building the first prompt";
  if (!finders.finished) {
    if (finderRuns.length === 1 && finders.done === 0)
      return "Sending the first finder to set the cache";
    const looking = finderRuns.filter((each) => each.state === "running").length;
    return candidates === 0 ? `${plural(looking, "finder", "finders")} looking for bugs` : `${plural(looking, "finder", "finders")} still looking · ${plural(candidates, "lead", "leads")} so far`;
  }
  const claims = Number(routed?.[1] ?? candidates);
  const notes = Number(routed?.[2] ?? 0);
  if (!pool.finished)
    return `Grouping ${plural(claims, "possible bug", "possible bugs")} for checking · ${plural(notes, "note", "notes")} to weigh`;
  if (!verification.finished) {
    const weighing = judgment.started && !judgment.finished ? ` · weighing ${plural(notes, "note", "notes")}` : "";
    return `Double-checking ${plural(claims, "possible bug", "possible bugs")}${weighing}`;
  }
  if (!judgment.finished)
    return `Weighing ${plural(notes, "note", "notes")}`;
  return "Writing the dossier";
};
var renderStrip = (view, fx, el, now, actions) => {
  const { Box, Text, Button } = el;
  const ended = view.exitCode !== undefined;
  const cells = [Text({ color: "#d7875f", bold: true, children: "◆ Gauntlet  " })];
  if (ended)
    cells.push(...resultCells(el, fx));
  else {
    for (const [at, each] of stageState(view).entries()) {
      const color = STAGE_COLOR[each.stage];
      if (at > 0)
        cells.push(Text({ dimColor: true, children: "  " }));
      cells.push(Text(each.started ? { color, bold: !each.finished, children: `${SHORT[each.stage]} ` } : { dimColor: true, children: `${SHORT[each.stage]} ` }));
      cells.push(...agentMarks(el, view, each.stage, now));
    }
  }
  const candidates = view.activity.filter((each) => rowOf(each.invocationId)?.stage === "Finders").reduce((sum2, each) => sum2 + (each.items ?? 0), 0);
  const status = ended ? `${plural(fx.findings.length, "finding", "findings")} from ${plural(candidates, "lead", "leads")}` : doing(view, fx, now);
  return Box({ flexDirection: "column", width: "100%", paddingRight: 2, children: [
    Box({ flexDirection: "row", width: "100%", alignItems: "center", children: [
      Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: "row", alignItems: "center", children: cells }),
      ...ended ? [Button({ key: "dossier", label: "Open dossier", hotkey: "o", onPress: actions.dossier }), Button({ key: "dismiss", label: "Dismiss", hotkey: "d", onPress: actions.dismiss })] : []
    ] }),
    Text({ dimColor: true, wrap: "truncate-end", children: `${clock2((view.endedAt ?? now) - view.startedAt)} · ${status}` })
  ] });
};
var VERDICT = {
  confirmed: { mark: "✓", color: "green" },
  kept: { mark: "◆", color: "#5fafff" },
  plausible: { mark: "?", color: "yellow" }
};
var PRIORITY_COLOR = { P0: "red", P1: "red", P2: "#ff8700", P3: "#878787" };
var findingRows = (el, findings, width, selected, select) => {
  const { Box, Text, Button } = el;
  return findings.map((finding, at) => {
    const isSelected = at === selected;
    const where = `${finding.file.split("/").pop() ?? finding.file}:${finding.line}`;
    return Box({
      key: `finding-${String(at)}`,
      flexDirection: "row",
      width: "100%",
      ...isSelected ? { backgroundColor: "#303030" } : {},
      children: [
        Text({ color: isSelected ? "#ffaf5f" : "#444444", children: isSelected ? "▌" : " " }),
        Box({ width: 3, flexShrink: 0, children: [Text({ bold: true, color: PRIORITY_COLOR[finding.priority] ?? "white", children: finding.priority })] }),
        Box({ width: 2, flexShrink: 0, children: [Text({ color: VERDICT[finding.verdict].color, children: VERDICT[finding.verdict].mark })] }),
        Box({ width: 22, flexShrink: 0, children: [
          at < 9 ? Button({ key: `pick-${String(at)}`, label: where, hotkey: String(at + 1), plain: true, dimColor: !isSelected, onPress: () => select(at) }) : Text({ wrap: "truncate-end", children: `   ${where}` })
        ] }),
        Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, children: [Text({ wrap: "truncate-end", dimColor: !isSelected, children: finding.summary })] })
      ]
    });
  });
};
var findingDetail = (el, finding, width, fix) => {
  const { Box, Text, Button } = el;
  return Box({
    flexDirection: "column",
    width: "100%",
    borderStyle: "round",
    borderColor: "#585858",
    paddingX: 1,
    marginTop: 1,
    children: [
      Box({ flexDirection: "row", children: [
        Text({ bold: true, color: PRIORITY_COLOR[finding.priority] ?? "white", children: `${finding.priority} ` }),
        Text({ color: VERDICT[finding.verdict].color, children: `${finding.verdict}  ` }),
        Box({ flexShrink: 1, minWidth: 0, children: [Text({ color: "cyan", wrap: "truncate-start", children: `${finding.file}:${finding.line}` })] })
      ] }),
      Text({ wrap: "wrap", children: finding.summary }),
      Text({ dimColor: true, wrap: "wrap", children: `Evidence: ${finding.evidence}` }),
      Box({ flexDirection: "row", marginTop: 1, gap: 1, children: [
        Text({ dimColor: true, children: `found by ${finding.lenses.join(", ")}` }),
        Box({ flexGrow: 1 }),
        Button({ key: "fix", label: "Fix this", hotkey: "f", variant: "primary", onPress: () => fix(finding) })
      ] })
    ]
  });
};
var renderFindings = (fx, el, width, selected, actions) => {
  const { Box, Text, Button } = el;
  const counts = fx.findings.reduce((sum2, each) => ({ ...sum2, [each.verdict]: (sum2[each.verdict] ?? 0) + 1 }), {});
  return Box({
    flexDirection: "column",
    children: [
      Box({ flexDirection: "row", width: "100%", children: [
        Box({ flexGrow: 1, flexShrink: 1, flexDirection: "row", children: [
          Text({ bold: true, children: `${String(fx.findings.length)} findings  ` }),
          Text({ color: "green", children: `✓${String(counts["confirmed"] ?? 0)} ` }),
          Text({ color: "#5fafff", children: `◆${String(counts["kept"] ?? 0)} ` }),
          Text({ color: "yellow", children: `?${String(counts["plausible"] ?? 0)} ` }),
          Text({ dimColor: true, children: `· ${String(fx.dropped)} dropped` })
        ].map((cell) => Box({ flexShrink: 0, children: [cell] })) }),
        Button({ key: "report", label: "Report", hotkey: "r", onPress: actions.report }),
        Text({ children: " " }),
        Button({ key: "close", label: "Close", hotkey: "c", onPress: actions.close })
      ] }),
      ...findingRows(el, fx.findings, width, selected, actions.select),
      ...fx.findings[selected] === undefined ? [] : [findingDetail(el, fx.findings[selected], width, actions.fix)]
    ]
  });
};
var hex = (color) => Number.parseInt(color.slice(1), 16);
var DEFAULT = 16777216;
var lanes = (fx, view) => fx.invocations.map((each) => {
  const row = rowOf(each.invocationId);
  const activity = view.activity.find((a) => a.invocationId === each.invocationId);
  return { name: row?.name ?? "?", stage: row?.stage ?? "Finders", from: each.spawnedAt, to: each.endedAt, activity };
});
var timelineCells = (fx, view, columns, t) => {
  const all = lanes(fx, view);
  const rows = all.length + 1;
  const words = new Uint32Array(columns * rows * 3);
  const span = fx.endedAt;
  for (const [row, lane2] of all.entries()) {
    for (let x = 0;x < columns; x++) {
      const at = (row * columns + x) * 3;
      const ms = (x + 0.5) / columns * span;
      const on = ms >= lane2.from && ms <= Math.min(lane2.to, t);
      const live = lane2.activity?.state === "running";
      words[at] = on ? 9600 : ms <= t ? 183 : 32;
      words[at + 1] = on ? live ? 6281215 : hex(STAGE_COLOR[lane2.stage]) : 3815994;
      words[at + 2] = DEFAULT;
    }
  }
  for (let x = 0;x < columns; x++) {
    const at = ((rows - 1) * columns + x) * 3;
    const sec = (x + 0.5) / columns * span / 1000;
    const tick = Math.floor(sec / 30) !== Math.floor((sec - span / 1000 / columns) / 30);
    const head = Math.abs((x + 0.5) / columns * span - t) < span / columns / 2;
    words[at] = head ? 9650 : tick ? 9532 : 9472;
    words[at + 1] = head ? 16756575 : 5789784;
    words[at + 2] = DEFAULT;
  }
  return { cells: new Uint8Array(words.buffer).toBase64(), rows, names: all.map((each) => each.name) };
};
var renderTimeline = (fx, view, el, width, t, surface2) => {
  const { Box, Text } = el;
  const labels = 18;
  const columns = Math.max(20, width - labels - 1);
  if (surface2 !== "terminal" && el["Svg"] !== undefined) {
    return Box({ flexDirection: "column", children: [el["Svg"]({ source: timelineSvg(fx, view, t), alt: "Gantt timeline of the review's agents", isInteractive: true })] });
  }
  const grid = timelineCells(fx, view, columns, t);
  const labelRows = [];
  for (const name of grid.names)
    labelRows.push(Text({ dimColor: true, wrap: "truncate-end", children: name }));
  labelRows.push(Text({ dimColor: true, children: `0:00 … ${clock2(fx.endedAt)}` }));
  return Box({
    flexDirection: "column",
    children: [
      Box({ flexDirection: "row", children: [
        Text({ bold: true, children: `Timeline  ` }),
        ...STAGES.flatMap((stage) => [Text({ color: STAGE_COLOR[stage], children: "■ " }), Text({ dimColor: true, children: `${stage}  ` })]),
        Text({ color: "#5fd7ff", children: "■ " }),
        Text({ dimColor: true, children: `running   ${clock2(t)}` })
      ] }),
      Box({ flexDirection: "row", children: [
        Box({ width: labels, flexShrink: 0, flexDirection: "column", children: labelRows }),
        el["Raster"]({ key: "gantt", columns, rows: grid.rows, cells: grid.cells })
      ] })
    ]
  });
};
var timelineSvg = (fx, view, t) => {
  const all = lanes(fx, view);
  const W = 720;
  const left = 170;
  const laneH = 22;
  const top = 28;
  const H = top + all.length * laneH + 30;
  const x = (ms) => left + ms / fx.endedAt * (W - left - 16);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(W)} ${String(H)}" width="${String(W)}" height="${String(H)}" font-family="ui-sans-serif, system-ui" font-size="12">`,
    `<style>.lane:hover rect.bar{filter:brightness(1.25)} text{fill:#c6c6c6} .dim{fill:#7a7a7a}</style>`,
    `<rect width="100%" height="100%" fill="#1c1c1c" rx="8"/>`
  ];
  for (let s = 0;s <= fx.endedAt; s += 30000) {
    parts.push(`<line x1="${String(x(s))}" x2="${String(x(s))}" y1="${String(top - 6)}" y2="${String(H - 24)}" stroke="#333"/>`);
    parts.push(`<text class="dim" x="${String(x(s))}" y="${String(H - 10)}" text-anchor="middle">${clock2(s)}</text>`);
  }
  all.forEach((lane2, at) => {
    const y = top + at * laneH;
    const end = Math.min(lane2.to, t);
    const live = lane2.activity?.state === "running";
    const fill = live ? "#5fd7ff" : STAGE_COLOR[lane2.stage];
    parts.push(`<g class="lane"><title>${lane2.stage} · ${lane2.name} · ${clock2(lane2.to - lane2.from)} · ${kilo2(lane2.activity?.tokens.cacheRead ?? 0)} cached tokens</title>`);
    parts.push(`<text x="${String(left - 10)}" y="${String(y + 15)}" text-anchor="end">${lane2.name}</text>`);
    if (lane2.from <= t)
      parts.push(`<rect class="bar" x="${String(x(lane2.from))}" y="${String(y + 4)}" width="${String(Math.max(2, x(end) - x(lane2.from)))}" height="${String(laneH - 8)}" rx="4" fill="${fill}"/>`);
    parts.push(`</g>`);
  });
  parts.push(`<line x1="${String(x(t))}" x2="${String(x(t))}" y1="${String(top - 8)}" y2="${String(H - 24)}" stroke="#ffaf5f" stroke-width="2"/>`);
  parts.push(`<text x="${String(left)}" y="16" font-weight="600">${fx.target} · ${fx.recipe}</text></svg>`);
  return parts.join("");
};
var renderCard = (fx, el, width) => {
  const { Box, Text } = el;
  const counts = fx.findings.reduce((sum2, each) => ({ ...sum2, [each.verdict]: (sum2[each.verdict] ?? 0) + 1 }), {});
  const top = [...fx.findings].sort((a, b) => a.priority.localeCompare(b.priority)).slice(0, 3);
  const tokens = fx.invocations.reduce((sum2, each) => sum2 + each.tokens.input + each.tokens.cacheRead + each.tokens.cacheWrite, 0);
  const cached = fx.invocations.reduce((sum2, each) => sum2 + each.tokens.cacheRead, 0);
  return Box({
    flexDirection: "column",
    width: Math.min(width, 100),
    borderStyle: "round",
    borderColor: "#d7875f",
    paddingX: 1,
    children: [
      Box({ flexDirection: "row", children: [
        Text({ bold: true, color: "#d7875f", children: "◆ Gauntlet review  " }),
        Text({ bold: true, children: fx.target }),
        Box({ flexGrow: 1 }),
        Text({ dimColor: true, children: clock2(fx.endedAt) })
      ] }),
      Box({ flexDirection: "row", children: [
        Text({ color: "green", bold: true, children: `✓ ${String(counts["confirmed"] ?? 0)} confirmed   ` }),
        Text({ color: "#5fafff", children: `◆ ${String(counts["kept"] ?? 0)} kept   ` }),
        Text({ color: "yellow", children: `? ${String(counts["plausible"] ?? 0)} plausible   ` }),
        Text({ dimColor: true, children: `${String(fx.dropped)} dropped · ${kilo2(tokens)} tokens, ${String(Math.round(cached / tokens * 100))}% cached` })
      ] }),
      Text({ children: " " }),
      ...top.map((finding) => Box({ flexDirection: "row", children: [
        Box({ width: 4, flexShrink: 0, children: [Text({ bold: true, color: PRIORITY_COLOR[finding.priority] ?? "white", children: finding.priority })] }),
        Box({ width: 26, flexShrink: 0, children: [Text({ wrap: "truncate-end", children: `${finding.file.split("/").pop() ?? ""}:${finding.line}` })] }),
        Box({ flexGrow: 1, flexShrink: 1, children: [Text({ dimColor: true, wrap: "truncate-end", children: finding.summary })] })
      ] })),
      Text({ dimColor: true, children: `+${String(fx.findings.length - top.length)} more · /gc-cli findings to browse · dossier in ~/.gauntlet/runs/${fx.runId.slice(-4)}` })
    ]
  });
};
var esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var code = (text) => esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
var renderReportHtml = (fx) => {
  const view = viewAt(fx, fx.endedAt + 1);
  const counts = fx.findings.reduce((sum2, each) => ({ ...sum2, [each.verdict]: (sum2[each.verdict] ?? 0) + 1 }), {});
  const line = (re) => fx.progress.map((each) => re.exec(each.line)).find((m) => m !== null);
  const routed = line(/(\d+) BugClaims → Verification · (\d+) Observations → Judgment/);
  const bundles = line(/(\d+) bundles → Verification/);
  const verified = line(/Verification finished — (\d+) confirmed · (\d+) refuted · (\d+) plausible/);
  const judged = line(/Judgment finished — (\d+) kept · (\d+) dropped · (\d+) undecided/);
  const candidates = fx.invocations.filter((each) => rowOf(each.invocationId)?.stage === "Finders").reduce((sum2, each) => sum2 + each.items, 0);
  const tokens = view.activity.reduce((sum2, each) => ({ prompt: sum2.prompt + each.tokens.input + each.tokens.cacheRead + each.tokens.cacheWrite, cached: sum2.cached + each.tokens.cacheRead, out: sum2.out + each.tokens.output }), { prompt: 0, cached: 0, out: 0 });
  const step = (n, label, tone = "") => `<div class="step ${tone}"><b>${String(n ?? "–")}</b><span>${label}</span></div>`;
  const chip = (verdict) => `<span class="chip ${verdict}">${verdict}</span>`;
  const card = (finding, at) => `
    <article class="finding ${finding.priority.toLowerCase()}">
      <header><span class="prio">${finding.priority}</span>${chip(finding.verdict)}
        <span class="path">${esc(finding.file)}:${esc(finding.line)}</span>
        <span class="num">#${String(at + 1)}</span></header>
      <p>${code(finding.summary)}</p>
      ${finding.failureScenario ? `<details><summary>Failure scenario</summary><p>${code(finding.failureScenario)}</p></details>` : ""}
      <details><summary>Evidence</summary><p>${code(finding.evidence)}</p></details>
      <footer>${finding.lenses.map((lens) => `<span class="lens">${esc(lens)}</span>`).join("")}</footer>
    </article>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gauntlet review ${esc(fx.runId.slice(-4))}</title>
<style>
:root{--bg:#f6f5f2;--panel:#fff;--ink:#1d1d1b;--dim:#6b6a66;--line:#e4e2dc;--accent:#c4643c;--ok:#2f8f57;--kept:#2f6fb3;--warn:#b58300;--p2:#d9731a;--p3:#8a8984}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--panel:#1d1d1d;--ink:#e8e6e1;--dim:#9a988f;--line:#2e2e2e;--accent:#e08a5f;--ok:#5fd787;--kept:#5fafff;--warn:#e5c07b;--p2:#ff8f3a;--p3:#8a8984}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 60px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--dim);margin:0 0 22px}.sub b{color:var(--ink);font-weight:600}
h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:30px 0 10px}
.funnel{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch}.step{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:110px}
.step b{display:block;font-size:22px}.step span{color:var(--dim);font-size:12.5px}.arrow{align-self:center;color:var(--dim)}
.step.ok b{color:var(--ok)}.step.kept b{color:var(--kept)}.step.warn b{color:var(--warn)}.step.dim b{color:var(--dim)}
.timeline{background:#1c1c1c;border-radius:10px;padding:6px;overflow-x:auto}.timeline svg{display:block;max-width:100%;height:auto}
.finding{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--p3);border-radius:10px;padding:12px 16px;margin:10px 0}
.finding.p2,.finding.p1,.finding.p0{border-left-color:var(--p2)}
.finding header{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13.5px}.prio{font-weight:700;color:var(--p3)}.p2 .prio{color:var(--p2)}
.finding .path{color:var(--ink);font-family:ui-monospace,Menlo,monospace;font-size:13px}.num{margin-left:auto;color:var(--dim)}
.chip{font-size:11.5px;padding:1px 8px;border-radius:99px;border:1px solid}.chip.confirmed{color:var(--ok)}.chip.kept{color:var(--kept)}.chip.plausible{color:var(--warn)}
.finding p{margin:8px 0}details{color:var(--dim);font-size:14px}summary{cursor:pointer}code{font:12.5px ui-monospace,Menlo,monospace;background:color-mix(in srgb,var(--line) 60%,transparent);padding:1px 4px;border-radius:4px}
footer{display:flex;gap:6px;flex-wrap:wrap}.lens{font-size:12px;color:var(--dim);border:1px solid var(--line);border-radius:6px;padding:0 6px}
.totals{color:var(--dim);font-size:13.5px}
</style></head><body><main>
<h1>Gauntlet review · ${esc(fx.target)}</h1>
<p class="sub"><b>${String(counts["confirmed"] ?? 0)} confirmed</b> · ${String(counts["kept"] ?? 0)} kept · ${String(counts["plausible"] ?? 0)} plausible · ${String(fx.dropped)} dropped — ${esc(fx.recipe)} · ${clock2(fx.endedAt)} · run ${esc(fx.runId)}</p>
<h2>How the candidates were narrowed</h2>
<div class="funnel">
${step(candidates, `candidates from ${String(fx.lenses.length)} lenses`)}<span class="arrow">→</span>
${step(routed?.[1], "BugClaims to verify")}${step(routed?.[2], "Observations to judge")}<span class="arrow">→</span>
${step(bundles?.[1], "verification bundles")}<span class="arrow">→</span>
${step(verified?.[1], "confirmed", "ok")}${step(verified?.[3], "plausible", "warn")}${step(verified?.[2], "refuted", "dim")}
${step(judged?.[1], "kept", "kept")}${step(judged?.[2], "dropped", "dim")}
</div>
<h2>Timeline</h2>
<div class="timeline">${timelineSvg(fx, view, fx.endedAt)}</div>
<p class="totals">Tokens: ${kilo2(tokens.prompt)} in, ${String(Math.round(tokens.cached / tokens.prompt * 100))}% from cache · ${kilo2(tokens.out)} out · ${String(fx.invocations.length)} agents</p>
<h2>Findings</h2>
${fx.findings.map(card).join("")}
</main></body></html>`;
};
export {
  drawOn,
  nowAt,
  renderBand,
  renderCard,
  renderDock,
  renderFindings,
  renderProgress,
  renderReportHtml,
  renderRunPane,
  renderStrip,
  renderTimeline,
  timelineCells,
  timelineSvg,
  viewAt
};
