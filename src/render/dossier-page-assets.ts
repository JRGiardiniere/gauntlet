// The Dossier page's stylesheet and script, inlined into every page so the
// file needs nothing beside it; only the Archivo font comes from Google
// Fonts, and offline the page falls back to system faces. Colour is
// adjudication ink only (P1–P3 stamps, the pinned line); code and diffs
// carry weight and tone, never hue. The script keeps reviewed marks and the
// flag in localStorage, per run.
export const DOSSIER_PAGE_CSS = String.raw`
:root{
  --desk:#e6e0d3; --kraft:#c9a56b; --kraft-2:#b48f55; --kraft-ink:#2e2412; --kraft-ink-2:#5b4728;
  --sheet:#f8f6f0; --sheet-2:#f1ede3; --rule:#ddd5c4; --rule-2:#c9bfab;
  --ink-1:#1c1b18; --ink-2:#47433b; --ink-3:#6b6559;
  --p1:#d93b40; --p2:#e57a00; --p3:#b98f00; --mark:#d7875f;
  --add:#ebe6d9; --add-ink:#1c1b18; --del:#f3f0e8; --del-ink:#6b6559; --hl:#fff1c2;
  --shadow:0 1px 2px rgba(40,30,10,.10),0 6px 18px -6px rgba(40,30,10,.18);
  --blend:multiply;
  --cond:"Archivo","Arial Narrow",system-ui,sans-serif;
  --text:"Archivo",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --desk:#121110; --kraft:#4a3920; --kraft-2:#5e4829; --kraft-ink:#f1dfbd; --kraft-ink-2:#c9b089;
  --sheet:#1c1b19; --sheet-2:#232220; --rule:#34312c; --rule-2:#47433b;
  --ink-1:#ece8df; --ink-2:#c3bcae; --ink-3:#958e80;
  --p1:#e5484d; --p2:#ff8700; --p3:#e0b000; --mark:#e89a72;
  --add:#34312c; --add-ink:#ece8df; --del:#1f1e1b; --del-ink:#958e80; --hl:#3a3216;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 22px -8px rgba(0,0,0,.6);
  --blend:screen; color-scheme:dark;
}}
:root[data-theme="dark"]{
  --desk:#121110; --kraft:#4a3920; --kraft-2:#5e4829; --kraft-ink:#f1dfbd; --kraft-ink-2:#c9b089;
  --sheet:#1c1b19; --sheet-2:#232220; --rule:#34312c; --rule-2:#47433b;
  --ink-1:#ece8df; --ink-2:#c3bcae; --ink-3:#958e80;
  --p1:#e5484d; --p2:#ff8700; --p3:#e0b000; --mark:#e89a72;
  --add:#34312c; --add-ink:#ece8df; --del:#1f1e1b; --del-ink:#958e80; --hl:#3a3216;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 22px -8px rgba(0,0,0,.6);
  --blend:screen; color-scheme:dark;
}
*{box-sizing:border-box}
html{scroll-padding-top:16px}
body{margin:0;background:var(--desk);color:var(--ink-1);font:400 16px/1.6 var(--text);display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh;-webkit-font-smoothing:antialiased}
::selection{background:color-mix(in oklab,var(--kraft) 55%,transparent);color:var(--ink-1)}
:focus-visible{outline:2px solid var(--ink-1);outline-offset:2px;border-radius:2px}
*{scrollbar-width:thin;scrollbar-color:var(--rule-2) transparent}
code,kbd{font-family:var(--mono);font-size:.86em}
p code,li code,.lead code,.rest code{-webkit-box-decoration-break:clone;box-decoration-break:clone;background:var(--sheet-2);border:1px solid var(--rule);border-radius:3px;padding:0 .3em;color:var(--ink-1)}
a{color:inherit}
.muted{color:var(--ink-3)}
.field-label,.tag,.sp-tab,.sec-head,.ev-kind,.act,.sp-view button,.dk,.stamp,.sleeve-title,.sp-mark,.brief-by,.st-by{font-family:var(--cond);font-stretch:72%;text-transform:uppercase;letter-spacing:.07em}

/* the spine */
.spine{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;background:var(--kraft);color:var(--kraft-ink);padding:18px 0 24px;border-right:1px solid var(--kraft-2);box-shadow:inset -8px 0 14px -10px rgba(0,0,0,.25)}
.diamond{color:var(--mark)}
.sp-mark .diamond{-webkit-text-stroke:.7px var(--kraft-ink);paint-order:stroke fill}
.sp-mark{padding:0 18px 14px;font-weight:800;font-size:15px;letter-spacing:.12em;color:var(--kraft-ink)}
.sp-view{display:flex;margin:0 12px 16px;border:1px solid var(--kraft-ink-2);border-radius:3px;overflow:hidden}
.sp-view button{flex:1;border:0;background:transparent;color:var(--kraft-ink);font-size:12.5px;font-weight:700;padding:6px 4px;cursor:pointer}
.sp-view button b{font-variant-numeric:tabular-nums}
.sp-view button[aria-checked="true"]{background:var(--kraft-ink);color:var(--kraft)}
.sp-group{margin:0 0 6px}
.sp-tab{display:flex;justify-content:space-between;align-items:baseline;margin-right:-1px;padding:6px 14px 5px 18px;font-weight:800;font-size:14px;text-decoration:none;color:var(--kraft-ink);background:color-mix(in oklab,var(--kraft-2) 70%,var(--kraft));border-radius:0 6px 6px 0;width:calc(100% - 14px)}
.sp-tab b{font-variant-numeric:tabular-nums;font-weight:700}
.sp-tab span{display:inline-flex;align-items:center;gap:7px}
.sp-p1 .sp-tab span::before,.sp-p2 .sp-tab span::before,.sp-p3 .sp-tab span::before{content:"";width:9px;height:9px;border-radius:2px;transform:rotate(-6deg)}
.sp-p1 .sp-tab span::before{background:var(--p1)} .sp-p2 .sp-tab span::before{background:var(--p2)} .sp-p3 .sp-tab span::before{background:var(--p3)}
.sp-group.empty .sp-tab{opacity:.55}
.spine ol{list-style:none;margin:4px 0 8px;padding:0}
.spine li a{display:grid;grid-template-columns:38px 1fr auto auto auto;align-items:center;gap:4px;padding:3px 12px 3px 18px;text-decoration:none;font-size:13px;line-height:1.35;color:var(--kraft-ink)}
.spine li a:hover{background:color-mix(in oklab,var(--kraft-ink) 8%,transparent)}
.spine li a.here{background:color-mix(in oklab,var(--kraft-ink) 14%,transparent)}
.spine li a.dim{opacity:.35}
.ix{font-family:var(--mono);font-size:11.5px;color:var(--kraft-ink-2)}
.sf{font-family:var(--mono);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spine svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.sp-check,.sp-flag{display:none}
.spine li a.done .sp-check{display:inline-flex}
.spine li a.flagged .sp-flag{display:inline-flex;color:var(--mark)}
.sp-brief{display:inline-flex;color:var(--kraft-ink-2)}
.sp-progress{margin:18px 18px 0;padding-top:10px;border-top:1px solid var(--kraft-ink-2);font-size:12.5px;color:var(--kraft-ink-2);font-variant-numeric:tabular-nums}

/* the file */
.file{padding:28px clamp(16px,3vw,44px) 64px;max-width:1500px;width:100%}
.sheet,.exhibit{background:var(--sheet);box-shadow:var(--shadow);border-radius:2px}
.index{padding:22px 28px 6px;margin-bottom:26px;position:relative}
.ix-title{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 24px;border-bottom:2px solid var(--ink-1);padding-bottom:14px}
h1{margin:0;font-family:var(--cond);font-stretch:68%;font-weight:800;font-size:clamp(34px,4.6vw,58px);line-height:.95;letter-spacing:-.01em;text-transform:uppercase}
.h-mark{display:none;font-size:.5em;vertical-align:.35em;margin-right:.3em}
.h-range{font-family:var(--mono);font-stretch:100%;font-weight:500;font-size:clamp(14px,.42em,24px);letter-spacing:0;text-transform:none;color:var(--ink-2);vertical-align:.4em}
.ix-docket{margin:0;display:flex;gap:16px;flex-wrap:wrap}
.dk{font-size:14px;font-weight:700;color:var(--ink-3)}
.dk b{font-family:var(--text);font-stretch:100%;font-size:22px;font-weight:800;color:var(--ink-1);margin-right:3px;font-variant-numeric:tabular-nums}
.dk-p1 b{color:var(--p1)} .dk-p2 b{color:var(--p2)} .dk-p3 b{color:var(--p3)} .dk.zero b{color:var(--ink-3)}
.ix-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));column-gap:24px}
.ix-field{display:flex;flex-direction:column;gap:0;padding:7px 0 6px;border-bottom:1px solid var(--rule);min-width:0}
.ix-more{grid-column:1/-1}
.ix-more>summary{display:none}
.ix-field{grid-column:span 1} .ix-field.w2{grid-column:span 2} .ix-field.w3{grid-column:span 3} .ix-field.w4{grid-column:span 4} .ix-field.w6{grid-column:1/-1}
.ix-field.num .ix-value{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}
.ix-field.warn .ix-value{color:var(--p1)}
.ix-value{font-size:14.5px;overflow-wrap:anywhere}
.field-label{font-size:11.5px;font-weight:700;color:var(--ink-3)}
.sec-head{display:flex;align-items:baseline;gap:14px;margin:40px 0 14px;font-size:15px;font-weight:800;color:var(--ink-2)}
.sec-head small{font-family:var(--text);font-stretch:100%;text-transform:none;letter-spacing:0;font-weight:400;font-size:14px;color:var(--ink-3)}

/* an exhibit */
.exhibit{margin:0 0 12px;scroll-margin-top:12px}
.exhibit:target,.exhibit.here{box-shadow:var(--shadow),0 0 0 1.5px color-mix(in oklab,var(--ink) 50%,transparent)}
.ex-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 14px;margin:0 22px;padding:14px 0 12px;border-bottom:3px double var(--rule-2)}
.tag{display:inline-flex;align-items:center;gap:7px;font-weight:800;font-size:13px;padding:3px 10px 3px 7px;border:1px solid var(--ink-2);border-radius:3px 12px 12px 3px;background:var(--sheet);color:var(--ink-1)}
.hole{width:7px;height:7px;border-radius:50%;border:1.5px solid var(--ink-2);background:var(--sheet-2)}
.ex-loc{font-size:13.5px;font-weight:600;color:var(--ink-1)}
.ex-lens{font-size:13px;color:var(--ink-3)}
.ex-marks{margin-left:auto;display:flex;align-items:center;gap:12px}
.reviewed{display:none;align-items:center;gap:4px;font-family:var(--cond);font-stretch:72%;text-transform:uppercase;letter-spacing:.08em;font-weight:800;font-size:13px;color:var(--ink-2);border:2px solid var(--ink-2);border-radius:3px;padding:4px 9px 4px 6px;transform:rotate(2.5deg)}
.reviewed svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.exhibit.done .reviewed{display:inline-flex}
.exhibit.done.pressed .reviewed{animation:press .32s cubic-bezier(.16,1,.3,1)}
@keyframes press{from{transform:rotate(2.5deg) scale(1.5);opacity:0;filter:blur(2px)}to{transform:rotate(2.5deg) scale(1);opacity:1;filter:none}}
.stamp{display:inline-flex;flex-direction:column;align-items:center;color:var(--ink);border:3px double currentColor;border-radius:4px;padding:5px 12px 5px;transform:rotate(-2.5deg);mix-blend-mode:var(--blend);line-height:1}
.st-word{font-weight:800;letter-spacing:.14em}
.st-by{font-size:11px;font-weight:700;letter-spacing:.12em;margin-top:2px}
.st-P1 .st-word{font-size:25px} .st-P2 .st-word{font-size:20px} .st-P3 .st-word{font-size:16px} .st-none .st-word{font-size:14px}
.st-plausible,.st-undecided{border-style:dashed;border-width:2px}
.st-refuted,.st-dropped{color:var(--ink-3)}
.st-small{transform:rotate(-2deg) scale(.82);transform-origin:left center}
.ex-body{display:grid;grid-template-columns:minmax(300px,5fr) minmax(0,7fr);gap:0 30px;padding:20px 22px 22px}
.claim{max-width:68ch}
.lead{margin:0 0 10px;font-size:19px;line-height:1.45;font-weight:620;letter-spacing:-.005em;text-wrap:pretty}
.rest{margin:0 0 14px;color:var(--ink-2);text-wrap:pretty}
.field{margin:14px 0 0;padding-top:8px;border-top:1px solid var(--rule)}
.field-body{font-size:15px;color:var(--ink-2)}
.field-body p{margin:3px 0 0} .field-body ul{margin:4px 0 0;padding-left:18px}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.act{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:var(--ink-1);background:var(--sheet);border:1px solid var(--rule-2);border-radius:3px;padding:6px 10px;cursor:pointer;text-decoration:none}
.act:hover{border-color:var(--ink-2)} .act:active{transform:translateY(1px)}
.act svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.act kbd{font-size:11px;color:var(--ink-3);border:1px solid var(--rule);border-radius:3px;padding:0 4px;text-transform:none}
.act.ok span{color:var(--add-ink)}
.exhibit.done .act-review{color:var(--ink-3)}
.proof{min-width:0;display:flex;flex-direction:column;gap:14px}

/* evidence */
.evidence{margin:0;border:1px solid var(--rule);border-radius:3px;background:var(--sheet);overflow:hidden}
.ev-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;padding:6px 10px;border-bottom:1px solid var(--rule);background:var(--sheet-2);font-size:12.5px}
.ev-kind{font-weight:800;font-size:11.5px;color:var(--ink-3)}
.ev-head code{color:var(--ink-1)}
.ev-rev{color:var(--ink-3);margin-left:auto;font-size:12px}
.ev-caption{margin:0;padding:7px 12px 8px;border-top:1px solid var(--rule);font-size:13.5px;color:var(--ink-2)}
.code{overflow-x:auto;font:12.5px/1.6 var(--mono);font-variant-ligatures:none}
.code-inner{display:grid;width:max-content;min-width:100%;padding:6px 0}
.row{display:flex;align-items:baseline;padding-right:12px}
.no{flex:none;width:44px;padding-right:10px;text-align:right;color:var(--ink-3);opacity:.75;font-variant-numeric:tabular-nums;user-select:none}
.diff .no{width:38px}
.sign{flex:none;width:16px;color:var(--ink-3);user-select:none}
.src{white-space:pre;padding-left:4px}
.snippet .src{padding-left:14px}
.row.add{background:var(--add)} .row.add .sign{color:var(--add-ink);font-weight:700}
.row.del{background:var(--del)} .row.del .sign,.row.del .src,.row.del .src *{color:var(--del-ink)} .row.del .src{text-decoration:line-through;text-decoration-color:color-mix(in oklab,var(--del-ink) 45%,transparent)}
.row.fold .src{color:var(--ink-3);font-style:italic;font-family:var(--text)}
.row.mark{background:color-mix(in oklab,var(--ink) 16%,var(--sheet));box-shadow:inset 3px 0 0 var(--ink)}
.leader{flex:1 0 24px;align-self:center;border-bottom:1px dashed color-mix(in oklab,var(--ink) 70%,transparent);margin:0 6px 0 14px}
.pin{flex:none;position:sticky;right:8px;font:800 11px/1 var(--cond);font-stretch:72%;letter-spacing:.06em;color:var(--sheet);background:var(--ink);padding:3px 6px 2px;border-radius:2px;box-shadow:-10px 0 0 color-mix(in oklab,var(--ink) 16%,var(--sheet))}
.t-kw{color:var(--ink-1);font-weight:650} .t-str{color:var(--ink-2)} .t-num{color:var(--ink-1)} .t-com{color:var(--ink-3);font-style:italic} .t-type{color:var(--ink-1);font-weight:550}

/* a brief, clipped to its exhibit */
.brief{margin:0 22px 22px;padding:16px 20px 20px;background:var(--sheet-2);border:1px solid var(--rule-2);border-radius:2px;position:relative;display:flex;flex-direction:column;gap:14px}
.brief-head{display:flex;align-items:center;gap:12px}
.brief-head .clip{position:absolute;top:-12px;left:18px;color:var(--ink-2)}
.brief-head .clip svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round}
.brief-by{font-family:var(--text);font-stretch:100%;text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink-3)}
.takeaway{margin:0;font-family:var(--cond);font-stretch:80%;font-size:clamp(22px,2.3vw,30px);font-weight:750;line-height:1.18;letter-spacing:-.005em;color:var(--ink-1);max-width:34ch;text-wrap:balance}
.brief-body{display:flex;flex-direction:column;gap:12px;color:var(--ink-2)}
.brief-body>:is(p,ul,ol,blockquote,table,h2,h3,h4){margin:0;max-width:72ch}
.brief-body :is(ul,ol){padding-left:20px} .brief-body li+li{margin-top:3px}
.brief-body strong{color:var(--ink-1)}
.brief-body :is(h2,h3,h4){font-family:var(--cond);font-stretch:72%;text-transform:uppercase;letter-spacing:.07em;font-size:14px;font-weight:800;color:var(--ink-1);margin-top:6px}
.brief-body blockquote{border-left:3px solid var(--rule-2);padding-left:12px}
.brief-body table{border-collapse:collapse;font-size:14px} .brief-body :is(th,td){border-bottom:1px solid var(--rule);padding:4px 12px 4px 0;text-align:left;vertical-align:top}
.brief-body th{font-family:var(--cond);font-stretch:72%;text-transform:uppercase;letter-spacing:.07em;font-size:12px;color:var(--ink-3)}
.sketch .src{padding-left:14px} .diff.sketch .src{padding-left:4px} .diff.sketch .sign{padding-left:10px;width:26px}

/* set aside */
.sleeve{margin-top:40px;padding:0;background:var(--sheet-2)}
.sleeve summary{display:flex;align-items:baseline;gap:14px;padding:14px 22px;cursor:pointer;list-style:none}
.sleeve summary::-webkit-details-marker{display:none}
.sleeve summary::before{content:"";width:8px;height:8px;border-right:2px solid var(--ink-2);border-bottom:2px solid var(--ink-2);transform:rotate(-45deg);align-self:center;transition:transform .2s}
.sleeve[open] summary::before{transform:rotate(45deg)}
.sleeve-title{font-weight:800;font-size:15px}
.aside{list-style:none;margin:0;padding:0 22px 12px}
.aside-row{padding:12px 0;border-top:1px solid var(--rule)}
.aside-top{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px}
.aside-top code{font-size:13px}
.aside-claim{margin:6px 0 4px;max-width:80ch}
.aside-why{margin:0;max-width:80ch;color:var(--ink-2);font-size:14.5px}
.aside-why .field-label{margin-right:6px}
.colophon{margin-top:28px;font-size:13px;color:var(--ink-3)}

/* views */
body.view-thought .exhibit:not(.thought){display:none}
body.view-thought .spine li a[data-thought="false"]{display:none}
/* Briefs: each briefed finding as its heading and lead sentence, then its brief */
body.view-briefs .exhibit:not(.briefed),body.view-briefs .spine li a[data-brief="false"],body.view-briefs #set-aside{display:none}
body.view-briefs .exhibit :is(.rest,.field,.proof,.act-brief){display:none}
body.view-briefs .ex-body{grid-template-columns:minmax(0,1fr);padding-bottom:6px}
body.view-briefs .claim{max-width:72ch}
body.view-briefs .index .ix-grid,body.view-briefs .brief-head{display:none}
body.view-briefs .brief{background:none;border:0;padding-top:4px}

@media (max-width:1180px){.ex-body{grid-template-columns:minmax(0,1fr)}.claim{max-width:none}.proof{margin-top:16px}}
@media (max-width:820px){
  html{scroll-padding-top:72px} .exhibit{scroll-margin-top:72px}
  body{grid-template-columns:minmax(0,1fr)}
  .spine{position:sticky;top:0;z-index:5;height:auto;display:flex;align-items:center;gap:8px;padding:8px 12px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--kraft-2);box-shadow:0 4px 10px -6px rgba(0,0,0,.3)}
  .sp-mark,.spine ol,.sp-progress{display:none}
  .sp-view{margin:0;flex:none}
  .sp-group{margin:0;flex:none}
  .sp-tab{width:auto;border-radius:4px;gap:6px;padding:5px 9px}
  .file{padding:16px 16px 48px}
  .index{padding:18px 16px 6px}
  .ix-grid{grid-template-columns:repeat(3,minmax(0,1fr));column-gap:14px}
  .ix-more>summary{display:flex;align-items:center;gap:10px;padding:9px 0;cursor:pointer;border-bottom:1px solid var(--rule);list-style:none}
  .ix-more>summary::-webkit-details-marker{display:none}
  .ix-more>summary::before{content:"";width:7px;height:7px;border-right:2px solid var(--ink-3);border-bottom:2px solid var(--ink-3);transform:rotate(-45deg);transition:transform .2s}
  .ix-more[open]>summary::before{transform:rotate(45deg)}
  .ix-docket{display:grid;grid-template-columns:repeat(5,auto);gap:4px 12px;width:100%}
  .dk{display:flex;flex-direction:column;font-size:11.5px}
  .dk b{font-size:20px}
  .h-mark{display:inline}
  .ix-field.w2,.ix-field.w3,.ix-field.w4,.ix-field.w6{grid-column:1/-1}
  .ex-head{margin:0 14px;padding:10px 0}
  .ex-marks{margin-left:0;width:100%;justify-content:flex-end}
  .ex-body{padding:14px 14px 16px}
  .brief{margin:0 12px 14px;padding:14px}
  .lead{font-size:17.5px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`

export const DOSSIER_PAGE_SCRIPT = String.raw`
(() => {
  const run = document.body.dataset.run
  const store = (() => { try { return JSON.parse(localStorage.getItem("dossier:" + run) || "{}") } catch { return {} } })()
  const save = () => { try { localStorage.setItem("dossier:" + run, JSON.stringify(store)) } catch {} }
  store.done = store.done || []
  const exhibits = [...document.querySelectorAll(".exhibit")]
  const link = (no) => document.querySelector('.spine a[data-for="' + no + '"]')
  const paint = () => {
    for (const ex of exhibits) {
      const done = store.done.includes(ex.dataset.no)
      ex.classList.toggle("done", done)
      const a = link(ex.dataset.no)
      if (a) { a.classList.toggle("done", done); a.classList.toggle("flagged", store.flag === ex.dataset.no) }
    }
    const p = document.querySelector("[data-progress]")
    if (p) p.textContent = String(store.done.length)
  }
  // The view is remembered per run; #briefs opens the page on the briefs.
  const show = (view) => {
    const button = document.querySelector('.sp-view button[data-view="' + view + '"]')
    if (!button) return
    for (const b of document.querySelectorAll(".sp-view button")) b.setAttribute("aria-checked", String(b === button))
    document.body.classList.toggle("view-thought", view === "thought")
    document.body.classList.toggle("view-briefs", view === "briefs")
  }
  show(location.hash === "#briefs" ? "briefs" : store.view || "all")
  const visible = () => exhibits.filter((ex) => ex.offsetParent !== null)
  let current = null
  const focus = (ex) => {
    if (!ex) return
    current = ex
    ex.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
    ex.focus({ preventScroll: true })
  }
  const review = (ex) => {
    if (!ex) return
    const no = ex.dataset.no
    if (store.done.includes(no)) store.done = store.done.filter((x) => x !== no)
    else { store.done.push(no); ex.classList.add("pressed"); setTimeout(() => ex.classList.remove("pressed"), 400) }
    store.flag = no
    save(); paint()
  }
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button")
    if (!t) return
    if (t.hasAttribute("data-review")) review(t.closest(".exhibit"))
    if (t.dataset.copy) {
      navigator.clipboard?.writeText(t.dataset.copy).then(() => {
        const label = t.querySelector("span"); const was = label.textContent
        label.textContent = t.dataset.done; t.classList.add("ok")
        setTimeout(() => { label.textContent = was; t.classList.remove("ok") }, 1400)
      })
    }
    if (t.dataset.view) { store.view = t.dataset.view; save(); show(store.view) }
  })
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "")) return
    const list = visible()
    const at = list.indexOf(current ?? list[0])
    if (e.key === "j") focus(list[Math.min(list.length - 1, current ? at + 1 : 0)])
    else if (e.key === "k") focus(list[Math.max(0, at - 1)])
    else if (e.key === "x") review(current ?? list[0])
    else return
    e.preventDefault()
  })
  // The spine follows the exhibit in view.
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue
      current = en.target
      document.querySelectorAll(".spine a.here").forEach((a) => a.classList.remove("here"))
      link(en.target.dataset.no)?.classList.add("here")
    }
  }, { rootMargin: "-20% 0px -70% 0px" })
  exhibits.forEach((ex) => io.observe(ex))
  if (matchMedia("(max-width: 820px)").matches) document.querySelectorAll(".ix-more").forEach((d) => { d.open = false })
  if (store.flag && !location.hash) setTimeout(() => focus(document.getElementById(store.flag)), 60)
  paint()
})()
`
