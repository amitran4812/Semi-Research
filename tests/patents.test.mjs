import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Ops, parseOps, applicantName, linkPatents, topFilers, ipMap, ipNote, mergeFamilies } from "../site/lib/patents.js";

const cfg = JSON.parse(fs.readFileSync(new URL("../site/config.json", import.meta.url)));
const nand = cfg.categories.find((c) => c.id === "nand");

const doc = (cc, num, kind, fam, date, title, abs, apps, npl = []) => ({
  "@country": cc, "@doc-number": num, "@kind": kind, "@family-id": fam,
  "bibliographic-data": {
    "publication-reference": { "document-id": [{ "@document-id-type": "docdb", country: { $: cc }, "doc-number": { $: num }, kind: { $: kind }, date: { $: date } }] },
    "invention-title": [{ "@lang": "en", $: title }],
    parties: { applicants: { applicant: apps.flatMap((a) => [{ "@data-format": "epodoc", "applicant-name": { name: { $: a } } }, { "@data-format": "original", "applicant-name": { name: { $: a.toLowerCase() } } }]) } },
    "references-cited": { citation: npl.map((t) => ({ nplcit: { text: { $: t } } })) },
  },
  abstract: { "@lang": "en", p: { $: abs } },
});
const OPS_JSON = { "ops:world-patent-data": { "ops:biblio-search": { "@total-result-count": "3", "ops:search-result": { "exchange-documents": [
  { "exchange-document": doc("US", "2026012345", "A1", "111", "20260901", "Three-dimensional NAND memory with graded tunnel oxide for data retention", "A vertical NAND string with a graded tunnel oxide improves retention and endurance.", ["SAMSUNG ELECTRONICS CO LTD [KR]"], ["Author A, Graded tunnel oxide for 3D NAND, IEEE TED, doi:10.1109/TED.2026.0001"]) },
  { "exchange-document": doc("KR", "20260099", "A", "111", "20260801", "Three-dimensional NAND memory with graded tunnel oxide", "", ["SAMSUNG ELECTRONICS CO LTD [KR]"]) },
  { "exchange-document": doc("CN", "123456789", "A", "222", "20260701", "Charge trap memory read disturb suppression", "Reducing read disturb in a charge trap flash string by word line biasing.", ["SK HYNIX INC [KR]"]) },
] } } } };

test("OPS search results: parsed, families merged, applicants cleaned", () => {
  const { total, patents } = parseOps(OPS_JSON);
  assert.equal(total, 3);
  assert.equal(patents.length, 3);
  assert.deepEqual(patents[0].applicants, ["Samsung Electronics"]);
  assert.equal(patents[0].date, "2026-09-01");
  assert.match(patents[0].url, /espacenet.*US2026012345A1/);
  const m = mergeFamilies(patents);
  assert.equal(m.length, 2, "same family filed in US and KR is one entry");
  assert.deepEqual(m[0].also, ["KR"]);
  assert.equal(applicantName("SK HYNIX INC [KR]"), "SK Hynix");
  assert.equal(applicantName("KIOXIA CORP [JP]"), "KIOXIA");
  assert.equal(applicantName("UNIV SEOUL NAT R & DB FOUND [KR]"), "University Seoul Nat R & DB Found");
});

test("patents link to the papers they cite, then to papers with the same terms; filers and IP map", () => {
  const pats = mergeFamilies(parseOps(OPS_JSON).patents);
  const papers = [
    { id: "W1", doi: "10.1109/TED.2026.0001", title: "Graded tunnel oxide for 3D NAND", abstract: "We simulate a graded tunnel oxide to improve retention of vertical NAND." },
    { id: "W2", title: "Read disturb in charge trap flash strings under word line bias", abstract: "Read disturb of charge trap flash is studied with word line biasing schemes." },
    { id: "W3", title: "Retention of charge trap NAND", abstract: "Retention and charge loss in 3D NAND cells." },
    { id: "W4", title: "Retention study", abstract: "Retention and data loss of charge trap cells after bake." },
    { id: "W5", title: "Cell retention", abstract: "Retention behaviour and charge loss." },
  ];
  linkPatents(pats, papers);
  assert.deepEqual(pats[0].links[0], { id: "W1", why: "Cited by the patent", kind: "cites" });
  assert.ok(pats[1].links.some((l) => l.id === "W2" && l.kind === "terms"));
  assert.deepEqual(topFilers(pats).map((f) => f.name), ["Samsung Electronics", "SK Hynix"]);
  const ip = ipMap(pats, papers, nand, cfg);
  const ret = ip.find((r) => r.id === "retention");
  assert.ok(ret.papers >= 3 && ret.patents === 1);
  assert.equal(ret.signal, "open");
  assert.match(ipNote({ feature: "retention" }, ip, 2), /^Open for IP/);
});

test("OPS client: signs in, sends one CQL query with a date, stops without keys", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    if (url.endsWith("/auth/accesstoken")) return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: "1199" }) };
    return { ok: true, status: 200, json: async () => OPS_JSON };
  };
  const ops = new Ops({ key: "k", secret: "s", fetch, pause: 0 });
  const res = await ops.search(["3D NAND", "charge trap flash"], { since: "2025-11-16" });
  assert.equal(res.length, 2);
  assert.match(seen[0].init.headers.authorization, /^Basic /);
  const q = new URL(seen[1].url).searchParams.get("q");
  assert.equal(q, '(ta="3D NAND" or ta="charge trap flash") and pd>=20251116');
  assert.equal(seen[1].init.headers.authorization, "Bearer tok");
  assert.deepEqual(await new Ops({}).search(["x"]), []);
});
