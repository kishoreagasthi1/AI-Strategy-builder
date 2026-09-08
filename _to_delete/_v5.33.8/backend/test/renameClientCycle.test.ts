/**
 * The rename CYCLE, at the level of the pure planner (v5.32.93).
 *
 * frontend/test/rename-cycle-e2e.mjs drives this same function through a real
 * browser; this file pins its behaviour directly, so a regression names the
 * exact rule it broke instead of surfacing as "the page shows the old name".
 *
 * What every case here is really testing is one claim: after a rename, ALL of
 * the places a client's identity is stored agree. Four rounds of fixes each
 * passed a single forward rename and left one store behind, and the store left
 * behind became the input to the next rename. So these tests rename in cycles
 * and re-assert agreement after every hop, rather than once at the end.
 */
import { describe, it, expect } from "vitest";
import {
  normClient,
  planClientRename,
  resolveEngagementCode,
  ownedNormsFor,
  type ClientRenamePlan,
} from "../src/auth/clients.js";

const CODE = "ENG-GSC6-Y7ME";
const OTHER = "ENG-MCJQ-RBH3";

interface World {
  state: Record<string, string>;
  engagements: Array<{ id: string; client_name: string }>;
  interviews: Array<{ id: string; client_name: string }>;
  assignments: Array<{ user_id: string; client_name: string; client_norm: string }>;
}

function world(): World {
  return {
    state: {
      vynora_engagement_index: JSON.stringify({
        meridianfoods: CODE,
        nissanmotorscorporation: OTHER,
      }),
      ["vynora_engagement_" + CODE]: JSON.stringify({
        code: CODE, client: "Meridian Foods", industry: "Manufacturing",
      }),
      ["vynora_engagement_" + OTHER]: JSON.stringify({
        code: OTHER, client: "Nissan Motors Corporation",
      }),
      vynora_briefing_meridianfoods: JSON.stringify({
        client: "Meridian Foods", engagementCode: CODE,
        hypotheses: [{ index: 0, text: "Data is siloed" }],
      }),
      vynora_mandatory_meridianfoods: JSON.stringify({ client: "Meridian Foods" }),
      vynora_solution_design_meridianfoods: JSON.stringify({ client: "Meridian Foods" }),
      vynora_briefing_nissanmotorscorporation: JSON.stringify({ client: "Nissan Motors Corporation" }),
      vynora_last_briefing: JSON.stringify({ normKey: "meridianfoods", client: "Meridian Foods" }),
      vynora_roadmap_index: JSON.stringify({ [CODE]: { clientName: "Meridian Foods" } }),
      vynora_roadmap_state: JSON.stringify({ dependencies: { client_meridianfoods: { d: 1 } } }),

      /* Orphan keys under norms with no index entry, no engagements row and no
       * interviews — the debris production accumulated. It must not block a
       * rename, and must not be mistaken for a client. */
      vynora_briefing_meridianfoods1: JSON.stringify({ client: "Meridian Foods 1" }),
      vynora_briefing_acmeindustrial: JSON.stringify({ client: "Acme Industrial" }),
    },
    engagements: [
      { id: "e1", client_name: "Meridian Foods" },
      { id: "e2", client_name: "Nissan Motors Corporation" },
    ],
    interviews: [
      { id: "iv1", client_name: "Meridian Foods" },
      { id: "iv2", client_name: "Meridian Foods" },
      { id: "nv1", client_name: "Nissan Motors Corporation" },
    ],
    assignments: [{ user_id: "u2", client_name: "Meridian Foods", client_norm: "meridianfoods" }],
  };
}

/** Apply a plan the way routes/assignments.ts does. */
function apply(w: World, plan: ClientRenamePlan): void {
  for (const [k, v] of Object.entries(plan.sets)) w.state[k] = v;
  for (const k of plan.deletes) if (!(k in plan.sets)) delete w.state[k];
  for (const id of plan.engagementIds) {
    const r = w.engagements.find((x) => x.id === id);
    if (r) r.client_name = plan.newName;
  }
  for (const id of plan.interviewIds) {
    const r = w.interviews.find((x) => x.id === id);
    if (r) r.client_name = plan.newName;
  }
  for (const a of w.assignments) {
    if (plan.assignmentNorms.includes(a.client_norm)) {
      a.client_norm = plan.newNorm;
      a.client_name = plan.newName;
    }
  }
}

function rename(w: World, newName: string, target: { code?: string | null; clientName?: string | null } = { code: CODE }) {
  const plan = planClientRename({ ...w, target, newName });
  if (!plan.conflict) apply(w, plan);
  return plan;
}

/** The seven stores, read back. */
function stores(w: World) {
  const idx = JSON.parse(w.state.vynora_engagement_index) as Record<string, string>;
  const eng = JSON.parse(w.state["vynora_engagement_" + CODE]) as { client: string };
  const lb = JSON.parse(w.state.vynora_last_briefing) as { normKey: string; client: string };
  return {
    interviews: w.interviews.filter((r) => r.id.startsWith("iv")).map((r) => r.client_name),
    engagement: w.engagements.find((r) => r.id === "e1")!.client_name,
    indexNormsForCode: Object.keys(idx).filter((n) => idx[n] === CODE),
    record: eng.client,
    normKeys: ["vynora_briefing_", "vynora_mandatory_", "vynora_solution_design_"]
      .filter((f) => Object.keys(w.state).some((k) => k.startsWith(f) && k !== f + "nissanmotorscorporation")),
    lastBriefing: lb,
    assignment: w.assignments[0],
    bystander: w.engagements.find((r) => r.id === "e2")!.client_name,
  };
}

function expectAgreement(w: World, name: string) {
  const norm = normClient(name);
  const s = stores(w);
  expect(s.interviews).toEqual([name, name]);
  expect(s.engagement).toBe(name);
  expect(s.indexNormsForCode).toEqual([norm]);
  expect(s.record).toBe(name);
  expect(s.lastBriefing).toEqual({ normKey: norm, client: name });
  expect(s.assignment).toEqual({ user_id: "u2", client_name: name, client_norm: norm });
  for (const f of ["vynora_briefing_", "vynora_mandatory_", "vynora_solution_design_"]) {
    expect(Object.keys(w.state)).toContain(f + norm);
  }
  // The bystander client is never collateral.
  expect(s.bystander).toBe("Nissan Motors Corporation");
  expect(w.state.vynora_briefing_nissanmotorscorporation).toBeTruthy();
}

describe("planClientRename — the rename cycle", () => {
  it("keeps every store in agreement across seven hops, three of them back to an earlier name", () => {
    const w = world();
    const hops = [
      "Meridian Foods New",
      "Meridian Foods Test",
      "Meridian Foods Test 1",
      "Meridian Foods",       // back to the original
      "Meridian Foods New",   // back to an intermediate
      "Harbor Point Dairy",
      "Meridian Foods Test",  // back, five hops later
    ];
    for (const name of hops) {
      const plan = rename(w, name);
      expect(plan.conflict, `hop to ${name} was refused: ${plan.conflict}`).toBeUndefined();
      // The post-condition, checked after EVERY hop rather than at the end.
      expect(plan.report.residue, `hop to ${name} left records behind`).toEqual([]);
      expectAgreement(w, name);
    }
  });

  it("never leaves a second index entry pointing at the same code", () => {
    const w = world();
    for (const name of ["A Foods", "B Foods", "A Foods", "C Foods"]) {
      rename(w, name);
      const idx = JSON.parse(w.state.vynora_engagement_index) as Record<string, string>;
      expect(Object.keys(idx).filter((n) => idx[n] === CODE)).toHaveLength(1);
    }
  });

  /* ── The root cause, isolated ─────────────────────────────────────────── */
  it("corrects an engagement record whose name is two hops out of step, instead of silently skipping it", () => {
    const w = world();
    // Exactly the production split: the index and the rows moved on, the
    // record's own .client did not. The old code patched .client ONLY if it
    // already agreed with the name being renamed FROM, so this record was
    // skipped, nothing counted it, and the browser then seeded the NEXT
    // rename from this stale value.
    w.state["vynora_engagement_" + CODE] = JSON.stringify({ code: CODE, client: "Meridian Foods New" });
    w.state.vynora_engagement_index = JSON.stringify({ meridianfoodstest: CODE, nissanmotorscorporation: OTHER });
    w.state.vynora_briefing_meridianfoodstest = w.state.vynora_briefing_meridianfoods;
    w.state.vynora_mandatory_meridianfoodstest = w.state.vynora_mandatory_meridianfoods;
    w.state.vynora_solution_design_meridianfoodstest = w.state.vynora_solution_design_meridianfoods;
    delete w.state.vynora_briefing_meridianfoods;
    delete w.state.vynora_mandatory_meridianfoods;
    delete w.state.vynora_solution_design_meridianfoods;
    w.state.vynora_last_briefing = JSON.stringify({ normKey: "meridianfoodstest", client: "Meridian Foods Test" });
    for (const r of w.interviews) if (r.id.startsWith("iv")) r.client_name = "Meridian Foods Test";
    w.engagements[0].client_name = "Meridian Foods Test";
    w.assignments[0] = { user_id: "u2", client_name: "Meridian Foods Test", client_norm: "meridianfoodstest" };

    const plan = rename(w, "Meridian Foods Test 1");
    expect(plan.conflict).toBeUndefined();
    // The split is SEEN: both identities this engagement was found under are
    // collected, and both move. Under the old code only the one the caller
    // happened to name moved, and the other became the next rename's input.
    expect([...plan.report.ownedNorms].sort()).toEqual(["meridianfoodsnew", "meridianfoodstest"]);
    expect(plan.report.residue).toEqual([]);
    expectAgreement(w, "Meridian Foods Test 1");

    // And the hop AFTER the repair is ordinary — the poison loop is broken,
    // not merely papered over for one call.
    const next = rename(w, "Meridian Foods");
    expect(next.conflict).toBeUndefined();
    expect(next.report.residue).toEqual([]);
    expectAgreement(w, "Meridian Foods");
  });

  it("sweeps a duplicate index entry that a half-finished rename left behind", () => {
    const w = world();
    w.state.vynora_engagement_index = JSON.stringify({
      meridianfoodsnew: CODE,     // the entry the delete missed
      meridianfoods: CODE,        // and the live one
      nissanmotorscorporation: OTHER,
    });
    const plan = rename(w, "Meridian Foods Test");
    expect(plan.conflict).toBeUndefined();
    expect(plan.report.duplicateIndexNormsRemoved.length).toBeGreaterThan(0);
    const idx = JSON.parse(w.state.vynora_engagement_index) as Record<string, string>;
    expect(Object.keys(idx).filter((n) => idx[n] === CODE)).toEqual(["meridianfoodstest"]);
    expect(idx.nissanmotorscorporation).toBe(OTHER);
  });

  /* ── Collisions: debris must not block, a live client must ─────────────── */
  it("renames BACK over an index entry left behind for this same engagement", () => {
    const w = world();
    // Production's exact shape, verbatim from the observed index:
    //   {"meridianfoodsnew":"ENG-GSC6-Y7ME","meridianfoodstest":"ENG-GSC6-Y7ME"}
    // Two norms, one code, with the rest of the stores on "Meridian Foods Test".
    w.state.vynora_engagement_index = JSON.stringify({
      meridianfoodsnew: CODE,
      meridianfoodstest: CODE,
      nissanmotorscorporation: OTHER,
    });
    w.state["vynora_engagement_" + CODE] = JSON.stringify({ code: CODE, client: "Meridian Foods Test" });
    for (const f of ["vynora_briefing_", "vynora_mandatory_", "vynora_solution_design_"]) {
      w.state[f + "meridianfoodstest"] = w.state[f + "meridianfoods"];
      delete w.state[f + "meridianfoods"];
    }
    w.state.vynora_last_briefing = JSON.stringify({ normKey: "meridianfoodstest", client: "Meridian Foods Test" });
    for (const r of w.interviews) if (r.id.startsWith("iv")) r.client_name = "Meridian Foods Test";
    w.engagements[0].client_name = "Meridian Foods Test";
    w.assignments[0] = { user_id: "u2", client_name: "Meridian Foods Test", client_norm: "meridianfoodstest" };

    // "meridianfoodsnew" is sitting in the index. Under the old collision
    // check that made this rename impossible, forever — which is precisely the
    // case the user asked to be made reliable.
    const plan = rename(w, "Meridian Foods New");
    expect(plan.conflict).toBeUndefined();
    expect(plan.report.residue).toEqual([]);
    expectAgreement(w, "Meridian Foods New");
  });

  it("corrects a module's own copy of the name when it agrees with nothing, and says so", () => {
    const w = world();
    // Every module keeps its own copy of the client name (the reason
    // /api/clients/rename exists at all). A copy that drifts — a hand-repair
    // typo, a half-applied earlier rename — used to be permanent: .client was
    // patched ONLY if it already agreed with the name being renamed from, so a
    // name matching nothing was skipped, in silence, forever after.
    w.state["vynora_synthesis_full_" + CODE] = JSON.stringify({ client: "Merdian Foods", findings: [] });

    const plan = rename(w, "Meridian Foods New");
    expect(plan.conflict).toBeUndefined();
    expect(plan.report.keysRepaired).toContain("vynora_synthesis_full_" + CODE);
    expect(JSON.parse(w.state["vynora_synthesis_full_" + CODE]).client).toBe("Meridian Foods New");
    // The engagement record is corrected too — it is not reported as a repair
    // because its own name is one of the identities the planner anchors on.
    expect(JSON.parse(w.state["vynora_engagement_" + CODE]).client).toBe("Meridian Foods New");
    expect(plan.report.residue).toEqual([]);
    expectAgreement(w, "Meridian Foods New");
  });

  it("renames onto a norm held only by orphan workspace keys, and says it overwrote them", () => {
    const w = world();
    const plan = rename(w, "Meridian Foods 1"); // norm "meridianfoods1" — debris only
    expect(plan.conflict).toBeUndefined();
    expect(plan.report.debrisOverwritten).toContain("vynora_briefing_meridianfoods1");
    expectAgreement(w, "Meridian Foods 1");
  });

  it("still refuses a name held by a DIFFERENT live client", () => {
    const w = world();
    const plan = rename(w, "Nissan Motors Corporation");
    expect(plan.conflict).toBeTruthy();
    expect(plan.sets).toEqual({});
    expect(plan.deletes).toEqual([]);
    // Refused means nothing moved — not "mostly nothing".
    expectAgreement(w, "Meridian Foods");
  });

  it("refuses a name held by another client's rows even with no index entry", () => {
    const w = world();
    w.state.vynora_engagement_index = JSON.stringify({ meridianfoods: CODE });
    w.engagements.push({ id: "e3", client_name: "Halcyon Freight" });
    expect(rename(w, "Halcyon Freight").conflict).toBeTruthy();
  });

  /* ── Reporting: a rename that changed nothing is a failure ─────────────── */
  it("refuses a name-anchored rename whose old name is not in this workspace", () => {
    const w = world();
    // What a stale browser tab used to send. It matched nothing, moved
    // nothing, and returned ok — after which every later rename was computed
    // from the same wrong base.
    const plan = rename(w, "Something Else", { clientName: "Meridian Foods New" });
    expect(plan.conflict).toBeTruthy();
    expectAgreement(w, "Meridian Foods");
  });

  it("refuses an engagement code this workspace has never heard of, rather than falling back to the name", () => {
    const w = world();
    const plan = rename(w, "Anything", { code: "ENG-XXXX-XXXX", clientName: "Meridian Foods" });
    expect(plan.conflict).toBe("unknown_engagement");
    expectAgreement(w, "Meridian Foods");
  });

  it("ignores the caller's name entirely when a code resolves", () => {
    const w = world();
    // A tab two renames behind. The code is what identifies the client.
    const plan = rename(w, "Cedar Ridge Dairy", { code: CODE, clientName: "A Name From Last Week" });
    expect(plan.conflict).toBeUndefined();
    expectAgreement(w, "Cedar Ridge Dairy");
  });

  /* ── The assignment collision (v5.33.3, audit HIGH) ────────────────────
   *
   * client_assignments.client_norm is the ONLY key authorization runs on.
   * A norm that exists only as an assignment — POST /api/assignments requires
   * no engagement — read as "free" to the collision check, so renaming onto it
   * merged two clients and handed one consultant the other's entire workspace.
   *
   * REVERT TEST: delete the `takenByAssignment` term from the collision block
   * in planClientRename and the first case here fails, with the plan happily
   * re-keying every Meridian key onto "globex".
   */
  it("refuses a rename onto a name that is only a consultant ASSIGNMENT", () => {
    const w = world();
    // Bob is assigned to a client nobody has started work on yet.
    w.assignments.push({ user_id: "u9", client_name: "Globex", client_norm: "globex" });
    const plan = rename(w, "Globex", { code: CODE });
    expect(plan.conflict).toBeDefined();
    expect(plan.conflict).toContain("already assigned");
    // Nothing moved: the workspace still reads as Meridian Foods.
    expect(Object.keys(plan.sets)).toEqual([]);
    expect(plan.engagementIds).toEqual([]);
    expectAgreement(w, "Meridian Foods");
  });

  it("the refusal names the assignment, not a phantom other client", () => {
    // The wrong message here sends an owner looking for a client that does not
    // exist — there is no engagement, no interview and no index entry to find.
    const w = world();
    w.assignments.push({ user_id: "u9", client_name: "Globex", client_norm: "globex" });
    const plan = rename(w, "Globex", { code: CODE });
    expect(plan.conflict).not.toContain("already in use by a different client");
    expect(plan.conflict).toContain("Remove the assignment first");
  });

  it("still refuses when only the assignment's DISPLAY NAME matches", () => {
    // A row whose client_norm is stale but whose client_name normalizes to the
    // target is the same exposure — allowedClientNorms would still hand it over
    // after the next assignment write re-derives the norm.
    const w = world();
    w.assignments.push({ user_id: "u9", client_name: "Globex", client_norm: "globexstale" });
    expect(rename(w, "Globex", { code: CODE }).conflict).toBeDefined();
  });

  /* The counterweight, and the reason this check is written with a
   * `!norms.has()` guard rather than a bare membership test. The user's
   * standing requirement is renaming back to a name used earlier in the same
   * engagement, as many times as they like. Our OWN assignment rows must never
   * be read as somebody else's claim. */
  it("does NOT refuse a rename back to a name THIS client already holds", () => {
    const w = world();
    // The assignment sitting on our own current norm.
    expect(w.assignments[0].client_norm).toBe("meridianfoods");
    expect(rename(w, "Meridian Foods Test", { code: CODE }).conflict).toBeUndefined();
    expectAgreement(w, "Meridian Foods Test");
    // ...and back again, with the assignment row now moved to the new norm.
    w.assignments = [{ user_id: "u2", client_name: "Meridian Foods Test", client_norm: "meridianfoodstest" }];
    expect(rename(w, "Meridian Foods", { code: CODE }).conflict).toBeUndefined();
    expectAgreement(w, "Meridian Foods");
  });

  it("a full rename cycle through four names is unaffected by assignments", () => {
    const w = world();
    for (const name of ["Harbour Provisions", "Meridian Foods", "Cedar Ridge Dairy", "Meridian Foods"]) {
      const plan = rename(w, name, { code: CODE });
      expect(plan.conflict, `refused the hop to ${name}`).toBeUndefined();
      // Simulate the route's assignment move, which is what keeps the next hop
      // from seeing our own row as a foreign claim.
      w.assignments = w.assignments.map((a) => ({ ...a, client_name: name, client_norm: normClient(name) }));
      expectAgreement(w, name);
    }
  });

  /* ── The helpers the above rests on ────────────────────────────────────── */
  it("resolveEngagementCode believes a code only when the workspace corroborates it", () => {
    const w = world();
    expect(resolveEngagementCode(w.state, { code: CODE })).toBe(CODE);
    expect(resolveEngagementCode(w.state, { code: "eng-gsc6-y7me" })).toBe(CODE); // case-insensitive
    expect(resolveEngagementCode(w.state, { code: "ENG-NOPE-0000" })).toBeNull();
    expect(resolveEngagementCode(w.state, { clientName: "Meridian Foods" })).toBe(CODE);
    expect(resolveEngagementCode(w.state, { clientName: "Nobody" })).toBeNull();
  });

  it("ownedNormsFor collects every norm the engagement is currently found under", () => {
    const w = world();
    w.state.vynora_engagement_index = JSON.stringify({
      meridianfoods: CODE, meridianfoodsnew: CODE, nissanmotorscorporation: OTHER,
    });
    w.state["vynora_engagement_" + CODE] = JSON.stringify({ code: CODE, client: "Meridian Foods Test" });
    const norms = ownedNormsFor(w.state, CODE, ["Meridian Foods Legacy"]);
    expect([...norms].sort()).toEqual(
      ["meridianfoods", "meridianfoodslegacy", "meridianfoodsnew", "meridianfoodstest"]
    );
    expect(norms.has("nissanmotorscorporation")).toBe(false);
  });
});
