// Paper sources: OpenAlex (search, references, citing papers) and Semantic Scholar
// (why a paper was cited: citation intents and context sentences).
// Works in the browser and in Node 18+ (global fetch). Both APIs are free and need no key.

import { abstractFromIndex, cleanText, normTitle, tokens, jaccard } from "./text.js";

export const OPENALEX = "https://api.openalex.org/works";
export const S2 = "https://api.semanticscholar.org/graph/v1/paper";
const SELECT = "id,doi,display_name,publication_date,publication_year,primary_location,cited_by_count,abstract_inverted_index,authorships,referenced_works,type";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Sources {
  constructor(opts = {}) {
    this.fetch = opts.fetch || ((...a) => globalThis.fetch(...a));
    this.mailto = opts.mailto || "";
    this.s2Key = opts.s2Key || "";
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
  };
}
