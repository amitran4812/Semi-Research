import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { growth, parseRss, parseYearCounts, risingTerms, ruleBriefing, trendTerms, TREND_SCHEMA, trendPrompt } from "../site/lib/trends.js";

const cfg = JSON.parse(fs.readFileSync(new URL("../site/config.json", import.meta.url)));
const hbf = cfg.categories.find((c) => c.id === "hbf");
const topic = hbf.topics.find((t) => t.id === "hbf");

const RSS = `<?xml version="1.0"?><rss><channel><title>x</title>
<item><title>Flash makers team up on high bandwidth flash - Example News</title><link>https://news.example.com/a</link><pubDate>Mon, 03 Nov 2026 08:00:00 GMT</pubDate><source url="https://news.example.com">Example News</source></item>
<item><title><![CDATA[HBF &amp; HBM: what AI inference needs]]></title><link>https://news.example.com/b</link><pubDate>Tue, 28 Oct 2026 08:00:00 GMT</pubDate></item>
<item><title>Flash makers team up on high bandwidth flash - Example News</title><link>https://news.example.com/a2</link><source>Example News</source></item>
<item><title>No link</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

test("news: RSS items parsed, source split off, duplicates and bad links dropped", () => {
  const n = parseRss(RSS);
  assert.equal(n.length, 2);
  assert.deepEqual(n[0], { title: "Flash makers team up on high bandwidth flash", url: "https://news.example.com/a", date: "2026-11-03", source: "Example News" });
  assert.equal(n[1].title, "HBF & HBM: what AI inference needs");
});

test("papers per year and growth", () => {
  const j = { group_by: [{ key: "2026", count: 90 }, { key: "2024", count: 50 }, { key: "2025", count: 80 }, { key: "2022", count: 40 }, { key: "2023", count: 45 }, { key: "2010", count: 3 }] };
  const ys = parseYearCounts(j, 2016);
  assert.deepEqual(ys.map((y) => y.year), [2022, 2023, 2024, 2025, 2026]);
  const g = growth(ys, new Date("2026-11-15"));
  assert.equal(g.last_year, 2025);
  assert.equal(g.yoy, 60);
  assert.equal(g.three_year, 100);
  assert.ok(g.this_year_pace > 90);
});

test("rising terms: new phrases rank, the topic's own phrase is excluded", () => {
  const mk = (t) => ({ title: t, abstract: "" });
  const recent = [
    ...Array.from({ length: 6 }, (_, i) => mk(`High bandwidth flash for LLM inference weights, stack ${i}`)),
    ...Array.from({ length: 4 }, (_, i) => mk(`Read disturb in high bandwidth flash under KV cache traffic ${i}`)),
  ];
  const older = Array.from({ length: 10 }, (_, i) => mk(`NAND flash program speed and retention study ${i}`));
  const r = risingTerms(recent, older, { exclude: topic.search });
  const terms = r.map((x) => x.term);
  assert.ok(terms.includes("read disturb"), terms.join());
  assert.ok(!terms.includes("llm inference"), "words of the topic's own phrases are excluded");
  assert.ok(!terms.some((t) => /bandwidth flash/.test(t)), terms.join());
  assert.ok(r[0].ratio > 1.6 && r[0].share > 0);
});

test("briefing without AI: background plus numbers, and search phrases", () => {
  const b = ruleBriefing(topic, { years: [{ year: 2024, count: 10 }, { year: 2025, count: 20 }], rising: [{ term: "kv cache", share: 30, ratio: 5 }], news: [] });
  assert.match(b.core_idea, /through-silicon vias/);
  assert.match(b.why_hot, /up 100%/);
  assert.match(b.why_hot, /kv cache/);
  assert.equal(b.by, "rules");
  assert.ok(b.search_terms.includes("kv cache") && b.search_terms.length <= 5);
  assert.ok(!trendTerms(topic, [], ["high bandwidth flash"]).includes("high bandwidth flash"), "existing phrases are not repeated");
  for (const c of cfg.categories) for (const t of c.topics) assert.ok(t.brief && t.brief.idea && t.brief.why && t.brief.industry && t.brief.terms.length, t.id);
});

test("briefing prompt and schema", () => {
  const p = trendPrompt(topic, hbf, { years: [{ year: 2025, count: 5 }], rising: [], news: [{ date: "2026-11-03", source: "X", title: "Y" }], titles: ["Z"] });
  assert.ok(p.includes("high bandwidth flash") && p.includes("2026-11-03 X: Y"));
  assert.equal(TREND_SCHEMA.additionalProperties, false);
  assert.deepEqual(TREND_SCHEMA.required.sort(), Object.keys(TREND_SCHEMA.properties).sort());
});
