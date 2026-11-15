// Synthetic OpenAlex / Semantic Scholar responses for offline tests. These are made-up papers.
const inv = (text) => {
  const o = {};
  text.split(/\s+/).forEach((w, i) => { (o[w] = o[w] || []).push(i); });
  return o;
};

export function work(id, title, abstract, extra = {}) {
  return {
    id: "https://openalex.org/" + id,
    doi: extra.doi ? "https://doi.org/" + extra.doi : null,
    display_name: title,
    publication_date: extra.date || "2026-09-01",
    publication_year: 2026,
    primary_location: { landing_page_url: "https://example.org/" + id, source: { display_name: extra.venue || "IEEE Transactions on Electron Devices", host_organization_name: "IEEE" } },
    cited_by_count: extra.cites || 0,
    abstract_inverted_index: inv(abstract),
    authorships: [{ author: { display_name: "A. Author" } }],
    referenced_works: (extra.refs || []).map((r) => "https://openalex.org/" + r),
    type: "article",
  };
}

export const WORKS = {
  W1: work("W1", "TCAD study of a 3D NAND charge trap cell with a graded tunnel oxide",
    "We propose a graded tunnel oxide for 3D NAND charge trap flash. Sentaurus TCAD simulations show faster program speed and a wider memory window. The cell retention after bake is predicted with trap emission models.",
    { doi: "10.1109/TED.2026.0001", refs: ["W10", "W11", "W12"], cites: 2 }),
  W10: work("W10", "Charge trap 3D NAND with bandgap engineered tunnel oxide",
    "A bandgap engineered tunnel oxide for charge trap 3D NAND flash is fabricated and measured. Program speed and retention are characterized on a 128-layer test chip.",
    { refs: [], cites: 340, date: "2019-05-01" }),
  W11: work("W11", "Lateral charge migration in 3D NAND charge trap layers",
    "Lateral charge migration between cells degrades retention in 3D NAND. We fabricated arrays and measured cell-to-cell interference and temperature dependence.",
    { refs: [], cites: 120, date: "2021-02-01" }),
  W12: work("W12", "Poly-Si channel grain boundary effects in vertical NAND",
    "Grain boundaries in the polysilicon channel of vertical NAND cause variability. Device simulation with random grain boundaries reproduces measured distributions.",
    { refs: [], cites: 80, date: "2020-07-01" }),
  // cite W1
  W20: work("W20", "Retention of graded oxide charge trap cells at high temperature",
    "We simulate retention of graded tunnel oxide charge trap cells at high temperature using TCAD and trap emission.", { refs: ["W1"], venue: "IEEE Electron Device Letters" }),
  // cite W10 (the base)
  W30: work("W30", "Endurance of bandgap engineered tunnel oxide after P/E cycling",
    "P/E cycling endurance of 3D NAND with engineered tunnel oxide was measured up to 10k cycles on fabricated wafers.", { refs: ["W10"] }),
  W31: work("W31", "Read disturb in engineered tunnel oxide 3D NAND",
    "Read disturb of 3D NAND with engineered tunnel oxide was measured on a fabricated array and modeled.", { refs: ["W10"] }),
  W32: work("W32", "Cycling-induced trap generation in charge trap flash",
    "Endurance degradation after P/E cycling in charge trap flash is studied with measured data from fabricated cells.", { refs: ["W10"] }),
  W33: work("W33", "Read disturb at elevated read voltage in vertical NAND",
    "We measured read disturb on vertical NAND test chips and propose a reduced pass voltage.", { refs: ["W10"] }),
  W34: work("W34", "Tunnel oxide engineering for faster program in 3D NAND",
    "Faster program speed is demonstrated in fabricated 3D NAND cells with a modified tunnel oxide.", { refs: ["W10"] }),
  W35: work("W35", "Program speed and window of bandgap engineered tunnel stacks",
    "Program speed and memory window of bandgap engineered tunnel stacks were measured on fabricated devices.", { refs: ["W10"] }),
};

export const CITERS = { W1: ["W20"], W10: ["W30", "W31", "W32", "W33", "W34", "W35", "W1"], W11: ["W31"], W12: [] };

export function fakeFetch(url) {
  const u = new URL(url);
  const json = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  if (u.hostname === "api.semanticscholar.org") {
    if (url.includes("/references")) return json({ data: [{ isInfluential: true, intents: ["methodology"], contexts: ["Following the engineered tunnel oxide of [10], we grade the barrier."], citedPaper: { title: WORKS.W10.display_name, externalIds: {} } }] });
    return json({ data: [] });
  }
  const filter = u.searchParams.get("filter") || "";
  let m;
  if ((m = filter.match(/ids\.openalex:([W\d|]+)/))) return json({ results: m[1].split("|").map((id) => WORKS[id]).filter(Boolean) });
  if ((m = filter.match(/cites:(W\d+)/))) return json({ results: (CITERS[m[1]] || []).map((id) => WORKS[id]) });
  if (u.pathname.startsWith("/works/doi:")) return json(WORKS.W1);
  if (u.searchParams.get("search")) return json({ results: [WORKS.W1, WORKS.W20] });
  return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
}
