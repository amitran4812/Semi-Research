# Gap Finder

A website that finds research gaps in semiconductor devices. Papers are split into fields (**NAND flash**, **DRAM**, **high-power devices**, **wide-bandgap devices**), each field into topics, and every topic gets its own page of research gaps laid out as square cards, in the same look as the Device Hub research portal (red header, card grid, light and dark theme).

For each topic it:

1. **Finds the newest papers**, IEEE Transactions first (OpenAlex search over the last 150 days, plus the core device journals by ISSN).
2. **Builds a citation tree** for the best few: the paper's references, its **base paper** (the most similar and most influential reference), the papers that cite it, who else builds on the base paper, and who builds on the next most important references. Semantic Scholar adds *why* each paper was cited (methodology / background / result, and the sentence that cites it).
3. **Works out what each paper did** from its abstract: simulation / TCAD only, fabricated and measured, or used in a circuit, and which physical effects it covers (retention, self-heating, trapping, GIDL, …).
4. **Lists the gaps**, each with the papers it rests on and concrete next steps:
   - *Not fabricated yet*: simulated only, and nobody citing it has built one.
   - *Missing physics / TCAD feature*: an effect many papers in the topic study but this one leaves out, with the TCAD model to turn on.
   - *Not used in a circuit yet*: with the compact model to fit and the EDA tools to use (Cadence Spectre, HSPICE, ngspice/Xyce + OpenVAF, LTspice, PLECS, Keysight ADS, ASM-HEMT, …) and the steps.
   - *Idea from a nearby topic*: a technique used in a sibling topic (for example cache / page buffer work in NAND) that is missing here.
   - *Untried combination*: two directions people building on the base paper follow, but never together.
5. A **coverage grid** per topic shows, for every effect, how many recent papers are simulation, fabricated or circuit-level, so thin spots stand out.

### My papers

On **My papers** anyone can add their own paper or several (DOI, arXiv id, OpenAlex link or title; or drop PDFs, `.bib`, `.ris` or `.txt` files). The browser builds a local citation tree for each one straight from OpenAlex and Semantic Scholar, merges them into one local tree, shows the papers they have in common, and runs the same gap checks, plus checks *between* the user's papers (a technique one uses that another lacks; a simulated one that the fabricated one could calibrate). Results stay in that browser.

### Bring your own AI key

The key button (top right) takes a key for **Claude, OpenAI, Gemini or any OpenAI-compatible API** (OpenRouter, Groq, Mistral, DeepSeek, a local Ollama or LM Studio server). Then every citation tree, including the user's own, gets an **Analyse with AI** button (summary, why the base paper matters, sharper gaps, and whether each related paper's idea is already done here, applies, partly applies or does not apply) and a box to ask questions about the tree. The key stays in the browser and is sent only to the chosen provider; it is forgotten when the tab closes unless "Remember" is ticked.

## How it runs

A GitHub Actions job (`.github/workflows/update.yml`) runs every Monday at 01:00 UTC and on demand. It fetches papers, builds the trees, writes `site/data/*.json`, commits them and publishes `site/` to GitHub Pages. No server.

### Set up

1. Push to `main`.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Actions → Update Gap Finder → Run workflow** for the first build (about 20–40 minutes for all four fields; use the *only* box, e.g. `nand`, for one field).

The site is then at `https://<user>.github.io/<repo>/`.

### Optional settings

| Name | Type | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Actions *secret* | Claude refines the gaps for every tree during the scheduled build (marked **AI** on the site). Without it, the rule-based gaps are shown, and visitors can still use their own key. |
| `GAPFINDER_MODEL` | Actions *variable* | Claude model for the build. Default `claude-opus-5-5`. |
| `OPENALEX_EMAIL` | Actions *variable* | Contact email for OpenAlex's faster "polite pool". |
| `S2_API_KEY` | Actions *secret* | Semantic Scholar key (free on request) for higher rate limits. |

Trees are kept for 14 days and only new ones are sent to Claude, so a weekly run makes at most about 50 Claude calls.

## Customising

Everything lives in [`site/config.json`](site/config.json):

- `categories[].topics`: each topic's search phrases. Add a topic and it gets its own page and square.
- `categories[].venues_issn`: journals searched first (IEEE T-ED, T-PEL, TDMR, EDL, JSSC, JEDS, …).
- `categories[].features`: the effects and techniques checked, the words that detect them, and the TCAD advice for each (`kind: technique` ones can move between topics).
- `categories[].eda`: compact model, EDA tools and steps for the "put it in a circuit" gap.
- `stage_terms`: words that mark a paper as simulation, fabricated or circuit-level.
- `tree`: how many references and citing papers each tree keeps.

## Running locally

```bash
npm install
node pipeline/run.mjs --only nand      # or no flag for all fields; --no-ai, --refresh
npm run serve                          # http://localhost:8000
npm test                               # offline tests
```

## Layout

```
site/
  index.html, styles.css, app.js     front end (square-card layout, tree diagram, My papers, AI key)
  art.js, motion.js                  cover art and motion from the Device Hub portal
  config.json                        fields, topics, effects, EDA advice
  lib/sources.js                     OpenAlex + Semantic Scholar clients (browser and Node)
  lib/tree.js                        citation tree builder, base-paper choice
  lib/engine.js                      stage detection, gap checks, coverage grid
  lib/ai.js                          prompt, JSON schema, bring-your-own-key providers
  data/                              written by the scheduled build
pipeline/run.mjs                     scheduled build
pipeline/claude.mjs                  Claude refinement (Anthropic SDK)
tests/                               offline tests with made-up fixture papers
```

The same tree and gap code runs in the scheduled build and in the browser, so a user's own papers get exactly the same checks as the topic pages.

## Limits

Gaps are worked out from titles and abstracts, not full texts, so treat each one as a lead and read the linked papers. Paywalled publishers sometimes hide abstracts from OpenAlex; those papers are judged by title only. Semantic Scholar's public rate limit is shared, so "why cited" sentences can be missing on busy days.
