/**
 * findingsParity.test.ts — v5.32.59 (F13).
 *
 * Two halves of the corroboration rule (frontend/vyne-findings.js and
 * backend/src/tenant/findings.ts) executed against the same inputs, plus the
 * behaviour the old dimension-grouping rule got wrong.
 *
 * The behavioural cases matter as much as the parity ones: the point of this
 * change is that the product stops telling a client two people agreed when
 * they did not, and that claim is only worth anything if a test states the
 * specific pair of sentences that must NOT merge.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import * as srv from "../src/tenant/findings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webPath = path.resolve(here, "../../frontend/vyne-findings.js");

function loadBrowser(): any {
  const sandbox: any = { module: { exports: {} }, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(webPath, "utf8"), sandbox, { filename: webPath });
  const api = sandbox.module.exports;
  if (!api || typeof api.corroborateFindings !== "function") {
    throw new Error("vyne-findings.js did not export corroborateFindings");
  }
  if (sandbox.VyneFindings !== api) throw new Error("vyne-findings.js did not publish window.VyneFindings");
  return api;
}
const web = loadBrowser();

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const WORDS = [
  "data", "governance", "lineage", "quality", "pipeline", "warehouse", "reporting",
  "trust", "skills", "training", "hiring", "budget", "roadmap", "strategy",
  "vendor", "legacy", "integration", "manual", "process", "handoff", "risk",
  "policy", "approval", "shadow", "spreadsheet", "duplication", "ownership",
];
const ROLES = ["CEO", "CTO", "CFO", "COO", "CHRO", "CDO", "IT_Director", ""];
/** Small on purpose — see the fuzz case below. "" is an unnamed interview. */
const PEOPLE = ["Marcus Webb", "Dana Fox", "Priya Sharma", ""];
const DIMS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", ""];

describe("findings parity — frontend/vyne-findings.js vs backend/src/tenant/findings.ts", () => {
  it("exposes the same constants", () => {
    expect(web.SIMILARITY_THRESHOLD).toBe(srv.SIMILARITY_THRESHOLD);
    expect(web.MIN_SHARED_TOKENS).toBe(srv.MIN_SHARED_TOKENS);
  });

  it("tokenises identically across 500 randomised strings", () => {
    const rnd = lcg(4242);
    for (let t = 0; t < 500; t++) {
      const n = 1 + Math.floor(rnd() * 14);
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        const w = WORDS[Math.floor(rnd() * WORDS.length)];
        parts.push(rnd() < 0.3 ? w + "s" : w);
        if (rnd() < 0.2) parts.push("the");
        if (rnd() < 0.1) parts.push("—");
        if (rnd() < 0.1) parts.push("is");
      }
      const s = parts.join(" ");
      expect(web.contentTokens(s), s).toEqual(srv.contentTokens(s));
    }
  });

  it("clusters identically across 300 randomised finding sets", () => {
    const rnd = lcg(777001);
    for (let t = 0; t < 300; t++) {
      const findings: any[] = [];
      const n = Math.floor(rnd() * 12);
      for (let i = 0; i < n; i++) {
        const len = 2 + Math.floor(rnd() * 6);
        const parts: string[] = [];
        for (let k = 0; k < len; k++) parts.push(WORDS[Math.floor(rnd() * WORDS.length)]);
        findings.push({
          dimension: DIMS[Math.floor(rnd() * DIMS.length)],
          text: rnd() < 0.05 ? "" : parts.join(" "),
          role: ROLES[Math.floor(rnd() * ROLES.length)],
          // v5.32.86: names drawn from a SMALL pool against a small role pool,
          // so collisions — one role held by several people, and the same
          // person in two roles — occur often rather than by luck. Parity on
          // the attribution rule is worth nothing if the fuzz never hits it.
          interviewee: PEOPLE[Math.floor(rnd() * PEOPLE.length)],
        });
      }
      expect(web.corroborateFindings(findings), `case ${t}`).toEqual(srv.corroborateFindings(findings));
    }
  });

  it("flattens interviews identically", () => {
    const ivs = [
      { role: "CEO", findings: [{ dimension: "D1", text: "data quality is poor" }] },
      { role: "", findings: [{ dimension: "D1", text: "x", role: "CFO" }] },
      { role: "CTO", findings: null },
      // v5.32.86: `interviewee` and its `name` alias, and two holders of one
      // role — the shape an engagement with divisional COOs actually has.
      { role: "COO", interviewee: "Marcus Webb", findings: [{ dimension: "D5", text: "handoffs are manual" }] },
      { role: "COO", name: "Dana Fox", findings: [{ dimension: "D5", text: "manual handoffs everywhere" }] },
      null,
    ];
    expect(web.findingsOf(ivs)).toEqual(srv.findingsOf(ivs as any));
  });

  it("labels attribution identically", () => {
    const fs = [
      { dimension: "D5", role: "COO", interviewee: "Marcus Webb", text: "a" },
      { dimension: "D5", role: "COO", interviewee: "Dana Fox", text: "b" },
      { dimension: "D1", role: "CFO", interviewee: "Priya Sharma", text: "c" },
      { dimension: "D1", role: "CTO", text: "d" },
    ];
    const w = web.attributionLabels(fs);
    const b = srv.attributionLabels(fs);
    for (const f of fs) expect(w(f), JSON.stringify(f)).toBe(b(f));
  });
});

describe("corroboration — what the dimension-grouping rule got wrong", () => {
  it("does NOT corroborate two different claims that share only a dimension", () => {
    // The motivating case. Both are D1 findings; they are not the same point.
    const r = srv.corroborateFindings([
      { dimension: "D1", role: "CFO", text: "We cannot get a straight answer on data lineage" },
      { dimension: "D1", role: "CHRO", text: "Nobody in the business trusts the reporting team" },
    ]);
    expect(r.corroborated).toEqual([]);
    expect(r.thematic).toHaveLength(1);
    expect(r.thematic[0].dimension).toBe("D1");
    expect(r.thematic[0].roles.sort()).toEqual(["CFO", "CHRO"]);
  });

  it("DOES corroborate the same claim stated differently by two roles", () => {
    const r = srv.corroborateFindings([
      { dimension: "D1", role: "CFO", text: "Data lineage is undocumented across finance systems" },
      { dimension: "D1", role: "CDO", text: "Lineage for our data is undocumented" },
    ]);
    expect(r.corroborated).toHaveLength(1);
    expect(r.corroborated[0].roles.sort()).toEqual(["CDO", "CFO"]);
    // The fullest statement leads.
    expect(r.corroborated[0].text).toBe("Data lineage is undocumented across finance systems");
    expect(r.thematic).toEqual([]);
  });

  /**
   * One role, several people — the case this rule was blind to (v5.32.86).
   *
   * A client with divisional COOs has three of them. Attribution deduped on
   * the ROLE STRING, so two of them independently making the same point
   * produced roles ["COO"], length 1, corroborated FALSE. Two separate
   * executives agreeing is the strongest evidence an engagement can produce,
   * and it was being filed as a single unsupported observation.
   */
  it("DOES corroborate two people who hold the same role", () => {
    const r = srv.corroborateFindings([
      { dimension: "D5", role: "COO", interviewee: "Marcus Webb",
        text: "Most automation is spreadsheets and manual handoffs" },
      { dimension: "D5", role: "COO", interviewee: "Dana Fox",
        text: "Our automation is really manual handoffs and spreadsheets" },
    ]);
    expect(r.corroborated).toHaveLength(1);
    // Named, because "COO and COO agree" is not a sentence a consultant can use.
    expect(r.corroborated[0].roles.sort())
      .toEqual(["COO (Dana Fox)", "COO (Marcus Webb)"]);
  });

  it("does NOT add the person's name when the role identifies them already", () => {
    // The label only widens where it must: naming everyone would churn every
    // existing string in the product for no gain.
    const r = srv.corroborateFindings([
      { dimension: "D1", role: "CFO", interviewee: "Priya Sharma",
        text: "Data lineage is undocumented across finance systems" },
      { dimension: "D1", role: "CDO", interviewee: "Sam Vale",
        text: "Lineage for our data is undocumented" },
    ]);
    expect(r.corroborated).toHaveLength(1);
    expect(r.corroborated[0].roles.sort()).toEqual(["CDO", "CFO"]);
  });

  it("does NOT corroborate two UNNAMED holders of one role", () => {
    /* Conservative on purpose. With no name there is nothing to tell two
     * holders of a role apart, and minting an identity per interview row would
     * manufacture agreement — the exact failure this module exists to stop. So
     * this stays at the pre-v5.32.86 answer rather than guessing. */
    const r = srv.corroborateFindings([
      { dimension: "D5", role: "COO", text: "Most automation is spreadsheets and manual handoffs" },
      { dimension: "D5", role: "COO", text: "Our automation is really manual handoffs and spreadsheets" },
    ]);
    expect(r.corroborated).toEqual([]);
    expect(r.single).toHaveLength(1);
    expect(r.single[0].roles).toEqual(["COO"]);
  });

  it("still does not let ONE person corroborate themselves once named", () => {
    const r = srv.corroborateFindings([
      { dimension: "D5", role: "COO", interviewee: "Marcus Webb",
        text: "Most automation is spreadsheets and manual handoffs" },
      { dimension: "D5", role: "COO", interviewee: "Marcus Webb",
        text: "Our automation is really manual handoffs and spreadsheets" },
      { dimension: "D5", role: "COO", interviewee: "Dana Fox", text: "different point entirely about vendor risk" },
    ]);
    const same = r.corroborated.concat(r.single, r.thematic.flatMap((t) => t.clusters))
      .find((c) => /spreadsheet/.test(c.text));
    expect(same!.roles).toEqual(["COO (Marcus Webb)"]);
    expect(same!.corroborated).toBe(false);
  });

  it("two people in one role raising DIFFERENT points is thematic, not agreement", () => {
    const r = srv.corroborateFindings([
      { dimension: "D5", role: "COO", interviewee: "Marcus Webb", text: "Handoffs between plants are manual" },
      { dimension: "D5", role: "COO", interviewee: "Dana Fox", text: "Vendor approval takes six weeks" },
    ]);
    expect(r.corroborated).toEqual([]);
    expect(r.thematic).toHaveLength(1);
    expect(r.thematic[0].roles.sort()).toEqual(["COO (Dana Fox)", "COO (Marcus Webb)"]);
  });

  it("does not corroborate one person repeating themselves", () => {
    const r = srv.corroborateFindings([
      { dimension: "D2", role: "CTO", text: "legacy integration is manual and slow" },
      { dimension: "D2", role: "CTO", text: "integration work is manual, legacy and slow" },
    ]);
    expect(r.corroborated).toEqual([]);
    expect(r.single).toHaveLength(1);
    expect(r.single[0].roles).toEqual(["CTO"]);
  });

  it("does not let the category noun alone merge two findings", () => {
    // Only "data" in common — one shared token, below MIN_SHARED_TOKENS.
    const r = srv.corroborateFindings([
      { dimension: "D1", role: "CEO", text: "data budget was cut" },
      { dimension: "D1", role: "CTO", text: "data hiring stalled" },
    ]);
    expect(r.corroborated).toEqual([]);
  });

  it("treats a finding with no attributable role as unusable rather than as a second source", () => {
    const r = srv.corroborateFindings([
      { dimension: "D1", role: "CFO", text: "data lineage is undocumented everywhere" },
      { dimension: "D1", role: "", text: "data lineage is undocumented everywhere" },
    ]);
    expect(r.corroborated).toEqual([]);
    expect(r.single).toHaveLength(1);
  });

  it("is independent of the order interviews completed in", () => {
    const fs = [
      { dimension: "D5", role: "COO", text: "handoff between process steps is manual" },
      { dimension: "D5", role: "CEO", text: "manual handoff between our process steps" },
      { dimension: "D5", role: "CFO", text: "approval policy requires three signatures" },
    ];
    const a = srv.corroborateFindings(fs);
    const b = srv.corroborateFindings([fs[2], fs[1], fs[0]]);
    expect(b.corroborated.map((c) => c.roles.slice().sort()))
      .toEqual(a.corroborated.map((c) => c.roles.slice().sort()));
    expect(b.corroborated).toHaveLength(1);
  });

  it("ranks the most-corroborated claim first", () => {
    const r = srv.corroborateFindings([
      { dimension: "D3", role: "CEO", text: "strategy roadmap has no budget attached" },
      { dimension: "D3", role: "CFO", text: "roadmap strategy carries no budget" },
      { dimension: "D3", role: "CTO", text: "no budget attached to the strategy roadmap" },
      { dimension: "D6", role: "CEO", text: "policy approval sits with legal only" },
      { dimension: "D6", role: "CFO", text: "approval policy sits with legal" },
    ]);
    expect(r.corroborated[0].roles).toHaveLength(3);
    expect(r.corroborated[0].dimension).toBe("D3");
  });

  it("returns empty structures rather than throwing on junk input", () => {
    for (const junk of [null, undefined, [], [null], [{}], [{ dimension: "D1" }]] as any[]) {
      const r = srv.corroborateFindings(junk);
      expect(r.corroborated).toEqual([]);
      expect(r.thematic).toEqual([]);
      expect(r.single).toEqual([]);
    }
  });
});
