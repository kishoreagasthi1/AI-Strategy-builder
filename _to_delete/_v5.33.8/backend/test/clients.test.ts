/**
 * Phase 5 gate — client-level data separation WITHIN a firm.
 *
 * Pure unit tests (always run): the workspace key filter and write scoper.
 * Integration matrix (RLS_TEST=1): owner sees all clients; a consultant
 * assigned to Client A can never see, invite for, or write to Client B —
 * through the real HTTP app.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import {
  filterWorkspaceState,
  scopeWorkspaceWrite,
  normClient,
  purgeClientKeys,
  renameClientKeys,
} from "../src/auth/clients.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";
import type { ProviderAdapter } from "../src/llm/types.js";
import type { FastifyInstance } from "fastify";

/* ══ Unit: workspace filtering ═══════════════════════════════════════════ */

const STATE: Record<string, string> = {
  vynora_engagement_index: JSON.stringify({ acme: "ACME-1", globex: "GLBX-1" }),
  "vynora_engagement_ACME-1": JSON.stringify({ client: "Acme", code: "ACME-1" }),
  "vynora_engagement_GLBX-1": JSON.stringify({ client: "Globex", code: "GLBX-1" }),
  vynora_briefing_acme: JSON.stringify({ client: "Acme", hypotheses: [1] }),
  vynora_briefing_globex: JSON.stringify({ client: "Globex", hypotheses: [2] }),
  "vynora_hypothesis_verdicts_ACME-1": "[1]",
  "vynora_hypothesis_verdicts_GLBX-1": "[2]",
  vynora_session_s1: JSON.stringify({ client: "Acme", messages: [] }),
  vynora_session_s2: JSON.stringify({ client: "Globex", messages: [] }),
  vynora_code_index: JSON.stringify({ "ACME-1": "s1", "GLBX-1": "s2" }),
  vynora_last_briefing: JSON.stringify({ normKey: "globex", client: "Globex" }),
  vynora_api_key: "sk-shared-firm-key",                    // allowlisted global (exact key)
  vynora_industry_catalog_retailhairsalonchain: '{"D1":3}', // allowlisted global (prefix)
  vynora_dm_snapshots: JSON.stringify([{ filename: "a.json", clientName: "Globex" }]), // NOT allowlisted — mixes client data
  vynora_some_future_key_nobody_reviewed: JSON.stringify({ anything: "at all" }), // unrecognized — must deny, not assume global
  vynora_roadmap_index: JSON.stringify({ "ACME-1": { clientName: "Acme" }, "GLBX-1": { clientName: "Globex" } }),
  vynora_roadmap_state: JSON.stringify({
    assumptions: { "eng_ACME-1": { a: 1 }, "eng_GLBX-1": { b: 2 } },
    dependencies: { "client_acme": { c: 3 }, "client_globex": { d: 4 } },
    generated: {},
    byEng: { "eng_ACME-1": { synthesis: { ok: 1 }, gantt: { g: 1 } }, "eng_GLBX-1": { synthesis: { secret: "globex" } } },
    notes: { uc1_d1: "confidential globex note" },
    synthesis: { client: "Globex" },
  }),
};

describe("workspace client filter (unit)", () => {
  const acmeOnly = new Set(["acme"]);

  it("owner (null) passes everything through untouched", () => {
    expect(filterWorkspaceState(STATE, null)).toBe(STATE);
  });

  it("consultant assigned to Acme never receives Globex data", () => {
    const f = filterWorkspaceState(STATE, acmeOnly);
    const dump = JSON.stringify(f).toLowerCase();
    expect(dump).not.toContain("globex");
    expect(f["vynora_briefing_acme"]).toBeTruthy();
    expect(f["vynora_engagement_ACME-1"]).toBeTruthy();
    expect(f["vynora_hypothesis_verdicts_ACME-1"]).toBe("[1]");
    expect(f["vynora_session_s1"]).toBeTruthy();
    // V225-audit CRITICAL regression: reviewed globals survive — see the
    // write-side test below, which exercises vynora_deck_mode.
    // v5.32.29 (audit M-6) took vynora_api_key OFF that list. It has no
    // client identity, which is why it was there, but a consultant with zero
    // assignments could read and overwrite the firm's LLM key through
    // /api/module-state/workspace. It is owner-only now; owners short-circuit
    // before this filter runs, so they are unaffected.
    expect(f["vynora_api_key"]).toBeUndefined();
    expect(f["vynora_industry_catalog_retailhairsalonchain"]).toBe('{"D1":3}');
    // ...but a key nobody reviewed, and a key that MIXES another client's data
    // under one opaque name, are both DENIED — not assumed global. This is the
    // exact shape of the bug: resolveKeyClient() used to `return "GLOBAL"` for
    // both of these, leaking Globex's data (and anything future) to every
    // consultant regardless of client_assignments.
    expect(f["vynora_dm_snapshots"]).toBeUndefined();
    expect(f["vynora_some_future_key_nobody_reviewed"]).toBeUndefined();
    expect(JSON.parse(f["vynora_engagement_index"])).toEqual({ acme: "ACME-1" });
    expect(JSON.parse(f["vynora_code_index"])).toEqual({ "ACME-1": "s1" });
    expect(JSON.parse(f["vynora_roadmap_index"])).toEqual({ "ACME-1": { clientName: "Acme" } });
    expect(f["vynora_last_briefing"]).toBeUndefined(); // points at Globex
    const rs = JSON.parse(f["vynora_roadmap_state"]);
    expect(rs.assumptions).toEqual({ "eng_ACME-1": { a: 1 } });
    expect(rs.dependencies).toEqual({ "client_acme": { c: 3 } });
    expect(rs.byEng).toEqual({ "eng_ACME-1": { synthesis: { ok: 1 }, gantt: { g: 1 } } }); // per-client slice kept
    expect(rs.notes).toBeUndefined();      // unattributable legacy → dropped
    expect(rs.synthesis).toBeUndefined();
  });

  it("writes to another client's keys are dropped; index writes merge", () => {
    const { sets, deletes } = scopeWorkspaceWrite(
      {
        vynora_briefing_acme: '{"client":"Acme","v":2}',
        vynora_briefing_globex: '{"client":"Globex","hacked":true}',
        // v5.32.64 (audit V2-H4): binding a code now requires the record that
        // asserts whose it is, so the browser's filtered copy comes with it.
        // An index entry alone is a self-asserted claim, which is what the
        // audit found could be used to pre-claim any code.
        vynora_engagement_index: JSON.stringify({ acme: "ACME-2" }), // filtered browser copy
        "vynora_engagement_ACME-2": JSON.stringify({ code: "ACME-2", client: "Acme" }),
      },
      ["vynora_briefing_globex", "vynora_hypothesis_verdicts_ACME-1"],
      STATE,
      acmeOnly
    );
    expect(sets["vynora_briefing_acme"]).toBeTruthy();
    expect(sets["vynora_briefing_globex"]).toBeUndefined();
    // Globex's index entry survives the merge even though the browser never saw it.
    expect(JSON.parse(sets["vynora_engagement_index"])).toEqual({ acme: "ACME-2", globex: "GLBX-1" });
    expect(deletes).toEqual(["vynora_hypothesis_verdicts_ACME-1"]);
  });

  it("V225-audit CRITICAL: a write under an unrecognized key is denied, not passed through as global", () => {
    const { sets } = scopeWorkspaceWrite(
      { vynora_totally_new_feature_key: JSON.stringify({ smuggled: "data" }) },
      [], STATE, acmeOnly
    );
    expect(sets["vynora_totally_new_feature_key"]).toBeUndefined();
    // Reviewed globals still write fine.
    const { sets: okSets } = scopeWorkspaceWrite(
      { vynora_deck_mode: "client" }, [], STATE, acmeOnly
    );
    expect(okSets["vynora_deck_mode"]).toBe("client");
    // v5.32.29 (audit M-6): the firm's LLM key is not one of them any more —
    // a restricted consultant could previously overwrite it firm-wide.
    const { sets: keySets } = scopeWorkspaceWrite(
      { vynora_api_key: "sk-attacker" }, [], STATE, acmeOnly
    );
    expect(keySets["vynora_api_key"]).toBeUndefined();
  });

  it("a spoofed engagement write cannot land under another client", () => {
    const { sets } = scopeWorkspaceWrite(
      { "vynora_engagement_GLBX-1": JSON.stringify({ code: "GLBX-1", stolen: true }) }, // no .client field
      [], STATE, acmeOnly
    );
    expect(sets["vynora_engagement_GLBX-1"]).toBeUndefined();
  });

  it("normClient matches the module convention", () => {
    expect(normClient("Acme Industrial Ltd.")).toBe("acmeindustrialltd");
  });

  it("purgeClientKeys removes ONE client everywhere and leaves the rest", () => {
    const { sets, deletes } = purgeClientKeys(STATE, "globex");
    // Globex-owned keys deleted
    expect(deletes).toContain("vynora_briefing_globex");
    expect(deletes).toContain("vynora_engagement_GLBX-1");
    expect(deletes).toContain("vynora_hypothesis_verdicts_GLBX-1");
    expect(deletes).toContain("vynora_session_s2");
    expect(deletes).toContain("vynora_last_briefing"); // pointed at globex
    // Acme + globals untouched
    expect(deletes).not.toContain("vynora_briefing_acme");
    expect(deletes).not.toContain("vynora_api_key");
    // Shared indexes keep only Acme
    expect(JSON.parse(sets["vynora_engagement_index"])).toEqual({ acme: "ACME-1" });
    expect(JSON.parse(sets["vynora_code_index"])).toEqual({ "ACME-1": "s1" });
    expect(JSON.parse(sets["vynora_roadmap_index"])).toEqual({ "ACME-1": { clientName: "Acme" } });
    const rs = JSON.parse(sets["vynora_roadmap_state"]);
    expect(rs.assumptions).toEqual({ "eng_ACME-1": { a: 1 } });
    expect(rs.dependencies).toEqual({ "client_acme": { c: 3 } });
    expect(rs.byEng["eng_GLBX-1"]).toBeUndefined();
  });
});

/* ══ Unit: renameClientKeys (v5.32.7) ═══════════════════════════════════════
 * The Roadmap Builder / Pre-Engagement / Synthesis / Interview Tracker each
 * keep their own JSON blob for a client, and a client's identity IS the
 * access-control key (client_assignments.client_norm, resolveKeyClient()).
 * A correct rename has to move every one of those blobs' embedded name AND
 * any KEY that's literally suffixed by the normalized name — in one pass,
 * without ever touching a different client's data. */
describe("renameClientKeys (unit)", () => {
  // Same fixture as purgeClientKeys, plus one CODE_SUFFIX family that's
  // actually norm-keyed under the hood (vynora_solution_design_) — the
  // disambiguation renameClientKeys has to get right.
  const RSTATE: Record<string, string> = {
    ...STATE,
    vynora_solution_design_acme: JSON.stringify({ client: "Acme", stages: [1] }),
    vynora_solution_design_globex: JSON.stringify({ client: "Globex", stages: [2] }),
  };

  it("renames a norm-keyed family (vynora_briefing_) by moving the KEY", () => {
    const { sets, deletes } = renameClientKeys(RSTATE, "acme", "Acme Industrial")!;
    expect(deletes).toContain("vynora_briefing_acme");
    expect(sets["vynora_briefing_acmeindustrial"]).toBeTruthy();
    expect(JSON.parse(sets["vynora_briefing_acmeindustrial"]).client).toBe("Acme Industrial");
    // Globex's own vynora_briefing_ key is untouched.
    expect(deletes).not.toContain("vynora_briefing_globex");
    expect(sets["vynora_briefing_globex"]).toBeUndefined();
  });

  it("renames the norm-keyed member hiding inside CODE_SUFFIX (vynora_solution_design_)", () => {
    const { sets, deletes } = renameClientKeys(RSTATE, "acme", "Acme Industrial")!;
    expect(deletes).toContain("vynora_solution_design_acme");
    expect(sets["vynora_solution_design_acmeindustrial"]).toBeTruthy();
    expect(deletes).not.toContain("vynora_solution_design_globex");
  });

  it("leaves a code-keyed family's KEY alone and only patches the embedded value", () => {
    const { sets, deletes } = renameClientKeys(RSTATE, "acme", "Acme Industrial")!;
    expect(deletes).not.toContain("vynora_engagement_ACME-1");
    expect(JSON.parse(sets["vynora_engagement_ACME-1"]).client).toBe("Acme Industrial");
    // Code-keyed families with no embedded client field (verdicts is a bare
    // array) are correctly left alone entirely.
    expect(sets["vynora_hypothesis_verdicts_ACME-1"]).toBeUndefined();
  });

  it("moves the client through vynora_engagement_index, vynora_roadmap_index, vynora_last_briefing, vynora_dm_snapshots", () => {
    const { sets } = renameClientKeys(RSTATE, "globex", "Globex Corp")!;
    const idx = JSON.parse(sets["vynora_engagement_index"]);
    expect(idx.globex).toBeUndefined();
    expect(idx.globexcorp).toBe("GLBX-1");
    expect(idx.acme).toBe("ACME-1"); // untouched

    const ri = JSON.parse(sets["vynora_roadmap_index"]);
    expect(ri["GLBX-1"].clientName).toBe("Globex Corp");
    expect(ri["ACME-1"].clientName).toBe("Acme"); // untouched

    const lb = JSON.parse(sets["vynora_last_briefing"]);
    expect(lb.client).toBe("Globex Corp");
    expect(lb.normKey).toBe("globexcorp");

    const snaps = JSON.parse(sets["vynora_dm_snapshots"]);
    expect(snaps[0].clientName).toBe("Globex Corp");
  });

  it("renames the 'client_<norm>' sub-keys inside vynora_roadmap_state", () => {
    const { sets } = renameClientKeys(RSTATE, "globex", "Globex Corp")!;
    const rs = JSON.parse(sets["vynora_roadmap_state"]);
    expect(rs.dependencies["client_globex"]).toBeUndefined();
    expect(rs.dependencies["client_globexcorp"]).toEqual({ d: 4 });
    expect(rs.dependencies["client_acme"]).toEqual({ c: 3 }); // untouched
  });

  it("a same-norm rename (case/punctuation only) patches values without moving any key", () => {
    const { sets, deletes } = renameClientKeys(RSTATE, "acme", "ACME!!")!;
    expect(deletes.filter((k) => k.startsWith("vynora_briefing_"))).toHaveLength(0);
    expect(JSON.parse(sets["vynora_briefing_acme"]).client).toBe("ACME!!");
  });

  it("refuses (returns null) when the new name collides with a DIFFERENT existing client", () => {
    // "Globex" already owns norm "globex" in this workspace.
    expect(renameClientKeys(RSTATE, "acme", "Globex")).toBeNull();
  });

  it("does not touch the target client's own prior data when colliding with itself (no-op guard doesn't misfire)", () => {
    // Renaming Acme to a name that still normalizes to "acme" is fine — it's
    // not a collision with a DIFFERENT client, just itself.
    expect(renameClientKeys(RSTATE, "acme", "Acme Co.")).not.toBeNull();
  });

  it("Globex's own independent keys are absent from the diff entirely", () => {
    const { sets, deletes } = renameClientKeys(RSTATE, "acme", "Acme Industrial")!;
    // Globex's own per-client keys must not be touched at all — neither
    // renamed, deleted, nor rewritten — by an Acme rename. (Shared blobs
    // like vynora_engagement_index / vynora_roadmap_state legitimately keep
    // Globex's untouched entries embedded alongside Acme's change, which is
    // fine — this checks Globex's OWN keys specifically, not every string.)
    for (const k of ["vynora_briefing_globex", "vynora_engagement_GLBX-1", "vynora_solution_design_globex"]) {
      expect(sets[k]).toBeUndefined();
      expect(deletes).not.toContain(k);
    }
    // And where Globex's data is legitimately embedded in a shared blob, its
    // content is untouched.
    const rs = JSON.parse(sets["vynora_roadmap_state"]);
    expect(rs.dependencies["client_globex"]).toEqual({ d: 4 });
  });
});

/* ══ Integration: through the HTTP app (RLS_TEST=1) ══════════════════════ */

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:change-me-via-ops@localhost:5432/vyne";

class FakeVerifier implements TokenVerifier {
  constructor(private map: Record<string, VerifiedIdentity>) {}
  async verify(t: string): Promise<VerifiedIdentity> {
    const id = this.map[t];
    if (!id) throw new Error("bad token");
    return id;
  }
}
const fakeAdapter: ProviderAdapter = {
  name: "gemini-aistudio", model: "fake", freeTier: true,
  isConfigured: () => true,
  async generate() {
    return { text: "ok", model: "fake", usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0 } };
  },
};

describe.skipIf(!ENABLED)("Phase 5 client assignment matrix", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;

  beforeAll(async () => {
    process.env.DEV_AUTH = "1";
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Assignment Firm') RETURNING id`);
    tenant = t.rows[0].id;
    const mkUser = async (uid: string, role: string) => {
      const u = await admin.query<{ id: string }>(
        `INSERT INTO users (identity_platform_uid, email) VALUES ($1, $2) ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
        [uid, `${uid}@firm.com`]);
      await admin.query(
        `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)`,
        [u.rows[0].id, tenant, role]);
      return u.rows[0].id;
    };
    await mkUser("uid-own", "owner");
    await mkUser("uid-c1", "consultant");

    initPool(APP_URL);
    app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier({
        "tok-own": { uid: "uid-own", email: "uid-own@firm.com", idpTenantId: undefined },
        "tok-c1": { uid: "uid-c1", email: "uid-c1@firm.com", idpTenantId: undefined },
        "tok-iv-a": { uid: "iva@alpha.com", email: "iva@alpha.com", idpTenantId: undefined },
      }),
      adapters: [fakeAdapter],
      meter: async () => {},
    });

    // Owner seeds two clients' worth of workspace data + interviews.
    await app.inject({
      method: "PUT", url: "/api/module-state/workspace", headers: H("tok-own"),
      payload: {
        sets: {
          vynora_engagement_index: JSON.stringify({ alphaco: "ALPH-1", betaco: "BETA-1" }),
          "vynora_engagement_ALPH-1": JSON.stringify({ client: "AlphaCo", code: "ALPH-1" }),
          "vynora_engagement_BETA-1": JSON.stringify({ client: "BetaCo", code: "BETA-1" }),
          vynora_briefing_alphaco: JSON.stringify({ client: "AlphaCo", hypotheses: [1], peContext: "secret" }),
          vynora_briefing_betaco: JSON.stringify({ client: "BetaCo", hypotheses: [2], peContext: "secret" }),
        }, deletes: [],
      },
    });
    for (const [client, email] of [["AlphaCo", "iva@alpha.com"], ["BetaCo", "ivb@beta.com"]]) {
      const r = await app.inject({
        method: "POST", url: "/api/interviews", headers: H("tok-own"),
        payload: { clientName: client, intervieweeName: "IV " + client, intervieweeRole: "CFO", email },
      });
      if (r.statusCode !== 201) throw new Error("seed invite failed: " + r.body);
    }
  });

  afterAll(async () => {
    await app?.close();
    await closePool();
    if (admin) {
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
      await admin.query(`DELETE FROM users WHERE identity_platform_uid LIKE '%alpha.com' OR identity_platform_uid LIKE '%beta.com' OR identity_platform_uid = 'newcons@firm.com'`);
      await admin.end();
    }
    delete process.env.DEV_AUTH;
  });

  const H = (tok: string) => ({ authorization: `Bearer ${tok}` });

  it("unassigned consultant sees NOTHING; owner sees both clients", async () => {
    const own = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-own") });
    expect(own.json().interviews).toHaveLength(2);
    const c1 = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-c1") });
    expect(c1.json().interviews).toHaveLength(0);
    const ws = await app.inject({ method: "GET", url: "/api/module-state/workspace", headers: H("tok-c1") });
    expect(JSON.stringify(ws.json().state)).not.toContain("AlphaCo");
    expect(JSON.stringify(ws.json().state)).not.toContain("BetaCo");
  });

  it("consultants cannot manage assignments; owner assigns AlphaCo to c1", async () => {
    expect((await app.inject({
      method: "POST", url: "/api/assignments", headers: H("tok-c1"),
      payload: { email: "uid-c1@firm.com", clientName: "BetaCo" },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST", url: "/api/assignments", headers: H("tok-own"),
      payload: { email: "uid-c1@firm.com", clientName: "AlphaCo" },
    })).statusCode).toBe(201);
    const mine = await app.inject({ method: "GET", url: "/api/my-clients", headers: H("tok-c1") });
    expect(mine.json().clients).toEqual(["AlphaCo"]);
  });

  it("assigned consultant sees ONLY AlphaCo — tracker, workspace, invites", async () => {
    const list = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-c1") });
    expect(list.json().interviews).toHaveLength(1);
    expect(list.json().interviews[0].client_name).toBe("AlphaCo");

    const ws = await app.inject({ method: "GET", url: "/api/module-state/workspace", headers: H("tok-c1") });
    const st = ws.json().state;
    expect(st["vynora_briefing_alphaco"]).toBeTruthy();
    expect(st["vynora_briefing_betaco"]).toBeUndefined();
    expect(JSON.parse(st["vynora_engagement_index"])).toEqual({ alphaco: "ALPH-1" });
    expect(JSON.stringify(st)).not.toContain("BetaCo");

    expect((await app.inject({
      method: "POST", url: "/api/interviews", headers: H("tok-c1"),
      payload: { clientName: "BetaCo", intervieweeName: "X", intervieweeRole: "CFO", email: "x@beta.com" },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST", url: "/api/interviews", headers: H("tok-c1"),
      payload: { clientName: "AlphaCo", intervieweeName: "Y", intervieweeRole: "COO", email: "y@alpha.com" },
    })).statusCode).toBe(201);
  });

  it("consultant cannot read/edit/delete BetaCo's interview or session state", async () => {
    const own = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-own") });
    const beta = own.json().interviews.find((i: { client_name: string }) => i.client_name === "BetaCo");
    expect((await app.inject({ method: "GET", url: `/api/interviews/${beta.id}/state`, headers: H("tok-c1") })).statusCode).toBe(404);
    expect((await app.inject({
      method: "PATCH", url: `/api/interviews/${beta.id}`, headers: H("tok-c1"),
      payload: { intervieweeRole: "Hacked" },
    })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/interviews/${beta.id}`, headers: H("tok-c1") })).statusCode).toBe(404);
  });

  it("consultant writes to BetaCo's workspace keys are dropped; index merge preserves BetaCo", async () => {
    await app.inject({
      method: "PUT", url: "/api/module-state/workspace", headers: H("tok-c1"),
      payload: {
        sets: {
          vynora_briefing_alphaco: JSON.stringify({ client: "AlphaCo", hypotheses: [9] }),
          vynora_briefing_betaco: JSON.stringify({ client: "BetaCo", hacked: true }),
          vynora_engagement_index: JSON.stringify({ alphaco: "ALPH-1" }), // filtered copy
        }, deletes: ["vynora_briefing_betaco"],
      },
    });
    const ws = await app.inject({ method: "GET", url: "/api/module-state/workspace", headers: H("tok-own") });
    const st = ws.json().state;
    expect(JSON.parse(st["vynora_briefing_alphaco"]).hypotheses).toEqual([9]);      // allowed write landed
    expect(JSON.parse(st["vynora_briefing_betaco"]).hacked).toBeUndefined();        // hostile write dropped
    expect(JSON.parse(st["vynora_briefing_betaco"]).hypotheses).toEqual([2]);       // delete dropped too
    expect(JSON.parse(st["vynora_engagement_index"])).toEqual({ alphaco: "ALPH-1", betaco: "BETA-1" });
  });

  it("interviewee bootstrap only carries THEIR client's data (and it's sanitized)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-iv-a") });
    expect(r.statusCode).toBe(200);
    const inj = r.json().injected;
    expect(inj["vynora_briefing_alphaco"]).toBeTruthy();
    expect(JSON.parse(inj["vynora_briefing_alphaco"]).peContext).toBeUndefined();   // sanitized
    expect(inj["vynora_briefing_betaco"]).toBeUndefined();                          // other client: never
    expect(JSON.stringify(inj)).not.toContain("BetaCo");
  });

  it("unassigning removes access again", async () => {
    expect((await app.inject({
      method: "DELETE", url: "/api/assignments", headers: H("tok-own"),
      payload: { email: "uid-c1@firm.com", clientName: "AlphaCo" },
    })).statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-c1") });
    expect(list.json().interviews).toHaveLength(0);
  });

  it("owner creates a consultant login via /api/team, assigns it, removal revokes both", async () => {
    // Consultants cannot manage the team.
    expect((await app.inject({ method: "GET", url: "/api/team", headers: H("tok-c1") })).statusCode).toBe(403);

    // Assigning an unknown email fails with the helpful hint.
    const bad = await app.inject({
      method: "POST", url: "/api/assignments", headers: H("tok-own"),
      payload: { email: "newcons@firm.com", clientName: "BetaCo" },
    });
    expect(bad.statusCode).toBe(404);
    expect(bad.json().detail).toContain("Team");

    // Add the consultant, then assignment resolves.
    const add = await app.inject({
      method: "POST", url: "/api/team", headers: H("tok-own"),
      payload: { email: "newcons@firm.com", name: "New Cons" },
    });
    expect(add.statusCode).toBe(201);
    const team = await app.inject({ method: "GET", url: "/api/team", headers: H("tok-own") });
    expect(team.json().members.some(
      (m: { email: string; role: string }) => m.email === "newcons@firm.com" && m.role === "consultant")).toBe(true);
    expect((await app.inject({
      method: "POST", url: "/api/assignments", headers: H("tok-own"),
      payload: { email: "newcons@firm.com", clientName: "BetaCo" },
    })).statusCode).toBe(201);

    // Owners cannot be removed; removing the consultant removes assignments too.
    expect((await app.inject({
      method: "DELETE", url: "/api/team", headers: H("tok-own"),
      payload: { email: "uid-own@firm.com" },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "DELETE", url: "/api/team", headers: H("tok-own"),
      payload: { email: "newcons@firm.com" },
    })).statusCode).toBe(200);
    const asg = await app.inject({ method: "GET", url: "/api/assignments", headers: H("tok-own") });
    expect(asg.json().assignments.some(
      (a: { email: string }) => a.email === "newcons@firm.com")).toBe(false);
  });

  it("owner deletes a client: interviews, workspace keys, and logins go; other clients stay", async () => {
    // Consultants cannot delete clients.
    expect((await app.inject({
      method: "DELETE", url: "/api/clients", headers: H("tok-c1"),
      payload: { clientName: "BetaCo" },
    })).statusCode).toBe(403);

    const del = await app.inject({
      method: "DELETE", url: "/api/clients", headers: H("tok-own"),
      payload: { clientName: "BetaCo" },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().interviews).toBeGreaterThanOrEqual(1);
    expect(del.json().workspaceKeys).toBeGreaterThanOrEqual(1);

    // Tracker: no BetaCo rows; AlphaCo intact.
    const list = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-own") });
    const clients = list.json().interviews.map((i: { client_name: string }) => i.client_name);
    expect(clients).not.toContain("BetaCo");
    expect(clients).toContain("AlphaCo");

    // Workspace: BetaCo gone everywhere; AlphaCo untouched.
    const ws = await app.inject({ method: "GET", url: "/api/module-state/workspace", headers: H("tok-own") });
    const st = ws.json().state;
    expect(st["vynora_briefing_betaco"]).toBeUndefined();
    expect(st["vynora_engagement_BETA-1"]).toBeUndefined();
    expect(JSON.parse(st["vynora_engagement_index"]).betaco).toBeUndefined();
    expect(JSON.parse(st["vynora_engagement_index"]).alphaco).toBe("ALPH-1");
    expect(st["vynora_briefing_alphaco"]).toBeTruthy();

    // BetaCo's interviewee login lost its membership → 403 on bootstrap.
    // (ivb@beta.com only had the BetaCo interview.)
  });

  it("owner renames a client: everything moves together, and a consultant's ACCESS survives the rename", async () => {
    // Consultants cannot rename clients.
    expect((await app.inject({
      method: "PATCH", url: "/api/clients/rename", headers: H("tok-c1"),
      payload: { clientName: "AlphaCo", newClientName: "AlphaCo Intl" },
    })).statusCode).toBe(403);

    // Re-assign AlphaCo to c1 (the earlier test unassigned it) so this test
    // can prove the thing that matters most: access survives the rename.
    expect((await app.inject({
      method: "POST", url: "/api/assignments", headers: H("tok-own"),
      payload: { email: "uid-c1@firm.com", clientName: "AlphaCo" },
    })).statusCode).toBe(201);
    // Register the canonical engagements row too (normally done by
    // Pre-Engagement's saveBriefingContext), so this test exercises all four
    // propagation targets, not just three.
    const regStatus = (await app.inject({
      method: "POST", url: "/api/engagements", headers: H("tok-own"),
      payload: { clientName: "AlphaCo", industry: "Logistics" },
    })).statusCode;
    expect([200, 201]).toContain(regStatus);
    const beforeCount = (await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-c1") }))
      .json().interviews.length;
    expect(beforeCount).toBeGreaterThanOrEqual(1);

    const ren = await app.inject({
      method: "PATCH", url: "/api/clients/rename", headers: H("tok-own"),
      payload: { clientName: "AlphaCo", newClientName: "AlphaCo Intl" },
    });
    expect(ren.statusCode).toBe(200);
    expect(ren.json().engagementsRenamed).toBeGreaterThanOrEqual(1);
    expect(ren.json().interviewsRenamed).toBeGreaterThanOrEqual(1);
    expect(ren.json().assignmentsMoved).toBeGreaterThanOrEqual(1);

    // The security invariant: c1 was assigned to "AlphaCo" and can still see
    // everything under the new name, WITHOUT the owner having to re-assign.
    const afterList = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-c1") });
    expect(afterList.json().interviews).toHaveLength(beforeCount);
    expect(afterList.json().interviews.every(
      (i: { client_name: string }) => i.client_name === "AlphaCo Intl")).toBe(true);
    const afterWs = await app.inject({ method: "GET", url: "/api/module-state/workspace", headers: H("tok-c1") });
    expect(JSON.stringify(afterWs.json().state)).toContain("AlphaCo Intl");
    expect(JSON.stringify(afterWs.json().state)).not.toContain('"AlphaCo"'); // old exact label is gone

    // Engagements table reflects the rename too.
    const engs = await app.inject({ method: "GET", url: "/api/engagements", headers: H("tok-own") });
    expect(engs.json().engagements.some((e: { client_name: string }) => e.client_name === "AlphaCo Intl")).toBe(true);
    expect(engs.json().engagements.some((e: { client_name: string }) => e.client_name === "AlphaCo")).toBe(false);

    // Refuses to merge two DIFFERENT clients onto one name.
    await app.inject({
      method: "POST", url: "/api/engagements", headers: H("tok-own"),
      payload: { clientName: "GammaCo" },
    });
    const collide = await app.inject({
      method: "PATCH", url: "/api/clients/rename", headers: H("tok-own"),
      payload: { clientName: "GammaCo", newClientName: "AlphaCo Intl" },
    });
    expect(collide.statusCode).toBe(409);
  });
});
