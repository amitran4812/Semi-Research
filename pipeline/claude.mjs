// Claude refinement of the rule-based gaps, used by the scheduled build when ANTHROPIC_API_KEY is set.
import Anthropic from "@anthropic-ai/sdk";
import { SCHEMA, SYSTEM, buildPrompt, parseJson } from "../site/lib/ai.js";
import { TREND_SCHEMA, TREND_SYSTEM, trendPrompt } from "../site/lib/trends.js";

const MODEL = process.env.GAPFINDER_MODEL || "claude-opus-5-5";
let client = null;

async function ask(system, user, schema, log, maxTokens = 16000) {
  if (!client) client = new Anthropic();
  try {
    const resp = await client.beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "medium", format: { type: "json_schema", schema } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (resp.stop_reason === "refusal") { log("Claude declined one request"); return null; }
    if (resp.stop_reason === "max_tokens") { log("Claude output hit max_tokens; skipped"); return null; }
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const out = parseJson(text);
    return out ? { ...out, model: resp.model || MODEL } : null;
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) log("Claude rate limited: " + e.message);
    else if (e instanceof Anthropic.APIConnectionError) log("Claude connection error: " + e.message);
    else if (e instanceof Anthropic.APIError) log(`Claude API error ${e.status}: ${e.message}`);
    else throw e;
    return null;
  }
}

export function claudeAnalysis(items, cat, cfg, related, log = console.log) {
  return ask(SYSTEM, buildPrompt(items, cat, cfg, related), SCHEMA, log);
}

// The topic briefing: why it is hot, the core idea, what industry is doing, new search phrases.
export function claudeTrend(topic, cat, inputs, log = console.log) {
  return ask(TREND_SYSTEM, trendPrompt(topic, cat, inputs), TREND_SCHEMA, log, 8000);
}
