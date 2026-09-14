/**
 * Two findings from the seam audit, fixed. (v5.34.96)
 *
 * ── 1. The maturity bands lived in four places ──────────────────────────────
 *
 * The five words a client is told, and the thresholds between them, existed in
 * routes/scorecard.ts, interview_agent.html, and TWICE inline in
 * synthesis.html — plus a fifth colour map in scorecard.html keyed by the
 * label strings. Nothing compared any of them. scorecard.test.ts hardcodes the
 * five labels and never reads the frontend; scoreMeaningAndWeight.test.ts
 * stubs its own bands entirely. Renaming "AI Capable" in one file would have
 * shipped a deck and a dashboard disagreeing about the client's maturity, and
 * the suite would have stayed green.
 *
 * They all agreed when this was written, which is exactly when to fix it: the
 * cheap moment is before the divergence, and the expensive moment is when a
 * client asks why two documents say different things.
 *
 * ── 2. The ⚡ marker was written at the wrong LEVEL ──────────────────────────
 *
 * synthesis.html reads `round.eventDriven` and `round.eventCoveredDims` to mark
 * a dimension whose score moved because of an external event — "re-scored due
 * to: new CTO" — so a jump is explainable rather than mysterious.
 *
 * Nothing had ever written those. Both builders set eventDriven /
 * eventCoveredDims / eventContext on the INTERVIEW record, and no code anywhere
 * assigned them to a round, so the `&&` guard at synthesis.html:1043 could never
 * be true. The whole feature was written on both sides of the boundary and
 * consumed by nobody — the isRefresh/isRefreshMode defect with a level
 * substituted for a spelling.
 *
 * Fixed by DERIVING the round's flags from its interviews rather than adding a
 * fourth writer. A derivation cannot drift from the data it describes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import {
  MATURITY_BANDS, maturityBand, maturityLabel, roundEventRollup,
} from "../src/tenant/scoring.js";
import { maturityLabel as routeMaturityLabel } from "../src/routes/scorecard.js";
import { mergeSessionIntoEngagement, type SessionRecord } from "../src/tenant/engagementMerge.js";
import { loadInterviewAgent } from "./support/pageContext.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");

/** The browser module, executed. */
const VS: any = (() => {
  const p = join(root, "frontend", "vyne-scoring.js");
  const sandbox: any = { module: { exports: {} }, console };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(p, "utf8"), sandbox, { filename: p });
  return sandbox.module.exports;
})();

describe("v5.34.96 — one set of maturity bands", () => {
  it("the browser and the server hold the identical table", () => {
    expect(VS.MATURITY_BANDS).toEqual(MATURITY_BANDS.map((b) => ({ ...b })));
  });

  it("they band every score the same way, across the whole scale", () => {
    /*
     * Every tenth from 0.0 to 5.0, plus the boundaries themselves. A threshold
     * off by 0.1 in one runtime shows up as one client sitting a band apart on
     * two screens, which is not something a spot-check of five values finds.
     */
    for (let i = 0; i <= 50; i++) {
      const v = Math.round(i) / 10;
      expect(VS.maturityLabel(v), `score ${v}`).toBe(maturityLabel(v));
      expect(VS.maturityBand(v).label, `band ${v}`).toBe(maturityBand(v).label);
    }
    for (const edge of [1.5, 2.5, 3.5, 4.5, 4.4999, 2.4999]) {
      expect(VS.maturityLabel(edge), `edge ${edge}`).toBe(maturityLabel(edge));
    }
  });

  it("null and 0 stay different answers on both sides", () => {
    /*
     * A round with no scores has no maturity — the caller renders "Pending" or
     * "Not assessed". A round measured at 0 genuinely is AI Unaware. Collapsing
     * the two would report an unstarted engagement as the worst possible one.
     */
    expect(maturityLabel(null)).toBeNull();
    expect(VS.maturityLabel(null)).toBeNull();
    expect(maturityLabel(undefined)).toBeNull();
    expect(maturityLabel(0)).toBe("AI Unaware");
    expect(VS.maturityLabel(0)).toBe("AI Unaware");
  });

  it("/api/scorecard delegates rather than keeping its own copy", () => {
    for (const v of [null, 0, 1.4, 1.5, 2.7, 4.5]) {
      expect(routeMaturityLabel(v as never)).toBe(maturityLabel(v as never));
    }
    const src = readFileSync(join(root, "backend", "src", "routes", "scorecard.ts"), "utf8");
    expect(src.replace(/\/\*[\s\S]*?\*\//g, ""), "scorecard.ts still declares its own band table")
      .not.toMatch(/const MATURITY\s*=/);
  });

  it("the interview page bands identically — executed, not grepped", () => {
    const page = loadInterviewAgent();
    for (let i = 0; i <= 50; i++) {
      const v = Math.round(i) / 10;
      const got = page.call<{ label: string }>("getMaturity", v);
      expect(got.label, `page band at ${v}`).toBe(maturityLabel(v));
    }
  });

  it("the page still supplies a colour for every band", () => {
    /*
     * The bands moved out; the colours stayed, keyed by label. A renamed band
     * would silently fall through to the neutral default and the badge would
     * go grey — visible, but only to whoever happens to look.
     */
    const page = loadInterviewAgent();
    for (const b of MATURITY_BANDS) {
      const got = page.call<{ label: string; color: string; bg: string }>("getMaturity", b.min);
      expect(got.label).toBe(b.label);
      expect(got.color, `no colour for ${b.label}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(got.bg, `no background for ${b.label}`).toMatch(/^rgba\(/);
    }
  });

  it("no page keeps an inline band ladder any more", () => {
    /*
     * The two in synthesis.html were ternary chains, which is how they escaped
     * every search for "MATURITY". Matched on the thresholds instead, which is
     * what any re-introduction would have to contain.
     */
    for (const f of ["synthesis.html", "interview_agent.html", "roadmap.html"]) {
      const src = readFileSync(join(root, "frontend", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src, `${f} still bands scores inline instead of calling VyneScoring`)
        .not.toMatch(/>=\s*4\.5\s*\?\s*['"]AI-Native['"]/);
    }
  });

  it("scorecard.html's colour map is keyed by the real labels", () => {
    // A fifth copy of the LABELS, as map keys. It loses its colours silently if
    // a band is reworded, so the key set is pinned to the band set.
    const src = readFileSync(join(root, "frontend", "scorecard.html"), "utf8");
    for (const b of MATURITY_BANDS) {
      expect(src, `scorecard.html has no colour for "${b.label}"`).toContain(`"${b.label}"`);
    }
  });
});

describe("v5.34.96 — the event marker reaches the round", () => {
  const evtSession = (role: string, dims: string[]): SessionRecord => ({
    sessionId: `s-${role}`, sessionCode: `VYNE-${role}`,
    client: "Meridian", stakeholderRole: role, stakeholderName: role,
    scores: Object.fromEntries(dims.map((d) => [d, 3.0])),
    findings: [],
    eventDriven: true,
    eventContext: "new CTO hired in March",
    eventCoveredDims: dims,
  } as unknown as SessionRecord);

  it("rolls interview-level tags up to the round, on the server path", () => {
    const eng = mergeSessionIntoEngagement(
      null, "ENG-EVT", evtSession("CTO", ["D2", "D6"]),
      { sourceInterviewId: "iv-1", kind: "initial" },
    );
    const round = eng.rounds![0];
    expect(round.eventDriven, "the round is not marked, so Synthesis draws no ⚡").toBe(true);
    expect(round.eventCoveredDims).toEqual(["D2", "D6"]);
    expect(round.eventContext).toBe("new CTO hired in March");
  });

  it("unions the covered dimensions across several interviews", () => {
    let eng: any = null;
    eng = mergeSessionIntoEngagement(eng, "ENG-U", evtSession("CTO", ["D2", "D6"]),
      { sourceInterviewId: "iv-1", kind: "initial" });
    eng = mergeSessionIntoEngagement(eng, "ENG-U", evtSession("CFO", ["D3", "D6"]),
      { sourceInterviewId: "iv-2", kind: "initial" });
    // Union, de-duplicated, and in a stable order so the record does not churn.
    expect(eng.rounds[0].eventCoveredDims).toEqual(["D2", "D3", "D6"]);
  });

  it("a round with no event-driven interview is not marked", () => {
    /* `undefined`, not `null`: SessionRecord types eventCoveredDims as
     * `string[] | undefined`, and an interview with no event simply omits it.
     * Asserting with a null here typechecked only because the cast hid it —
     * caught by tsconfig.test.json, which typechecks test/ (tsconfig.json
     * excludes it, so plain `tsc --noEmit` never sees these files). */
    const plain = { ...evtSession("CTO", ["D2"]), eventDriven: false, eventContext: null, eventCoveredDims: undefined };
    const eng = mergeSessionIntoEngagement(null, "ENG-P", plain as SessionRecord,
      { sourceInterviewId: "iv-1", kind: "initial" });
    expect(eng.rounds![0].eventDriven).toBe(false);
    expect(eng.rounds![0].eventCoveredDims).toEqual([]);
  });

  it("does NOT overwrite an eventContext the consultant authored", () => {
    /*
     * Pre-Engagement writes round.eventContext, and that wording is the
     * consultant's — it appears in the client-facing tooltip. An interview's
     * own tag must fill the gap, never replace the sentence.
     */
    const eng = mergeSessionIntoEngagement(null, "ENG-C", evtSession("CTO", ["D2"]),
      { sourceInterviewId: "iv-1", kind: "initial" });
    eng.rounds![0].eventContext = "Consultant's own wording";
    const eng2 = mergeSessionIntoEngagement(eng, "ENG-C", evtSession("CFO", ["D3"]),
      { sourceInterviewId: "iv-2", kind: "initial" });
    expect(eng2.rounds![0].eventContext).toBe("Consultant's own wording");
  });

  it("the browser path rolls up identically — executed", () => {
    const page = loadInterviewAgent();
    const S = page.S;
    S.client = "Meridian";
    S.stakeholderRole = "CTO";
    S.stakeholderName = "Priya";
    S.sessionId = "s1"; S.sessionCode = "VYNE-A-B";
    S.scores = { D2: 3.0, D6: 3.0 };
    S.findings = [];
    S.isRefreshMode = false;
    S.eventContext = "new CTO hired in March";   // what tags an interview
    page.call("writeInterviewToEngagement");

    const idx = JSON.parse(page.win.vyneStore.getItem("vynora_engagement_index")!);
    const code = idx["meridian"];
    const eng = JSON.parse(page.win.vyneStore.getItem("vynora_engagement_" + code)!);
    const round = eng.rounds[0];
    expect(round.eventDriven, "the browser path does not roll the tag up to the round").toBe(true);
    expect(round.eventCoveredDims).toEqual(["D2", "D6"]);
    expect(round.eventContext).toBe("new CTO hired in March");
  });

  it("both runtimes' rollups agree", () => {
    const cases = [
      [],
      [{ eventDriven: false }],
      [{ eventDriven: true, eventContext: "a", eventCoveredDims: ["D3", "D1"] }],
      [{ eventDriven: true, eventContext: "a", eventCoveredDims: ["D3"] },
       { eventDriven: true, eventContext: "b", eventCoveredDims: ["D1", "D3"] }],
      // Junk in the covered list must be dropped by both, not carried.
      [{ eventDriven: true, eventContext: "a", eventCoveredDims: ["D9", "", "D2", "__proto__"] }],
      [{ eventDriven: true, eventContext: null, eventCoveredDims: null }],
    ];
    for (const c of cases) {
      expect(VS.roundEventRollup(c)).toEqual(roundEventRollup(c as never));
    }
  });

  it("Synthesis's guard can now actually be true", () => {
    /*
     * The end of the chain, stated as the condition the page evaluates:
     *   r.eventDriven && r.eventCoveredDims && r.eventCoveredDims.indexOf(d)>=0
     * Reproduced here against a real round, because "the field is set" is not
     * the same claim as "the marker renders".
     */
    let eng: any = null;
    eng = mergeSessionIntoEngagement(eng, "ENG-S", evtSession("CTO", ["D6"]),
      { sourceInterviewId: "iv-1", kind: "initial" });
    const r = eng.rounds[0];
    const marks = (d: string) => !!(r.eventDriven && r.eventCoveredDims && r.eventCoveredDims.indexOf(d) >= 0);
    expect(marks("D6")).toBe(true);
    expect(marks("D1")).toBe(false);
  });
});
