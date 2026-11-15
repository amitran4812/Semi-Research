// AI analysis of a citation tree. The prompt and output schema are shared by the browser
// (bring your own key, any provider) and the scheduled pipeline (Claude via the Anthropic SDK).

import { cleanText } from "./text.js";
import { GAP_TYPES, profile, STAGES } from "./engine.js";

const STR = { type: "string" };
const LIST = { type: "array", items: STR };
const obj = (props) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
const GAP_STAGES = [...new Set(Object.values(GAP_TYPES).map((g) => g.stage))];

export const SCHEMA = obj({
  summary: STR,
  base_reason: STR,
  gaps: { type: "array", items: obj({ title: STR, stage: { type: "string", enum: GAP_STAGES }, why: STR, evidence_ids: LIST, next_steps: LIST, tools: LIST }) },
  applicability: { type: "array", items: obj({ id: STR, verdict: { type: "string", enum: ["already done here", "applies", "partly applies", "does not apply"] }, note: STR }) },
});

export const SYSTEM =
  "You are a research adviser for semiconductor device researchers (NAND, DRAM, power and wide-bandgap devices). " +
  "You get one or more target papers, their citation tree (references, the base paper, papers citing them, and papers " +
  "building on the base paper), related recent papers from the same field, and a list of candidate gaps found by keyword rules. " +
  "Using only the supplied titles, abstracts and full-text excerpts (where a free full text was found): write 'summary' (at most 80 words: what the target paper(s) did, and at which " +
  "stage: simulation/TCAD only, fabricated and measured, or used in a circuit); 'base_reason' (one or two sentences on why the " +
  "base paper matters to the target and what the target changed); 'gaps' (3-6 concrete research gaps, best first: confirm, sharpen " +
  "or reject the candidate gaps and add better ones; the authors' own stated limitations and future work are strong leads, but check whether a citing paper has already done them. Typical gaps: simulated but never fabricated; a physical effect or TCAD model " +
  "missing; a device never evaluated in a circuit (name the compact model and EDA tool, e.g. Verilog-A + Cadence Spectre, ASM-HEMT, " +
  "LTspice/PLECS, ngspice); a technique from a related paper that could apply. Each gap cites the ids of the papers it rests on, " +
  "and gives 3-5 next steps a PhD student could start this month); 'applicability' (for up to 8 of the most relevant related or " +
  "citing papers: is their idea already done in the target, does it apply, partly apply, or not apply, with a one-line note). " +
  "Do not invent results, numbers or papers. If an abstract is too thin to judge, say so in the note. Plain text, no markdown.";

function brief(p, cat, cfg, n = 450) {
  const pr = profile(p, cat, cfg);
  const out = { id: p.id, title: p.title, year: p.year, venue: p.venue, stage: STAGES[pr.stage].short, judged_from: pr.basis, features: pr.features, abstract: cleanText(p.abstract, n), why_cited: p.why && p.why.context || undefined };
  if (n >= 800 && p.body) out.full_text_excerpt = cleanText(p.body, n >= 2000 ? 3500 : 1200);
  if (p.future && p.future.length) out.authors_limitations_and_future_work = p.future;
  return out;
}

// One or several trees (the user's own papers) -> the user message.
export function buildPrompt(items, cat, cfg, related = []) {
  const payload = { category: cat.name, targets: [], related: related.slice(0, 25).map((p) => brief(p, cat, cfg, 300)) };
  for (const { tree, analysis } of items) {
    const N = tree.nodes || {};
    const pick = (ids, k) => (ids || []).slice(0, k).map((id) => N[id]).filter(Boolean).map((p) => brief(p, cat, cfg));
    payload.targets.push({
      paper: brief(tree.seed, cat, cfg, 2000),
      base_paper: N[tree.base] ? brief(N[tree.base], cat, cfg, 800) : null,
      references: pick(tree.references, 12),
      cited_by: pick(tree.citers, 12),
      building_on_base: pick(tree.base_citers, 10),
      candidate_gaps: (analysis.gaps || []).map((g) => ({ type: g.type, title: g.title, why: g.why, evidence: g.evidence })),
    });
  }
  return "Papers (JSON):\n" + JSON.stringify(payload);
}

export function parseJson(text) {
  if (!text) return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return null;
}

// ------------------------------------------------------------------ bring-your-own-key providers (browser)
export const PROVIDERS = {
  anthropic: { name: "Claude (Anthropic)", model: "claude-opus-5-5", keyHint: "sk-ant-…", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { name: "OpenAI", model: "gpt-4.1", keyHint: "sk-…", keyUrl: "https://platform.openai.com/api-keys" },
  gemini: { name: "Google Gemini", model: "gemini-2.5-flash", keyHint: "AIza…", keyUrl: "https://aistudio.google.com/app/apikey" },
  compatible: { name: "Other (OpenAI-compatible: OpenRouter, Groq, Mistral, DeepSeek, Ollama…)", model: "", keyHint: "key (blank for a local server)", base: "https://openrouter.ai/api/v1" },
};

async function post(url, headers, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = j && (j.error && (j.error.message || j.error) || j.message) || r.statusText;
    throw new Error(`${r.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  return j;
}

/**
 * Send one request to the provider the user chose.
 * settings: { provider, key, model, base }. json: true asks for the gap schema.
 * Returns the reply text.
 */
export async function complete(settings, system, user, { json = false, maxTokens = 16000 } = {}) {
  const p = settings.provider || "anthropic";
  const model = settings.model || PROVIDERS[p].model;
  if (p === "anthropic") {
    const body = {
      model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }],
      output_config: json ? { effort: "medium", format: { type: "json_schema", schema: SCHEMA } } : { effort: "medium" },
      fallbacks: "default",
    };
    const j = await post("https://api.anthropic.com/v1/messages", {
      "x-api-key": settings.key, "anthropic-version": "2023-06-01",
      "anthropic-beta": "server-side-fallback-2026-07-01",
      "anthropic-dangerous-direct-browser-access": "true",
    }, body);
    if (j.stop_reason === "refusal") throw new Error("The model declined this request.");
    return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  if (p === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const j = await post(url, { "x-goog-api-key": settings.key }, {
      systemInstruction: { parts: [{ text: system + (json ? "\nReply with JSON matching this schema: " + JSON.stringify(SCHEMA) : "") }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: json ? { responseMimeType: "application/json" } : {},
    });
    const c = j.candidates && j.candidates[0];
    return c && c.content ? c.content.parts.map((x) => x.text || "").join("") : "";
  }
  // OpenAI and OpenAI-compatible servers
  const base = (p === "openai" ? "https://api.openai.com/v1" : (settings.base || PROVIDERS.compatible.base)).replace(/\/+$/, "");
  const body = { model, messages: [{ role: "system", content: system + (json && p !== "openai" ? "\nReply with JSON only, matching this schema: " + JSON.stringify(SCHEMA) : "") }, { role: "user", content: user }] };
  if (json) body.response_format = p === "openai" ? { type: "json_schema", json_schema: { name: "gaps", strict: true, schema: SCHEMA } } : { type: "json_object" };
  const j = await post(base + "/chat/completions", settings.key ? { authorization: "Bearer " + settings.key } : {}, body);
  return j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content || "" : "";
}

export async function analyzeWithAI(settings, items, cat, cfg, related) {
  const text = await complete(settings, SYSTEM, buildPrompt(items, cat, cfg, related), { json: true });
  const out = parseJson(text);
  if (!out || !Array.isArray(out.gaps)) throw new Error("The model's reply was not in the expected format. Try again or pick another model.");
  return out;
}

export const CHAT_SYSTEM =
  "You answer questions from a semiconductor device researcher about the papers supplied (a citation tree and related papers). " +
  "Use only the supplied titles and abstracts, cite paper ids in square brackets like [W123], and say when the abstracts do not answer the question. " +
  "Be concrete: name TCAD models, fabrication steps, compact models and EDA tools where useful. Plain text, short paragraphs.";
