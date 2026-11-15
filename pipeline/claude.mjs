// Claude refinement of the rule-based gaps, used by the scheduled build when ANTHROPIC_API_KEY is set.
import Anthropic from "@anthropic-ai/sdk";
import { SCHEMA, SYSTEM, buildPrompt, parseJson } from "../site/lib/ai.js";

const MODEL = process.env.GAPFINDER_MODEL || "claude-opus-5-5";
let client = null;

export async function claudeAnalysis(items, cat, cfg, related, log = console.log) {
  if (!client) client = new Anthropic();
  try {
    const resp = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: "user", content: buildPrompt(items, cat, cfg, related) }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (resp.stop_reason === "refusal") { log("Claude declined one analysis"); return null; }
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
