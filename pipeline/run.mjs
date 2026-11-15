#!/usr/bin/env node
// Scheduled build: for every topic, fetch recent papers (IEEE Transactions first), build a citation
// tree for the best few, find gaps, optionally ask Claude to refine them, and write site/data/*.json.
//
//   node pipeline/run.mjs                 all categories
//   node pipeline/run.mjs --only nand     one category (comma-separate several)
//   node pipeline/run.mjs --no-ai         skip Claude even when ANTHROPIC_API_KEY is set
//   node pipeline/run.mjs --refresh       rebuild trees even when they are recent

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Sources, venueRank } from "../site/lib/sources.js";
import { buildTree, slim } from "../site/lib/tree.js";
import { analyzeTree } from "../site/lib/engine.js";
import { phraseRegex } from "../site/lib/text.js";
import { claudeAnalysis } from "./claude.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(here, "..", "site");
const DATA = process.env.GAPFINDER_DATA_DIR || path.join(SITE, "data");
const cfg = JSON.parse(fs.readFileSync(path.join(SITE, "config.json"), "utf8"));

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const only = opt("--only") ? opt("--only").split(",") : null;
const useAI = !flag("--no-ai") && !!process.env.ANTHROPIC_API_KEY;
const refresh = flag("--refresh");
const TREE_MAX_AGE_DAYS = 14;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const src = new Sources({ mailto: process.env.OPENALEX_EMAIL || "", s2Key: process.env.S2_API_KEY || "", log, pause: 150 });

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return dflt; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(data));
  fs.renameSync(file + ".tmp", file);
}
const daysAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;

export function pickSeeds(papers, n) {
  return papers
    .filter((p) => (p.abstract || "").length > 300)
    .sort((a, b) => venueRank(b.venue) - venueRank(a.venue) || String(b.date).localeCompare(String(a.date)))
    .slice(0, n);
}

async function topicPapers(cat, topic, since) {
  const byId = new Map();
  const add = (p) => { if (p.id && !byId.has(p.id)) byId.set(p.id, p); };
  for (const phrase of topic.search) {
    (await src.search(phrase, { since, issns: cat.venues_issn, perPage: 25 })).forEach(add);
    (await src.search(phrase, { since, perPage: 40 })).forEach(add);
  }
  const rx = phraseRegex(topic.search);
  return [...byId.values()].filter((p) => rx.test(p.title + " " + p.abstract));
}

async function main() {
  const since = new Date(Date.now() - cfg.lookback_days * 86400000).toISOString().slice(0, 10);
  const index = readJson(path.join(DATA, "index.json"), { categories: [] });
  const catIndex = Object.fromEntries((index.categories || []).map((c) => [c.id, c]));
  let aiCalls = 0;

  for (const cat of cfg.categories) {
    if (only && !only.includes(cat.id)) continue;
    log(`== ${cat.name}`);
    const pools = {};
    for (const topic of cat.topics) {
      pools[topic.id] = (await topicPapers(cat, topic, since)).map((p) => ({ ...p, topic: topic.id }));
      log(`   ${topic.id}: ${pools[topic.id].length} recent papers`);
    }
    const catPool = Object.values(pools).flat();
    const topicsOut = [];

    for (const topic of cat.topics) {
      const file = path.join(DATA, "topics", topic.id + ".json");
      const old = readJson(file, { seeds: [] });
      const oldTrees = Object.fromEntries((old.seeds || []).map((t) => [t.seed.id, t]));
      const pool = pools[topic.id];
      if (!pool.length && (old.pool || []).length) {
        log(`   ${topic.id}: no papers fetched (API down?), keeping the previous data`);
        const prev = (catIndex[cat.id] && catIndex[cat.id].topics || []).find((t) => t.id === topic.id);
        if (prev) topicsOut.push(prev);
        continue;
      }
      const seeds = pickSeeds(pool, cfg.seeds_per_topic);
      const trees = [];
      for (const seed of seeds) {
        let tree = oldTrees[seed.id];
        if (!tree || refresh || daysAgo(tree.built) > TREE_MAX_AGE_DAYS) {
          log(`   tree: ${seed.title.slice(0, 70)}`);
          const fresh = await buildTree(src, seed, { tree: cfg.tree });
          if (tree && tree.ai) fresh.ai = tree.ai;
          tree = fresh;
        }
        const analysis = analyzeTree(tree, { cat, cfg, topicId: topic.id, pool: catPool, topicName: (id) => (cat.topics.find((t) => t.id === id) || {}).name || id });
        tree.rule_gaps = analysis.gaps.length;
        if (useAI && (!tree.ai || tree.ai.built !== tree.built)) {
          const related = catPool.filter((p) => p.id !== seed.id).slice(0, 25);
          const ai = await claudeAnalysis([{ tree, analysis }], cat, cfg, related, log);
          aiCalls++;
          if (ai) tree.ai = { ...ai, built: tree.built };
        }
        tree.top_gap = (tree.ai && tree.ai.gaps && tree.ai.gaps[0] && tree.ai.gaps[0].title) || (analysis.gaps[0] && analysis.gaps[0].title) || "";
        trees.push(tree);
      }
      const poolSlim = pool
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .slice(0, 90)
        .map((p) => ({ ...slim(p, 500), topic: topic.id }));
      writeJson(file, { topic: topic.id, category: cat.id, updated: new Date().toISOString(), since, pool: poolSlim, seeds: trees });
      topicsOut.push({
        id: topic.id, name: topic.name, papers: pool.length, seeds: trees.length,
        tx: pool.filter((p) => p.tx).length,
        gaps: trees.reduce((n, t) => n + ((t.ai && t.ai.gaps && t.ai.gaps.length) || t.rule_gaps || 0), 0),
        top_gap: (trees[0] && trees[0].top_gap) || "",
      });
    }
    catIndex[cat.id] = { id: cat.id, name: cat.name, topics: topicsOut, updated: new Date().toISOString() };
  }

  const out = {
    updated: new Date().toISOString(),
    ai: useAI,
    categories: cfg.categories.map((c) => catIndex[c.id]).filter(Boolean),
  };
  writeJson(path.join(DATA, "index.json"), out);
  log(`Done. API calls: ${src.calls} (papers), ${aiCalls} (Claude).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
