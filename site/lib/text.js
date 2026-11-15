// Text helpers shared by the browser and the Node pipeline.

const STOP = new Set(("a an and are as at be based by can for from has have in into is it its of on or our show shows shown that the their these this those to using via was we were which with without within than then also such both between over under more most high low new novel study paper proposed propose results result device devices based approach method methods analysis performance model models effect effects large small work used use different two three one however while different significant significantly order further compared respectively characteristics characteristic investigated investigate demonstrated demonstrate").split(/\s+/));

export function cleanText(s, limit) {
  if (!s) return "";
  s = String(s).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
  if (limit && s.length > limit) s = s.slice(0, limit - 1).replace(/\s+\S*$/, "") + "…";
  return s;
}

export function normTitle(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function tokens(s) {
  const out = new Set();
  String(s || "").toLowerCase().replace(/[^a-z0-9\-/ ]+/g, " ").split(/\s+/).forEach((w) => {
    w = w.replace(/^[-/]+|[-/]+$/g, "");
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) return;
    if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.add(w);
  });
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export function shared(a, b, max) {
  const out = [];
  for (const w of a) if (b.has(w)) out.push(w);
  return out.slice(0, max || 6);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Regex for a list of phrases: whole-word, optional plural, space and hyphen interchangeable.
export function phraseRegex(words) {
  const alts = [...new Set((words || []).map((w) => w.toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!alts.length) return null;
  const body = alts.map((a) => escapeRe(a).replace(/(\\-| )/g, "[\\s\\-]")).join("|");
  return new RegExp("(?<![a-z0-9])(?:" + body + ")s?(?![a-z0-9])", "i");
}

export function abstractFromIndex(inv) {
  if (!inv) return "";
  const pos = [];
  for (const [w, idxs] of Object.entries(inv)) for (const i of idxs) pos.push([i, w]);
  pos.sort((a, b) => a[0] - b[0]);
  return pos.map((p) => p[1]).join(" ");
}

export function findDois(text) {
  const out = new Set();
  const rx = /\b10\.\d{4,9}\/[^\s"'<>(){}\[\],;]+/gi;
  let m;
  while ((m = rx.exec(String(text || "")))) out.add(m[0].replace(/[.)\]]+$/, ""));
  return [...out];
}
