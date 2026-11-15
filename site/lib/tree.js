// Builds a citation tree around one paper:
//   references (with the base paper picked out) -> the paper -> papers that cite it,
//   plus who else builds on the base paper and on the next most important references.

import { cleanText, jaccard, normTitle, tokens } from "./text.js";

const DEFAULT = { references: 14, citers: 15, base_citers: 15, ref_citers_for: 3, ref_citers: 8 };

export function slim(p, keepAbstract = 700) {
  const out = {
    id: p.id, doi: p.doi, title: p.title, year: p.year, date: p.date, venue: p.venue, tx: !!p.tx,
    cited_by: p.cited_by || 0, url: p.url, authors: (p.authors || []).slice(0, 4),
    abstract: cleanText(p.abstract, keepAbstract),
  };
  if (p.why && (p.why.context || p.why.intents && p.why.intents.length || p.why.influential)) out.why = p.why;
  return out;
}

function whyFor(map, p) {
  if (!map || !map.size) return null;
  return (p.doi && map.get("doi:" + p.doi.toLowerCase())) || map.get("t:" + normTitle(p.title)) || null;
}

export function pickBase(seed, refs) {
  const st = tokens(seed.title + " " + seed.abstract);
  let best = null, bestScore = -1;
  const scored = refs.map((r) => {
    const sim = jaccard(st, tokens(r.title + " " + r.abstract));
    const score = sim * 6 + (r.why && r.why.influential ? 1.2 : 0) + Math.log10(1 + (r.cited_by || 0)) * 0.35
      + ((r.why && (r.why.intents || []).includes("methodology")) ? 0.5 : 0);
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  if (scored.length) { best = scored[0].r; bestScore = scored[0].score; }
  return { base: best, ordered: scored.map((s) => s.r), score: bestScore };
}

/**
 * src: a Sources instance. seed: a paper from Sources (with .refs).
 * Returns a JSON-ready tree; nodes are slimmed.
 */
export async function buildTree(src, seed, opts = {}) {
  const T = { ...DEFAULT, ...(opts.tree || {}) };
  const onStep = opts.onStep || (() => {});
  if (!seed.refs || !seed.refs.length) {
    const full = await src.byIds([seed.id]);
    if (full[0]) seed = { ...full[0], ...seed, refs: full[0].refs };
  }
  onStep("references");
  const [refsAll, s2refs, s2cit] = await Promise.all([
    src.byIds((seed.refs || []).slice(0, 120)),
    src.s2Links(seed.doi, "references"),
    src.s2Links(seed.doi, "citations"),
  ]);
  refsAll.forEach((r) => { const w = whyFor(s2refs, r); if (w) r.why = w; });
  const { base, ordered } = pickBase(seed, refsAll);
  const refs = ordered.slice(0, T.references);

  onStep("citing papers");
  const citers = (await src.citers(seed.id, { perPage: T.citers })).filter((p) => p.id !== seed.id);
  citers.forEach((c) => { const w = whyFor(s2cit, c); if (w) c.why = w; });

  let baseCiters = [];
  if (base) {
    onStep("who else builds on the base paper");
    baseCiters = (await src.citers(base.id, { perPage: T.base_citers + 1 })).filter((p) => p.id !== seed.id).slice(0, T.base_citers);
  }
  const nodes = {};
  const addNode = (p) => { if (p && p.id && !nodes[p.id]) nodes[p.id] = slim(p); };
  [...refs, ...citers, ...baseCiters].forEach(addNode);

  const refCiters = {};
  for (const r of refs.filter((r) => !base || r.id !== base.id).slice(0, T.ref_citers_for)) {
    onStep("who builds on " + r.title.slice(0, 40) + "…");
    const got = (await src.citers(r.id, { perPage: T.ref_citers + 1 })).filter((p) => p.id !== seed.id).slice(0, T.ref_citers);
    got.forEach(addNode);
    refCiters[r.id] = got.map((p) => p.id);
  }

  return {
    seed: { ...slim(seed, 3000), refs_total: (seed.refs || []).length },
    base: base ? base.id : null,
    nodes,
    references: refs.map((p) => p.id),
    citers: citers.map((p) => p.id),
    base_citers: baseCiters.map((p) => p.id),
    ref_citers: refCiters,
    built: new Date().toISOString(),
  };
}
