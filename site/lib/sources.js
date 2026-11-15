// Paper sources, all free:
//   OpenAlex          search, references, citing papers, open-access links
//   Semantic Scholar  why a paper was cited (intents, context sentences), open-access PDF
//   Unpaywall         legal open-access copy of a DOI (needs a contact email)
//   Crossref          abstract fallback when OpenAlex has none
//   CORE              full text from open repositories (needs a free API key)
//   arXiv             preprint full text (HTML or PDF)
// Google Scholar has no API and blocks automated access, so it is only linked.
// Works in the browser and in Node 18+ (global fetch).

import { abstractFromIndex, cleanText, normTitle, tokens, jaccard } from "./text.js";
import { candidates, condense, htmlToText, pdfText } from "./fulltext.js";

export const OPENALEX = "https://api.openalex.org/works";
export const S2 = "https://api.semanticscholar.org/graph/v1/paper";
const SELECT = "id,doi,display_name,publication_date,publication_year,primary_location,cited_by_count,abstract_inverted_index,authorships,referenced_works,type,open_access,best_oa_location,locations";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Sources {
  constructor(opts = {}) {
    this.fetch = opts.fetch || ((...a) => globalThis.fetch(...a));
    this.mailto = opts.mailto || "";
    this.s2Key = opts.s2Key || "";
    this.unpaywallEmail = opts.unpaywallEmail || "";
    this.coreKey = opts.coreKey || "";
    this.pdfjs = opts.pdfjs || null;          // a pdf.js module, to read open PDFs
    this.keepRx = opts.keepRx || [];          // sentences worth keeping from full texts
    this.useS2 = opts.useS2 !== false;
    this.pause = opts.pause == null ? 120 : opts.pause;
    this.log = opts.log || (() => {});
    this.timeout = opts.timeout || 30000;
    this.calls = 0;
    this.cache = new Map();
  }

  async getJson(url, headers, retries = 3) {
    if (this.cache.has(url)) return this.cache.get(url);
    let delay = 1500;
    for (let i = 1; i <= retries; i++) {
      try {
        this.calls++;
        const init = headers ? { headers } : {};
        if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) init.signal = AbortSignal.timeout(this.timeout);
        const r = await this.fetch(url, init);
        if (r.ok) {
          const j = await r.json();
          this.cache.set(url, j);
          if (this.pause) await sleep(this.pause);
          return j;
        }
        if (![429, 500, 502, 503, 504].includes(r.status)) { this.log(`GET ${url} -> ${r.status}`); return null; }
        this.log(`GET ${url} -> ${r.status} (attempt ${i})`);
      } catch (e) {
        this.log(`GET ${url} failed: ${e.message} (attempt ${i})`);
      }
      await sleep(delay);
      delay *= 2;
    }
    return null;
  }

  oa(params) {
    const p = new URLSearchParams({ select: SELECT, ...params });
    if (this.mailto) p.set("mailto", this.mailto);
    return this.getJson(OPENALEX + "?" + p.toString());
  }

  // Recent papers for a search phrase, optionally only from the given journals (ISSNs).
  async search(phrase, { since, issns, perPage = 50 } = {}) {
    const f = ["has_abstract:true", "type:article|review"];
    if (since) f.push("from_publication_date:" + since);
    if (issns && issns.length) f.push("primary_location.source.issn:" + issns.join("|"));
    const j = await this.oa({ search: `"${phrase}"`, filter: f.join(","), sort: "publication_date:desc", "per-page": String(perPage) });
    return (j && j.results || []).map(toPaper);
  }

  async byIds(ids) {
    const out = [];
    const clean = [...new Set(ids.map(shortId).filter(Boolean))];
    for (let i = 0; i < clean.length; i += 50) {
      const chunk = clean.slice(i, i + 50);
      const j = await this.oa({ filter: "ids.openalex:" + chunk.join("|"), "per-page": "50" });
      (j && j.results || []).forEach((w) => out.push(toPaper(w)));
    }
    return out;
  }

  async citers(id, { perPage = 15, sort = "publication_date:desc" } = {}) {
    const j = await this.oa({ filter: "cites:" + shortId(id), sort, "per-page": String(perPage) });
    return (j && j.results || []).map(toPaper);
  }

  // A DOI, arXiv id, OpenAlex id, URL or a title -> one paper (or null).
  async resolve(q) {
    q = String(q || "").trim();
    if (!q) return null;
    let m;
    const one = async (path) => {
      const p = new URLSearchParams({ select: SELECT });
      if (this.mailto) p.set("mailto", this.mailto);
      const j = await this.getJson(OPENALEX + "/" + path + "?" + p.toString());
      return j && j.id ? toPaper(j) : null;
    };
    if ((m = q.match(/\b(10\.\d{4,9}\/[^\s"'<>]+)/))) return one("doi:" + encodeURIComponent(m[1].replace(/[.)\]]+$/, "")));
    if ((m = q.match(/openalex\.org\/(W\d+)|^(W\d+)$/i))) return one((m[1] || m[2]).toUpperCase());
    if ((m = q.match(/arxiv\.org\/(?:abs|pdf)\/([\w.\-/]+?)(?:v\d+)?(?:\.pdf)?$|^(?:arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?$/i))) {
      return one("doi:" + encodeURIComponent("10.48550/arXiv." + (m[1] || m[2])));
    }
    const j = await this.oa({ search: q, "per-page": "5" });
    const res = (j && j.results || []).map(toPaper);
    if (!res.length) return null;
    const qt = tokens(q);
    res.sort((a, b) => jaccard(qt, tokens(b.title)) - jaccard(qt, tokens(a.title)));
    return res[0];
  }

  async getRaw(url) {
    try {
      this.calls++;
      const init = {};
      if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) init.signal = AbortSignal.timeout(this.timeout * 2);
      const r = await this.fetch(url, init);
      if (!r.ok) return null;
      const len = +(r.headers && r.headers.get && r.headers.get("content-length") || 0);
      if (len > 30e6) return null;
      const buf = new Uint8Array(await r.arrayBuffer());
      if (this.pause) await sleep(this.pause);
      return { buf, type: (r.headers && r.headers.get && r.headers.get("content-type")) || "" };
    } catch (e) { this.log(`GET ${url} failed: ${e.message}`); return null; }
  }

  // Abstract from Crossref when OpenAlex has none (publishers that hide it from OpenAlex).
  async crossrefAbstract(doi) {
    if (!doi) return "";
    const j = await this.getJson("https://api.crossref.org/works/" + encodeURIComponent(doi) + (this.mailto ? "?mailto=" + encodeURIComponent(this.mailto) : ""), null, 2);
    return cleanText(j && j.message && j.message.abstract || "").replace(/^Abstract\s*/i, "");
  }

  // Open-access PDF links from Unpaywall and Semantic Scholar.
  async oaLinks(p) {
    if (!p.doi) return;
    if (this.unpaywallEmail && !p.upw_pdf) {
      const j = await this.getJson(`https://api.unpaywall.org/v2/${encodeURIComponent(p.doi)}?email=${encodeURIComponent(this.unpaywallEmail)}`, null, 2);
      const best = j && j.best_oa_location;
      if (best) { p.upw_pdf = best.url_for_pdf || null; p.oa_url = p.oa_url || best.url; }
    }
    if (this.useS2 && !p.s2_pdf) {
      const j = await this.getJson(`${S2}/DOI:${encodeURIComponent(p.doi)}?fields=openAccessPdf,externalIds`, this.s2Key ? { "x-api-key": this.s2Key } : undefined, 2);
      if (j && j.openAccessPdf && j.openAccessPdf.url) p.s2_pdf = j.openAccessPdf.url;
      if (j && j.externalIds && j.externalIds.ArXiv && !p.arxiv) p.arxiv = j.externalIds.ArXiv;
    }
  }

  // CORE: full text from institutional repositories (free key from core.ac.uk).
  async coreText(p) {
    if (!this.coreKey || !p.doi) return null;
    const j = await this.getJson(`https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent('doi:"' + p.doi + '"')}&limit=1`, { authorization: "Bearer " + this.coreKey }, 2);
    const w = j && j.results && j.results[0];
    return w && w.fullText && w.fullText.length > 2000 ? { text: w.fullText, url: w.downloadUrl || (w.links || [])[0] && w.links[0].url || "", source: "CORE" } : null;
  }

  /**
   * Read a free full text for a paper, if there is one, and keep what the gap checks need.
   * Sets p.ft = {source, url, words}, p.body (key sentences) and p.future (limitations / future work).
   */
  async fullText(p) {
    if (p.ft) return p.ft;
    if (!p.abstract) p.abstract = await this.crossrefAbstract(p.doi);
    await this.oaLinks(p);
    let got = await this.coreText(p);
    for (const c of got ? [] : candidates(p)) {
      if (c.kind === "arxiv-html") {
        const r = await this.getRaw(c.url);
        if (r && /html/i.test(r.type)) {
          const text = htmlToText(new TextDecoder().decode(r.buf));
          if (text.length > 4000) { got = { text, url: c.url, source: c.source }; break; }
        }
      } else if (c.kind === "pdf" && this.pdfjs) {
        const r = await this.getRaw(c.url);
        if (r && r.buf[0] === 0x25 && r.buf[1] === 0x50 && r.buf[2] === 0x44 && r.buf[3] === 0x46) { // "%PDF"
          try {
            const text = await pdfText(this.pdfjs, r.buf);
            if (text.length > 2000) { got = { text, url: c.url, source: c.source }; break; }
          } catch (e) { this.log(`PDF ${c.url}: ${e.message}`); }
        }
      }
    }
    if (!got) return null;
    return attachText(p, got.text, got.source, got.url, this.keepRx);
  }

  // Semantic Scholar: why papers cite each other. Returns Map(key -> {intents, context, influential}),
  // keyed by lower-case DOI and by normalised title. Best effort: an empty map on any failure.
  async s2Links(doi, direction) {
    const out = new Map();
    if (!this.useS2 || !doi) return out;
    const side = direction === "citations" ? "citingPaper" : "citedPaper";
    const url = `${S2}/DOI:${encodeURIComponent(doi)}/${direction}?fields=title,externalIds,intents,contexts,isInfluential&limit=100`;
    const j = await this.getJson(url, this.s2Key ? { "x-api-key": this.s2Key } : undefined, 2);
    for (const row of (j && j.data) || []) {
      const p = row[side] || {};
      const info = {
        intents: row.intents || [],
        context: cleanText((row.contexts || [])[0] || "", 320),
        influential: !!row.isInfluential,
      };
      const d = p.externalIds && p.externalIds.DOI;
      if (d) out.set("doi:" + d.toLowerCase(), info);
      if (p.title) out.set("t:" + normTitle(p.title), info);
    }
    return out;
  }
}

export function shortId(id) {
  const m = String(id || "").match(/W\d+/i);
  return m ? m[0].toUpperCase() : "";
}

export function isTransactions(venue) {
  return /\btransactions\b/i.test(venue || "");
}

export function venueRank(venue) {
  if (isTransactions(venue)) return 3;
  if (/\bieee\b/i.test(venue || "")) return 2;
  return venue ? 1 : 0;
}

export function toPaper(w) {
  const loc = w.primary_location || {};
  const src = loc.source || {};
  const doi = (w.doi || "").replace(/^https?:\/\/doi\.org\//i, "") || null;
  const venue = src.display_name || "";
  return {
    id: shortId(w.id),
    doi,
    title: cleanText(w.display_name || w.title),
    year: w.publication_year || null,
    date: w.publication_date || null,
    venue,
    publisher: src.host_organization_name || "",
    tx: isTransactions(venue),
    cited_by: w.cited_by_count || 0,
    url: loc.landing_page_url || (doi ? "https://doi.org/" + doi : w.id),
    authors: (w.authorships || []).map((a) => a.author && a.author.display_name).filter(Boolean).slice(0, 4),
    abstract: cleanText(abstractFromIndex(w.abstract_inverted_index)),
    refs: (w.referenced_works || []).map(shortId).filter(Boolean),
    oa: !!(w.open_access && w.open_access.is_oa),
    oa_url: (w.open_access && w.open_access.oa_url) || (w.best_oa_location && w.best_oa_location.landing_page_url) || null,
    oa_pdf: (w.best_oa_location && w.best_oa_location.pdf_url) || null,
    arxiv: arxivId(w),
  };
}

function arxivId(w) {
  for (const l of w.locations || []) {
    const m = String(l.landing_page_url || l.pdf_url || "").match(/arxiv\.org\/(?:abs|pdf)\/([\w.\-/]+?)(?:v\d+)?(?:\.pdf)?$/i);
    if (m) return m[1];
  }
  const d = String(w.doi || "").match(/10\.48550\/arxiv\.(.+)$/i);
  return d ? d[1] : null;
}

// Attach a full text (from any source, including a PDF the user dropped in) to a paper.
export function attachText(p, text, source, url, keepRx) {
  const c = condense(text, keepRx);
  p.body = c.body;
  p.future = c.future;
  p.ft = { source, url: url || "", words: c.words };
  return p.ft;
}
