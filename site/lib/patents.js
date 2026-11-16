// Patents: who is filing in each topic, which papers the patents connect to, and what that says
// about the gaps. Source: EPO Open Patent Services (OPS), free with registration, worldwide
// coverage (US, EP, WO, CN, KR, JP, TW …). Called from the scheduled build only, because OPS
// needs a secret key and does not allow browser requests.

import { cleanText, findDois, jaccard, normTitle, shared, tokens } from "./text.js";
import { profile } from "./engine.js";

export const OPS = "https://ops.epo.org/3.2";

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = (x) => (x == null ? "" : typeof x === "string" ? x : x.$ != null ? String(x.$) : "");

// ------------------------------------------------------------------ OPS client
export class Ops {
  constructor({ key, secret, fetch, log, pause = 400 } = {}) {
    this.key = key; this.secret = secret;
    this.fetch = fetch || ((...a) => globalThis.fetch(...a));
    this.log = log || (() => {});
    this.pause = pause;
    this.token = null; this.expires = 0; this.calls = 0; this.off = !key || !secret;
  }

  async auth() {
    if (this.token && Date.now() < this.expires - 60000) return this.token;
    const basic = typeof btoa === "function" ? btoa(this.key + ":" + this.secret) : Buffer.from(this.key + ":" + this.secret).toString("base64");
    const r = await this.fetch(OPS + "/auth/accesstoken", {
      method: "POST",
      headers: { authorization: "Basic " + basic, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!r.ok) { this.log(`EPO OPS sign-in failed (${r.status}); patents skipped. Check the EPO_OPS_KEY and EPO_OPS_SECRET secrets.`); this.off = true; return null; }
    const j = await r.json();
    this.token = j.access_token;
    this.expires = Date.now() + (+j.expires_in || 1200) * 1000;
    return this.token;
  }

  // Recent publications whose title or abstract has any of the phrases. Newest first, families merged.
  async search(phrases, { since, max = 100 } = {}) {
    if (this.off) return [];
    const tok = await this.auth();
    if (!tok) return [];
    const terms = phrases.slice(0, 6).map((p) => `ta="${String(p).replace(/"/g, "")}"`).join(" or ");
    const q = `(${terms})` + (since ? ` and pd>=${since.replace(/-/g, "")}` : "");
    const out = [];
    for (let start = 1; start <= max; start += 100) {
      const end = Math.min(max, start + 99);
      const url = `${OPS}/rest-services/published-data/search/biblio?q=${encodeURIComponent(q)}&Range=${start}-${end}`;
      let r;
      try {
        this.calls++;
        r = await this.fetch(url, { headers: { authorization: "Bearer " + tok, accept: "application/json", "X-OPS-Range": `${start}-${end}` } });
      } catch (e) { this.log("EPO OPS request failed: " + e.message); break; }
      if (r.status === 404) break;                                   // no results
      if (!r.ok) { this.log(`EPO OPS search -> ${r.status}`); if (r.status === 403) this.off = true; break; }
      const page = parseOps(await r.json());
      out.push(...page.patents);
      if (this.pause) await new Promise((s) => setTimeout(s, this.pause));
      if (end >= page.total) break;
    }
    return mergeFamilies(out);
  }
}

// ------------------------------------------------------------------ parsing
export function parseOps(j) {
  const root = j && j["ops:world-patent-data"];
  const sr = root && root["ops:biblio-search"];
  const total = +(sr && sr["@total-result-count"]) || 0;
  const docs = arr(sr && sr["ops:search-result"] && sr["ops:search-result"]["exchange-documents"]);
  const patents = [];
  for (const d of docs) {
    const doc = d["exchange-document"] || d;
    for (const x of arr(doc)) { const p = parseDoc(x); if (p) patents.push(p); }
  }
  return { total, patents };
}

function parseDoc(x) {
  const b = x["bibliographic-data"] || {};
  const ids = arr(b["publication-reference"] && b["publication-reference"]["document-id"]);
  const docdb = ids.find((i) => i["@document-id-type"] === "docdb") || ids[0] || {};
  const cc = txt(docdb.country) || x["@country"] || "", num = txt(docdb["doc-number"]) || x["@doc-number"] || "", kind = txt(docdb.kind) || x["@kind"] || "";
  if (!num) return null;
  const date = txt(docdb.date);
  const titles = arr(b["invention-title"]);
  const title = txt(titles.find((t) => t["@lang"] === "en") || titles[0]);
  const abs = arr(x.abstract);
  const ab = abs.find((a) => a["@lang"] === "en") || abs[0];
  const abstract = ab ? arr(ab.p).map(txt).join(" ") : "";
  const apps = arr(b.parties && b.parties.applicants && b.parties.applicants.applicant);
  const pick = apps.filter((a) => a["@data-format"] === "epodoc");
  const applicants = [...new Set((pick.length ? pick : apps).map((a) => applicantName(txt(a["applicant-name"] && a["applicant-name"].name))).filter(Boolean))];
  const npl = arr(b["references-cited"] && b["references-cited"].citation).map((c) => c.nplcit && txt(c.nplcit.text)).filter(Boolean);
  const ipc = arr(b["classifications-ipcr"] && b["classifications-ipcr"]["classification-ipcr"]).map((c) => txt(c.text).replace(/\s+/g, " ").trim().split(" ").slice(0, 2).join("")).filter(Boolean);
  const id = cc + num + kind;
  return {
    id, cc, num, kind, family: x["@family-id"] || "",
    date: date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : "",
    title: cleanText(title), abstract: cleanText(abstract, 900), applicants, npl, ipc: [...new Set(ipc)].slice(0, 4),
    url: `https://worldwide.espacenet.com/patent/search?q=pn%3D${encodeURIComponent(id)}`,
    gp: `https://patents.google.com/patent/${encodeURIComponent(id)}`,
  };
}

// One entry per patent family (the same invention filed in several countries); keep the newest.
export function mergeFamilies(list) {
  const by = new Map();
  for (const p of list) {
    const k = p.family || p.id;
    const o = by.get(k);
    if (!o) { by.set(k, { ...p, also: [] }); continue; }
    o.also.push(p.cc);
    if (p.date > o.date) Object.assign(o, { id: p.id, cc: p.cc, num: p.num, kind: p.kind, date: p.date, url: p.url, gp: p.gp });
    if (!o.abstract && p.abstract) o.abstract = p.abstract;
    if (p.npl.length) o.npl = [...new Set([...o.npl, ...p.npl])];
    if (p.applicants.length && !o.applicants.length) o.applicants = p.applicants;
  }
  return [...by.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

const SUFFIX = /\b(CO|COMPANY|LTD|LIMITED|INC|INCORPORATED|CORP|CORPORATION|LLC|L L C|GMBH|AG|SA|BV|NV|KK|KABUSHIKI KAISHA|PLC|SE|SAS|SRL|SPA|HOLDINGS?|GROUP|UNIV)\b\.?/g;
const KEEP = new Set(["SK", "IBM", "TSMC", "IMEC", "CEA", "AMD", "TDK", "NXP", "ST", "LG", "BOE", "SMIC", "YMTC", "CXMT", "KIOXIA", "UMC", "MIT", "KAIST", "IME", "ITRI", "NAND", "ABB", "ROHM", "GAN", "SIC"]);
// "SAMSUNG ELECTRONICS CO LTD [KR]" -> "Samsung Electronics"
export function applicantName(s) {
  let n = String(s || "").replace(/\[[A-Z]{2}\]/g, " ").replace(/[,.]/g, " ").toUpperCase();
  if (/UNIV/.test(n) && !/UNIVERSITY/.test(n)) n = n.replace(/UNIV\b/, "UNIVERSITY");
  n = n.replace(SUFFIX, " ").replace(/\s+/g, " ").trim();
  if (!n) return "";
  return n.split(" ").map((w) => (KEEP.has(w) || w.length <= 2 ? w : w[0] + w.slice(1).toLowerCase())).join(" ");
}

// ------------------------------------------------------------------ linking patents and papers
/**
 * Link each patent to the papers it relates to: papers it cites (DOI or title in its non-patent
 * citations) first, then papers using the same terms. Adds p.links = [{id, why}].
 */
export function linkPatents(patents, papers, { max = 3, minSim = 0.12 } = {}) {
  const byDoi = new Map(papers.filter((p) => p.doi).map((p) => [p.doi.toLowerCase(), p]));
  const titled = papers.filter((p) => p.title && p.title.length > 25).map((p) => [normTitle(p.title), p]);
  const tok = new Map(papers.map((p) => [p.id, tokens(p.title + " " + (p.abstract || "").slice(0, 600))]));
  for (const pt of patents) {
    const links = [];
    const add = (p, why, kind) => { if (p && !links.some((l) => l.id === p.id)) links.push({ id: p.id, why, kind }); };
    for (const n of pt.npl || []) {
      findDois(n).forEach((d) => add(byDoi.get(d.toLowerCase()), "Cited by the patent", "cites"));
      const nn = normTitle(n);
      for (const [t, p] of titled) if (nn.includes(t)) add(p, "Cited by the patent", "cites");
    }
    const pt_tok = tokens(pt.title + " " + pt.abstract);
    const scored = papers.map((p) => [p, jaccard(pt_tok, tok.get(p.id))]).filter(([, s]) => s >= minSim).sort((a, b) => b[1] - a[1]);
    for (const [p] of scored) {
      if (links.length >= max) break;
      add(p, "Same terms: " + shared(pt_tok, tok.get(p.id), 4).join(", "), "terms");
    }
    pt.links = links.slice(0, Math.max(max, links.filter((l) => l.kind === "cites").length));
  }
  return patents;
}

// Who is filing: applicant -> count, biggest first.
export function topFilers(patents, n = 8) {
  const c = new Map();
  for (const p of patents) for (const a of p.applicants || []) c.set(a, (c.get(a) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
}

/**
 * Papers against patents for each effect / technique of the field.
 *   open: studied in recent papers but few or no patents -> room for IP
 *   crowded: many patents -> industry is already working on it; check claims first
 */
export function ipMap(patents, papers, cat, cfg) {
  const rows = (cat.features || []).map((f) => ({ id: f.id, name: f.name, kind: f.kind, papers: 0, patents: 0, filers: new Map() }));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const p of papers) for (const f of profile(p, cat, cfg).features) byId[f] && byId[f].papers++;
  for (const pt of patents) for (const f of profile({ title: pt.title, abstract: pt.abstract }, cat, cfg).features) {
    const r = byId[f]; if (!r) continue;
    r.patents++;
    (pt.applicants || []).forEach((a) => r.filers.set(a, (r.filers.get(a) || 0) + 1));
  }
  const maxPat = Math.max(1, ...rows.map((r) => r.patents));
  return rows.map((r) => {
    const filers = [...r.filers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => ({ name, count }));
    let signal = "";
    if (r.papers >= 3 && r.patents <= Math.max(1, Math.floor(r.papers / 6))) signal = "open";
    else if (r.patents >= 5 && r.patents >= 0.5 * maxPat) signal = "crowded";
    return { id: r.id, name: r.name, kind: r.kind, papers: r.papers, patents: r.patents, filers, signal };
  }).filter((r) => r.papers || r.patents);
}

// A short note for a gap from the IP map: is the area open for patents, or crowded?
export function ipNote(g, ip, patentsTotal) {
  if (!ip || !ip.length) return "";
  const row = g.feature ? ip.find((r) => r.id === g.feature) : null;
  const who = (r) => r.filers.map((f) => `${f.name} ${f.count}`).join(", ");
  if (row && row.signal === "open") return `Open for IP: ${row.papers} recent papers study ${row.name.toLowerCase()} but only ${row.patents} recent patent${row.patents === 1 ? "" : "s"} mention it. A working result here could be patented before you publish.`;
  if (row && row.signal === "crowded") return `Crowded: ${row.patents} recent patents mention ${row.name.toLowerCase()}${row.filers.length ? " (" + who(row) + ")" : ""}. Industry is working on it; read their claims so your result is new.`;
  if (!row && patentsTotal >= 30) return `Industry is active in this topic (${patentsTotal} patent families in the last year). Check the patent list before you publish.`;
  if (!row && patentsTotal <= 3) return `Few patents in this topic (${patentsTotal} in the last year): a demonstrated result could be patentable.`;
  return "";
}

// Slim copy for the site's data files.
export const slimPatent = (p) => ({ id: p.id, title: p.title, abstract: cleanText(p.abstract, 500), date: p.date, applicants: p.applicants.slice(0, 3), also: [...new Set(p.also || [])].slice(0, 6), npl: (p.npl || []).length, ipc: p.ipc, url: p.url, gp: p.gp, links: p.links || [] });
