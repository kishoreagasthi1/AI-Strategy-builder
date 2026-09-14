/**
 * Whose answers is this score standing on? (v5.34.92)
 *
 * ── What this exists to say ─────────────────────────────────────────────────
 *
 * The round score for a dimension is a role-weighted mean across whoever
 * answered, and it is arithmetically correct whoever that was. What it cannot
 * say is that the person the weight table trusts most on that dimension was
 * never in the room.
 *
 * The case, from docs/SCORING_EXPLAINED.md: D6 Governance & Risk lands at 1.7,
 * the engagement's lowest score and the one the deck leads with, from a CTO
 * (0.8) and a CFO (0.6). The General Counsel carries 1.0 on D6 and was not
 * interviewed. Nothing in the product said so — and the Coverage Map beside
 * this panel actively said the opposite, because it counts interviews and two
 * interviews reads as adequate.
 *
 * v5.34.92's dimension weighting makes it matter MORE, not less: D6 now pulls
 * harder on the headline precisely because two of the three roles led on it,
 * while resting on neither of the two people most qualified to answer.
 *
 * ── Why the analysis is in vyne-scoring.js ──────────────────────────────────
 *
 * So it can be run here, against the real weight table, rather than asserted
 * as a string inside a 1.1MB HTML page. synthesis.html only renders what this
 * returns. The weight table is injected rather than imported for the reason
 * computeRoundScores injects it: it lives in vyne-client.js and
 * engagementMerge.ts, and vyne-scoring.js must not become a third copy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { ROLE_WEIGHTS } from "../src/tenant/engagementMerge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");

const VS: any = (() => {
  const p = join(root, "frontend", "vyne-scoring.js");
  const sandbox: any = { module: { exports: {} }, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(p, "utf8"), sandbox, { filename: p });
  return sandbox.module.exports;
})();

/** The REAL table. A synthetic one would let the analysis be right about a
 *  world the product does not ship. */
const W = ROLE_WEIGHTS as unknown as Record<string, Record<string, number>>;
const by = (rows: any[], d: string) => rows.find((r) => r.dim === d);

/** The worked example: CTO + CFO + CHRO, scores as in the doc. */
const ROSTER = [
  { role: "CTO", scores: { D1: 4.0, D2: 3.5, D3: 2.5, D4: 2.0, D6: 1.5, D7: 2.0 } },
  { role: "CFO", scores: { D1: 2.0, D2: 2.0, D3: 3.0, D4: 2.5, D5: 3.0, D6: 2.0, D7: 2.0 } },
  { role: "CHRO", scores: { D3: 2.0, D4: 4.0, D5: 2.5, D7: 3.5 } },
];

describe("v5.34.92 — roster coverage, on the engagement the doc walks through", () => {
  const rows = VS.rosterCoverage(ROSTER, W);

  it("flags D6 — the lowest score in the engagement, with no General Counsel", () => {
    const d6 = by(rows, "D6");
    expect(d6.status, "the governance gap is not flagged").toBe("thin");
    expect(d6.have, "the CTO, at 0.8, is the most authoritative voice that answered").toBe(0.8);
    expect(d6.best).toBe(1);
    expect(d6.missing).toEqual(["General_Counsel"]);
  });

  it("passes D4 — the CHRO leads on people and was interviewed", () => {
    const d4 = by(rows, "D4");
    expect(d4.status).toBe("ok");
    expect(d4.haveRole).toBe("CHRO");
    expect(d4.missing).toEqual([]);
  });

  it("flags D5 — no COO and no Operations Manager on a process score", () => {
    const d5 = by(rows, "D5");
    expect(d5.status).toBe("thin");
    expect(d5.have).toBe(0.7);       // CFO
    expect(d5.missing).toEqual(["COO"]);
  });

  it("names every contributor with the weight its answer carried", () => {
    /*
     * The panel has to be actionable, which means showing the working: "scored
     * by CTO (0.8), CFO (0.6)" is what lets a consultant decide whether to
     * chase a General Counsel or accept the number.
     */
    const d6 = by(rows, "D6");
    expect(d6.contributors).toEqual([
      { role: "CTO", weight: 0.8, score: 1.5 },
      { role: "CFO", weight: 0.6, score: 2.0 },
    ]);
  });

  it("returns one row per dimension, in DIMS order, always", () => {
    expect(rows.map((r: any) => r.dim)).toEqual([...VS.DIMS]);
  });
});

describe("v5.34.92 — the ways this analysis could lie", () => {
  it("a tie at the top is covered by EITHER role, and says nothing is missing", () => {
    /*
     * Found by running it: D7 is CEO 1.0 and CHRO 1.0. The first version listed
     * every top-weighted role not in the roster, so a D7 answered
     * authoritatively by the CHRO was flagged "well covered" and, in the same
     * row, explained that the highest-weighted voice had not been interviewed.
     * A panel that contradicts itself teaches consultants to ignore it.
     */
    const rows = VS.rosterCoverage([{ role: "CHRO", scores: { D7: 3.5 } }], W);
    const d7 = by(rows, "D7");
    expect(W.D7.CEO, "this test assumes D7 is a tie — the table changed").toBe(1);
    expect(W.D7.CHRO).toBe(1);
    expect(d7.status).toBe("ok");
    expect(d7.missing, "a covered dimension must not also report a missing voice").toEqual([]);
  });

  it("0 means no evidence, so a zeroed dimension is 'none', not badly covered", () => {
    const rows = VS.rosterCoverage([{ role: "CTO", scores: { D1: 4.0, D6: 0 } }], W);
    expect(by(rows, "D6").status).toBe("none");
    expect(by(rows, "D6").contributors).toEqual([]);
    // And 'none' still tells the consultant who to go and ask.
    expect(by(rows, "D6").bestRoles).toContain("General_Counsel");
  });

  it("an empty roster is every dimension 'none', not a crash and not 'ok'", () => {
    const rows = VS.rosterCoverage([], W);
    expect(rows).toHaveLength(7);
    expect(rows.every((r: any) => r.status === "none")).toBe(true);
    expect(VS.rosterCoverage(null, W)).toHaveLength(7);
    expect(VS.rosterCoverage(ROSTER, null)).toHaveLength(7);
  });

  it("a DISPLAY-label role resolves to its weight instead of the 0.5 default", () => {
    /*
     * Synthetic and imported engagements store "COO / VP Operations" where
     * invites store "COO". Reading that as an unknown role would weigh it 0.5
     * and report a thin D5 on exactly the engagements whose rosters came from
     * those paths — a warning that is wrong, on the data most likely to be
     * demoed.
     */
    const rows = VS.rosterCoverage([{ role: "COO / VP Operations", scores: { D5: 3.0 } }], W);
    const d5 = by(rows, "D5");
    expect(d5.haveRole).toBe("COO");
    expect(d5.have).toBe(1);
    expect(d5.status).toBe("ok");
  });

  it("severity separates 'the best voice is absent' from 'nobody qualified answered'", () => {
    // VP Sales carries 0.2 on governance. A D6 resting only on them is not thin.
    const gap = by(VS.rosterCoverage([{ role: "VP_Sales", scores: { D6: 2.0 } }], W), "D6");
    expect(gap.status).toBe("gap");
    // The CDO carries 0.9 against the GC's 1.0 — a real but small shortfall.
    const thin = by(VS.rosterCoverage([{ role: "CDO", scores: { D6: 2.0 } }], W), "D6");
    expect(thin.status).toBe("thin");
    expect(thin.have).toBe(0.9);
  });

  it("an unknown role is weighed at the same 0.5 the scoring uses, not at 0", () => {
    /*
     * Must match vyneRoleWeight's fallback. Weighing an unrecognised role at 0
     * here would report "no evidence" for a dimension that HAS a score, and the
     * two panels would disagree about what has been assessed.
     */
    const rows = VS.rosterCoverage([{ role: "Chief Vibes Officer", scores: { D3: 3.0 } }], W);
    const d3 = by(rows, "D3");
    expect(d3.contributors).toHaveLength(1);
    expect(d3.contributors[0].weight).toBe(0.5);
    expect(d3.status).toBe("gap");
  });

  it("changes no score", () => {
    /*
     * The whole point. This is an audit of the roster, not an adjustment to the
     * arithmetic — a consultant must be able to act on it or ignore it without
     * the number moving either way.
     */
    const before = JSON.parse(JSON.stringify(ROSTER));
    VS.rosterCoverage(ROSTER, W);
    expect(ROSTER).toEqual(before);
  });
});

describe("v5.34.92 — the panel is wired into the dashboard", () => {
  const synth = readFileSync(join(root, "frontend", "synthesis.html"), "utf8");
  const code = synth.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the card exists and has a mount point", () => {
    expect(synth).toMatch(/id="card-roster-coverage"/);
    expect(synth).toMatch(/id="roster-coverage"/);
  });

  it("the dashboard render actually calls it", () => {
    // The failure this session keeps producing: a correct function nothing invokes.
    expect(code, "renderRosterCoverage is defined but never called")
      .toMatch(/\n\s*renderRosterCoverage\(iv\);/);
    expect(code).toMatch(/function renderRosterCoverage\(interviews\)\{/);
  });

  it("it renders the shared analysis rather than re-deriving one", () => {
    expect(code).toMatch(/VyneScoring\.rosterCoverage\(/);
    expect(code, "the page must not carry its own copy of the weight table")
      .not.toMatch(/D1:\{CDO:1\.0/);
  });

  it("every status the analysis can return has a label and a style", () => {
    for (const s of ["ok", "thin", "gap", "none"]) {
      expect(code, `no FLAG entry for status '${s}'`).toMatch(new RegExp(`${s}:\\['rc-${s}'`));
      expect(synth, `.rc-${s} has no CSS`).toMatch(new RegExp(`\\.rc-${s}\\{`));
    }
  });

  it("builds rows as text nodes, not as an innerHTML template", () => {
    /*
     * Role strings reach this panel from interview records, which are written
     * by a browser the interviewee controls. innerHtmlSinks.test.ts already
     * baselines eight unresolvable sinks in this file; a panel of three strings
     * and a number has no reason to be the ninth.
     */
    const body = code.slice(code.indexOf("function renderRosterCoverage("));
    const fn = body.slice(0, body.indexOf("\nfunction "));
    expect(fn).toMatch(/note\.textContent\s*=/);
    expect(fn).toMatch(/dim\.textContent\s*=/);
    expect(fn, "a role string is being interpolated into markup")
      .not.toMatch(/innerHTML\s*=\s*[`'"].*\$\{|innerHTML\s*\+=/);
  });
});
