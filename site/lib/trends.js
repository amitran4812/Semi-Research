// Trend briefing for a topic: why it is hot, the core idea, what industry is doing, and which search
// terms that suggests. Built from papers per year (OpenAlex), terms that are rising in this year's
// papers compared with three years ago, recent news headlines (Google News RSS) and the hand-written
// background in config.json. Claude (scheduled build) or the visitor's own AI key writes the final text;
// without one, rules write it from the same numbers.

import { cleanText, phraseRegex } from "./text.js";

const STOP = new Set(("a an the and or of in on for to with by from at as is are was were be been this that these those " +
  "we our it its their via using based new novel study analysis results result show shows shown paper proposed propose " +
  "method approach high low which also can than into over under between both each such more most first two three one " +
  "used use different effect effects performance device devices characteristic characteristics model models modeling " +
  "however while where when has have had not only well due through investigated investigate demonstrate demonstrated " +
  "achieve achieved compared respectively significant significantly improved improve improvement work present presented").split(" "));

function words(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\-/ ]+/g, " ").split(/\s+/)
    .map((w) => w.replace(/^[-/]+|[-/]+$/g, ""))
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

// Document frequency of single words and two-word phrases (titles + abstracts).
function termFreq(papers) {
  const df = new Map();
  for (const p of papers) {
    const w = words(p.title + " " + (p.abstract || "").slice(0, 1500));
    const seen = new Set();
    for (let i = 0; i < w.length; i++) {
      const a = w[i], b = w[i + 1];
      const okA = a && a.length >= 3 && !STOP.has(a) && !/^\d+$/.test(a);
      if (okA) seen.add(a);
      if (okA && b && b.length >= 2 && !STOP.has(b) && !/^\d+$/.test(b)) seen.add(a + " " + b);
    }
    seen.forEach((t) => df.set(t, (df.get(t) || 0) + 1));
  }
  return df;
}

/**
 * Terms that appear in a larger share of recent papers than of papers from a few years ago.
 * exclude: the topic's own search phrases (they are in every paper by construction).
 */
export function risingTerms(recent, older, { exclude = [], top = 10, minCount = 3 } = {}) {
  if (!recent.length) return [];
  const R = termFreq(recent), O = termFreq(older);
  const nR = recent.length, nO = Math.max(1, older.length);
  const ex = exclude.length ? phraseRegex(exclude) : null;
  const exWords = new Set(exclude.flatMap((e) => words(e)));
  const out = [];
  for (const [t, c] of R) {
    if (c < minCount) continue;
    if ((ex && ex.test(t)) || t.split(" ").every((w) => exWords.has(w))) continue;
    const shareR = c / nR, shareO = (O.get(t) || 0) / nO;
    const ratio = (shareR + 0.01) / (shareO + 0.01);
    if (ratio < 1.6) continue;
    out.push({ term: t, recent: c, older: O.get(t) || 0, share: Math.round(shareR * 100), ratio: Math.round(ratio * 10) / 10, score: ratio * Math.sqrt(c) * (t.includes(" ") ? 1.4 : 1) });
  }
  out.sort((a, b) => b.score - a.score);
  // Drop a single word when a phrase containing it is already listed.
  const picked = [];
  for (const r of out) {
    if (picked.some((p) => p.term.split(" ").includes(r.term) || r.term.split(" ").includes(p.term) && !r.term.includes(" "))) continue;
    picked.push(r);
    if (picked.length >= top) break;
  }
  return picked.map(({ score, ...r }) => r);
}

// OpenAlex group_by=publication_year -> [{year, count}] sorted, from `from` on.
export function parseYearCounts(j, from) {
  const rows = (j && j.group_by || []).map((g) => ({ year: +g.key, count: g.count })).filter((r) => r.year >= from && r.year <= new Date().getFullYear());
  return rows.sort((a, b) => a.year - b.year);
}

// Growth from papers per year: the last full year against the one before, and over three years.
export function growth(years, now = new Date()) {
  const full = years.filter((y) => y.year < now.getFullYear());
  const last = full[full.length - 1], prev = full[full.length - 2], back3 = full[full.length - 4];
  const pct = (a, b) => (a && b && b.count ? Math.round(((a.count - b.count) / b.count) * 100) : null);
  const cur = years.find((y) => y.year === now.getFullYear());
  const frac = (now - new Date(now.getFullYear(), 0, 1)) / (365.25 * 86400000);
  return {
    last_year: last ? last.year : null, last_count: last ? last.count : 0,
    yoy: pct(last, prev), three_year: pct(last, back3),
    this_year: cur ? cur.count : 0,
    this_year_pace: cur && frac > 0.15 ? Math.round(cur.count / frac) : null,
  };
}

const decode = (s) => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");

// RSS 2.0 (Google News and most feeds) -> [{title, url, date, source}].
export function parseRss(xml, max = 8) {
  const out = [];
  const items = String(xml || "").match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  for (const it of items) {
    const tag = (t) => { const m = it.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]).trim() : ""; };
    let title = cleanText(tag("title").replace(/<[^>]+>/g, ""), 220);
    const source = cleanText(tag("source"), 60);
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    const url = tag("link");
    const d = new Date(tag("pubDate"));
    if (!title || !/^https?:\/\//.test(url)) continue;
    if (out.some((o) => o.title.toLowerCase() === title.toLowerCase())) continue;
    out.push({ title, url, date: isNaN(d) ? "" : d.toISOString().slice(0, 10), source });
    if (out.length >= max) break;
  }
  return out;
}

export function newsUrl(topic) {
  const q = (topic.news || topic.search.slice(0, 3).map((s) => `"${s}"`).join(" OR ")) + " when:60d";
  return "https://news.google.com/rss/search?" + new URLSearchParams({ q, hl: "en-US", gl: "US", ceid: "US:en" }).toString();
}

// Search phrases for the briefing's extra search: hand-picked ones first, then rising phrases.
export function trendTerms(topic, rising, aiTerms = []) {
  const have = new Set(topic.search.map((s) => s.toLowerCase()));
  const out = [];
  const add = (t) => { t = String(t || "").trim(); if (t.length >= 4 && t.length <= 60 && !have.has(t.toLowerCase())) { have.add(t.toLowerCase()); out.push(t); } };
  aiTerms.forEach(add);
  ((topic.brief && topic.brief.terms) || []).forEach(add);
  rising.filter((r) => r.term.includes(" ")).slice(0, 3).forEach((r) => add(r.term));
  return out.slice(0, 5);
}

// Without an AI key: the briefing from the hand-written background plus the numbers.
export function ruleBriefing(topic, { years = [], rising = [], news = [], filers = [] } = {}) {
  const b = topic.brief || {};
  const g = growth(years);
  const nums = [];
  if (g.yoy != null) nums.push(`OpenAlex lists ${g.last_count} papers on it in ${g.last_year}, ${g.yoy >= 0 ? "up" : "down"} ${Math.abs(g.yoy)}% on the year before${g.three_year != null ? ` and ${g.three_year >= 0 ? "up" : "down"} ${Math.abs(g.three_year)}% on three years earlier` : ""}.`);
  if (g.this_year_pace) nums.push(`This year is on pace for about ${g.this_year_pace}.`);
  if (rising.length) nums.push(`Terms showing up more often than three years ago: ${rising.slice(0, 5).map((r) => r.term).join(", ")}.`);
  return {
    why_hot: [b.why, ...nums].filter(Boolean).join(" "),
    core_idea: b.idea || "",
    industry_now: [b.industry, filers.length ? `Most patent families published in the last year: ${filers.slice(0, 4).map((f) => `${f.name} (${f.count})`).join(", ")}.` : "", news.length ? `Recent headlines are listed below; ${news.length} in the last two months.` : ""].filter(Boolean).join(" "),
    open_questions: b.questions || [],
    search_terms: trendTerms(topic, rising),
    by: "rules",
  };
}

const STR = { type: "string" };
export const TREND_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["why_hot", "core_idea", "industry_now", "open_questions", "search_terms"],
  properties: { why_hot: STR, core_idea: STR, industry_now: STR, open_questions: { type: "array", items: STR }, search_terms: { type: "array", items: STR } },
};

export const TREND_SYSTEM =
  "You brief a semiconductor device researcher on one research topic before they look for a research gap. Answer these questions " +
  "from the material supplied (papers per year, terms rising in recent papers, recent news headlines, who filed patents in the last year, recent paper titles and a " +
  "hand-written background): Why is this topic trending, and why is it hot right now? What is the core idea behind it? What is " +
  "happening in the market and what is industry doing (products, roadmaps, standards, who is investing)? Write 'why_hot' (2-4 " +
  "sentences, use the numbers), 'core_idea' (1-3 sentences, the device physics or architecture idea), 'industry_now' (2-4 " +
  "sentences, only what the headlines or background support, name companies only when a headline or the background does), " +
  "'open_questions' (3-5 questions the field has not answered yet, which a device researcher could work on) and 'search_terms' " +
  "(3-5 short literature search phrases, 2-4 words each, for the newest work this briefing points to that the topic's current " +
  "search phrases would miss). Headlines are short and may be promotional; do not treat them as measured results. Do not invent " +
  "numbers, dates, products or companies. Plain text, no markdown.";

export function trendPrompt(topic, cat, inputs) {
  const payload = {
    field: cat.name, topic: topic.name, current_search_phrases: topic.search,
    background: topic.brief || {},
    papers_per_year: inputs.years || [], growth: growth(inputs.years || []),
    rising_terms: (inputs.rising || []).map((r) => `${r.term} (in ${r.share}% of recent papers, ${r.ratio}x the share three years ago)`),
    news_last_60_days: (inputs.news || []).map((n) => `${n.date} ${n.source ? n.source + ": " : ""}${n.title}`),
    patent_filers_last_year: (inputs.filers || []).map((f) => `${f.name} (${f.count} patent families)`),
    recent_paper_titles: (inputs.titles || []).slice(0, 30),
  };
  return "Topic material (JSON):\n" + JSON.stringify(payload);
}
