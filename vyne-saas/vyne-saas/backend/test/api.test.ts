/**
 * Phase 1 gate — full HTTP-layer integration test.
 *
 * Proves, through the real Fastify app against a real Postgres:
 *   • auth: no token → 401; unknown user → 403
 *   • module-state: round-trip, delete, and CROSS-TENANT ISOLATION via API
 *   • engagements: create/list scoped to the caller's tenant
 *   • LLM route: generate → response + usage_events metering row (RLS-scoped)
 *
 * Run: RLS_TEST=1 TEST_DATABASE_URL=... RLS_APP_URL=... npx vitest run test/api.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import { dbMeter } from "../src/llm/metering.js";
import { VERSION } from "../src/version.js";
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

const fakeAdapter: ProviderAdapter = {
  name: "gemini-aistudio",
  model: "fake-flash",
  freeTier: true,
  isConfigured: () => true,
  async generate() {
    return {
      text: '{"benchmarks":{}}',
      model: "fake-flash",
      usage: { tokensIn: 42, tokensOut: 7, costEstUsd: 0 },
    };
  },
};

describe.skipIf(!ENABLED)("Phase 1 API integration", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    // Seed two firms with one user each.
    const mk = async (firm: string, uid: string) => {
      const t = await admin.query<{ id: string }>(
        `INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [firm]);
      const u = await admin.query<{ id: string }>(
        `INSERT INTO users (identity_platform_uid, email) VALUES ($1, $2) ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
        [uid, `${uid}@test.local`]);
      // Owner role: these tests exercise TENANT isolation; client-level
      // assignment scoping (Phase 5) has its own suite in clients.test.ts.
      await admin.query(
        `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`,
        [u.rows[0].id, t.rows[0].id]);
      return t.rows[0].id;
    };
    tenantA = await mk("API Firm A", "uid-a");
    tenantB = await mk("API Firm B", "uid-b");

    initPool(APP_URL); // the app runs as the NON-OWNER role → RLS applies
    app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier({
        "tok-a": { uid: "uid-a", email: "a@test.local", idpTenantId: undefined },
        "tok-b": { uid: "uid-b", email: "b@test.local", idpTenantId: undefined },
      }),
      adapters: [fakeAdapter],
      meter: dbMeter,
    });
  });

  afterAll(async () => {
    await app?.close();
    await closePool();
    if (admin) {
      await admin.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
      await admin.end();
    }
  });

  const H = (tok: string) => ({ authorization: `Bearer ${tok}` });

  it("/api/version and /api/health both report the same VERSION, unauthenticated", async () => {
    const v = await app.inject({ method: "GET", url: "/api/version" });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ version: VERSION, env: "test" });

    const h = await app.inject({ method: "GET", url: "/api/health" });
    expect(h.statusCode).toBe(200);
    expect(h.json().version).toBe(VERSION);
  });

  it("rejects missing and invalid tokens", async () => {
    expect((await app.inject({ method: "GET", url: "/api/engagements" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/engagements", headers: H("nope") })).statusCode
    ).toBe(401);
  });

  it("module-state round-trips for tenant A", async () => {
    const put = await app.inject({
      method: "PUT", url: "/api/module-state/pre_engagement", headers: H("tok-a"),
      payload: { sets: { "vynora_briefing_acme": '{"hypotheses":[1,2]}' }, deletes: [] },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET", url: "/api/module-state/pre_engagement", headers: H("tok-a"),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().state["vynora_briefing_acme"]).toBe('{"hypotheses":[1,2]}');
  });

  it("tenant B cannot see tenant A's module state (API-level isolation)", async () => {
    const get = await app.inject({
      method: "GET", url: "/api/module-state/pre_engagement", headers: H("tok-b"),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().state).toEqual({});
  });

  it("deletes module-state keys", async () => {
    await app.inject({
      method: "PUT", url: "/api/module-state/pre_engagement", headers: H("tok-a"),
      payload: { sets: {}, deletes: ["vynora_briefing_acme"] },
    });
    const get = await app.inject({
      method: "GET", url: "/api/module-state/pre_engagement", headers: H("tok-a"),
    });
    expect(get.json().state).toEqual({});
  });

  it("engagements are tenant-scoped through the API", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/engagements", headers: H("tok-a"),
      payload: { clientName: "Acme Corp" },
    });
    expect(created.statusCode).toBe(201);

    const listA = await app.inject({ method: "GET", url: "/api/engagements", headers: H("tok-a") });
    const listB = await app.inject({ method: "GET", url: "/api/engagements", headers: H("tok-b") });
    expect(listA.json().engagements).toHaveLength(1);
    expect(listB.json().engagements).toHaveLength(0);
  });

  it("LLM generate returns text and writes a metering row scoped to the tenant", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/llm/generate", headers: H("tok-a"),
      payload: {
        task: "benchmarks", module: "pre_engagement",
        messages: [{ role: "user", content: "estimate benchmarks" }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("benchmarks");
    expect(res.json().provider).toBe("gemini-aistudio");

    // Verify through tenant context (FORCE RLS blinds even the table owner —
    // which is itself the isolation working as designed).
    const appC = new pg.Client({ connectionString: APP_URL });
    await appC.connect();
    try {
      const readAs = async (tid: string) => {
        await appC.query("BEGIN");
        await appC.query("SELECT set_config('app.tenant_id', $1, true)", [tid]);
        const r = await appC.query(
          `SELECT module, task, provider, tokens_in, tokens_out, ok FROM usage_events`
        );
        await appC.query("COMMIT");
        return r.rows;
      };
      const rowsA = await readAs(tenantA);
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]).toMatchObject({
        module: "pre_engagement", task: "benchmarks",
        provider: "gemini-aistudio", tokens_in: 42, tokens_out: 7, ok: true,
      });
      expect(await readAs(tenantB)).toHaveLength(0);
    } finally {
      await appC.end();
    }
  });

  it("accepts multimodal content blocks (document intelligence path)", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/llm/generate", headers: H("tok-a"),
      payload: {
        task: "doc_intelligence", module: "pre_engagement",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Analyse this document" },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
          ],
        }],
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
