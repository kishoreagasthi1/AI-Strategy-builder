/**
 * Solution Design Studio (v5.30) — AI-generated, editable, exportable
 * build/buy/partner doc per Roadmap use case.
 *
 * Integration test with a fake adapter (same pattern as synthetic.test.ts):
 * generate-and-save, read-back, hand-edit via PUT, delete, client scoping
 * (consultant blocked from an unassigned client), and interviewees blocked
 * outright.
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
    if (!id) throw new Error("bad token");
    return id;
  }
}

function fakeDoc(overrides: Record<string, unknown> = {}) {
  return {
    problemStatement: "Manual invoice matching consumes 40 hours/week across the AP team.",
    currentState: "Analysts manually reconcile invoices against POs in spreadsheets.",
    targetState: "AI-assisted matching auto-resolves 80% of invoices with human review only on exceptions.",
    recommendation: { approach: "buy", rationale: "Mature vendor tools exist; building in-house isn't a differentiator here." },
    dataAndIntegrationRequirements: ["ERP invoice feed", "PO system API access", "Historical exception log"],
    phasedPlan: [
      { phase: 1, name: "Vendor selection", description: "Evaluate 3 AP automation vendors.", durationWeeks: 4 },
      { phase: 2, name: "Pilot", description: "Run on one business unit.", durationWeeks: 8 },
      { phase: 3, name: "Rollout", description: "Expand to all business units.", durationWeeks: 12 },
    ],
    risksAndDependencies: [{ risk: "Data quality in legacy ERP", mitigation: "Run a data audit before pilot." }],
    successMetrics: [{ metric: "Manual review hours/week", target: "Reduce from 40 to 8" }],
    ...overrides,
  };
}

const fakeAdapter: ProviderAdapter = {
  name: "gemini-aistudio", model: "fake", freeTier: true,
  isConfigured: () => true,
  async generate() {
    return { text: JSON.stringify(fakeDoc()), model: "fake", usage: { tokensIn: 50, tokensOut: 300, costEstUsd: 0 } };
  },
};

describe.skipIf(!ENABLED)("Solution Design Studio HTTP", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;
  const verifierMap: Record<string, VerifiedIdentity> = {
    "tok-owner": { uid: "uid-sd-owner", email: "sd-owner@firm.com", idpTenantId: undefined },
    "tok-cons": { uid: "uid-sd-cons", email: "sd-cons@firm.com", idpTenantId: undefined },
    "tok-iv": { uid: "uid-sd-iv", email: "sd-iv@client.com", idpTenantId: undefined },
  };

  beforeAll(async () => {
    process.env.DEV_AUTH = "1";
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    const t = await admin.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('SD Firm') RETURNING id`);
    tenant = t.rows[0].id;

    const owner = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-sd-owner', 'sd-owner@firm.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, [owner.rows[0].id, tenant]);

    const cons = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-sd-cons', 'sd-cons@firm.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'consultant')`, [cons.rows[0].id, tenant]);
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    // Consultant is assigned only to Acme — never Beta.
    await admin.query(
      `INSERT INTO client_assignments (tenant_id, user_id, client_name, client_norm) VALUES ($1, $2, 'Acme', 'acme')`,
      [tenant, cons.rows[0].id]);
    await admin.query("COMMIT");

    const iv = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-sd-iv', 'sd-iv@client.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'interviewee')`, [iv.rows[0].id, tenant]);

    initPool(APP_URL);
    app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier(verifierMap),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await admin.end();
    await app.close();
    await closePool();
  });

  it("owner generates a doc for Acme, and it's readable back", async () => {
    const gen = await app.inject({
      method: "POST", url: "/api/solution-design/generate",
      headers: { authorization: "Bearer tok-owner" },
      payload: { clientName: "Acme", useCaseId: "uc-ap-1", useCaseName: "AP Invoice Matching", industry: "Manufacturing" },
    });
    expect(gen.statusCode).toBe(200);
    const genBody = gen.json();
    expect(genBody.entry.doc.recommendation.approach).toBe("buy");
    expect(genBody.entry.generatedAt).toBeTruthy();
    expect(genBody.entry.editedAt).toBeNull();

    const read = await app.inject({ method: "GET", url: "/api/solution-design?client=Acme", headers: { authorization: "Bearer tok-owner" } });
    expect(read.statusCode).toBe(200);
    expect(read.json().designs["uc-ap-1"].useCaseName).toBe("AP Invoice Matching");
  });

  it("consultant can generate/read for their assigned client (Acme)", async () => {
    const gen = await app.inject({
      method: "POST", url: "/api/solution-design/generate",
      headers: { authorization: "Bearer tok-cons" },
      payload: { clientName: "Acme", useCaseId: "uc-ap-2", useCaseName: "AP Duplicate Detection" },
    });
    expect(gen.statusCode).toBe(200);
  });

  it("consultant is blocked from generating for a client they aren't assigned to (Beta)", async () => {
    const gen = await app.inject({
      method: "POST", url: "/api/solution-design/generate",
      headers: { authorization: "Bearer tok-cons" },
      payload: { clientName: "Beta", useCaseId: "uc-x", useCaseName: "Something" },
    });
    expect(gen.statusCode).toBe(403);
    expect(gen.json().error).toBe("client_not_assigned");
  });

  it("consultant is blocked from reading another client's designs (Beta)", async () => {
    // Owner seeds a Beta doc first so there's something to (fail to) read.
    await app.inject({
      method: "POST", url: "/api/solution-design/generate",
      headers: { authorization: "Bearer tok-owner" },
      payload: { clientName: "Beta", useCaseId: "uc-beta-1", useCaseName: "Beta Use Case" },
    });
    const read = await app.inject({ method: "GET", url: "/api/solution-design?client=Beta", headers: { authorization: "Bearer tok-cons" } });
    expect(read.statusCode).toBe(403);
  });

  it("interviewees are blocked outright", async () => {
    const r = await app.inject({ method: "GET", url: "/api/solution-design?client=Acme", headers: { authorization: "Bearer tok-iv" } });
    expect(r.statusCode).toBe(403);
  });

  it("PUT saves a hand-edit, setting editedAt and preserving the original generatedAt/model", async () => {
    const gen = await app.inject({
      method: "POST", url: "/api/solution-design/generate",
      headers: { authorization: "Bearer tok-owner" },
      payload: { clientName: "Acme", useCaseId: "uc-edit-1", useCaseName: "Editable UC" },
    });
    const genEntry = gen.json().entry;

    const edited = fakeDoc({ problemStatement: "Hand-edited problem statement." });
    const put = await app.inject({
      method: "PUT", url: "/api/solution-design",
      headers: { authorization: "Bearer tok-owner" },
      payload: { clientName: "Acme", useCaseId: "uc-edit-1", doc: edited },
    });
    expect(put.statusCode).toBe(200);
    const putEntry = put.json().entry;
    expect(putEntry.doc.problemStatement).toBe("Hand-edited problem statement.");
    expect(putEntry.editedAt).toBeTruthy();
    expect(putEntry.generatedAt).toBe(genEntry.generatedAt);
    expect(putEntry.model).toBe(genEntry.model);
  });

  it("DELETE removes a saved doc; a second delete 404s", async () => {
    await app.inject({
      method: "POST", url: "/api/solution-design/generate",
      headers: { authorization: "Bearer tok-owner" },
      payload: { clientName: "Acme", useCaseId: "uc-del-1", useCaseName: "To delete" },
    });
    const del = await app.inject({
      method: "DELETE", url: "/api/solution-design",
      headers: { authorization: "Bearer tok-owner" },
      payload: { clientName: "Acme", useCaseId: "uc-del-1" },
    });
    expect(del.statusCode).toBe(200);

    const del2 = await app.inject({
      method: "DELETE", url: "/api/solution-design",
      headers: { authorization: "Bearer tok-owner" },
      payload: { clientName: "Acme", useCaseId: "uc-del-1" },
    });
    expect(del2.statusCode).toBe(404);

    const read = await app.inject({ method: "GET", url: "/api/solution-design?client=Acme", headers: { authorization: "Bearer tok-owner" } });
    expect(read.json().designs["uc-del-1"]).toBeUndefined();
  });

  it("rejects a malformed generate body with 400 invalid_input", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/solution-design/generate",
      headers: { authorization: "Bearer tok-owner" },
      payload: { clientName: "Acme" }, // missing useCaseId/useCaseName
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_input");
  });
});
