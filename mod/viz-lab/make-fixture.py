#!/usr/bin/env python3
# Turns a finished run dir into the viz-lab replay fixture: each
# invocation's spawn/end offsets, tokens, items and a few plausible tool
# steps, plus the dossier's findings. Later stages log cost and cache share
# only, so their tokens are estimated from those at Opus prices.
import json, re, sys, datetime
run = sys.argv[1]
out = sys.argv[2]
log = open(f"{run}/run.log").read().splitlines()
def ts(line):
    t = re.search(r"timestamp=(\S+)", line).group(1)
    return datetime.datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp() * 1000
t0 = ts(log[0])
rid = run.rstrip("/").split("/")[-1]
stage = json.load(open(f"{run}/finder-stage.json"))
dossier = json.load(open(f"{run}/dossier.json"))
inv, spawn = [], {}
lenses = []
for line in log:
    m = re.search(r'message="(.*?)"', line); msg = m.group(1) if m else ""
    at = ts(line) - t0
    if (k := re.match(r"invoking finder (\S+)", msg)):
        lenses.append(k.group(1)); spawn[f"{rid}-finders-1-finder-{k.group(1)}"] = at
    elif msg == "invoking Pool": spawn[f"{rid}-pool"] = at
    elif (k := re.match(r"invoking Verification bundle (\d+)", msg)): spawn[f"{rid}-verification-{k.group(1)}"] = at
    elif msg == "invoking Judgment": spawn[f"{rid}-judgment"] = at
progress = []
for line in log:
    m = re.search(r'message="(.*?)"', line)
    if m: progress.append({"at": ts(line) - t0, "line": "gauntlet: " + m.group(1)})
for f in stage["finders"]:
    lens = f["invocationKey"].removeprefix("finder-")
    iid = f"{rid}-finders-1-finder-{lens}"
    u = f["outcome"]["usage"]
    items = len(f["outcome"].get("output", {}).get("findings", []))
    inv.append({"invocationId": iid, "spawnedAt": spawn[iid], "endedAt": spawn[iid] + f["outcome"]["durationMillis"],
                "items": items, "toolCalls": f["outcome"]["toolCalls"]["total"],
                "tokens": {k: u[k] for k in ("input", "output", "cacheRead", "cacheWrite")}})
def later(iid, done_re, items):
    for line in log:
        m = re.search(r'message="(.*?)"', line)
        if m and (k := re.match(done_re, m.group(1))):
            secs, cost, cache = float(k.group(1)), float(k.group(2)), int(k.group(3)) / 100
            # Opus 5.5: $5/M in, $25/M out, 0.5 read, 6.25 write; ~8% of spend is output.
            out_tok = int(cost * 0.08 / 25e-6)
            prompt = int((cost - out_tok * 25e-6) / (cache * 0.5e-6 + (1 - cache) * 6.25e-6))
            inv.append({"invocationId": iid, "spawnedAt": spawn[iid], "endedAt": ts(line) - t0, "items": items,
                        "toolCalls": 2, "tokens": {"input": 0, "output": out_tok, "cacheRead": int(prompt * cache), "cacheWrite": prompt - int(prompt * cache)}})
later(f"{rid}-pool", r"Pool done — (\d+)s · \$([\d.]+) · cache (\d+)%", 2)
for b in ("1", "2"):
    later(f"{rid}-verification-{b}", rf"Verification bundle {b} done — (\d+)s · \$([\d.]+) · cache (\d+)%", 3 if b == "1" else 3)
later(f"{rid}-judgment", r"Judgment done — (\d+)s · \$([\d.]+) · cache (\d+)%", 14)
# Plausible tool steps while each agent runs, spread over its lifetime.
files = ["platform/operations/publish-app.ts", "platform/operations/errors.ts", "platform/operations/operations.ts",
         "platform/operations/app-authorization.ts", "platform/git/git-writer.ts", "docs/mcp/workspace.md",
         "platform/operations/app-manifest.ts", "platform/access/access-projection.ts"]
for n, i in enumerate(inv):
    span = i["endedAt"] - i["spawnedAt"]
    steps = max(2, i["toolCalls"] + 3)
    tools = []
    for s in range(steps):
        f = files[(n * 3 + s) % len(files)]
        tools.append({"at": i["spawnedAt"] + span * (s + 1) / (steps + 1),
                      "tool": [f"Read {f}", f'Grep "PostPushDeployFailed" in {f.rsplit("/", 1)[0]}', f"Read {f}"][s % 3]})
    i["tools"] = tools
def finding(f):
    if f["_tag"] == "Judgment":
        c, j = f["candidate"], f["judgment"]
        return {"verdict": "kept", "priority": j["reviewPriority"], "file": c["file"], "line": c["line"], "summary": c["summary"],
                "lenses": [c["lens"]], "evidence": j["reason"]}
    claims = f["bugClaims"]
    return {"verdict": f["verdict"]["_tag"].lower(), "priority": f["verdict"].get("reviewPriority", "P3"), "file": claims[0]["file"],
            "line": claims[0]["line"], "summary": claims[0]["summary"], "lenses": sorted({c["lens"] for c in claims}),
            "evidence": f["verdict"].get("evidence", f["verdict"].get("reason", "")),
            "failureScenario": claims[0].get("failureScenario", "")}
fixture = {
    "runId": rid, "argv": ["review", "--related-files", "--pr=641"], "target": "cloudflare-hub PR #641 (ca51fa8)",
    "recipe": "claude-opus-medium", "lenses": lenses, "endedAt": max(i["endedAt"] for i in inv) + 400,
    "invocations": sorted(inv, key=lambda i: i["spawnedAt"]), "progress": progress,
    "findings": [finding(f) for f in dossier["findings"]] + [finding(f) for f in dossier["unresolved"]],
    "dropped": len(dossier["rejected"]["droppedObservations"]), "refuted": len(dossier["rejected"]["refutedClaims"]),
    "result": "5 confirmed · 4 kept · 1 plausible · 0 undecided",
}
json.dump(fixture, open(out, "w"), indent=1)
print(len(fixture["invocations"]), "invocations", len(fixture["findings"]), "findings", fixture["endedAt"] / 1000, "s")
