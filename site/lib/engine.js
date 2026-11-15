// Gap engine: reads a citation tree and the papers around it, and says where the gaps are.
// Pure functions, shared by the browser and the Node pipeline. Every check works from titles
// and abstracts, so each gap lists the papers it is based on: read them before relying on it.

import { jaccard, phraseRegex, shared, tokens } from "./text.js";

const rxCache = new WeakMap();
function rx(obj, key, words) {
  let m = rxCache.get(obj);
  if (!m) { m = {}; rxCache.set(obj, m); }
  if (!(key in m)) m[key] = phraseRegex(words);
  return m[key];
}
const hit = (r, text) => !!(r && r.test(text));

export const STAGES = {
  sim: { label: "Simulation / TCAD only", short: "Simulation" },
  fab: { label: "Fabricated & measured", short: "Fabricated" },
  circuit: { label: "Used in a circuit", short: "Circuit" },
  unknown: { label: "Not clear from the abstract", short: "Unclear" },
};

export const GAP_TYPES = {
  not_fabricated: { label: "Not fabricated yet", stage: "Fabrication" },
  missing_feature: { label: "Missing physics / feature", stage: "TCAD & device" },
  not_in_circuit: { label: "Not used in a circuit yet", stage: "Circuit & EDA" },
  cross_topic: { label: "Idea from a nearby topic", stage: "Cross-topic" },
  combination: { label: "Untried combination", stage: "Combination" },
  open_followup: { label: "Nobody has built on it yet", stage: "Follow-up" },
};

// What a paper did, judged from its title and abstract.
export function profile(p, cat, cfg) {
  if (p._prof && p._prof.cat === cat.id) return p._prof;
  const text = (p.title || "") + ". " + (p.abstract || "");
  const st = cfg.stage_terms;
  const sim = hit(rx(cfg, "sim", st.sim), text);
  const fab = hit(rx(cfg, "fab", st.fab), text);
  const circuit = hit(rx(cfg, "circuit", st.circuit), text);
  const features = [];
  for (const f of cat.features) if (hit(rx(f, "t", f.terms), text)) features.push(f.id);
  const stage = circuit && (fab || !sim) ? "circuit" : fab ? "fab" : sim ? "sim" : "unknown";
  const prof = { cat: cat.id, sim, fab, circuit, stage, features, tok: tokens(text) };
  Object.defineProperty(p, "_prof", { value: prof, enumerable: false, configurable: true, writable: true });
  return prof;
}

// Which category fits a set of papers best (for the user's own papers).
export function guessCategory(papers, cfg) {
  let best = cfg.categories[0], bestScore = -1;
  for (const cat of cfg.categories) {
    let s = 0;
    for (const p of papers) {
      const text = (p.title || "") + " " + (p.abstract || "");
      for (const t of cat.topics) if (hit(rx(t, "s", t.search), text)) s += 3;
      s += profile(p, cat, cfg).features.length;
    }
    if (s > bestScore) { best = cat; bestScore = s; }
  }
  return best;
}

function featureName(cat, id) { const f = cat.features.find((x) => x.id === id); return f ? f.name : id; }
function feature(cat, id) { return cat.features.find((x) => x.id === id); }

function rankEvidence(list, cat, cfg) {
  return list.slice().sort((a, b) => {
    const pa = profile(a, cat, cfg), pb = profile(b, cat, cfg);
    return (pb.fab - pa.fab) || ((b.tx ? 1 : 0) - (a.tx ? 1 : 0)) || ((b.cited_by || 0) - (a.cited_by || 0));
  });
}

/**
 * Analyse one paper's citation tree.
 * tree: { seed, base, nodes, references, citers, base_citers, ref_citers }
 * ctx:  { cat, cfg, topicId, pool: [{...paper, topic}], topicName(id) }
 * Returns { gaps, base_reason, summary }.
 */
export function analyzeTree(tree, ctx) {
  const { cat, cfg } = ctx;
  const N = tree.nodes || {};
  const get = (id) => N[id];
  const seed = tree.seed;
  const sp = profile(seed, cat, cfg);
  const list = (ids) => (ids || []).map(get).filter(Boolean);
  const refs = list(tree.references);
  const citers = list(tree.citers);
  const baseCiters = list(tree.base_citers);
  const refCiters = Object.values(tree.ref_citers || {}).flatMap(list);
  const base = get(tree.base);
  const followers = [...citers, ...baseCiters].filter((p) => p.id !== seed.id);
  const treePapers = uniq([...refs, ...citers, ...baseCiters, ...refCiters]).filter((p) => p.id !== seed.id);
  const pool = uniq([...(ctx.pool || []).filter((p) => p.id !== seed.id), ...treePapers]);
  const ownTopic = pool.filter((p) => !p.topic || p.topic === ctx.topicId);
  const otherTopic = (ctx.pool || []).filter((p) => p.topic && p.topic !== ctx.topicId && p.id !== seed.id);
  const near = (p) => jaccard(sp.tok, profile(p, cat, cfg).tok) >= 0.08 || overlap(sp.features, profile(p, cat, cfg).features) >= 2;
  const gaps = [];

  // 1. Simulated, but not fabricated (by this paper or anyone who built on it).
  if (sp.sim && !sp.fab) {
    const fabbedFollowers = followers.filter((p) => profile(p, cat, cfg).fab && near(p));
    const fabRefs = rankEvidence(treePapers.filter((p) => profile(p, cat, cfg).fab), cat, cfg).slice(0, 3);
    if (!fabbedFollowers.length) {
      gaps.push({
        type: "not_fabricated", score: 0.95,
        title: "Fabricate and measure the simulated device",
        why: "The abstract reports simulation / TCAD results only, and none of the papers that cite it (or that build on its base paper) report a fabricated version.",
        evidence: fabRefs.map((p) => p.id),
        steps: [
          "Calibrate the TCAD deck against measured data from the fabricated works listed here first, so the predicted gain is believable.",
          "Turn the simulated structure into a process flow (Sentaurus Process / Silvaco Victory Process) and check every step is available in your fab or an MPW / university cleanroom run.",
          "Design short-loop test structures for the one feature that gives the improvement, plus a reference device without it.",
          "Measure the same figures of merit the paper simulated and compare simulation with silicon.",
        ],
        tools: ["Synopsys Sentaurus Process", "Silvaco Victory Process", "KLayout (masks)"],
      });
    } else {
      gaps.push({
        type: "not_fabricated", score: 0.35,
        title: "Fabrication has started elsewhere: compare with it",
        why: `The paper is simulation-only, and ${fabbedFollowers.length} related later paper(s) report fabricated devices. Check whether they built the same structure or only part of it.`,
        evidence: fabbedFollowers.slice(0, 3).map((p) => p.id),
        steps: ["Compare the fabricated follow-ups with the simulated structure, feature by feature.", "Any feature they left out is still open for a fabricated demonstration."],
        tools: [],
      });
    }
  }

  // 2. Physics / features that the domain studies but this paper does not.
  const seen = new Set(sp.features);
  const counts = countFeatures(ownTopic, cat, cfg);
  const cands = Object.entries(counts)
    .filter(([id, c]) => !seen.has(id) && c.length >= 2 && c.length >= 0.08 * ownTopic.length)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3);
  for (const [id, papers] of cands) {
    const f = feature(cat, id);
    const share = Math.round((100 * papers.length) / Math.max(1, ownTopic.length));
    gaps.push({
      type: "missing_feature", score: 0.5 + Math.min(0.35, papers.length / Math.max(8, ownTopic.length)),
      feature: id,
      title: (sp.sim ? "Add " : "Study ") + f.name.toLowerCase() + (sp.sim ? " to the TCAD model" : ""),
      why: `${papers.length} papers in this area (${share}%) look at ${f.name.toLowerCase()}, but this paper's abstract does not mention it.`,
      evidence: rankEvidence(papers, cat, cfg).slice(0, 4).map((p) => p.id),
      steps: [
        sp.sim ? f.tcad : "Repeat the key measurement with " + f.name.toLowerCase() + " in view. " + f.tcad,
        "Report how the paper's headline figure of merit changes once this effect is included.",
      ],
      tools: sp.sim ? ["Synopsys Sentaurus Device", "Silvaco Atlas / Victory Device"] : [],
    });
  }

  // 3. A device that has not been put in a circuit.
  if (!sp.circuit) {
    const circuitFollowers = followers.filter((p) => profile(p, cat, cfg).circuit && near(p));
    if (!circuitFollowers.length) {
      gaps.push({
        type: "not_in_circuit", score: sp.fab ? 0.9 : 0.7,
        title: "Put the device in a circuit and show the system-level benefit",
        why: "The paper stays at device level, and no paper citing it evaluates it inside a circuit.",
        evidence: rankEvidence(pool.filter((p) => profile(p, cat, cfg).circuit), cat, cfg).slice(0, 3).map((p) => p.id),
        compact_model: cat.eda.compact_model,
        steps: cat.eda.steps,
        tools: cat.eda.tools,
      });
    }
  }

  // 4. Techniques used in nearby topics of the same category but not here.
  const ownCounts = counts;
  const otherCounts = countFeatures(otherTopic, cat, cfg);
  const cross = Object.entries(otherCounts)
    .filter(([id, c]) => feature(cat, id).kind === "technique" && !seen.has(id) && c.length >= 2 && (ownCounts[id] || []).length <= 1)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 2);
  for (const [id, papers] of cross) {
    const f = feature(cat, id);
    const topics = [...new Set(papers.map((p) => p.topic))].map((t) => (ctx.topicName ? ctx.topicName(t) : t));
    gaps.push({
      type: "cross_topic", score: 0.45 + Math.min(0.2, papers.length / 20),
      feature: id,
      title: "Try " + f.name.toLowerCase() + " here",
      why: `${papers.length} recent papers in ${topics.join(", ")} use ${f.name.toLowerCase()}; it is almost absent in this topic. Check whether it applies to this paper's device.`,
      evidence: rankEvidence(papers, cat, cfg).slice(0, 4).map((p) => p.id),
      steps: ["Read how the cited papers use it and list what it needs from the device.", "Check those needs against this paper's structure; if they fit, simulate the combination first.", f.tcad],
      tools: [],
    });
  }

  // 5. Two directions that people building on the base paper follow, but never together.
  const builders = uniq([...baseCiters, ...citers]);
  if (builders.length >= 6) {
    const fc = countFeatures(builders, cat, cfg);
    const top = Object.entries(fc).filter(([, c]) => c.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 6).map(([id]) => id);
    let combo = null;
    for (let i = 0; i < top.length && !combo; i++) for (let j = i + 1; j < top.length && !combo; j++) {
      const a = top[i], b = top[j];
      const both = builders.filter((p) => { const f = profile(p, cat, cfg).features; return f.includes(a) && f.includes(b); });
      if (!both.length && !(seen.has(a) && seen.has(b))) combo = [a, b];
    }
    if (combo) {
      const [a, b] = combo;
      gaps.push({
        type: "combination", score: 0.42,
        title: `Combine ${featureName(cat, a).toLowerCase()} with ${featureName(cat, b).toLowerCase()}`,
        why: `Among ${builders.length} papers that build on this work and its base paper, ${fc[a].length} study ${featureName(cat, a).toLowerCase()} and ${fc[b].length} study ${featureName(cat, b).toLowerCase()}, but none studies both together.`,
        evidence: [...rankEvidence(fc[a], cat, cfg).slice(0, 2), ...rankEvidence(fc[b], cat, cfg).slice(0, 2)].map((p) => p.id),
        steps: ["Check whether one effect changes the other (for example, does the second one shift the first one's figure of merit?).", "Design one experiment or simulation that varies both."],
        tools: [],
      });
    }
  }

  // 6. A fresh result with no follow-ups yet.
  if (!citers.length) {
    gaps.push({
      type: "open_followup", score: 0.3,
      title: "Be the first to extend this result",
      why: "No paper has cited this one yet, so every direction in its conclusion is still open.",
      evidence: [], steps: ["Read the paper's conclusion and future-work section and pick the direction closest to your tools."], tools: [],
    });
  }

  gaps.sort((a, b) => b.score - a.score);
  return { gaps, base_reason: baseReason(tree, base, seed, cat, cfg), summary: describe(seed, sp, cat) };
}

export function baseReason(tree, base, seed, cat, cfg) {
  if (!base) return "";
  if (tree.base_reason) return tree.base_reason;
  const parts = [];
  const why = base.why || {};
  if (why.influential) parts.push("Semantic Scholar marks it as a highly influential citation");
  const common = shared(profile(seed, cat, cfg).tok, profile(base, cat, cfg).tok, 5);
  if (common.length) parts.push("it shares the most terms with this paper (" + common.join(", ") + ")");
  if (base.cited_by) parts.push(`it is cited ${base.cited_by} times overall`);
  let s = parts.length ? "Picked as the base paper because " + parts.join(", and ") + "." : "";
  if (why.context) s += " The paper cites it as: “" + why.context + "”";
  return s;
}

export function describe(p, prof, cat) {
  const f = prof.features.map((id) => featureName(cat, id).toLowerCase());
  return STAGES[prof.stage].label + (f.length ? "; covers " + f.join(", ") : "") + ".";
}

// Feature x stage counts for a set of papers (the coverage grid on topic pages).
export function coverage(papers, cat, cfg) {
  const rows = cat.features.map((f) => ({ id: f.id, name: f.name, kind: f.kind, sim: 0, fab: 0, circuit: 0, total: 0 }));
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const p of papers) {
    const pr = profile(p, cat, cfg);
    for (const id of pr.features) {
      const r = by[id];
      r.total++;
      if (pr.sim) r.sim++;
      if (pr.fab) r.fab++;
      if (pr.circuit) r.circuit++;
    }
  }
  return rows;
}

// Topic-level gaps: features explored in simulation but rarely fabricated or put in circuits.
export function topicGaps(papers, cat, cfg) {
  const out = [];
  for (const r of coverage(papers, cat, cfg)) {
    if (r.sim >= 2 && r.fab === 0) out.push({ feature: r.id, kind: "sim-only", text: `${r.name}: ${r.sim} simulation papers, no fabricated ones` });
    else if (r.total >= 3 && r.circuit === 0) out.push({ feature: r.id, kind: "no-circuit", text: `${r.name}: ${r.total} papers, none at circuit level` });
    else if (r.total === 0) out.push({ feature: r.id, kind: "untouched", text: `${r.name}: no recent paper here` });
  }
  return out;
}

function countFeatures(papers, cat, cfg) {
  const out = {};
  for (const p of papers) for (const id of profile(p, cat, cfg).features) (out[id] = out[id] || []).push(p);
  return out;
}
function overlap(a, b) { let n = 0; for (const x of a) if (b.includes(x)) n++; return n; }
function uniq(arr) { const s = new Set(); return arr.filter((p) => p && !s.has(p.id) && s.add(p.id)); }
