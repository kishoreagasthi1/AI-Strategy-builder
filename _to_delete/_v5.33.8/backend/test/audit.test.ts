/**
 * Structured audit logging (v5.30) — src/audit/log.ts + src/routes/audit.ts.
 *
 *   Unit coverage: auditLog() writes a row scoped to the given tenant, and
 *   never throws even when given a bogus tenant (best-effort by design —
 *   see log.ts's doc comment).
 *
 *   RLS-gated HTTP coverage: the real write sites in assignments.ts
 *   (consultant add/remove, client-assignment add/remove, client delete)
 *   each produce a matching audit_log row, retrievable only by the owner
 *   via GET /api/audit-log; a second tenant's rows never leak across
 *   (RLS, migration 008); pagination (limit/before) and the action filter
 *   both work; consultants and interviewees are blocked outright.
 *
 * Run: RLS_TEST=1 ... npx vitest run test/audit.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool, withTenant } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import { auditLog } from "../src/audit/log.js";
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
  name: "gemini-aistudio", model: "fake", freeTier: true,
  isConfigured: () => true,
  async generate() {
    return { text: "ok", model: "fake", usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0 } };
  },
};

describe.skipIf(!ENABLED)("auditLog() unit coverage", () => {
  let admin: pg.Client;
  let tenant: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const t = await admin.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('Audit Unit Firm') RETURNING id`);
    tenant = t.rows[0].id;
    initPool(APP_URL);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await admin.end();
    await closePool();
  });

  it("writes a row scoped to the given tenant", async () => {
    await auditLog(tenant, null, "consultant_added", { email: "unit@test.com" });
    const rows = await withTenant(tenant, async (c) => {
      const r = await c.query(`SELECT action, detail FROM audit_log WHERE tenant_id = $1`, [tenant]);
      return r.rows;
    });
    expect(rows.some((r) => r.action === "consultant_added" && r.detail.email === "unit@test.com")).toBe(true);
  });

  it("never throws, even for a bogus tenant id", async () => {
    await expect(auditLog("00000000-0000-0000-0000-000000000000", null, "client_deleted", {})).resolves.toBeUndefined();
  });
});

describe.skipIf(!ENABLED)("Audit log HTTP — write-site wiring, RLS isolation, owner-only", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;
  let otherTenant: string;
  const verifierMap: Record<string, VerifiedIdentity> = {
    "tok-owner": { uid: "uid-audit-owner", email: "audit-owner@firm.com", idpTenantId: undefined },
    "tok-cons": { uid: "uid-audit-cons", email: "audit-cons@firm.com", idpTenantId: undefined },
    "tok-iv": { uid: "uid-audit-iv", email: "audit-iv@client.com", idpTenantId: undefined },
  };

  beforeAll(async () => {
    process.env.DEV_AUTH = "1";
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    const t = await admin.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('Audit HTTP Firm') RETURNING id`);
    tenant = t.rows[0].id;
    const ot = await admin.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('Audit HTTP Other Firm') RETURNING id`);
    otherTenant = ot.rows[0].id;

    const owner = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-audit-owner', 'audit-owner@firm.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`, [owner.rows[0].id, tenant]);

    const cons = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-audit-cons', 'audit-cons@firm.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'consultant')`, [cons.rows[0].id, tenant]);

    const iv = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-audit-iv', 'audit-iv@client.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'interviewee')`, [iv.rows[0].id, tenant]);

    initPool(APP_URL);

    // A row that must never be visible to `tenant`'s owner — proves RLS
    // isolation on audit_log itself (migration 008), not just app-level scoping.
    await auditLog(otherTenant, null, "client_deleted", { clientName: "Should Never Leak" });

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
    await admin.query(`DELETE FROM tenants WHERE id = $1`, [otherTenant]);
    await admin.end();
    await app.close();
    await closePool();
  });

  it("consultant add/remove each produce a matching audit_log entry", async () => {
    const add = await app.inject({
      method: "POST", url: "/api/team",
      headers: { authorization: "Bearer tok-owner" },
      payload: { email: "new-consultant@firm.com", name: "New Consultant" },
    });
    expect(add.statusCode).toBe(201);

    const remove = await app.inject({
      method: "DELETE", url: "/api/team",
      headers: { authorization: "Bearer tok-owner" },
      payload: { email: "new-consultant@firm.com" },
    });
    expect(remove.statusCode).toBe(200);

    const r = await app.inject({ method: "GET", url: "/api/audit-log", headers: { authorization: "Bearer tok-owner" } });
    expect(r.statusCode).toBe(200);
    const actions = r.json().entries.map((e: any) => e.action);
    expect(actions).toContain("consultant_added");
    expect(actions).toContain("consultant_removed");
  });

  it("client-assignment add/remove and client delete each log too", async () => {
    const assignAdd = await app.inject({
      method: "POST", url: "/api/assignments",
      headers: { authorization: "Bearer tok-owner" },
      payload: { email: "audit-cons@firm.com", clientName: "AuditCo" },
    });
    expect(assignAdd.statusCode).toBe(201);

    const assignRemove = await app.inject({
      method: "DELETE", url: "/api/assignments",
      headers: { authorization: "Bearer tok-owner" },
      payload: { email: "audit-cons@firm.com", clientName: "AuditCo" },
    });
    expect(assignRemove.statusCode).toBe(200);

    const del = await app.inject({
      method: "DELETE", url: "/api/clients",
      headers: { authorization: "Bearer tok-owner" },
      payload: { clientName: "AuditCo" },
    });
    expect(del.statusCode).toBe(200);

    const r = await app.inject({ method: "GET", url: "/api/audit-log", headers: { authorization: "Bearer tok-owner" } });
    const actions = r.json().entries.map((e: any) => e.action);
    expect(actions).toContain("client_assignment_added");
    expect(actions).toContain("client_assignment_removed");
    expect(actions).toContain("client_deleted");
  });

  it("owner never sees another tenant's audit rows (RLS isolation)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/audit-log?limit=200", headers: { authorization: "Bearer tok-owner" } });
    expect(r.statusCode).toBe(200);
    const details = r.json().entries.map((e: any) => JSON.stringify(e.detail));
    expect(details.some((d: string) => d.includes("Should Never Leak"))).toBe(false);
  });

  it("action filter narrows to just that action", async () => {
    const r = await app.inject({
      method: "GET", url: "/api/audit-log?action=consultant_added",
      headers: { authorization: "Bearer tok-owner" },
    });
    expect(r.statusCode).toBe(200);
    const actions = r.json().entries.map((e: any) => e.action);
    expect(actions.every((a: string) => a === "consultant_added")).toBe(true);
    expect(actions.length).toBeGreaterThan(0);
  });

  it("limit + before paginate without gaps or repeats", async () => {
    const page1 = await app.inject({ method: "GET", url: "/api/audit-log?limit=2", headers: { authorization: "Bearer tok-owner" } });
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json();
    expect(p1.entries.length).toBeLessThanOrEqual(2);
    if (p1.nextBefore) {
      const page2 = await app.inject({
        method: "GET", url: `/api/audit-log?limit=2&before=${p1.nextBefore}`,
        headers: { authorization: "Bearer tok-owner" },
      });
      const p2 = page2.json();
      const ids1 = new Set(p1.entries.map((e: any) => e.id));
      for (const e of p2.entries) expect(ids1.has(e.id)).toBe(false);
    }
  });

  it("consultants are blocked from the audit log", async () => {
    const r = await app.inject({ method: "GET", url: "/api/audit-log", headers: { authorization: "Bearer tok-cons" } });
    expect(r.statusCode).toBe(403);
  });

  it("interviewees are blocked from the audit log", async () => {
    const r = await app.inject({ method: "GET", url: "/api/audit-log", headers: { authorization: "Bearer tok-iv" } });
    expect(r.statusCode).toBe(403);
  });

  it("rejects a garbage limit with 400 invalid_input", async () => {
    const r = await app.inject({ method: "GET", url: "/api/audit-log?limit=9999", headers: { authorization: "Bearer tok-owner" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_input");
  });
});

// V225-audit billing Low fix (migration 010): vyne_app's blanket grant from
// 001_core.sql used to include UPDATE/DELETE on audit_log — meaning the
// application's own DB role, not just its code, could rewrite or erase its
// own audit trail. This proves the revoke actually took effect at the
// database level (not just "nothing in the app happens to call UPDATE"),
// using a raw connection as vyne_app rather than going through the app.
describe.skipIf(!ENABLED)("audit_log is append-only at the database role level", () => {
  let app_role: pg.Client;
  let admin: pg.Client;
  let tenant: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const t = await admin.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('WORM Firm') RETURNING id`);
    tenant = t.rows[0].id;
    await admin.query(
      `INSERT INTO audit_log (tenant_id, user_id, action, detail) VALUES ($1, NULL, 'consultant_added', '{}')`,
      [tenant]
    );
    app_role = new pg.Client({ connectionString: APP_URL });
    await app_role.connect();
    await app_role.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
  });

  afterAll(async () => {
    await app_role?.end();
    await admin?.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await admin?.end();
  });

  it("vyne_app cannot UPDATE audit_log rows", async () => {
    await expect(
      app_role.query(`UPDATE audit_log SET action = 'tampered' WHERE tenant_id = $1`, [tenant])
    ).rejects.toThrow(/permission denied/i);
  });

  it("vyne_app cannot DELETE audit_log rows", async () => {
    await expect(
      app_role.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenant])
    ).rejects.toThrow(/permission denied/i);
  });

  it("vyne_app CAN still INSERT and SELECT (the actual write/read paths)", async () => {
    await expect(
      app_role.query(`INSERT INTO audit_log (tenant_id, user_id, action, detail) VALUES ($1, NULL, 'consultant_added', '{}')`, [tenant])
    ).resolves.toBeDefined();
    const r = await app_role.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1`, [tenant]);
    expect(r.rowCount).toBeGreaterThan(0);
  });
});
