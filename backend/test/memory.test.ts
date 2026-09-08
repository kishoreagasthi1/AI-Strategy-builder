/**
 * vyne-memory.js — the derived per-person, per-dimension memory (v5.32.88).
 *
 * Executed here rather than only in a browser for the same reason
 * findingsParity does it: this is a pure function over an engagement record,
 * and the cases that matter are shapes, not pixels.
 *
 * The properties under test are the ones the design turns on:
 *
 *   · a claim can be traced to the round and interview that produced it —
 *     without provenance a summary in a prompt is unfalsifiable
 *   · recency: the latest round is verbatim, older rounds survive only as a
 *     trajectory, so a growing engagement does not drown the prompt
 *   · staleness distinguishes "unchanged because we asked" from "unchanged
 *     because nobody asked", which is the distinction round-2 scoring could
 *     not previously draw
 *   · selfView carries only the person's own material, and ambientView carries
 *     nobody's identity
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const webPath = path.resolve(here, "../../frontend/vyne-memory.js");

function load(): any {
  const sandbox: any = { module: { exports: {} }, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(webPath, "utf8"), sandbox, { filename: webPath });
  const api = sandbox.module.exports;
  if (!api || typeof api.build !== "function") throw new Error("vyne-memory.js did not export build()");
  if (sandbox.VyneMemory !== api) throw new Error("vyne-memory.js did not publish window.VyneMemory");
  return api;
}
const M = load();

/**
 * Three rounds, two divisional COOs and a CFO.
 *
 * Deliberately shaped so every property has something to bite on:
 *   · Cara speaks on D5 in rounds 1 and 3 — trajectory, and text kept only
 *     for round 3
 *   · Dev speaks on D5 in round 1 only, but takes part in round 3 — so D5 is
 *     STALE for him, the carried-forward case
 *   · the CFO never touches D5 — a dimension a person did not address must not
 *     appear for them at all
 *   · the rounds array is out of order, because that is a real shape (F23)
 */
const ENG = {
  code: "ACME01",
  client: "Acme Industrial",
  rounds: [
    {
      roundId: "r3", roundNumber: 3,
      interviews: [
        { role: "COO", interviewee: "Cara Diaz", sourceInterviewId: "iv-c3",
          scores: { D5: 4 }, coverageByDim: { D5: 0.9 },
          findings: [{ dimension: "D5", text: "Shift handoffs are now logged in the MES" }] },
        { role: "COO", interviewee: "Dev Rao", sourceInterviewId: "iv-d3",
          scores: { D1: 3 }, coverageByDim: { D1: 0.7 },
          findings: [{ dimension: "D1", text: "Reporting is consolidated but slow" }] },
      ],
    },
    {
      roundId: "r1", roundNumber: 1,
      interviews: [
        { role: "COO", interviewee: "Cara Diaz", sourceInterviewId: "iv-c1",
          scores: { D5: 2 }, coverageByDim: { D5: 0.4 },
          findings: [{ dimension: "D5", text: "Handoffs between shifts are manual" }] },
        { role: "COO", interviewee: "Dev Rao", sourceInterviewId: "iv-d1",
          scores: { D5: 4 },
          findings: [{ dimension: "D5", text: "The plant floor is largely automated" }] },
        { role: "CFO", interviewee: "Priya Sharma", sourceInterviewId: "iv-p1",
          scores: { D1: 3 },
          findings: [{ dimension: "D1", text: "Lineage is undocumented" }] },
      ],
    },
  ],
};

describe("VyneMemory.build — provenance and recency", () => {
  const mem = M.build(ENG);

  it("reads every round regardless of array order", () => {
    // The array is [3, 1]. Getting this wrong is exactly the defect fixed in
    // v5.32.87 one layer up.
    expect(mem.fromRounds).toEqual([1, 3]);
    expect(mem.newestRound).toBe(3);
  });

  it("indexes by person, so two holders of one role stay separate", () => {
    expect(Object.keys(mem.byPerson).sort())
      .toEqual(["CFO||Priya Sharma", "COO||Cara Diaz", "COO||Dev Rao"]);
    expect(mem.byPerson["COO||Cara Diaz"].label).toBe("COO (Cara Diaz)");
    // One holder: the role alone identifies them, so no name is appended.
    expect(mem.byPerson["CFO||Priya Sharma"].label).toBe("CFO");
  });

  it("carries provenance on every entry", () => {
    const d5 = mem.byPerson["COO||Cara Diaz"].byDimension.D5;
    expect(d5.history).toHaveLength(2);
    expect(d5.history[0].source).toEqual({ roundId: "r1", interviewId: "iv-c1" });
    expect(d5.history[1].source).toEqual({ roundId: "r3", interviewId: "iv-c3" });
  });

  it("keeps the latest round verbatim and drops older text to a trajectory", () => {
    const d5 = mem.byPerson["COO||Cara Diaz"].byDimension.D5;
    // Round 3's words survive; round 1's do not.
    expect(d5.latest.text).toBe("Shift handoffs are now logged in the MES");
    expect(d5.history[0].text).toBeNull();
    // But round 1's SCORE survives, because the movement is the point.
    expect(d5.trajectory).toEqual([{ round: 1, score: 2 }, { round: 3, score: 4 }]);
    expect(d5.movement).toBe(2);
  });

  it("flags a dimension as STALE when the person spoke more recently elsewhere", () => {
    // Dev scored D5 in round 1 and took part in round 3 without revisiting it.
    // His 4/5 is being carried forward and needs re-evidencing, not restating.
    const dev = mem.byPerson["COO||Dev Rao"].byDimension.D5;
    expect(dev.lastMeasuredRound).toBe(1);
    expect(dev.stale).toBe(true);
    expect(dev.roundsSinceMeasured).toBe(2);

    // Cara revisited D5 in round 3, so hers is not stale.
    expect(mem.byPerson["COO||Cara Diaz"].byDimension.D5.stale).toBe(false);
  });

  it("does not invent a dimension the person never addressed", () => {
    expect(mem.byPerson["CFO||Priya Sharma"].byDimension.D5).toBeUndefined();
    expect(Object.keys(mem.byPerson["CFO||Priya Sharma"].byDimension)).toEqual(["D1"]);
  });

  it("records coverage, which is what tells a carried-forward score from a fresh one", () => {
    expect(mem.byPerson["COO||Cara Diaz"].byDimension.D5.coverage).toBe(0.9);
    // Dev's round-1 entry had no coverage recorded at all — null, not zero.
    // "Nobody measured it" is a different fact from "it measured zero".
    expect(mem.byPerson["COO||Dev Rao"].byDimension.D5.coverage).toBeNull();
  });

  it("is a pure derivation — no timestamp baked in by the module", () => {
    // derivedAt is stamped by the caller. A clock inside a pure function makes
    // the output untestable and the cache impossible to compare.
    expect(mem.derivedAt).toBeNull();
  });
});

describe("VyneMemory projections", () => {
  const mem = M.build(ENG);

  it("selfView carries only the person's own material", () => {
    const self = M.selfView(mem, "COO||Dev Rao");
    const blob = JSON.stringify(self);
    expect(blob).toContain("plant floor is largely automated");     // his
    expect(blob).not.toContain("Handoffs between shifts are manual"); // Cara's
    expect(blob).not.toContain("Lineage is undocumented");           // Priya's
    expect(self.person).toBe("Dev Rao");
  });

  it("selfView can be scoped to today's agenda dimensions", () => {
    const self = M.selfView(mem, "COO||Cara Diaz", ["D5"]);
    expect(Object.keys(self.dimensions)).toEqual(["D5"]);
  });

  it("ambientView excludes the asker and every identity", () => {
    const amb = M.ambientView(mem, "COO||Dev Rao", ["D5"]);
    const blob = JSON.stringify(amb);
    // Somebody else's claim is present…
    expect(blob).toContain("Shift handoffs are now logged in the MES");
    // …his own is not…
    expect(blob).not.toContain("plant floor is largely automated");
    // …and nothing says who spoke. This is the projection that can reach a
    // person who must not know who said what, so it carries claims and no
    // speaker at all — not even a role, which on a small executive team is
    // frequently identifying on its own.
    expect(blob).not.toContain("Cara");
    expect(blob).not.toContain("COO");
    expect(blob).not.toContain("role");
  });

  it("ambientView is newest-first and capped", () => {
    const amb = M.ambientView(mem, "CFO||Priya Sharma", ["D5"]);
    expect(amb.D5.length).toBeLessThanOrEqual(M.AMBIENT_PER_DIM);
    // Cara's round-3 line leads; Dev's round-1 line follows.
    expect(amb.D5[0]).toBe("Shift handoffs are now logged in the MES");
  });

  it("rankDimensions puts today's agenda first, then what is stale", () => {
    const self = M.selfView(mem, "COO||Dev Rao");
    const ranked = M.rankDimensions(self, ["D1"], 2);
    // D1 is on the agenda so it leads even though D5 is stale.
    expect(ranked[0]).toBe("D1");
    expect(ranked).toContain("D5");
  });

  it("selfView of an unknown person is null, not an empty shell", () => {
    // An empty shell reads as "this person said nothing", which is a claim.
    // Absence of a record is a different fact and the caller must handle it.
    expect(M.selfView(mem, "COO||Nobody")).toBeNull();
  });
});

describe("VyneMemory — degenerate inputs", () => {
  it("survives an engagement with no rounds", () => {
    const mem = M.build({ code: "X" });
    expect(mem.fromRounds).toEqual([]);
    expect(mem.newestRound).toBeNull();
    expect(Object.keys(mem.byPerson)).toEqual([]);
  });

  it("survives null and junk", () => {
    expect(() => M.build(null)).not.toThrow();
    expect(() => M.build({ rounds: [null, {}, { interviews: [null] }] })).not.toThrow();
  });

  it("treats a score of 0 as no evidence, matching every other module", () => {
    // 0 has meant "no evidence for this dimension" since v5.31.
    const mem = M.build({
      rounds: [{ roundNumber: 1, interviews: [{ role: "CEO", interviewee: "A", scores: { D1: 0 } }] }],
    });
    expect(mem.byPerson["CEO||A"]).toBeUndefined();
  });
});
