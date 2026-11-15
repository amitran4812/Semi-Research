// Free full text: find a legal open copy of a paper (arXiv, CORE, the open-access PDF links from
// OpenAlex / Semantic Scholar / Unpaywall), read it, and keep only the sentences the gap checks
// need (what was fabricated / simulated / put in a circuit, the physics covered, and the authors'
// own limitations and future work). Google Scholar has no API and blocks automated access, so it
// is only linked, never fetched.

import { cleanText } from "./text.js";

const FUTURE = /\b(future work|in (the )?future|further (work|stud(y|ies)|investigation|research)|remains? (to be|unexplored|open|unclear|an open)|limitation|is (not|beyond) (yet )?(considered|included|investigated|addressed|the scope)|not (yet )?(been )?(considered|included|investigated|fabricated|demonstrated|studied|addressed)|beyond the scope|will be (investigated|studied|explored|reported|addressed)|we plan to|left for future|open question|needs? to be (verified|validated|investigated))/i;

export function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z(\[])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 600);
}

// Drop the reference list (it would make every cited technique look like this paper's own).
export function stripReferences(text) {
  const t = String(text || "");
  const re = /\n?\s*(References|REFERENCES|Bibliography|BIBLIOGRAPHY)\s*\n/g;
  let m, cut = -1;
  while ((m = re.exec(t))) if (m.index > t.length * 0.45) cut = m.index;
  return cut > 0 ? t.slice(0, cut) : t;
}

/**
 * Keep what the gap checks need from a full text.
 * keepRx: regexes (stage terms, feature terms) whose sentences are worth keeping.
 */
export function condense(text, keepRx = [], { maxBody = 6000, maxFuture = 6 } = {}) {
  const sentences = splitSentences(stripReferences(text));
  const future = [];
  const body = [];
  let len = 0;
  const seen = new Set();
  for (const s of sentences) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (FUTURE.test(s) && future.length < maxFuture && !/\[\d+\]|et al\./.test(s)) future.push(cleanText(s, 400));
    else if (len < maxBody && keepRx.some((r) => r && r.test(s))) { body.push(s); len += s.length + 1; }
  }
  return { body: cleanText(body.join(" "), maxBody), future, words: sentences.reduce((n, s) => n + s.split(" ").length, 0) };
}

export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|nav|header|footer|math)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h\d|li|section|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#\d+;/g, " ")
    .replace(/[ \t]+/g, " ");
}

// Text of a PDF with pdf.js (the caller passes the pdfjs module, so Node and the browser both work).
export async function pdfText(pdfjs, data, maxPages = 40) {
  // isEvalSupported: false, and pdf.js >= 6.2.108 (GHSA-hq66-cqwq-w95j), because these PDFs come from the web.
  const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, enableScripting: false });
  const doc = await task.promise;
  const n = Math.min(doc.numPages, maxPages);
  const parts = [];
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = "";
    for (const it of tc.items) { line += it.str + (it.hasEOL ? "\n" : " "); }
    parts.push(line);
  }
  await (task.destroy ? task.destroy() : doc.destroy());
  return parts.join("\n");
}

/**
 * Free-access candidates for a paper, best first. Each is {kind, url, source}.
 * kind: "arxiv-html" | "pdf" | "core".
 */
export function candidates(p) {
  const out = [];
  if (p.arxiv) {
    out.push({ kind: "arxiv-html", url: `https://arxiv.org/html/${p.arxiv}`, source: "arXiv (HTML)" });
    out.push({ kind: "pdf", url: `https://arxiv.org/pdf/${p.arxiv}`, source: "arXiv (PDF)" });
  }
  for (const [url, source] of [[p.oa_pdf, "Open-access PDF (OpenAlex)"], [p.s2_pdf, "Open-access PDF (Semantic Scholar)"], [p.upw_pdf, "Open-access PDF (Unpaywall)"]]) {
    if (url && !out.some((c) => c.url === url)) out.push({ kind: "pdf", url, source });
  }
  return out;
}
