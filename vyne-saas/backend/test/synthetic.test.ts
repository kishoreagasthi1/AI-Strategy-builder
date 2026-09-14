/**
 * Synthetic engagement generator — integration test with a fake adapter.
 * Verifies: consultant-only access, workspace keys written in the shapes
 * Synthesis reads (index merged, engagement with flat interviews + refresh
 * tags, briefing), tracker rows created as completed synthetics.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";
import type { ProviderAdapter } from "../src/llm/types.js";
import type { FastifyInstance } from "fastify";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:change-me-via-ops@localhost:5432/vyne";

class FakeVerifier implements TokenVerifier {
  constructor(private map: Record<string, VerifiedIdentity>) {}
  async verify(t: string): Promise<VerifiedIdentity> {
    const id = this.map[t];
    if (!id) throw new Error("bad");
    return id;
  }
}

const fakeAdapter: ProviderAdapter = {
  name: "gemini-aistudio", model: "fake", freeTier: true,
  isConfigured: () => true,
  async generate() {
    return {
      text: JSON.stringify({
        scores: { D1: 2.1, D2: 2.4, D3: 3.1, D4: 2.0, D5: 2.5, D6: 1.4, D7: 2.6 },
        findings: [
          { dimension: "D1", text: "Three data warehouses operate without a single source of truth." },
          { dimension: "D6", text: "No function currently owns AI governance." },
        ],
        summary: "Candid view of fragmented data landscape.",
      }),
      model: "fake",
      usage: { tokensIn: 100, tokensOut: 200, costEstUsd: 0 },
    };
  },
};

describe.skipIf(!ENABLED)("Synthetic engagement generator", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Synth Firm') RETURNING id`);
    tenant = t.rows[0].id;
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-synth', 's@f.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    // Owner role: this suite tests generation mechanics; client-assignment
    // scoping (Phase 5) is covered in clients.test.ts.
    await admin.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`,
      [u.rows[0].id, tenant]);
    const iu = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-synth-iv', 'i@f.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'interviewee')`,
      [iu.rows[0].id, tenant]);

    initPool(APP_URL);
    app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false,
      },
      verifier: new FakeVerifier({
        "tok-c": { uid: "uid-synth", email: "s@f.com", idpTenantId: undefined },
        "tok-i": { uid: "uid-synth-iv", email: "i@f.com", idpTenantId: undefined },
      }),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
  });

  afterAll(async () => {
    await app?.close();
    await closePool();
    if (admin) {
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
      await admin.query(`DELETE FROM users WHERE identity_platform_uid LIKE 'uid-synth%'`);
      await admin.end();
    }
  });

  it("generates a full engagement in the exact shapes Synthesis reads", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/synthetic/engagement",
      headers: { authorization: "Bearer tok-c" },
      payload: { clientName: "TestCo Industrial", industry: "Manufacturing", includeRefresh: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().interviews).toBe(10); // 5 initial + 5 refresh
    expect(r.json().rounds).toBe(2);
    const code = r.json().code;

    const ws = await app.inject({
      method: "GET", url: "/api/module-state/workspace",
      headers: { authorization: "Bearer tok-c" },
    });
    const state = ws.json().state;

    const idx = JSON.parse(state["vynora_engagement_index"]);
    expect(idx["testcoindustrial"]).toBe(code);

    const eng = JSON.parse(state["vynora_engagement_" + code]);
    expect(eng.interviews).toHaveLength(10);
    expect(eng.rounds).toHaveLength(1); // Synthesis's loader creates round 2 from tags
    const refresh = eng.interviews.filter((i: { isRefresh?: boolean }) => i.isRefresh);
    expect(refresh).toHaveLength(5);
    expect(refresh[0].refreshRound).toBe(2);
    expect(refresh[0].coverageByDim.D6).toBe(1.0);
    expect(eng.interviews[0].scores.D6).toBe(1.4);
    expect(eng.interviews[0].findings.length).toBeGreaterThan(0);

    const briefing = JSON.parse(state["vynora_briefing_testcoindustrial"]);
    expect(briefing.hypotheses).toHaveLength(4);

    const tracker = await app.inject({
      method: "GET", url: "/api/interviews", headers: { authorization: "Bearer tok-c" },
    });
    const synthRows = tracker.json().interviews.filter(
      (i: { interviewee_name: string }) => i.interviewee_name.includes("[Synthetic]"));
    expect(synthRows).toHaveLength(5);
    expect(synthRows.every((i: { status: string }) => i.status === "completed")).toBe(true);
  });

  it("uses the client's Pre-Engagement roles + hypotheses and preserves the real briefing", async () => {
    const H = { authorization: "Bearer tok-c" };
    await app.inject({ method: "PUT", url: "/api/module-state/workspace", headers: H, payload: { sets: {
      "vynora_engagement_index": JSON.stringify({ roleco: "ROLE-REAL" }),
      "vynora_engagement_ROLE-REAL": JSON.stringify({ client: "RoleCo", code: "ROLE-REAL", industry: "Healthcare", rounds: [{ roundId: "r1" }], interviews: [{ role: "CMO", name: "Real Person" }] }),
      "vynora_briefing_roleco": JSON.stringify({
        client: "RoleCo", industry: "Healthcare",
        roleCatalog: [
          { value: "cmo", display: "Chief Medical Officer", priorityDims: ["D4", "D6"] },
          { value: "cio", display: "Chief Information Officer", priorityDims: ["D1", "D2"] },
        ],
        hypotheses: [{ index: 0, text: "Clinical data silos block AI", status: "open" }],
      }),
    }, deletes: [] } });

    const r = await app.inject({ method: "POST", url: "/api/synthetic/engagement", headers: H,
      payload: { clientName: "RoleCo", includeRefresh: false } });
    expect(r.statusCode).toBe(200);
    expect(r.json().interviews).toBe(2); // one per configured role
    expect(r.json().code).toBe("ROLE-REAL"); // reuses the REAL engagement

    const ws = await app.inject({ method: "GET", url: "/api/module-state/workspace", headers: H });
    const st = ws.json().state;
    const briefing = JSON.parse(st["vynora_briefing_roleco"]);
    expect(briefing.hypotheses[0].text).toContain("Clinical data silos"); // untouched
    const eng = JSON.parse(st["vynora_engagement_ROLE-REAL"]);
    const roles = eng.interviews.map((i: { role: string }) => i.role);
    expect(roles).toContain("CMO"); // real interview kept
    expect(roles).toContain("Chief Medical Officer"); // synthetic from roleCatalog
    expect(roles).toContain("Chief Information Officer");
    expect(JSON.parse(st["vynora_engagement_index"]).roleco).toBe("ROLE-REAL");
  });

  it("interviewees cannot generate synthetic data", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/synthetic/engagement",
      headers: { authorization: "Bearer tok-i" },
      payload: { clientName: "Nope Co" },
    });
    expect(r.statusCode).toBe(403);
  });
});
