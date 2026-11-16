import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Sources, toPaper, isTransactions } from "../site/lib/sources.js";
import { buildTree } from "../site/lib/tree.js";
import { analyzeTree, profile, coverage, guessCategory } from "../site/lib/engine.js";
import { findDois, phraseRegex } from "../site/lib/text.js";
import { SCHEMA, buildPrompt, parseJson } from "../site/lib/ai.js";
import { pickSeeds, fetchOrder } from "../pipeline/run.mjs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { keepRegexes } from "../site/lib/engine.js";
import { condense, htmlToText, stripReferences } from "../site/lib/fulltext.js";
import { WORKS, fakeFetch } from "./fixtures.mjs";

const cfg = JSON.parse(fs.readFileSync(new URL("../site/config.json", import.meta.url)));
const nand = cfg.categories.find((c) => c.id === "nand");
const src = () => new Sources({ fetch: fakeFetch, pause: 0 });

test("OpenAlex records become papers with abstracts and references", () => {
  const p = toPaper(WORKS.W1);
  assert.equal(p.id, "W1");
  assert.equal(p.doi, "10.1109/TED.2026.0001");
  assert.ok(p.abstract.startsWith("We propose a graded tunnel oxide"));
  assert.deepEqual(p.refs, ["W10", "W11", "W12"]);
  assert.ok(p.tx);
  assert.ok(isTransactions("IEEE Transactions on Power Electronics"));
  assert.ok(!isTransactions("IEEE Electron Device Letters"));
});

test("stage detection: simulation-only vs fabricated", () => {
  assert.equal(profile(toPaper(WORKS.W1), nand, cfg).stage, "sim");
  assert.equal(profile(toPaper(WORKS.W10), nand, cfg).stage, "fab");
  assert.ok(profile(toPaper(WORKS.W11), nand, cfg).features.includes("interference"));
});

test("tree picks the base paper and finds who builds on it", async () => {
  const s = src();
  const seed = await s.resolve("10.1109/TED.2026.0001");
  const tree = await buildTree(s, seed, { tree: cfg.tree });
  assert.equal(tree.base, "W10", "most similar, influential reference");
  assert.deepEqual(tree.citers, ["W20"]);
  assert.ok(tree.base_citers.includes("W30") && !tree.base_citers.includes("W1"), "seed excluded from base citers");
  assert.ok(tree.nodes.W10.why.influential);
});

test("gaps: not fabricated, missing physics, not in a circuit", async () => {
  const s = src();
  const tree = await buildTree(s, await s.resolve("10.1109/TED.2026.0001"), { tree: cfg.tree });
  const { gaps, base_reason } = analyzeTree(tree, { cat: nand, cfg, topicId: "3d-nand-cell", pool: [] });
  const types = gaps.map((g) => g.type);
  assert.ok(types.includes("not_fabricated"), types.join());
  assert.ok(types.includes("not_in_circuit"));
  const missing = gaps.filter((g) => g.type === "missing_feature").map((g) => g.feature);
  assert.ok(missing.includes("endurance") || missing.includes("disturb"), missing.join());
  assert.ok(gaps.find((g) => g.type === "not_in_circuit").tools.some((t) => /Spectre/.test(t)));
  assert.match(base_reason, /influential/);
  for (const g of gaps) for (const id of g.evidence) assert.ok(tree.nodes[id] || id === tree.seed.id, "evidence ids exist in the tree: " + id);
});

test("coverage grid counts stages per feature", () => {
  const rows = coverage(Object.values(WORKS).map(toPaper), nand, cfg);
  const ret = rows.find((r) => r.id === "retention");
  assert.ok(ret.total >= 3 && ret.fab >= 1 && ret.sim >= 1);
});

test("category guess, DOI extraction, phrase matching", () => {
  assert.equal(guessCategory([toPaper(WORKS.W1)], cfg).id, "nand");
  assert.deepEqual(findDois("see https://doi.org/10.1109/TED.2026.0001. and 10.1063/5.0123456)"), ["10.1109/TED.2026.0001", "10.1063/5.0123456"]);
  assert.ok(phraseRegex(["3D NAND"]).test("3D-NAND flash"));
  assert.ok(!phraseRegex(["IGBT"]).test("IGBTx"));
});

test("seed choice prefers IEEE Transactions, then newest", () => {
  const ps = [
    { id: "a", venue: "Some Journal", date: "2026-10-01", abstract: "x".repeat(400) },
    { id: "b", venue: "IEEE Transactions on Electron Devices", date: "2026-08-01", abstract: "x".repeat(400) },
    { id: "c", venue: "IEEE Transactions on Electron Devices", date: "2026-09-01", abstract: "short" },
  ];
  assert.deepEqual(pickSeeds(ps, 2).map((p) => p.id), ["b", "a"]);
});

test("AI prompt and JSON parsing", async () => {
  const s = src();
  const tree = await buildTree(s, await s.resolve("10.1109/TED.2026.0001"), { tree: cfg.tree });
  const analysis = analyzeTree(tree, { cat: nand, cfg, topicId: "3d-nand-cell", pool: [] });
  const prompt = buildPrompt([{ tree, analysis }], nand, cfg, []);
  assert.ok(prompt.includes("graded tunnel oxide") && prompt.includes("candidate_gaps"));
  assert.deepEqual(parseJson('```json\n{"gaps": []}\n```'), { gaps: [] });
  assert.equal(SCHEMA.additionalProperties, false);
});

test("free full text: open PDF is read, references dropped, authors' future work becomes a gap", async () => {
  const s = new Sources({ fetch: fakeFetch, pause: 0, pdfjs, keepRx: keepRegexes(cfg) });
  const seed = await s.resolve("10.1109/TED.2026.0001");
  assert.equal(seed.oa_pdf, "https://example.org/W1.pdf");
  const tree = await buildTree(s, seed, { tree: cfg.tree, fullText: true });
  assert.equal(tree.seed.ft.source, "Open-access PDF (OpenAlex)");
  assert.match(tree.seed.body, /Sentaurus TCAD/);
  assert.ok(!/IEEE TED, 2020/.test(tree.seed.body), "reference list is not counted as the paper's own work");
  assert.ok(tree.seed.future.some((f) => /future work/i.test(f)));
  const { gaps } = analyzeTree(tree, { cat: nand, cfg, topicId: "3d-nand-cell", pool: [] });
  assert.equal(gaps[0].type, "authors_future_work");
});

test("full-text helpers", () => {
  assert.equal(htmlToText("<p>Hello <b>world</b></p><script>x()</script>").trim(), "Hello world");
  const t = "Intro text. ".repeat(50) + "\nReferences\n[1] Something fabricated.";
  assert.ok(!stripReferences(t).includes("Something fabricated"));
  const c = condense("We fabricated the device on a wafer. It was nice and very good indeed. Future work will study endurance in detail.", [/fabricated/i]);
  assert.equal(c.future.length, 1);
  assert.match(c.body, /fabricated/);
});

test("OpenAlex: phrases in one OR search, API key sent, stops when the daily budget is spent", async () => {
  const seen = [];
  let n = 0;
  const fetch = async (url) => {
    seen.push(url);
    n++;
    if (n >= 2) return { ok: false, status: 429, headers: new Map([["x-ratelimit-remaining", "0"]]), json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };
  const logs = [];
  const s = new Sources({ fetch, pause: 0, oaKey: "k123", log: (m) => logs.push(m) });
  await s.search(["3D NAND", "charge trap flash"], { since: "2026-01-01" });
  const u = new URL(seen[0]);
  assert.equal(u.searchParams.get("search"), '"3D NAND" OR "charge trap flash"');
  assert.equal(u.searchParams.get("api_key"), "k123");
  assert.deepEqual(await s.search("x"), [], "a spent budget returns no papers instead of failing");
  const before = seen.length;
  await s.search("y");
  assert.equal(seen.length, before, "no more OpenAlex requests once the budget is spent");
  assert.ok(s.oaOut && !logs.join(" ").includes("k123"), "key never logged");
});

test("every gap gets a step-by-step plan with tools, runs and an outcome", async () => {
  const { actionPlan, routeOf } = await import("../site/lib/plan.js");
  const s = src();
  const tree = await buildTree(s, await s.resolve("10.1109/TED.2026.0001"), { tree: cfg.tree });
  const { gaps } = analyzeTree(tree, { cat: nand, cfg, topicId: "3d-nand-cell", pool: [] });
  for (const g of gaps) {
    const plan = actionPlan(g, nand);
    assert.ok(plan.phases.length >= 3 && plan.outcome && plan.effort, g.type);
    assert.ok(plan.phases.every((ph) => ph.steps.length), g.type);
  }
  const miss = gaps.find((g) => g.type === "missing_feature");
  const txt = JSON.stringify(actionPlan(miss, nand));
  assert.match(txt, /Sentaurus/);
  assert.match(txt, /ISPP|Retention bake/);
  assert.match(txt, /with and without/);
  assert.equal(routeOf({ type: "not_in_circuit" }), "circuit");
  assert.match(JSON.stringify(actionPlan({ type: "not_in_circuit" }, nand)), /Verilog-A/);
  assert.match(JSON.stringify(actionPlan({ type: "not_fabricated" }, nand)), /B1500/);
  assert.equal(routeOf({ source: "ai", stage: "Follow-up", title: "Fabricate a vertical cell" }), "fab");
  for (const c of cfg.categories) for (const t of ["tcad", "fab", "circuit", "study"]) {
    const g = { tcad: { type: "missing_feature", feature: c.features[0].id }, fab: { type: "not_fabricated" }, circuit: { type: "not_in_circuit" }, study: { type: "authors_future_work" } }[t];
    assert.ok(actionPlan(g, c).phases.length >= 3, c.id + " " + t);
  }
});

test("fetch order: fields the budget never reached go first, then the oldest", () => {
  const cats = ["nand", "hbm", "dram", "power"].map((id) => ({ id }));
  const idx = { nand: { fetched: "2026-11-16T02:00:00Z" }, hbm: { fetched: "2026-11-09T02:00:00Z" }, dram: {} };
  assert.deepEqual(fetchOrder(cats, idx).map((c) => c.id), ["dram", "power", "hbm", "nand"]);
  assert.deepEqual(fetchOrder(cats).map((c) => c.id), ["nand", "hbm", "dram", "power"]);
});
