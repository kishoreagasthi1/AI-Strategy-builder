/**
 * A score is an observation. A maturity level is a claim. (v5.34.91)
 *
 * ── What happened ───────────────────────────────────────────────────────────
 *
 * v5.34.90 stopped the interviewer TELLING the client its assessment, and hid
 * the panel from the interviewee. Both correct, and both about who sees it.
 * This is the other half, and it is about what the number MEANS — which is the
 * consultant's problem too, not only the client's:
 *
 *   "Seeing the score is different than giving it a meaning without full
 *    assessments complete. Again the weights of a dimension matter. low score
 *    on a dimension that has no weight because we turned it off in the
 *    pre-engagement or gave it 'light' coverage may mean something in the end."
 *
 * Two separate defects, and they must not be conflated:
 *
 *  1. TIME. renderScorecard() printed `getMaturity(sc).label` from the first
 *     scoring pass onward. One answer in, a dimension read "1.0 / 5 · AI
 *     Unaware". The NUMBER on partial evidence is honest and is the whole point
 *     of the live meter. The LABEL on partial evidence is a verdict, and a
 *     verdict on a conversation that has not finished is not provisional, it is
 *     wrong.
 *
 *  2. WEIGHT. Every dimension rendered identically, whatever depth it was being
 *     interviewed at. getRolePriorityData() tiers them per role; a
 *     Pre-Engagement roleCatalog.dimTiers overrides that outright; a round's
 *     scopeDimensions narrows it further — and a dimension absent from all
 *     three is EXCLUDED, not "scored low". A 1.4 on a LIGHT dimension means two
 *     questions were asked in passing. The same 1.4 on a LEAD dimension is a
 *     finding. Same pixels for both.
 *
 *     Worse arithmetically: the overall averaged `Object.values(S.scores)`, so
 *     a dimension the consultant had switched OFF for this role still dragged
 *     the client's headline number down if any pass put a number on it.
 *
 * ── What is NOT done here, deliberately ─────────────────────────────────────
 *
 * No lead/cover/light weighting arithmetic. The product has never defined one,
 * synthesis.html averages the per-stakeholder overalls it is handed, and a
 * second formula in the browser would put two different "overall scores" in
 * front of the same client. Excluded dimensions leave the mean; tier is
 * surfaced as context. That is the whole change to the number.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const page = readFileSync(join(root, "frontend", "interview_agent.html"), "utf8");

/** The real vyne-scoring.js, loaded the way a browser would load it. */
const VyneScoring: any = (() => {
  const p = join(root, "frontend", "vyne-scoring.js");
  const sandbox: any = { module: { exports: {} }, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(p, "utf8"), sandbox, { filename: p });
  return sandbox.module.exports;
})();

/** The page with comments stripped — every assertion below is about CODE. */
const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Body of a top-level `function NAME(` … up to the next top-level `function`. */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  expect(at, `${name}() is gone — update this test`).toBeGreaterThan(-1);
  const next = src.indexOf("\nfunction ", at + 1);
  return src.slice(at, next === -1 ? src.length : next);
}

describe("v5.34.91 — a live number never carries a maturity label", () => {
  it("the scorecard knows whether the interview is closed", () => {
    expect(code).toMatch(/function scoringIsFinal\(\)\s*\{\s*return !!S\.interviewComplete;?\s*\}/);
  });

  it("renderScorecard asks that question before it renders anything", () => {
    const body = fnBody(code, "renderScorecard");
    expect(body, "renderScorecard does not consult scoringIsFinal()").toMatch(/isFinal\s*=\s*scoringIsFinal\(\)/);
  });

  it("the per-dimension maturity label is gated on it", () => {
    /*
     * The regression this pins is a one-character one: `m.label` re-appearing
     * unconditionally. Assert on the caption expression, which must reach
     * m.label only through isFinal.
     */
    const body = fnBody(code, "renderScorecard");
    const caption = /const caption =([\s\S]*?);\n/.exec(body);
    expect(caption, "the caption expression moved — update this test").toBeTruthy();
    expect(caption![1], "a dimension can still print its maturity label mid-interview")
      .toMatch(/isFinal \? m\.label/);
    expect(caption![1], "it must say what the number is instead while the interview runs")
      .toMatch(/Interim reading/);
    // And nothing else in the card template may print it behind isFinal's back.
    const card = /return `<div class="dim-card([\s\S]*?)`;\n/.exec(body);
    expect(card, "the dimension card template moved — update this test").toBeTruthy();
    expect(card![1], "the card prints m.label directly, bypassing the isFinal gate")
      .not.toMatch(/\$\{m\.label\}/);
  });

  it("the OVERALL badge is withheld until the interview closes", () => {
    const body = fnBody(code, "renderScorecard");
    expect(body, "the overall badge no longer distinguishes interim from final")
      .toMatch(/if\(isFinal\)\{[\s\S]*?badge\.textContent\s*=\s*m\.label/);
    expect(body, "there is no interim state for the overall badge")
      .toMatch(/badge\.textContent\s*=\s*'INTERIM'/);
  });

  it("but the NUMBER keeps updating live — the meter is the point", () => {
    /*
     * The failure mode in the other direction: someone reads "withhold the
     * assessment" as "hide the score" and the live meter goes dark, which is
     * the signal that scoring is alive (v5.34.85). The number is set OUTSIDE
     * the isFinal branch.
     */
    const body = fnBody(code, "renderScorecard");
    const setNum = /getElementById\('overall-score-num'\)\.textContent=([\s\S]*?);\n/.exec(body);
    expect(setNum, "the overall number is no longer written").toBeTruthy();
    const beforeBranch = body.slice(0, body.indexOf("if(isFinal)"));
    expect(beforeBranch, "the live number is now gated behind isFinal — the meter would go dark")
      .toContain("overall-score-num");
    // Per-dimension numbers, likewise, are unconditional.
    expect(body).toMatch(/\$\{sc>0\?sc\.toFixed\(1\):'--'\}/);
  });

  it("finishInterview closes it, and resuming re-opens it", () => {
    const fin = fnBody(code, "finishInterview");
    expect(fin, "finishInterview never marks the interview closed")
      .toMatch(/S\.interviewComplete\s*=\s*true/);
    /*
     * Order matters: the flag has to be set BEFORE the sheet reads a maturity
     * level, or the export screen names a level the panel beside it refuses to.
     */
    expect(fin.indexOf("S.interviewComplete = true"))
      .toBeLessThan(fin.indexOf("getMaturity("));
    const res = fnBody(code, "resumeFromCode");
    expect(res, "resuming a closed interview leaves it marked final — the panel would keep asserting a verdict while new evidence arrives")
      .toMatch(/interviewComplete:\s*false/);
  });

  it("the flag survives a reload", () => {
    const save = fnBody(code, "saveSession");
    expect(save, "interviewComplete is not persisted, so a reload re-opens a closed interview")
      .toMatch(/data\.interviewComplete\s*=\s*!!S\.interviewComplete/);
  });
});

describe("v5.34.91 — tier travels with the number", () => {
  it("the tier map is derived from the interviewer's own agenda, not recomputed", () => {
    /*
     * THE point of this test. Two independent computations of "which dimensions
     * are in scope" is the exact seam that produced every defect in this
     * session: the panel would tell the consultant a dimension is in scope
     * while the interviewer had been told to leave it alone. buildLiveAgenda()
     * is what the interviewer is given; the scorecard reads the same object.
     */
    const body = fnBody(code, "dimensionTierMap");
    expect(body, "dimensionTierMap computes scope independently of the interviewer's agenda")
      .toMatch(/buildLiveAgenda\(\)/);
    expect(body, "it must not re-derive tiers from the role table behind the agenda's back")
      .not.toMatch(/getRolePriorityData/);
    expect(body, "it must not re-read the round scope itself")
      .not.toMatch(/scopeDimensions/);
  });

  it("a dimension in none of the three tiers is EXCLUDED, not zero", () => {
    const body = fnBody(code, "dimensionTierMap");
    expect(body, "the default must be 'out' — absence from dimTiers means excluded")
      .toMatch(/map\[d\]\s*=\s*'out'/);
  });

  it("resolves a doubly-listed dimension to its strongest tier", () => {
    /*
     * Assignment order is load-bearing and invisible: light, then cover, then
     * lead. Reverse it and a LEAD dimension that a legacy priorityDims override
     * also left in `light` renders as light — i.e. the most important dimension
     * in the interview shows as the least.
     */
    const body = fnBody(code, "dimensionTierMap");
    const iLight = body.indexOf("'light'");
    const iCover = body.indexOf("'cover'");
    const iLead = body.indexOf("'lead'");
    expect(iLight).toBeGreaterThan(-1);
    expect(iLight, "cover is applied before light — a lead/cover dimension can render as light")
      .toBeLessThan(iCover);
    expect(iCover, "lead is not applied last, so it can be overwritten by a weaker tier")
      .toBeLessThan(iLead);
  });

  it("every tier has a label and a plain-English note", () => {
    for (const t of ["lead", "cover", "light", "out"]) {
      expect(code, `DIM_TIER_LABEL is missing ${t}`).toMatch(new RegExp(`${t}\\s*:\\s*'[^']+'`));
    }
    expect(code, "the note for an excluded dimension must say the number is incidental")
      .toMatch(/Not in scope for this role/);
    expect(code, "the note for a light dimension must say it is not a rating")
      .toMatch(/Light coverage — indicative only, not a rating/);
  });

  it("light and excluded dimensions NEVER get a maturity label — not even at close", () => {
    /*
     * This is the user's point in its strongest form. Closing the interview
     * does not retroactively make two passing questions sufficient to call a
     * dimension "AI Unaware". The tier check therefore sits ABOVE the isFinal
     * check in the caption, not beside it.
     */
    const body = fnBody(code, "renderScorecard");
    const caption = /const caption =([\s\S]*?);\n/.exec(body)![1];
    const iTier = caption.indexOf("tier === 'out' || tier === 'light'");
    const iFinal = caption.indexOf("isFinal ? m.label");
    expect(iTier, "the light/excluded branch is gone").toBeGreaterThan(-1);
    expect(iTier, "isFinal is tested before tier, so a light dimension gets a maturity label at close")
      .toBeLessThan(iFinal);
  });

  it("the card and the export sheet both show the tier", () => {
    const body = fnBody(code, "renderScorecard");
    expect(body, "the live card does not show which tier it is being interviewed at")
      .toMatch(/dim-tier dim-tier-\$\{tier\}/);
    const fin = fnBody(code, "finishInterview");
    expect(fin, "the export sheet drops the tier — a screenshotted row reads as an unqualified verdict")
      .toMatch(/dim-tier dim-tier-\$\{t\}/);
  });

  it("the tier chip has a style for every tier it can render", () => {
    for (const t of ["lead", "cover", "light", "out"]) {
      expect(page, `.dim-tier-${t} has no CSS — the chip renders unstyled`)
        .toMatch(new RegExp(`\\.dim-tier-${t}\\{`));
    }
  });
});

describe("v5.34.91 — an excluded dimension is not part of the mean", () => {
  it("there is ONE overall computation, shared by the panel and the sheet", () => {
    /*
     * There were two, byte-similar, in renderScorecard() and finishInterview().
     * Same shape as the duplicated benchmark legend and the two scoring
     * rubrics: they agree until one is edited.
     */
    expect(code).toMatch(/function computeOverall\(\)/);
    expect(fnBody(code, "renderScorecard"), "the panel computes its own overall again")
      .toMatch(/computeOverall\(\)/);
    expect(fnBody(code, "finishInterview"), "the export sheet computes its own overall again")
      .toMatch(/computeOverall\(\)/);
  });

  it("neither one averages raw S.scores any more", () => {
    for (const name of ["renderScorecard", "finishInterview"]) {
      expect(fnBody(code, name), `${name}() still averages every score including excluded dimensions`)
        .not.toMatch(/reduce\(\(a,b\)=>a\+b,0\)\/vals\.length/);
    }
  });

  it("computeOverall drops out-of-scope dimensions", () => {
    const body = fnBody(code, "computeOverall");
    expect(body).toMatch(/tiers\[d\.code\] !== 'out'/);
    expect(body, "it must also report how much of the scope has evidence")
      .toMatch(/assessed:/);
    expect(body).toMatch(/inScope:/);
  });

  it("gets its lead/cover/light weighting from the SHARED formula, never its own", () => {
    /*
     * v5.34.91 asserted here that computeOverall must NOT weight at all. The
     * reason given was that a weighted mean in this file would disagree with
     * synthesis.html and put two headline numbers in front of one client — and
     * that reason is still right. v5.34.92 answers it by moving the weighting
     * into vyne-scoring.js (mirrored in backend/src/tenant/scoring.ts, pinned
     * by scoringParity.test.ts) and calling it from here.
     *
     * So the assertion inverts but the thing it protects does not: there must
     * be exactly one weighting, and this file must not be where it lives.
     */
    const body = fnBody(code, "computeOverall");
    expect(body, "computeOverall no longer uses the shared weighting")
      .toMatch(/VyneScoring\.dimensionWeights\(/);
    expect(body, "computeOverall no longer uses the shared overall")
      .toMatch(/VyneScoring\.overallOf\(/);
    expect(body, "a private tier-weight table appeared in the page — it belongs in vyne-scoring.js")
      .not.toMatch(/lead\s*:\s*1|cover\s*:\s*0\.|light\s*:\s*0\./);
  });

  it("says out loud what the number is standing on", () => {
    const body = fnBody(code, "renderScorecard");
    expect(body, "the panel shows a number with no statement of its basis")
      .toMatch(/score-provisional/);
    expect(body).toMatch(/in-scope dimensions have evidence so far/);
    expect(body, "the final state must point at Synthesis for the engagement-level verdict")
      .toMatch(/Engagement-level maturity is set in Synthesis/);
  });

  it("the export sheet does not pass one interview off as the assessment", () => {
    expect(fnBody(code, "finishInterview"), "the sheet names a maturity level without scoping it to this interview")
      .toMatch(/this interview only/);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * BEHAVIOUR, not source text.
 *
 * Every assertion above reads the page as a string, which is the weakness this
 * whole session kept walking into: a test that greps for the fix passes against
 * a fix that is wired to nothing. So the four functions are lifted out of the
 * page and RUN, against a stub DOM and a stub agenda, and the output is what
 * gets asserted. If the caption logic inverts, or an excluded dimension creeps
 * back into the mean, these fail on the rendered result rather than on a regex.
 * ──────────────────────────────────────────────────────────────────────────── */

const SLICE_START = "var DIM_TIER_LABEL";
const SLICE_END = "\nfunction renderFinding(";

function loadScorecard(opts: {
  scores: Record<string, number>;
  agenda: { lead?: string[]; cover?: string[]; light?: string[] };
  complete?: boolean;
}) {
  const from = page.indexOf(SLICE_START);
  const to = page.indexOf(SLICE_END);
  expect(from, "DIM_TIER_LABEL moved — update this harness").toBeGreaterThan(-1);
  expect(to, "renderFinding moved — update this harness").toBeGreaterThan(from);
  const src = page.slice(from, to);

  const S: any = { scores: { ...opts.scores }, interviewComplete: !!opts.complete, benchmarks: null,
                   questionsAsked: 4, depth: "deep", isRefreshMode: false };
  const DIMENSIONS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"]
    .map((code) => ({ code, name: `Dimension ${code}` }));
  const MATURITY = [
    { min: 4.0, label: "AI LEADING", bg: "#0f0", color: "#000" },
    { min: 3.0, label: "AI CAPABLE", bg: "#0f0", color: "#000" },
    { min: 2.0, label: "AI EMERGING", bg: "#ff0", color: "#000" },
    { min: 1.0, label: "AI AWARE", bg: "#f90", color: "#000" },
    { min: 0.0, label: "AI UNAWARE", bg: "#f00", color: "#fff" },
  ];

  const els: Record<string, any> = {};
  const el = (id: string) => (els[id] ||= {
    id, textContent: "", innerHTML: "", style: {},
    insertAdjacentHTML(_p: string, h: string) { this.innerHTML += h; },
    // The provisional note is appended as a NODE (textContent, not markup — see
    // innerHtmlSinks.test.ts). Flattened back into innerHTML here so the
    // assertions below can read the whole panel as one string.
    appendChild(n: any) { this.innerHTML += `<div class="${n.className}">${n.textContent}</div>`; },
  });
  const document = {
    getElementById: el,
    createElement: () => ({ className: "", textContent: "" }),
  };

  const api = new Function(
    "S", "DIMENSIONS", "MATURITY", "document", "window", "buildLiveAgenda", "getMaturity", "esc", "VyneDepth",
    src + "\nreturn { renderScorecard, computeOverall, dimensionTierMap, scoringIsFinal };",
  )(
    S, DIMENSIONS, MATURITY, document,
    // The REAL scoring module, not a stub — computeOverall now delegates its
    // arithmetic to it, so stubbing it here would test nothing.
    { VyneScoring },
    () => opts.agenda,
    (s: number) => MATURITY.find((m) => s >= m.min) || MATURITY[4],
    (s: string) => String(s),
    { initialBudget: () => 20 },
  );

  api.renderScorecard();
  return { S, api, html: el("dim-cards-container").innerHTML, badge: el("maturity-badge"),
           num: el("overall-score-num") };
}

/** The caption line of one dimension card, as rendered. */
function captionOf(html: string, code: string): string {
  const at = html.indexOf(`>${code}</div>`);
  expect(at, `no card rendered for ${code}`).toBeGreaterThan(-1);
  const m = /class="dim-q-count">([^<]*)</.exec(html.slice(at));
  expect(m, `no caption on ${code}'s card`).toBeTruthy();
  return m![1];
}

/** The tier chip of one dimension card, as rendered. */
function tierOf(html: string, code: string): string {
  const at = html.indexOf(`>${code}</div>`);
  const m = /class="dim-tier dim-tier-(\w+)"/.exec(html.slice(at));
  expect(m, `no tier chip on ${code}'s card`).toBeTruthy();
  return m![1];
}

const AGENDA = { lead: ["D2", "D1", "D6"], cover: ["D3", "D5"], light: ["D4"] }; // D7 excluded

describe("v5.34.91 — rendered output, mid-interview", () => {
  it("names no maturity level anywhere while the interview runs", () => {
    const { html, badge } = loadScorecard({ scores: { D1: 4.5, D2: 1.0, D3: 3.2, D6: 2.0 }, agenda: AGENDA });
    for (const m of ["AI LEADING", "AI CAPABLE", "AI EMERGING", "AI AWARE", "AI UNAWARE"]) {
      expect(html, `the live scorecard printed "${m}" mid-interview`).not.toContain(m);
    }
    expect(badge.textContent).toBe("INTERIM");
  });

  it("still shows the moving numbers", () => {
    const { html, num } = loadScorecard({ scores: { D1: 4.5, D2: 1.0, D3: 3.2, D6: 2.0 }, agenda: AGENDA });
    expect(html).toContain("4.5");
    expect(html).toContain("1.0");
    /*
     * v5.34.92, weighted by this role's own tiers. D1/D2/D6 lead (1.0 each),
     * D3 cover (0.6), D7 excluded (0):
     *   (4.5×1.0 + 1.0×1.0 + 3.2×0.6 + 2.0×1.0) ÷ (1.0+1.0+0.6+1.0)
     *   = 9.42 ÷ 3.6 = 2.62 → 2.6
     * The plain mean of the same four numbers is 2.7. The gap is the point.
     */
    expect(num.textContent).toBe("2.6");
    expect(html).toMatch(/4 of 6 in-scope dimensions have evidence so far/);
  });

  it("labels each dimension with the tier it is being interviewed at", () => {
    const { html } = loadScorecard({ scores: { D1: 3, D4: 3, D7: 3 }, agenda: AGENDA });
    expect(tierOf(html, "D1")).toBe("lead");
    expect(tierOf(html, "D3")).toBe("cover");
    expect(tierOf(html, "D4")).toBe("light");
    expect(tierOf(html, "D7"), "a dimension in no tier must render as excluded, not as low-scoring")
      .toBe("out");
  });

  it("an excluded dimension with a score is kept out of the overall", () => {
    /*
     * THE arithmetic bug, end to end. D7 is switched off for this role and a
     * scoring pass put 1.0 on it anyway. Before: (4.0 + 1.0) / 2 = 2.5 on the
     * client's headline number. After: 4.0, and D7 says so on its own card.
     */
    const { num, html } = loadScorecard({ scores: { D1: 4.0, D7: 1.0 }, agenda: AGENDA });
    expect(num.textContent, "an off-scope dimension is still dragging the overall down").toBe("4.0");
    expect(captionOf(html, "D7")).toMatch(/Not in scope for this role/);
    expect(html).toMatch(/1 of 6 in-scope dimensions have evidence so far/);
  });

  it("an unscored dimension says so, and says which kind of unscored", () => {
    const { html } = loadScorecard({ scores: {}, agenda: AGENDA });
    expect(captionOf(html, "D1")).toBe("Not yet assessed");
    expect(captionOf(html, "D7"), "'not yet' implies it is still coming — it is not in scope at all")
      .toBe("Not assessed — out of scope");
  });
});

describe("v5.34.91 — rendered output, interview closed", () => {
  it("lead and cover dimensions get their maturity level", () => {
    const { html, badge } = loadScorecard({
      scores: { D1: 4.5, D2: 1.0, D3: 3.2 }, agenda: AGENDA, complete: true,
    });
    expect(captionOf(html, "D1")).toBe("AI LEADING");
    expect(captionOf(html, "D2")).toBe("AI AWARE");
    expect(captionOf(html, "D3")).toBe("AI CAPABLE");
    expect(badge.textContent).toBe("AI EMERGING"); // (4.5 + 1.0 + 3.2) / 3 = 2.9
  });

  it("a LIGHT dimension gets none, even at close", () => {
    /*
     * The user's sentence, as an executable assertion: "a low score on a
     * dimension we gave 'light' coverage may mean something in the end". Two
     * questions in passing cannot support "AI Unaware", and the interview
     * ending does not change how many questions were asked.
     */
    const { html } = loadScorecard({ scores: { D4: 1.2 }, agenda: AGENDA, complete: true });
    expect(captionOf(html, "D4")).toMatch(/Light coverage — indicative only, not a rating/);
    expect(html).not.toContain("AI AWARE");
  });

  it("an EXCLUDED dimension gets none either, and is not in the mean", () => {
    const { html, num } = loadScorecard({ scores: { D1: 4.0, D7: 1.0 }, agenda: AGENDA, complete: true });
    expect(captionOf(html, "D7")).toMatch(/Not in scope for this role/);
    expect(num.textContent).toBe("4.0");
  });

  it("points at Synthesis for the engagement-level verdict", () => {
    const { html } = loadScorecard({ scores: { D1: 4.0 }, agenda: AGENDA, complete: true });
    expect(html).toMatch(/Final for this interview: 1 of 6 in-scope dimensions evidenced/);
    expect(html).toMatch(/Engagement-level maturity is set in Synthesis/);
  });
});
