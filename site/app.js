/* Gap Finder front end. Topic data comes from data/*.json (written by the scheduled build);
   "My papers" builds citation trees live in the browser from OpenAlex and Semantic Scholar. */
import { Sources, attachText } from "./lib/sources.js";
import { pdfText } from "./lib/fulltext.js";
import { buildTree } from "./lib/tree.js";
import { analyzeTree, coverage, guessCategory, keepRegexes, profile, topicGaps, GAP_TYPES, STAGES } from "./lib/engine.js";
import { findDois, cleanText } from "./lib/text.js";
import { PROVIDERS, analyzeWithAI, complete, buildPrompt, parseJson, CHAT_SYSTEM } from "./lib/ai.js";
import { actionPlan } from "./lib/plan.js";
import { ipNote } from "./lib/patents.js";
import { exportKey, importKey, isSealed, open as openBox, unlock, CHECK } from "./lib/lock.js";
import { ruleBriefing, trendPrompt, trendTerms, TREND_SYSTEM, TREND_SCHEMA } from "./lib/trends.js";

const app = document.getElementById("app");
const overlayRoot = document.getElementById("overlay-root");
const D = { cfg: null, index: null, topics: {} };
const mem = { ai: {}, chats: {}, dropped: {} };
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/";
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import(PDFJS + "pdf.min.mjs").then((m) => { m.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs"; return m; }).catch(() => null);
  return pdfjsPromise;
}
const freePdf = (p) => p.oa_pdf || p.s2_pdf || p.upw_pdf || (p.arxiv ? "https://arxiv.org/pdf/" + p.arxiv : "");

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "#");
const ext = (u, label) => `<a href="${safeUrl(u)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); };
const empty = (msg) => `<div class="empty">${msg}</div>`;
const store = {
  get(k, session) { try { const v = (session ? sessionStorage : localStorage).getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set(k, v, session) { try { (session ? sessionStorage : localStorage).setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) {} },
};
const catById = (id) => D.cfg.categories.find((c) => c.id === id);
const topicById = (id) => { for (const c of D.cfg.categories) { const t = c.topics.find((x) => x.id === id); if (t) return { topic: t, cat: c }; } return {}; };
const topicName = (id) => (topicById(id).topic || {}).name || id;
const art = (key, seed) => window.DeviceArt(key, seed);
const noData = () => empty("No data yet. The first scheduled run fills this in, or run the <b>Update Gap Finder</b> workflow from the repo's Actions tab. You can already analyse your own papers in <a href=\"#/mine\">My papers</a>.");

function stageMark(stage) { return `<span class="stage ${stage}"><i aria-hidden="true"></i>${esc(STAGES[stage].short)}</span>`; }
function paperMeta(p, cat) {
  const pr = profile(p, cat, D.cfg);
  return `<div class="meta">${stageMark(pr.stage)}${p.tx ? '<span class="tx">TRANSACTIONS</span>' : ""}${p.ft ? `<span class="badge oa" title="Judged from the full text: ${esc(p.ft.source)}">FULL TEXT READ</span>` : p.oa ? '<span class="badge oa">OPEN ACCESS</span>' : ""}${p.via ? `<span class="badge via" title="Found by the briefing's search phrase: ${esc(p.via)}">VIA BRIEFING</span>` : ""}<span class="src">${esc(p.venue || "")}</span>${p.date ? `<span class="dot">${esc(fmtDate(p.date))}</span>` : p.year ? `<span class="dot">${p.year}</span>` : ""}${p.cited_by ? `<span class="dot">cited ${p.cited_by}×</span>` : ""}</div>`;
}
function paperCard(p, cat, opts = {}) {
  const why = p.why && (p.why.context || (p.why.intents || []).length) ? `<div class="why">${p.why.intents && p.why.intents.length ? "<b>" + esc(p.why.intents.join(", ")) + "</b> " : ""}${esc(p.why.context || "")}</div>` : "";
  const feats = profile(p, cat, D.cfg).features.map((f) => `<span class="tag">${esc((cat.features.find((x) => x.id === f) || {}).name || f)}</span>`).join("");
  return `<article class="card paper${opts.base ? " base" : ""}">
    ${opts.label ? `<span class="eyebrow">${esc(opts.label)}</span>` : ""}
    <h3>${opts.href ? `<a href="${opts.href}">${esc(p.title)}</a>` : ext(p.url, p.title)}</h3>
    ${paperMeta(p, cat)}
    ${why}
    ${p.abstract ? `<details class="abstract"><summary>Abstract</summary><p>${esc(p.abstract)}</p></details>` : ""}
    ${feats ? `<div class="tags">${feats}</div>` : ""}
    <div class="links">${ext(p.url, "Paper")}${freePdf(p) ? ext(freePdf(p), "Free PDF") : p.oa_url ? ext(p.oa_url, "Free copy") : ""}${p.doi ? ext("https://doi.org/" + p.doi, "DOI") : ""}${ext("https://scholar.google.com/scholar?q=" + encodeURIComponent(p.title), "Google Scholar")}${freePdf(p) || p.oa_url ? "" : ext("https://core.ac.uk/search?q=" + encodeURIComponent('"' + p.title + '"'), "Find on CORE")}</div>
  </article>`;
}
function banner(eyebrow, title, text, artKey, extra = "") {
  return `<div class="page-head banner"><div class="banner-art">${art(artKey, title)}</div><div class="banner-text"><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p class="muted">${text}</p>${extra}</div></div>`;
}
function sectionTitle(t, right = "") { return `<div class="section-title"><h2>${esc(t)}</h2>${right}</div>`; }
function crumbs(list) { return `<nav class="crumbs">${list.map((c, i) => (i ? "<span></span>" : "") + (c[1] ? `<a href="${c[1]}">${esc(c[0])}</a>` : esc(c[0]))).join("")}</nav>`; }

// ------------------------------------------------------------------ data
async function getJson(path) {
  let j = null;
  try { const r = await fetch(path + "?v=" + encodeURIComponent((D.index && D.index.updated) || Date.now())); j = r.ok ? await r.json() : null; } catch (e) { return null; }
  if (!isSealed(j)) return j;
  if (!D.key) return null;
  try { return await openBox(D.key, j); } catch (e) { return null; }
}

// ------------------------------------------------------------------ access code
// The data files are encrypted with the access code (see lib/lock.js); without the code nothing loads.
async function savedKey(lock) {
  const s = store.get("gf-access") || store.get("gf-access", true);
  if (!s || s.salt !== lock.salt) return null;
  try { const k = await importKey(s.key); return (await openBox(k, lock.check)) === CHECK ? k : null; } catch (e) { return null; }
}
function lockScreen(lock) {
  return new Promise((resolve) => {
    document.body.classList.add("locked");
    app.innerHTML = `<div class="lock-wrap"><form class="card form lock" id="lock-form" autocomplete="off">
      <span class="brand-mark big" aria-hidden="true"><svg viewBox="0 0 24 24" width="30" height="30"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="#fff" stroke-width="2"/><path d="M8 10V7a4 4 0 018 0v3" fill="none" stroke="#fff" stroke-width="2"/></svg></span>
      <h1>Access code</h1>
      <p class="muted">This site is private. Enter the access code to open it.</p>
      <label class="sr-only" for="lock-code">Access code</label>
      <input id="lock-code" type="password" required autofocus placeholder="Access code" autocomplete="current-password">
      <label class="check"><input type="checkbox" id="lock-remember"> Remember on this device</label>
      <div class="notice err" id="lock-err" hidden>That code is not right.</div>
      <button class="btn" type="submit">Open</button>
    </form></div>`;
    const form = document.getElementById("lock-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector("button"), err = document.getElementById("lock-err");
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Checking…'; err.hidden = true;
      const key = await unlock(lock, document.getElementById("lock-code").value);
      if (!key) { btn.disabled = false; btn.textContent = "Open"; err.hidden = false; document.getElementById("lock-code").select(); return; }
      const remember = document.getElementById("lock-remember").checked;
      store.set("gf-access", { salt: lock.salt, key: await exportKey(key) }, !remember);
      document.body.classList.remove("locked");
      resolve(key);
    });
  });
}
async function gate() {
  let lock = null;
  try { const r = await fetch("data/lock.json?v=" + Date.now()); lock = r.ok ? await r.json() : null; } catch (e) {}
  if (!lock || !lock.salt) return;
  D.locked = true;
  D.key = (await savedKey(lock)) || (await lockScreen(lock));
}
function lockOut() { store.del("gf-access"); location.hash = "#/"; location.reload(); }
async function loadTopic(id) {
  if (!(id in D.topics)) D.topics[id] = await getJson("data/topics/" + id + ".json");
  return D.topics[id];
}
async function categoryPool(cat) {
  const files = await Promise.all(cat.topics.map((t) => loadTopic(t.id)));
  return files.filter(Boolean).flatMap((f) => f.pool || []);
}

// ------------------------------------------------------------------ gaps
function normGaps(analysis, ai) {
  const out = [];
  if (ai && ai.gaps) ai.gaps.forEach((g) => out.push({ source: "ai", title: g.title, stage: g.stage, why: g.why, evidence: g.evidence_ids || [], steps: g.next_steps || [], tools: g.tools || [], outcome: g.expected_outcome || "" }));
  (analysis.gaps || []).forEach((g) => out.push({ source: "rules", type: g.type, feature: g.feature, title: g.title, stage: GAP_TYPES[g.type].stage, label: GAP_TYPES[g.type].label, why: g.why, evidence: g.evidence || [], steps: g.steps || [], tools: g.tools || [], compact: g.compact_model, quotes: g.quotes }));
  return out;
}
function gapTile(g, i, from) {
  return `<button type="button" class="card hover gap-tile${from ? " has-from" : ""}" data-gap="${i}">
    <div class="meta"><span class="badge st">${esc(g.stage || "")}</span>${g.source === "ai" ? '<span class="badge ai">AI</span>' : ""}${g.ip && /^Open for IP/.test(g.ip) ? '<span class="badge ip open">OPEN FOR IP</span>' : g.ip && /^Crowded/.test(g.ip) ? '<span class="badge ip crowded">CROWDED</span>' : ""}</div>
    <h3>${esc(g.title)}</h3>
    <p>${esc(g.why)}</p>
    ${from ? `<div class="from">From: ${esc(from)}</div>` : ""}
    <div class="foot"><span>${g.evidence.length ? g.evidence.length + " supporting paper" + (g.evidence.length > 1 ? "s" : "") : ""}</span><span class="read">${g.route ? esc(g.route) + " →" : "Next steps →"}</span></div>
  </button>`;
}
function gapGrid(gaps, lookup, cat, froms, ipData) {
  if (!gaps.length) return empty("No gaps found by the checks for this paper.");
  if (ipData && ipData.ip) gaps.forEach((g) => { if (g.ip == null) g.ip = ipNote(g, ipData.ip, ipData.patents_total || 0); });
  gaps.forEach((g) => { if (!g.plan) { g.plan = actionPlan(g, cat); g.route = g.plan && g.plan.short; } });
  const html = `<div class="tiles gaps">${gaps.map((g, i) => gapTile(g, i, froms && froms[i])).join("")}</div>`;
  setTimeout(() => {
    app.querySelectorAll(".gap-tile[data-gap]").forEach((el) => el.addEventListener("click", () => openGap(gaps[+el.dataset.gap], lookup, cat)));
  });
  return html;
}
function planHtml(plan, g) {
  return `<section class="plan">
    <h4>Your plan: ${esc(plan.label)}</h4>
    <p class="small muted">${esc(plan.effort)}. Work through the phases in order; each one names the tools and what to set up.</p>
    ${plan.phases.map((ph, i) => `<div class="phase"><div class="ph-head"><span class="ph-n">${i + 1}</span><b>${esc(ph.title)}</b></div>
      ${ph.tools.length ? `<div class="tags">${ph.tools.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
      <ul>${ph.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`).join("")}
    <div class="outcome"><span class="eyebrow">What you get at the end</span><p>${esc(g.outcome || plan.outcome)}</p></div>
  </section>`;
}
function openGap(g, lookup, cat) {
  const ev = g.evidence.map((id) => lookup(id)).filter(Boolean);
  overlayRoot.innerHTML = `<div class="overlay" role="dialog" aria-modal="true" aria-label="${esc(g.title)}"><div class="sheet">
    <button class="icon-btn plain close" type="button" aria-label="Close">✕</button>
    <div class="meta"><span class="badge st">${esc(g.stage || "")}</span>${g.source === "ai" ? '<span class="badge ai">AI</span>' : `<span class="small muted">${esc(g.label || "Rule check")}</span>`}</div>
    <h2>${esc(g.title)}</h2>
    ${g.quotes ? `<p>The paper's own words:</p>${g.quotes.map((q) => `<blockquote class="why">${esc(q)}</blockquote>`).join("")}` : `<p>${esc(g.why)}</p>`}
    ${g.steps.length ? `<h4>${g.plan ? "First, for this paper" : "What you can do"}</h4><ol>${g.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
    ${g.tools.length ? `<div class="tags">${g.tools.map((t) => `<span class="tag topic">${esc(t)}</span>`).join("")}</div>` : ""}
    ${g.ip ? `<div class="notice ipnote"><b>Patents:</b> ${esc(g.ip)}</div>` : ""}
    ${g.plan ? planHtml(g.plan, g) : g.compact ? `<h4>Compact model</h4><p>${esc(g.compact)}</p>` : ""}
    ${ev.length ? `<h4>Based on these papers</h4><div class="list">${ev.map((p) => paperCard(p, cat)).join("")}</div>` : ""}
  </div></div>`;
  const close = () => { overlayRoot.innerHTML = ""; document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  overlayRoot.querySelector(".close").addEventListener("click", close);
  overlayRoot.querySelector(".overlay").addEventListener("click", (e) => { if (e.target.classList.contains("overlay")) close(); });
  overlayRoot.querySelector(".close").focus();
}

// ------------------------------------------------------------------ citation tree diagram
// columns: [{title, items: [{p, links: [ids in the next column], hot, ring, seed}]}]
function treeSvg(columns, cat, idPrefix) {
  const W = 1200, colW = W / columns.length, rowH = 26, top = 54;
  const maxRows = Math.max(1, ...columns.map((c) => c.items.length));
  const H = top + maxRows * rowH + 24;
  const pos = {};
  columns.forEach((col, ci) => {
    const n = col.items.length, off = top + ((maxRows - n) * rowH) / 2;
    col.items.forEach((it, i) => { pos[ci + ":" + it.p.id] = { x: ci * colW + 22, y: off + i * rowH + rowH / 2 }; });
  });
  let edges = "", nodes = "", heads = "";
  columns.forEach((col, ci) => {
    heads += `<text class="col-h" x="${ci * colW + 22}" y="28">${esc(col.title)} (${col.items.length})</text>`;
    col.items.forEach((it) => {
      const a = pos[ci + ":" + it.p.id];
      (it.links || []).forEach((t) => {
        const nb = pos[(ci + 1) + ":" + t], pb = pos[(ci - 1) + ":" + t];
        if (!nb && !pb) return;
        // run from the end of the left node's label column to the right node's marker
        const [l, r] = nb ? [a, nb] : [pb, a];
        const x1 = l.x + colW - 96, x2 = r.x - 10, mx = (x1 + x2) / 2;
        edges += `<path class="edge${it.hot ? " hot" : ""}" d="M${x1} ${l.y}C${mx} ${l.y} ${mx} ${r.y} ${x2} ${r.y}"/>`;
      });
      const st = profile(it.p, cat, D.cfg).stage;
      const mark = st === "circuit" ? `<rect class="m-circuit" x="${a.x - 6}" y="${a.y - 6}" width="12" height="12" rx="2"/>` : `<circle class="m-${st}" cx="${a.x}" cy="${a.y}" r="${it.seed ? 8 : 6}"/>`;
      const maxLen = Math.floor((colW - 120) / 6.3);
      const t = it.p.title.length > maxLen ? it.p.title.slice(0, maxLen - 1) + "…" : it.p.title;
      nodes += `<g class="n" data-id="${esc(it.p.id)}" tabindex="0" role="button" aria-label="${esc(it.p.title)}"><title>${esc(it.p.title)} (${esc(STAGES[st].label)})</title>
        <rect class="hit" x="${a.x - 12}" y="${a.y - rowH / 2}" width="${colW - 14}" height="${rowH}"/>
        ${it.ring ? `<circle class="ring" cx="${a.x}" cy="${a.y}" r="11"/>` : ""}${mark}
        <text class="lbl${it.seed ? " seed" : ""}" x="${a.x + 14}" y="${a.y + 4}">${esc(t)}</text></g>`;
    });
  });
  return `<div class="tree-wrap" id="${idPrefix}-tree"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Citation tree">${heads}${edges}${nodes}</svg></div>
    <div class="legend small">${["sim", "fab", "circuit", "unknown"].map((s) => `<span class="stage ${s}"><i aria-hidden="true"></i>${esc(STAGES[s].label)}</span>`).join("")}<span class="stage"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--red)"/></svg>Base paper</span></div>
    <div class="node-detail" id="${idPrefix}-detail"><p class="muted small">Tap a paper in the tree to see what it did.</p></div>`;
}
function wireTree(idPrefix, lookup, cat) {
  const wrap = document.getElementById(idPrefix + "-tree");
  if (!wrap) return;
  const show = (g) => {
    wrap.querySelectorAll(".n.sel").forEach((x) => x.classList.remove("sel"));
    g.classList.add("sel");
    const p = lookup(g.dataset.id);
    if (p) document.getElementById(idPrefix + "-detail").innerHTML = paperCard(p, cat);
  };
  wrap.querySelectorAll(".n").forEach((g) => {
    g.addEventListener("click", () => show(g));
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(g); } });
  });
}
function singleTreeColumns(tree) {
  const N = tree.nodes, list = (ids) => (ids || []).map((id) => N[id]).filter(Boolean);
  const left = list(tree.base_citers).map((p) => ({ p, links: [tree.base], hot: true }));
  const seen = new Set(left.map((x) => x.p.id));
  for (const [rid, ids] of Object.entries(tree.ref_citers || {})) for (const p of list(ids)) if (!seen.has(p.id) && p.id !== tree.seed.id) { seen.add(p.id); left.push({ p, links: [rid] }); }
  const refs = list(tree.references).map((p) => ({ p, links: [tree.seed.id], ring: p.id === tree.base, hot: p.id === tree.base }));
  const cols = [
    { title: "Others building on its references", items: left.slice(0, 30) },
    { title: "References", items: refs },
    { title: "This paper", items: [{ p: tree.seed, seed: true, links: [] }] },
    { title: "Cited by", items: list(tree.citers).map((p) => ({ p, links: [tree.seed.id] })) },
  ];
  return cols;
}

// ------------------------------------------------------------------ AI settings
function aiSettings() { return store.get("gf-ai") || store.get("gf-ai", true); }
function updateKeyBtn() { const b = document.getElementById("key-btn"); if (b) b.classList.toggle("key-on", !!(aiSettings() && (aiSettings().key || aiSettings().provider === "compatible"))); }

function aiPanel(key, items, cat, related, stored) {
  const s = aiSettings();
  const has = s && (s.key || s.provider === "compatible");
  const result = mem.ai[key];
  return `<section id="ai-${esc(key)}">
    ${sectionTitle("AI analysis", has ? `<span class="small muted">Using ${esc(PROVIDERS[s.provider].name.split(" (")[0])} · ${esc(s.model || PROVIDERS[s.provider].model)} · <a href="#/ai">change</a></span>` : `<a href="#/ai">Add your AI key</a>`)}
    ${stored && !result ? `<p class="small muted">The gaps marked <span class="badge ai">AI</span> above were written by ${esc(stored.model || "Claude")} during the scheduled build. Run it again with your own key for a fresh view, or ask a question below.</p>` : ""}
    ${result && result.error ? `<div class="notice err">${esc(result.error)}</div>` : ""}
    ${result && result.summary ? aiResult(result, cat, key) : ""}
    <div class="row" style="display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:1rem">
      <button class="btn" type="button" data-ai-run="${esc(key)}" ${has ? "" : "disabled"}>${result && result.summary ? "Run the AI analysis again" : "Analyse this tree with AI"}</button>
      ${has ? "" : '<a class="btn ghost" href="#/ai">Add a key for Claude, OpenAI, Gemini or any OpenAI-compatible API</a>'}
    </div>
    <div class="card chat" data-chat="${esc(key)}">
      <div class="log">${(mem.chats[key] || []).map((m) => `<div class="q">${esc(m.q)}</div><div class="a">${esc(m.a)}</div>`).join("")}</div>
      <form><input type="text" placeholder="${has ? "Ask about these papers, e.g. which TCAD models are missing?" : "Add an AI key to ask questions about this tree"}" ${has ? "" : "disabled"} aria-label="Question"><button class="btn" type="submit" ${has ? "" : "disabled"}>Ask</button></form>
    </div>
  </section>`;
}
function aiResult(r, cat, key) {
  const rows = (r.applicability || []).map((a) => `<tr><td class="verdict">${esc(a.verdict)}</td><td><b>${esc(a.id)}</b> ${esc(a.note)}</td></tr>`).join("");
  return `<div class="card pad" style="margin-bottom:1rem"><span class="eyebrow">What the paper did</span><p>${esc(r.summary)}</p>${r.base_reason ? `<span class="eyebrow">Why the base paper</span><p>${esc(r.base_reason)}</p>` : ""}</div>
    ${rows ? `<h3>Is other work applicable here?</h3><div class="card pad" style="margin-bottom:1rem"><table class="applic">${rows}</table></div>` : ""}`;
}
function wireAI(key, items, cat, related, rerender) {
  const btn = app.querySelector(`[data-ai-run="${CSS.escape(key)}"]`);
  if (btn) btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Analysing… (can take a minute)';
    try { mem.ai[key] = await analyzeWithAI(aiSettings(), items, cat, D.cfg, related); }
    catch (e) { mem.ai[key] = { error: "AI request failed: " + e.message + (/fetch/i.test(e.message) ? " (the provider may block requests from browsers, or the network is down)" : "") }; }
    rerender();
  });
  const box = app.querySelector(`[data-chat="${CSS.escape(key)}"]`);
  if (box) box.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = box.querySelector("input"), q = input.value.trim();
    if (!q) return;
    input.value = ""; input.disabled = true;
    const log = box.querySelector(".log");
    log.insertAdjacentHTML("beforeend", `<div class="q">${esc(q)}</div><div class="a"><span class="spin"></span></div>`);
    const hist = mem.chats[key] = mem.chats[key] || [];
    const ctx = buildPrompt(items, cat, D.cfg, related);
    const convo = hist.map((m) => `Q: ${m.q}\nA: ${m.a}`).join("\n\n");
    let a;
    try { a = await complete(aiSettings(), CHAT_SYSTEM + "\n\n" + ctx, (convo ? convo + "\n\n" : "") + "Q: " + q, { maxTokens: 4000 }); }
    catch (err) { a = "Request failed: " + err.message; }
    hist.push({ q, a });
    log.lastElementChild.textContent = a;
    input.disabled = false; input.focus();
  });
}

// ------------------------------------------------------------------ pages
async function home() {
  const idx = D.index;
  const cats = D.cfg.categories.map((c) => {
    const ic = idx && idx.categories.find((x) => x.id === c.id);
    const papers = ic ? ic.topics.reduce((n, t) => n + t.papers, 0) : 0;
    const gaps = ic ? ic.topics.reduce((n, t) => n + t.gaps, 0) : 0;
    return { group: c.group, html: `<a class="card hover tile" href="#/c/${c.id}"><div class="media">${art(c.art, c.id)}</div><div class="body"><h3>${esc(c.name)}</h3><p>${esc(c.blurb)}</p>
      <div class="num"><span><b>${c.topics.length}</b>topics</span><span><b>${papers}</b>papers</span><span><b>${gaps}</b>gaps</span></div></div></a>` };
  });
  const latest = [];
  (idx ? idx.categories : []).forEach((ic) => ic.topics.forEach((t) => { if (t.top_gap) latest.push({ ...t, cat: ic.id }); }));
  app.innerHTML = `${banner("Research gap finder", "Find the gap, then go after it", "Memory and storage first (NAND, HBF, HBM, DRAM, MRAM, ReRAM, PCM, FeFET), power devices too. Every week it pulls the newest papers (IEEE Transactions first), reads the free full text where there is one, and builds the citation tree: the base paper, the references, who cites it, and what everyone else built on the same base. Then it tells you what is still missing: not fabricated yet, physics missing from the TCAD model, or a device nobody has put in a circuit.", "gap")}
    ${(D.cfg.groups || [{ id: null, name: "Fields" }]).map((g) => `<section>${sectionTitle(g.name, g.blurb ? `<span class="small muted">${esc(g.blurb)}</span>` : "")}<div class="tiles big">${cats.filter((c) => !g.id || c.group === g.id).map((c) => c.html).join("")}</div></section>`).join("")}
    <section>${sectionTitle("Latest gaps by topic")}${latest.length ? `<div class="tiles gaps">${latest.slice(0, 12).map((t) => `<a class="card hover gap-tile" href="#/t/${t.id}"><div class="meta"><span class="badge st">${esc(catById(t.cat).name)}</span></div><h3>${esc(t.top_gap)}</h3><p>${esc(t.name)}: ${t.papers} recent papers, ${t.gaps} gaps across ${t.seeds} citation trees.</p><div class="foot"><span>${t.tx} Transactions papers</span><span class="read">Open →</span></div></a>`).join("")}</div>` : noData()}</section>
    <section>${sectionTitle("How it works")}<div class="steps">
      <div class="card"><h3>Newest papers, weekly</h3><p>OpenAlex search per topic every Monday, last ${D.cfg.lookback_days} days, IEEE Transactions and core device journals first. Free full text from arXiv, open-access PDFs (OpenAlex, Semantic Scholar, Unpaywall) and CORE.</p></div>
      <div class="card"><h3>Citation tree</h3><p>References, the base paper (most similar and most influential reference), papers citing it, and who else builds on the base paper.</p></div>
      <div class="card"><h3>What each paper did</h3><p>From the free full text when there is one (including what the authors say is left open), otherwise the abstract: simulation/TCAD only, fabricated and measured, or used in a circuit, plus the physics it covers.</p></div>
      <div class="card"><h3>Gaps and next steps</h3><p>Not fabricated, missing TCAD physics, no circuit yet (with compact model and EDA tool), ideas from nearby topics. Add your AI key for a deeper read.</p></div>
    </div></section>`;
}

async function category(id) {
  const cat = catById(id);
  if (!cat) return notFound();
  const ic = D.index && D.index.categories.find((x) => x.id === id);
  const tiles = cat.topics.map((t) => {
    const it = ic && ic.topics.find((x) => x.id === t.id);
    return `<a class="card hover tile" href="#/t/${t.id}"><div class="media">${art(cat.art, t.id)}</div><div class="body"><h3>${esc(t.name)}</h3>
      <p>${it && it.top_gap ? "Top gap: " + esc(it.top_gap) : esc(t.search.join(" · "))}</p>
      <div class="num"><span><b>${it ? it.papers : 0}</b>papers</span><span><b>${it ? it.tx : 0}</b>Transactions</span><span><b>${it ? it.gaps : 0}</b>gaps</span>${it && it.trend && it.trend.yoy != null ? `<span title="Papers per year, last full year against the one before"><b>${it.trend.yoy >= 0 ? "+" : "−"}${Math.abs(it.trend.yoy)}%</b>per year</span>` : ""}</div></div></a>`;
  }).join("");
  app.innerHTML = `${crumbs([["Home", "#/"], [cat.name]])}${banner("Field", cat.name, esc(cat.blurb), cat.art)}
    <section>${sectionTitle("Topics")}<div class="tiles big">${tiles}</div></section>
    <section>${sectionTitle("Physics and features checked in this field")}<div class="tags">${cat.features.map((f) => `<span class="tag${f.kind === "technique" ? " topic" : ""}">${esc(f.name)}</span>`).join("")}</div>
    <p class="small muted" style="margin-top:.7rem">Grey tags are physical effects (missing ones become "add this to the TCAD model" gaps); red tags are techniques that can move between topics. Edit them in <code>site/config.json</code>.</p></section>`;
}

// ------------------------------------------------------------------ why it's hot / industry now
function yearChart(years, now = new Date()) {
  if (!years || years.length < 2) return "";
  const W = 560, H = 190, padL = 8, padR = 8, padT = 22, padB = 24;
  const max = Math.max(...years.map((y) => y.count), 1);
  const n = years.length, slot = (W - padL - padR) / n, bw = Math.max(6, Math.min(34, slot - 6));
  const cy = now.getFullYear();
  const lastFull = [...years].reverse().find((y) => y.year < cy);
  const bars = years.map((y, i) => {
    const h = Math.max(2, ((H - padT - padB) * y.count) / max), x = padL + i * slot + (slot - bw) / 2, yTop = H - padB - h, r = Math.min(4, bw / 2, h);
    const partial = y.year === cy;
    const d = `M${x},${H - padB}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + bw - r}Q${x + bw},${yTop} ${x + bw},${yTop + r}V${H - padB}Z`;
    const label = (lastFull && y.year === lastFull.year) || partial ? `<text class="v" x="${x + bw / 2}" y="${yTop - 6}" text-anchor="middle">${y.count}${partial ? " so far" : ""}</text>` : "";
    const tick = n <= 12 || i % 2 === (n - 1) % 2 ? `<text class="t" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${n > 8 ? "’" + String(y.year).slice(2) : y.year}</text>` : "";
    return `<g class="bar${partial ? " partial" : ""}"><title>${y.year}: ${y.count} papers${partial ? " (year so far)" : ""}</title><rect class="hit" x="${padL + i * slot}" y="${padT - 18}" width="${slot}" height="${H - padT - padB + 18}"></rect><path d="${d}"></path>${label}${tick}</g>`;
  }).join("");
  return `<svg class="yearchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Papers per year: ${years.map((y) => y.year + " " + y.count).join(", ")}"><line class="base" x1="${padL}" x2="${W - padR}" y1="${H - padB}" y2="${H - padB}"></line>${bars}</svg>`;
}
// ------------------------------------------------------------------ patents
function patentRow(pt, lookup) {
  const linked = (pt.links || []).map((l) => ({ l, p: lookup(l.id) })).filter((x) => x.p);
  return `<article class="card paper patent">
    <h3>${ext(pt.url, pt.title || pt.id)}</h3>
    <div class="meta"><span class="badge pat">PATENT</span><span class="src">${esc(pt.applicants.join(", ") || "Applicant not listed")}</span><span class="dot">${esc(pt.id)}</span>${pt.date ? `<span class="dot">${esc(fmtDate(pt.date))}</span>` : ""}${pt.also && pt.also.length ? `<span class="dot">also ${esc(pt.also.join(", "))}</span>` : ""}</div>
    ${pt.abstract ? `<details class="abstract"><summary>Abstract</summary><p>${esc(pt.abstract)}</p></details>` : ""}
    ${linked.length ? `<div class="pat-links"><span class="eyebrow">Connected papers</span><ul>${linked.map(({ l, p }) => `<li><b>${esc(l.kind === "cites" ? "Cited" : "Related")}:</b> ${p.url ? ext(p.url, p.title) : esc(p.title)} <span class="small muted">${esc(l.kind === "cites" ? "the patent cites this paper" : l.why)}</span></li>`).join("")}</ul></div>` : ""}
    <div class="links">${ext(pt.url, "Espacenet")}${ext(pt.gp, "Google Patents")}</div>
  </article>`;
}
function patentSection(data, lookup, cat) {
  if (!data.patents) return `<section>${sectionTitle("Patents · who is filing")}${empty("Patents are not loaded yet. Add the free <b>EPO_OPS_KEY</b> and <b>EPO_OPS_SECRET</b> secrets (developers.epo.org) and run the weekly build.")}</section>`;
  const pats = data.patents, filers = data.filers || [], ip = (data.ip || []).slice().sort((a, b) => (b.signal ? 1 : 0) - (a.signal ? 1 : 0) || b.papers + b.patents - a.papers - a.patents);
  const maxF = Math.max(1, ...filers.map((f) => f.count));
  const linked = pats.filter((p) => (p.links || []).some((l) => l.kind === "cites")).length;
  const sig = (r) => r.signal === "open" ? '<span class="badge ip open">OPEN FOR IP</span>' : r.signal === "crowded" ? '<span class="badge ip crowded">CROWDED</span>' : "";
  return `<section class="patents">${sectionTitle("Patents · who is filing", `<span class="small muted">${data.patents_total} patent families published since ${esc(fmtDate(data.patents_since))} (EPO, worldwide)</span>`)}
    <div class="trend-row">
      <div class="card pad"><span class="eyebrow">Top filers</span>${filers.length ? `<ul class="filers">${filers.map((f) => `<li title="${esc(f.name)}: ${f.count} patent families"><span>${esc(f.name)}</span><i style="--w:${Math.round((100 * f.count) / maxF)}%"></i><b>${f.count}</b></li>`).join("")}</ul>` : '<p class="small muted">No applicants listed.</p>'}</div>
      <div class="card pad"><span class="eyebrow">Papers against patents</span><p class="small muted">Recent papers and patents that mention each effect. <b>Open for IP</b>: studied in papers, rarely patented. <b>Crowded</b>: industry is filing heavily, so read the claims first.</p>
        ${ip.length ? `<table class="applic ipmap"><thead><tr><th>Effect / technique</th><th>Papers</th><th>Patents</th><th></th></tr></thead><tbody>${ip.slice(0, 12).map((r) => `<tr><td>${esc(r.name)}${r.filers.length ? `<span class="small muted"> · ${esc(r.filers.map((f) => f.name).join(", "))}</span>` : ""}</td><td class="c">${r.papers}</td><td class="c">${r.patents}</td><td>${sig(r)}</td></tr>`).join("")}</tbody></table>` : ""}
      </div>
    </div>
    <details class="pat-list"${pats.length <= 6 ? " open" : ""}><summary>Recent patents (${pats.length} shown${linked ? `, ${linked} cite papers in this topic` : ""})</summary><div class="list">${pats.slice(0, 30).map((p) => patentRow(p, lookup)).join("") || empty("No patents found for this topic in the last year.")}</div></details>
  </section>`;
}
function paperPatents(tree, data) {
  if (!data || !data.patents) return "";
  const ids = new Set([tree.seed.id, ...Object.keys(tree.nodes || {})]);
  const rel = data.patents.filter((pt) => (pt.links || []).some((l) => ids.has(l.id)));
  if (!rel.length) return "";
  const lookup = makeLookup([tree], data.pool || []);
  return `<section>${sectionTitle("Related patents", `<span class="small muted">Patents that cite or share terms with this paper or its tree</span>`)}<div class="list">${rel.slice(0, 8).map((p) => patentRow(p, lookup)).join("")}</div></section>`;
}

function trendSection(topic, cat, trend) {
  const key = "trend-" + topic.id;
  const mine = mem.ai[key];
  const t = mine && mine.why_hot ? { ...trend, ...mine } : trend || ruleBriefing(topic, {});
  const s = aiSettings();
  const has = s && (s.key || s.provider === "compatible");
  const g = t.growth || {};
  const by = mine && mine.why_hot ? `<span class="badge ai">AI</span> written with your key` : t.by === "ai" ? `<span class="badge ai">AI</span> written by ${esc(t.model || "Claude")} in the weekly build` : `background written by hand (${esc(D.cfg.brief_asof || "")}) plus this week's numbers`;
  const stat = (v, l) => `<div class="card stat"><div class="big">${v}</div><div class="lbl">${esc(l)}</div></div>`;
  const yoy = g.yoy == null ? "" : stat((g.yoy >= 0 ? "+" : "−") + Math.abs(g.yoy) + "%", `papers in ${g.last_year} vs ${g.last_year - 1}`);
  const tri = g.three_year == null ? "" : stat((g.three_year >= 0 ? "+" : "−") + Math.abs(g.three_year) + "%", `vs ${g.last_year - 3}`);
  return `<section class="trend" id="${esc(key)}">${sectionTitle("Why it’s hot · Industry now", `<span class="small muted">${by}</span>`)}
    <div class="trend-grid">
      <div class="card pad"><span class="eyebrow">Why it’s hot</span><p>${esc(t.why_hot)}</p></div>
      <div class="card pad"><span class="eyebrow">The core idea</span><p>${esc(t.core_idea)}</p></div>
      <div class="card pad"><span class="eyebrow">What industry is doing</span><p>${esc(t.industry_now)}</p></div>
    </div>
    ${(t.years && t.years.length > 1) || yoy ? `<div class="trend-row">
      <div class="card pad"><span class="eyebrow">Papers per year (OpenAlex)</span>${yearChart(t.years)}${yoy || tri ? `<div class="stats">${yoy}${tri}</div>` : ""}</div>
      <div class="card pad"><span class="eyebrow">Rising in recent papers</span>${(t.rising || []).length ? `<p class="small muted">Share of this topic’s recent papers that use the term, against papers from ${esc((t.older_window || [""])[0].slice(0, 4))}.</p><ul class="rising">${t.rising.slice(0, 8).map((r) => `<li><span>${esc(r.term)}</span><b>${r.share}%</b><i>${r.older ? r.ratio + "×" : "new"}</i></li>`).join("")}</ul>` : '<p class="small muted">Not enough recent papers to compare yet.</p>'}</div>
    </div>` : ""}
    ${(t.news || []).length ? `<div class="card pad news"><span class="eyebrow">In the news, last two months</span><ul>${t.news.map((n) => `<li>${ext(n.url, n.title)}<span class="small muted">${esc([n.source, n.date && fmtDate(n.date)].filter(Boolean).join(" · "))}</span></li>`).join("")}</ul><p class="small muted">Headlines from Google News. They are short and can be promotional, so read the article before you rely on one.</p></div>` : ""}
    ${(t.open_questions || []).length ? `<div class="card pad"><span class="eyebrow">Open questions</span><ul>${t.open_questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></div>` : ""}
    ${(t.search_terms || []).length ? `<p class="small muted">Extra search phrases from this briefing (papers found with them are marked <span class="badge via">VIA BRIEFING</span>): ${t.search_terms.map((x) => `<span class="tag">${esc(x)}</span>`).join(" ")}</p>` : ""}
    ${mine && mine.error ? `<div class="notice err">${esc(mine.error)}</div>` : ""}
    <div><button class="btn ghost" type="button" data-trend-run ${has ? "" : "disabled"}>${has ? "Rewrite this briefing with your AI key" : "Add an AI key to rewrite this briefing"}</button>${has ? "" : ' <a class="small" href="#/ai">Add a key</a>'}</div>
  </section>`;
}
function wireTrend(topic, cat, trend, pool, rerender) {
  const btn = app.querySelector("[data-trend-run]");
  if (!btn || btn.disabled) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Writing the briefing…';
    const inputs = { years: (trend && trend.years) || [], rising: (trend && trend.rising) || [], news: (trend && trend.news) || [], titles: pool.slice(0, 30).map((p) => p.title) };
    try {
      const sys = TREND_SYSTEM + (aiSettings().provider === "anthropic" ? "" : "\nReply with JSON only, matching this schema: " + JSON.stringify(TREND_SCHEMA));
      const r = parseJson(await complete(aiSettings(), sys, trendPrompt(topic, cat, inputs), { maxTokens: 6000 }));
      if (!r || !r.why_hot) throw new Error("the reply was not in the expected format");
      mem.ai["trend-" + topic.id] = { ...r, search_terms: trendTerms(topic, inputs.rising, r.search_terms || []) };
    } catch (e) { mem.ai["trend-" + topic.id] = { error: "AI request failed: " + e.message }; }
    rerender();
  });
}

async function topicPage(id) {
  const { topic, cat } = topicById(id);
  if (!topic) return notFound();
  app.innerHTML = '<p class="muted">Loading…</p>';
  const [data, catPool] = [await loadTopic(id), await categoryPool(cat)];
  if (!data) { app.innerHTML = crumbs([["Home", "#/"], [cat.name, "#/c/" + cat.id], [topic.name]]) + banner(cat.name, topic.name, "", cat.art) + trendSection(topic, cat, null) + noData(); wireTrend(topic, cat, null, [], () => topicPage(id)); return; }
  const lookupAll = makeLookup(data.seeds, data.pool);
  const allGaps = [], froms = [];
  for (const tree of data.seeds) {
    const an = analyzeTree(tree, { cat, cfg: D.cfg, topicId: id, pool: catPool, topicName });
    normGaps(an, tree.ai).slice(0, 4).forEach((g) => { allGaps.push(g); froms.push(tree.seed.title); });
  }
  const pool = data.pool || [];
  const cov = coverage(pool, cat, D.cfg);
  const tg = topicGaps(pool, cat, D.cfg);
  const counts = { sim: 0, fab: 0, circuit: 0, unknown: 0 };
  pool.forEach((p) => counts[profile(p, cat, D.cfg).stage]++);
  const st = store.get("gf-topic-stage", true) || "all";
  const shown = pool.filter((p) => st === "all" || profile(p, cat, D.cfg).stage === st);
  app.innerHTML = `${crumbs([["Home", "#/"], [cat.name, "#/c/" + cat.id], [topic.name]])}
    ${banner(cat.name, topic.name, `Recent papers since ${esc(fmtDate(data.since))}, with citation trees for the ${data.seeds.length} newest Transactions-first papers. Updated ${esc(fmtDate(data.updated))}.`, cat.art,
      `<div class="stats"><div class="card stat"><div class="big">${pool.length}</div><div class="lbl">recent papers</div></div><div class="card stat"><div class="big">${pool.filter((p) => p.tx).length}</div><div class="lbl">IEEE Transactions</div></div><div class="card stat"><div class="big">${counts.sim}</div><div class="lbl">simulation only</div></div><div class="card stat"><div class="big">${allGaps.length}</div><div class="lbl">gaps found</div></div></div>`)}
    ${trendSection(topic, cat, data.trend)}
    ${patentSection(data, lookupAll, cat)}
    <section>${sectionTitle("Research gaps")}${gapGrid(allGaps, lookupAll, cat, froms, data)}</section>
    <section>${sectionTitle("Citation trees")}<div class="list">${data.seeds.map((t) => paperCard(t.seed, cat, { href: `#/p/${id}/${t.seed.id}`, label: `${t.references.length} references · ${t.citers.length} citing · ${t.base_citers.length} building on the base paper` })).join("") || empty("No seed papers yet.")}</div></section>
    <section>${sectionTitle("Where the field is thin")}<p class="small muted">How many recent papers in this topic touch each effect, split by stage. Pale or empty cells are where nobody has gone yet.</p>
      <div class="card pad cov-wrap">${covTable(cov)}</div>
      ${tg.length ? `<ul class="small" style="margin-top:.8rem">${tg.slice(0, 8).map((g) => `<li>${esc(g.text)}</li>`).join("")}</ul>` : ""}</section>
    <section>${sectionTitle("Recent papers", `<div class="chips" id="stage-chips">${["all", "sim", "fab", "circuit", "unknown"].map((s) => `<button type="button" class="chip${s === st ? " active" : ""}" data-st="${s}">${s === "all" ? "All" : esc(STAGES[s].short)}<span class="count">${s === "all" ? pool.length : counts[s]}</span></button>`).join("")}</div>`)}
      <div class="list">${shown.slice(0, 60).map((p) => paperCard(p, cat)).join("") || empty("No papers at this stage.")}</div></section>`;
  app.querySelectorAll("#stage-chips .chip").forEach((b) => b.addEventListener("click", () => { store.set("gf-topic-stage", b.dataset.st, true); topicPage(id); }));
  wireTrend(topic, cat, data.trend, pool, () => topicPage(id));
}
function covTable(rows) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.sim, r.fab, r.circuit]));
  const cell = (v, label, name) => `<td class="c h${v ? Math.min(4, Math.ceil((4 * v) / max)) : 0}" title="${esc(name)}: ${v} ${label} paper${v === 1 ? "" : "s"}">${v}</td>`;
  return `<table class="cov"><thead><tr><th>Effect / technique</th><th>Simulation</th><th>Fabricated</th><th>Circuit</th><th>All</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="l">${esc(r.name)}<span class="k">${r.kind === "technique" ? "technique" : ""}</span></td>${cell(r.sim, "simulation", r.name)}${cell(r.fab, "fabricated", r.name)}${cell(r.circuit, "circuit-level", r.name)}<td class="c">${r.total}</td></tr>`).join("")}</tbody></table>`;
}
function makeLookup(trees, pool) {
  const m = {};
  (pool || []).forEach((p) => { m[p.id] = p; });
  trees.forEach((t) => { Object.assign(m, t.nodes); m[t.seed.id] = t.seed; });
  return (id) => m[id];
}

async function paperPage(topicId, seedId) {
  const { topic, cat } = topicById(topicId);
  if (!topic) return notFound();
  const data = await loadTopic(topicId);
  const tree = data && data.seeds.find((t) => t.seed.id === seedId);
  if (!tree) return notFound();
  const catPool = await categoryPool(cat);
  renderPaper(tree, cat, { topicId, pool: catPool, ipData: data, crumbs: [["Home", "#/"], [cat.name, "#/c/" + cat.id], [topic.name, "#/t/" + topicId], ["Paper"]], rerender: () => paperPage(topicId, seedId) });
}

function renderPaper(tree, cat, opts) {
  const an = analyzeTree(tree, { cat, cfg: D.cfg, topicId: opts.topicId, pool: opts.pool, topicName });
  const key = tree.seed.id;
  const ai = mem.ai[key] && mem.ai[key].gaps ? mem.ai[key] : tree.ai;
  const gaps = normGaps(an, ai);
  const lookup = makeLookup([tree], opts.pool);
  const pr = profile(tree.seed, cat, D.cfg);
  const base = tree.nodes[tree.base];
  const N = tree.nodes, list = (ids) => (ids || []).map((id) => N[id]).filter(Boolean);
  const related = (opts.pool || []).filter((p) => p.id !== tree.seed.id).slice(0, 25);
  app.innerHTML = `${crumbs(opts.crumbs)}
    <article class="card lead-paper"><span class="eyebrow">${esc(cat.name)} · ${tree.seed.tx ? "IEEE Transactions paper" : "Paper"}</span>
      <h1>${esc(tree.seed.title)}</h1>${paperMeta(tree.seed, cat)}
      <p class="small muted" style="margin-top:.5rem">${esc((tree.seed.authors || []).join(", "))}</p>
      <p><b>What it did:</b> ${esc((ai && ai.summary) || an.summary)}</p>
      ${tree.seed.abstract ? `<details class="abstract"><summary>Abstract</summary><p>${esc(tree.seed.abstract)}</p></details>` : ""}
      <div class="links">${ext(tree.seed.url, "Paper")}${freePdf(tree.seed) ? ext(freePdf(tree.seed), "Free PDF") : tree.seed.oa_url ? ext(tree.seed.oa_url, "Free copy") : ""}${tree.seed.doi ? ext("https://doi.org/" + tree.seed.doi, "DOI") : ""}${ext("https://scholar.google.com/scholar?q=" + encodeURIComponent(tree.seed.title), "Google Scholar")}</div>
      <p class="small muted">${tree.seed.ft ? `Read from the free full text (${esc(tree.seed.ft.source)}, about ${tree.seed.ft.words} words).` : "No free full text found, so this is judged from the title and abstract."}</p></article>
    <section>${sectionTitle("Research gaps")}${gapGrid(gaps, lookup, cat, null, opts.ipData)}</section>
    <section>${sectionTitle("Citation tree", `<span class="small muted">${tree.seed.refs_total || tree.references.length} references in total; the most relevant ${tree.references.length} shown</span>`)}${treeSvg(singleTreeColumns(tree), cat, "t")}</section>
    ${base ? `<section>${sectionTitle("Base paper")}${paperCard(base, cat, { base: true })}<p class="small" style="margin-top:.6rem">${esc((ai && ai.base_reason) || an.base_reason)}</p></section>` : ""}
    ${paperPatents(tree, opts.ipData)}
    ${aiPanel(key, [{ tree, analysis: an }], cat, related, tree.ai)}
    <section class="cols-2"><div>${sectionTitle("Cited by")}<div class="list">${list(tree.citers).map((p) => paperCard(p, cat)).join("") || empty("Nobody has cited it yet.")}</div></div>
      <div>${sectionTitle("Building on the base paper")}<div class="list">${list(tree.base_citers).map((p) => paperCard(p, cat)).join("") || empty("No other papers found.")}</div></div></section>
    <section>${sectionTitle("References")}<div class="list">${list(tree.references).map((p) => paperCard(p, cat, { base: p.id === tree.base, label: p.id === tree.base ? "Base paper" : "" })).join("")}</div></section>`;
  wireTree("t", lookup, cat);
  wireAI(key, [{ tree, analysis: an }], cat, related, opts.rerender);
}

// ------------------------------------------------------------------ AI key page
function aiPage() {
  const s = aiSettings() || { provider: "anthropic", model: "", key: "", base: "" };
  const remembered = !!store.get("gf-ai");
  app.innerHTML = `${crumbs([["Home", "#/"], ["AI key"]])}
    ${banner("Bring your own key", "Analyse with any AI", "Add a key for Claude, OpenAI, Gemini or any OpenAI-compatible API (OpenRouter, Groq, Mistral, DeepSeek, a local Ollama or LM Studio server). The key stays in this browser and goes only to the provider you pick. Then every citation tree gets an <b>Analyse with AI</b> button and a question box.", "ai")}
    <form class="card form" id="ai-form" autocomplete="off">
      <label>Provider<select name="provider">${Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}"${k === s.provider ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
      <label>API key<input type="password" name="key" value="${esc(s.key || "")}" placeholder="${esc(PROVIDERS[s.provider].keyHint)}"></label>
      <label>Model<input type="text" name="model" value="${esc(s.model || "")}" placeholder="${esc(PROVIDERS[s.provider].model || "model name, e.g. meta-llama/llama-3.3-70b-instruct")}"></label>
      <label id="base-row"${s.provider === "compatible" ? "" : " hidden"}>Base URL<input type="url" name="base" value="${esc(s.base || "")}" placeholder="${esc(PROVIDERS.compatible.base)} (or http://localhost:11434/v1 for Ollama)"></label>
      <label class="check"><input type="checkbox" name="remember"${remembered ? " checked" : ""}> Remember on this device (otherwise it is forgotten when you close the tab)</label>
      <div class="row"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" id="ai-test">Save and test</button><button class="btn ghost" type="button" id="ai-clear">Remove key</button>
        <span id="key-link" class="small">${PROVIDERS[s.provider].keyUrl ? ext(PROVIDERS[s.provider].keyUrl, "Get a key") : ""}</span></div>
      <div id="ai-msg"></div>
    </form>
    <p class="small muted" style="margin-top:1rem">Requests go straight from your browser to the provider and are billed to your key. Claude requests use <code>${esc(PROVIDERS.anthropic.model)}</code> by default with structured JSON output; OpenAI uses JSON-schema output; other providers are asked for JSON. Some providers block calls from web pages; if a test fails with a network error, use a provider that allows it (Anthropic, OpenAI, Gemini, OpenRouter and local servers do).</p>`;
  const f = document.getElementById("ai-form");
  const read = () => ({ provider: f.provider.value, key: f.key.value.trim(), model: f.model.value.trim(), base: f.base.value.trim() });
  f.provider.addEventListener("change", () => {
    const p = PROVIDERS[f.provider.value];
    f.key.placeholder = p.keyHint; f.model.placeholder = p.model || "model name";
    document.getElementById("base-row").hidden = f.provider.value !== "compatible";
    document.getElementById("key-link").innerHTML = p.keyUrl ? ext(p.keyUrl, "Get a key") : "";
  });
  const save = () => { const v = read(); store.del("gf-ai"); store.set("gf-ai", v, !f.remember.checked); updateKeyBtn(); return v; };
  const msg = (h) => { document.getElementById("ai-msg").innerHTML = h; };
  f.addEventListener("submit", (e) => { e.preventDefault(); save(); msg('<div class="notice">Saved. Open any paper and press <b>Analyse this tree with AI</b>.</div>'); });
  document.getElementById("ai-test").addEventListener("click", async () => {
    const v = save(); msg('<p class="progress"><span class="spin"></span>Testing…</p>');
    try { const a = await complete(v, "Reply with the single word: ready", "Say ready.", { maxTokens: 400 }); msg(`<div class="notice">Works. The model replied: “${esc(cleanText(a, 80))}”.</div>`); }
    catch (e) { msg(`<div class="notice err">Test failed: ${esc(e.message)}</div>`); }
  });
  document.getElementById("ai-clear").addEventListener("click", () => { store.del("gf-ai"); updateKeyBtn(); aiPage(); });
}

// ------------------------------------------------------------------ My papers
const MINE_TREE = { references: 12, citers: 12, base_citers: 10, ref_citers_for: 2, ref_citers: 6 };
// Returns the lines to add to the input box. A dropped PDF is also read in full (pdf.js), so the
// user's own paper is judged from its full text, including its limitations and future work.
async function readFileIds(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const pdfjs = await loadPdfjs();
    let text = "";
    if (pdfjs) { try { text = await pdfText(pdfjs, buf.slice()); } catch (e) { text = ""; } }
    let raw = "";
    for (let i = 0; i < Math.min(buf.length, 4e6); i += 65536) raw += String.fromCharCode.apply(null, buf.subarray(i, i + 65536));
    const meta = raw.match(/(?:prism:doi|pdfx:doi|crossmark:DOI|dc:identifier)[^>]*>\s*(?:doi:)?\s*(10\.\d{4,9}\/[^<\s]+)/i);
    const firstPage = text.slice(0, 4000);
    let id = meta ? meta[1] : (findDois(firstPage)[0] || "");
    if (!id) {
      const t = raw.match(/\/Title\s*\(((?:\\.|[^\\)]){12,300})\)/);
      id = t ? t[1].replace(/\\(.)/g, "$1") : cleanText(firstPage.split("\n").find((l) => l.trim().length > 25) || "", 200);
    }
    if (!id) return [];
    if (text.length > 1500) mem.dropped[id.toLowerCase()] = { text, name: file.name };
    return [id];
  }
  const text = await file.text();
  const dois = findDois(text);
  return dois.length ? dois : text.split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 8).slice(0, 10);
}
function mineState() { return store.get("gf-mine") || { input: "", cat: "auto", trees: [] }; }

function minePage(sub) {
  const S = mineState();
  if (sub) {
    const tree = S.trees.find((t) => t.seed.id === sub);
    if (!tree) return notFound();
    const cat = catById(S.catUsed) || D.cfg.categories[0];
    const pool = mineLocalPool(S, tree.seed.id);
    return renderPaper(tree, cat, { topicId: null, pool, crumbs: [["Home", "#/"], ["My papers", "#/mine"], ["Paper"]], rerender: () => minePage(sub) });
  }
  app.innerHTML = `${crumbs([["Home", "#/"], ["My papers"]])}
    ${banner("Your own papers", "Find the gap between your papers", "Add one paper or several (DOI, arXiv id, OpenAlex link or title, one per line; or drop PDFs or a .bib / .ris file). Dropped PDFs are read in full in your browser, and for the others it looks for a free legal copy (arXiv, open-access PDFs). For each one it builds a local citation tree: its references, who cited them, who cited your paper, and what those people did. Then it checks whether their work applies to yours or is already done, and lists the gaps.", "gap")}
    <form class="card form" id="mine-form">
      <label>Papers (one per line)<textarea name="input" placeholder="10.1109/TED.2025.1234567&#10;2501.01234&#10;A title of a paper you want to compare">${esc(S.input || "")}</textarea></label>
      <div class="drop" id="drop" tabindex="0" role="button">Drop PDF, .bib, .ris or .txt files here, or click to choose<input type="file" id="file" multiple accept=".pdf,.bib,.ris,.txt" hidden></div>
      <div class="row"><label style="flex:1;min-width:200px">Field<select name="cat"><option value="auto">Work it out from the papers</option>${D.cfg.categories.map((c) => `<option value="${c.id}"${S.cat === c.id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
        <label class="check" style="margin-top:1.2rem"><input type="checkbox" name="s2" checked> Ask Semantic Scholar why papers cite each other (slower)</label></div>
      <div class="row"><button class="btn" type="submit">Build the local tree</button>${S.trees.length ? '<button class="btn ghost" type="button" id="mine-clear">Clear</button>' : ""}</div>
      <div id="mine-progress"></div>
    </form>
    <div id="mine-results">${S.trees.length ? mineResults(S) : ""}</div>`;
  const f = document.getElementById("mine-form");
  const drop = document.getElementById("drop"), file = document.getElementById("file");
  const addFiles = async (files) => {
    for (const fl of files) {
      const ids = await readFileIds(fl);
      f.input.value = (f.input.value.trim() + "\n" + (ids.length ? ids.join("\n") : "# no DOI found in " + fl.name + ": paste its DOI or title")).trim();
    }
  };
  drop.addEventListener("click", () => file.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter") file.click(); });
  file.addEventListener("change", () => addFiles(file.files));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
  const clr = document.getElementById("mine-clear");
  if (clr) clr.addEventListener("click", () => { store.del("gf-mine"); minePage(); });
  f.addEventListener("submit", (e) => { e.preventDefault(); buildMine(f.input.value, f.cat.value, f.s2.checked); });
  if (S.trees.length) wireMine(S);
}

async function buildMine(input, catChoice, useS2) {
  const lines = input.split(/\n+/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#")).slice(0, 8);
  const prog = document.getElementById("mine-progress");
  const say = (t) => { prog.innerHTML = `<p class="progress"><span class="spin"></span>${esc(t)}</p>`; };
  if (!lines.length) { prog.innerHTML = '<div class="notice err">Add at least one DOI, arXiv id or title.</div>'; return; }
  say("Getting ready…");
  const pdfjs = await loadPdfjs();
  const src = new Sources({ useS2, pause: 120, pdfjs, keepRx: keepRegexes(D.cfg), timeout: 15000 });
  const seeds = [], missed = [];
  for (const q of lines) {
    say("Finding " + q.slice(0, 60) + "…");
    const p = await src.resolve(q);
    if (p && !seeds.find((s) => s.id === p.id)) {
      const mine = mem.dropped[q.toLowerCase()];
      if (mine) attachText(p, mine.text, "Your PDF (" + mine.name + ")", "", keepRegexes(D.cfg));
      seeds.push(p);
    } else if (!p) missed.push(q);
  }
  if (!seeds.length) { prog.innerHTML = `<div class="notice err">Could not find ${missed.map(esc).join(", ")} on OpenAlex. Check the DOI, or try the exact title.</div>`; return; }
  const trees = [];
  for (const [i, seed] of seeds.entries()) {
    const tree = await buildTree(src, seed, { tree: MINE_TREE, fullText: true, onStep: (s) => say(`Paper ${i + 1} of ${seeds.length}: ${s}…`) });
    trees.push(tree);
  }
  const cat = catChoice === "auto" ? guessCategory(trees.map((t) => t.seed), D.cfg) : catById(catChoice);
  const S = { input, cat: catChoice, catUsed: cat.id, trees, missed, built: new Date().toISOString() };
  if (!store.set("gf-mine", S)) prog.innerHTML = '<div class="notice">Built, but too large to keep after you leave this page.</div>';
  mem.mineCache = S;
  minePage();
  if (missed.length) document.getElementById("mine-progress").innerHTML = `<div class="notice">Not found: ${missed.map(esc).join(", ")}</div>`;
}
function mineLocalPool(S, exceptSeed) {
  const m = {};
  S.trees.forEach((t) => { if (t.seed.id !== exceptSeed) m[t.seed.id] = t.seed; Object.values(t.nodes).forEach((p) => { if (p.id !== exceptSeed) m[p.id] = p; }); });
  return Object.values(m);
}
function mineResults(S) {
  const cat = catById(S.catUsed) || D.cfg.categories[0];
  const pool = mineLocalPool(S);
  // shared ground: papers that appear in more than one of the user's trees
  const seen = {};
  S.trees.forEach((t, i) => [t.seed.id, ...t.references, ...t.citers, ...t.base_citers].forEach((id) => { (seen[id] = seen[id] || new Set()).add(i); }));
  const sharedIds = Object.entries(seen).filter(([, s]) => s.size > 1).map(([id]) => id);
  const lookup = makeLookup(S.trees, pool);
  const per = S.trees.map((t) => ({ tree: t, analysis: analyzeTree(t, { cat, cfg: D.cfg, topicId: null, pool: mineLocalPool(S, t.seed.id), topicName }) }));
  const gaps = [], froms = [];
  per.forEach(({ tree, analysis }) => normGaps(analysis, null).slice(0, 4).forEach((g) => { gaps.push(g); froms.push(tree.seed.title); }));
  pairGaps(S.trees, cat).forEach((g) => { gaps.unshift(g.gap); froms.unshift(g.from); });
  const ai = mem.ai.mine && mem.ai.mine.gaps ? normGaps({ gaps: [] }, mem.ai.mine) : [];
  ai.reverse().forEach((g) => { gaps.unshift(g); froms.unshift("AI, across all your papers"); });
  // combined local tree: all references -> your papers -> all citing papers
  const refsCol = new Map(), citCol = new Map();
  S.trees.forEach((t) => {
    t.references.forEach((id) => { const p = t.nodes[id]; if (!p) return; const e = refsCol.get(id) || { p, links: [], ring: false, hot: false }; e.links.push(t.seed.id); e.hot = e.hot || e.links.length > 1 || id === t.base; e.ring = e.ring || id === t.base; refsCol.set(id, e); });
    t.citers.forEach((id) => { const p = t.nodes[id]; if (!p) return; const e = citCol.get(id) || { p, links: [] }; e.links.push(t.seed.id); e.hot = e.links.length > 1; citCol.set(id, e); });
  });
  const byLinks = (a, b) => b.links.length - a.links.length;
  const cols = [
    { title: "References", items: [...refsCol.values()].sort(byLinks).slice(0, 40) },
    { title: "Your papers", items: S.trees.map((t) => ({ p: t.seed, seed: true })) },
    { title: "Cited by", items: [...citCol.values()].sort(byLinks).slice(0, 40) },
  ];
  mem.mineRun = { per, cat, pool, lookup };
  return `<section>${sectionTitle("Your papers", `<span class="small muted">Field: ${esc(cat.name)}</span>`)}<div class="list">${S.trees.map((t) => paperCard(t.seed, cat, { href: "#/mine/" + t.seed.id, label: `${t.references.length} references · ${t.citers.length} citing · ${t.base_citers.length} building on its base paper. Open its own tree →` })).join("")}</div></section>
    <section>${sectionTitle("Research gaps")}${gapGrid(gaps, lookup, cat, froms)}</section>
    <section>${sectionTitle("Local citation tree", `<span class="small muted">${sharedIds.length} papers shared between your trees</span>`)}${treeSvg(cols, cat, "m")}</section>
    ${sharedIds.length ? `<section>${sectionTitle("Common ground")}<p class="small muted">Papers that appear in more than one of your trees: start reading here.</p><div class="list">${sharedIds.slice(0, 12).map((id) => lookup(id)).filter(Boolean).map((p) => paperCard(p, cat)).join("")}</div></section>` : ""}
    ${aiPanel("mine", per, cat, [], null)}`;
}
function wireMine(S) {
  const r = mem.mineRun;
  wireTree("m", r.lookup, r.cat);
  wireAI("mine", r.per, r.cat, [], () => minePage());
}
// Between the user's own papers: a technique one paper (or the papers citing it) uses that another lacks.
function pairGaps(trees, cat) {
  const out = [];
  if (trees.length < 2) return out;
  const prof = (p) => profile(p, cat, D.cfg);
  for (const a of trees) for (const b of trees) {
    if (a === b) continue;
    const fa = new Set(prof(a.seed).features);
    const fb = prof(b.seed).features.filter((f) => !fa.has(f));
    for (const f of fb.slice(0, 1)) {
      const feat = cat.features.find((x) => x.id === f);
      out.push({
        from: a.seed.title,
        gap: {
          source: "rules", type: "cross_topic", stage: "Between your papers", label: "Between your papers",
          title: `Apply ${feat.name.toLowerCase()} from “${cleanText(b.seed.title, 50)}”`,
          why: `“${cleanText(b.seed.title, 80)}” covers ${feat.name.toLowerCase()}; “${cleanText(a.seed.title, 80)}” does not mention it. Check whether it applies there.`,
          evidence: [b.seed.id], steps: ["Compare the two device structures and operating conditions.", feat.tcad], tools: [],
        },
      });
    }
    if (out.length >= 4) break;
  }
  if (trees.length >= 2) {
    const fab = trees.filter((t) => prof(t.seed).fab), sim = trees.filter((t) => prof(t.seed).sim && !prof(t.seed).fab);
    if (fab.length && sim.length) out.push({ from: sim[0].seed.title, gap: { source: "rules", type: "not_fabricated", stage: "Between your papers", label: "Between your papers", title: "Use your fabricated paper to calibrate the simulated one", why: `“${cleanText(sim[0].seed.title, 80)}” is simulation-only, while “${cleanText(fab[0].seed.title, 80)}” has measured devices. Calibrating one against the other makes both stronger.`, evidence: [fab[0].seed.id, sim[0].seed.id], steps: ["Match the TCAD structure to the fabricated device.", "Fit mobility, trap and contact parameters to the measured curves.", "Re-run the simulated proposal with the calibrated deck."], tools: ["Synopsys Sentaurus", "Silvaco Atlas"] } });
  }
  return out.slice(0, 5);
}

function notFound() { app.innerHTML = empty('Page not found. <a href="#/">Go home</a>.'); }

// ------------------------------------------------------------------ router
async function route() {
  overlayRoot.innerHTML = "";
  const parts = (location.hash.replace(/^#\/?/, "") || "").split("/").filter(Boolean);
  const [a, b, c] = parts;
  document.querySelectorAll("#nav a").forEach((l) => l.classList.toggle("active",
    (!a && l.dataset.route === "home") || (a === "c" && l.dataset.route === b) || (a === "mine" && l.dataset.route === "mine") ||
    ((a === "t" || a === "p") && l.dataset.route === (topicById(b).cat || {}).id)));
  window.scrollTo(0, 0);
  if (!a) await home();
  else if (a === "c") await category(b);
  else if (a === "t") await topicPage(b);
  else if (a === "p") await paperPage(b, c);
  else if (a === "mine") minePage(b);
  else if (a === "ai") aiPage();
  else notFound();
  app.classList.remove("fade-in"); void app.offsetWidth; app.classList.add("fade-in");
}

function themeToggle() {
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const root = document.documentElement;
    const cur = root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("gf-theme", next); } catch (e) {}
  });
}

async function init() {
  themeToggle();
  updateKeyBtn();
  await gate();
  D.cfg = await (await fetch("config.json?v=" + Date.now())).json();
  D.index = await getJson("data/index.json");
  const meta = document.getElementById("footer-meta");
  if (D.index) meta.textContent = `Field data updated ${fmtDate(D.index.updated)}${D.index.ai ? " · gaps refined by Claude" : ""}.`;
  if (D.locked) {
    meta.insertAdjacentHTML("beforeend", ' <button type="button" class="linkish" id="lock-out">Lock this device</button>');
    document.getElementById("lock-out").addEventListener("click", lockOut);
  }
  window.addEventListener("hashchange", route);
  route();
}
init();
