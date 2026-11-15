# Gap Finder

A website that finds research gaps in semiconductor devices. The main focus is **memory and storage**: **NAND flash** (incl. SSDs), **HBF, HBM & 3D memory**, **DRAM**, and **emerging memory** (MRAM, ReRAM, PCM, FeFET / FeRAM, compute-in-memory). **High-power** and **wide-bandgap** devices are covered as a second group. 28 topics in all, each field split into topics, and every topic gets its own page of research gaps laid out as square cards, in the same look as the Device Hub research portal (red header, card grid, light and dark theme).

For each topic it:

0. **Works out why the topic is hot** before it searches. It answers three questions: why is it trending now, what is the core idea, and what is industry doing? It uses papers per year (OpenAlex), terms that turn up in this year's papers far more often than three years ago, news headlines from the last two months (Google News RSS) and a short background written by hand for every topic in `config.json`. Claude writes the briefing when a key is set; otherwise rules write it from the same numbers. The briefing's search phrases then run as an extra search, so newer work that the fixed phrases miss is found too (marked *via briefing*). Each topic page opens with a **Why it's hot · Industry now** section: the three answers, a papers-per-year chart, the rising terms, the headlines and open questions. Visitors can rewrite the briefing with their own AI key.
1. **Finds the newest papers every week**, IEEE Transactions first (OpenAlex search over the last 150 days, plus the core device journals by ISSN).
2. **Builds a citation tree** for the best few: the paper's references, its **base paper** (the most similar and most influential reference), the papers that cite it, who else builds on the base paper, and who builds on the next most important references. Semantic Scholar adds *why* each paper was cited (methodology / background / result, and the sentence that cites it).
3. **Reads the free full text** where a legal open copy exists (arXiv HTML/PDF, the open-access PDF links from OpenAlex, Semantic Scholar and Unpaywall, and CORE's repository full texts; Crossref fills in missing abstracts). It keeps the sentences about what was fabricated, simulated or put in a circuit, and the authors' own **limitations and future work**. Google Scholar has no API and blocks automated access, so it is only linked from every paper.
4. **Works out what each paper did** from the full text, or from the abstract when there is none: simulation / TCAD only, fabricated and measured, or used in a circuit, and which physical effects it covers (retention, self-heating, trapping, GIDL, …).
5. **Lists the gaps**, each with the papers it rests on and concrete next steps:
   - *Left open by the authors*: their own stated limitations and future work (full text only).
   - *Not fabricated yet*: simulated only, and nobody citing it has built one.
   - *Missing physics / TCAD feature*: an effect many papers in the topic study but this one leaves out, with the TCAD model to turn on.
   - *Not used in a circuit yet*: with the compact model to fit and the EDA tools to use (Cadence Spectre, HSPICE, ngspice/Xyce + OpenVAF, LTspice, PLECS, Keysight ADS, ASM-HEMT, …) and the steps.
   - *Idea from a nearby topic*: a technique used in a sibling topic (for example cache / page buffer work in NAND) that is missing here.
   - *Untried combination*: two directions people building on the base paper follow, but never together.
6. A **coverage grid** per topic shows, for every effect, how many recent papers are simulation, fabricated or circuit-level, so thin spots stand out.

### My papers

On **My papers** anyone can add their own paper or several (DOI, arXiv id, OpenAlex link or title; or drop PDFs, `.bib`, `.ris` or `.txt` files). Dropped PDFs are read in full in the browser (pdf.js), so a user's own paper is judged from its full text, including its future-work section. The browser builds a local citation tree for each one straight from OpenAlex and Semantic Scholar, merges them into one local tree, shows the papers they have in common, and runs the same gap checks, plus checks *between* the user's papers (a technique one uses that another lacks; a simulated one that the fabricated one could calibrate). Results stay in that browser.

### Bring your own AI key

The key button (top right) takes a key for **Claude, OpenAI, Gemini or any OpenAI-compatible API** (OpenRouter, Groq, Mistral, DeepSeek, a local Ollama or LM Studio server). Then every citation tree, including the user's own, gets an **Analyse with AI** button (summary, why the base paper matters, sharper gaps, and whether each related paper's idea is already done here, applies, partly applies or does not apply) and a box to ask questions about the tree. The key stays in the browser and is sent only to the chosen provider; it is forgotten when the tab closes unless "Remember" is ticked.

### Access code

Add a repository secret **`GAPFINDER_ACCESS_CODE`** and the site asks for that code before it shows anything. This is not a JavaScript check that can be skipped: the build encrypts every data file (`site/data/*.json`) with AES-256-GCM, using a key made from the code (PBKDF2-SHA256, 600,000 rounds). Without the code the published files are unreadable. Only `data/lock.json` is public; it holds a random salt and an encrypted check value, never the code. Visitors can tick "Remember on this device"; "Lock this device" in the footer forgets it.

- Use a long code (a passphrase of four or more words). The encrypted files are public, so a short code can be guessed offline.
- Change the code by changing the secret and running the workflow for **all** fields; older data sealed with the old code is rebuilt.
- What it does not hide: in a public repository the source code and `config.json` (topics, search phrases, background text) stay readable, and so do any data files committed before the code was set (git history). Make the repository private to hide those too (GitHub Pages from a private repository needs a paid GitHub plan).
- Remove the secret to open the site again.

## How it runs

A GitHub Actions job (`.github/workflows/update.yml`) pulls new papers once a week (Mondays 01:00 UTC) and on demand. It fetches papers, builds the trees, writes `site/data/*.json`, commits them and publishes `site/` to GitHub Pages. No server.

### Set up

1. Push to `main`.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Actions → Update Gap Finder → Run workflow** for the first build (about 30–60 minutes for all six fields; use the *only* box, e.g. `nand,hbf`, for some fields).

The site is then at `https://<user>.github.io/<repo>/`.

### Optional settings

| Name | Type | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Actions *secret* | Claude refines the gaps for every tree during the scheduled build (marked **AI** on the site). Without it, the rule-based gaps are shown, and visitors can still use their own key. |
| `GAPFINDER_MODEL` | Actions *variable* | Claude model for the build. Default `claude-opus-5-5`. |
| `OPENALEX_EMAIL` | Actions *variable* | Contact email for OpenAlex's faster "polite pool". |
| `S2_API_KEY` | Actions *secret* | Semantic Scholar key (free on request) for higher rate limits. |
| `UNPAYWALL_EMAIL` | Actions *variable* | Email Unpaywall asks for; turns on Unpaywall open-access lookups (falls back to `OPENALEX_EMAIL`). |
| `CORE_API_KEY` | Actions *secret* | Free key from core.ac.uk; adds full texts from university repositories. |
| `GAPFINDER_ACCESS_CODE` | Actions *secret* | Locks the site behind this code (see *Access code*). |

Trees are kept for 14 days and only new ones are sent to Claude, so a weekly run makes at most about 50 Claude calls for trees plus one briefing per topic (28).

## Customising

Everything lives in [`site/config.json`](site/config.json):

- `categories[].topics`: each topic's search phrases and `brief` (core idea, why it is hot, what industry is doing, extra search phrases). Add a topic and it gets its own page and square. `brief_asof` dates the hand-written background; update it when the field moves.
- `categories[].venues_issn`: journals searched first (IEEE T-ED, T-PEL, TDMR, EDL, JSSC, JEDS, …).
- `categories[].features`: the effects and techniques checked, the words that detect them, and the TCAD advice for each (`kind: technique` ones can move between topics).
- `categories[].eda`: compact model, EDA tools and steps for the "put it in a circuit" gap.
- `stage_terms`: words that mark a paper as simulation, fabricated or circuit-level.
- `tree`: how many references and citing papers each tree keeps.

## Running locally

```bash
npm install
node pipeline/run.mjs --only nand      # or no flag for all fields; --no-ai, --refresh, --no-fulltext, --no-trends
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
  lib/fulltext.js                    free full text: arXiv HTML, open PDFs (pdf.js), limitations / future work
  lib/ai.js                          prompt, JSON schema, bring-your-own-key providers
  lib/lock.js                        access code: AES-GCM encryption of the data files
  lib/trends.js                      topic briefing: papers per year, rising terms, news, briefing prompt
  data/                              written by the scheduled build
pipeline/run.mjs                     scheduled build
pipeline/claude.mjs                  Claude refinement (Anthropic SDK)
tests/                               offline tests with made-up fixture papers
```

The same tree and gap code runs in the scheduled build and in the browser, so a user's own papers get exactly the same checks as the topic pages.

## Limits

Full text is read only for the seed paper and its base paper of each tree, and only when a free legal copy exists; everything else is judged from titles and abstracts. Treat each gap as a lead and read the linked papers. Paywalled publishers sometimes hide abstracts; Crossref fills some in, the rest are judged by title. Semantic Scholar's public rate limit is shared, so "why cited" sentences can be missing on busy days.
