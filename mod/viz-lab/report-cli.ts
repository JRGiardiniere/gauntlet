// bun report-cli.ts <fixture.json> <out.html> [svg-out]
import { readFileSync, writeFileSync } from "node:fs"
import { renderReportHtml, timelineSvg, viewAt, type Fixture } from "./viz.ts"
const fx = JSON.parse(readFileSync(process.argv[2], "utf8")) as Fixture
writeFileSync(process.argv[3], renderReportHtml(fx))
if (process.argv[4]) writeFileSync(process.argv[4], `<!doctype html><body style="margin:0;background:#262626;padding:20px">${timelineSvg(fx, viewAt(fx, 150_000), 150_000)}</body>`)
