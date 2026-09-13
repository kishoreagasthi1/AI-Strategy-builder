/**
 * White-label firm resolution (v5.23).
 *   • GET /api/firm by slug, by IdP tenant id, by custom domain host
 *   • unknown → 404; suspended firms not resolvable
 *   • PATCH /api/firm gated by SIGNUP_ACCESS_KEY; binds slug/custom domain;
 *     duplicate binding → 409
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";
import type { FastifyInstance } from "fastify";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:change-me-via-ops@localhost:5432/vyne";

class NoVerifier implements TokenVerifier {
  async verify(): Promise<VerifiedIdentity> { throw new Error("unused"); }
}

describe.skipIf(!ENABLED)("White-label firm resolution", () => {
  let admin: pg.Client;
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.SIGNUP_ACCESS_KEY = "test-operator-key";
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(
      `INSERT INTO tenants (name, idp_tenant_id, slug, custom_domain)
       VALUES ('Meridian Advisors', 'Meridian-abc12', 'meridian-advisors', 'vyne.meridianadvisors.com'),
              ('Suspended Firm', 'Suspended-zzz99', 'suspended-firm', NULL),
              ('Second Firm', 'Second-def34', 'second-firm', NULL)
       ON CONFLICT (idp_tenant_id) DO UPDATE SET slug = EXCLUDED.slug, custom_domain = EXCLUDED.custom_domain`
    );
    await admin.query(`UPDATE tenants SET status = 'suspended' WHERE idp_tenant_id = 'Suspended-zzz99'`);
    // Fixtures for GET /api/firm/by-email (v5.32).
    await admin.query(
      `INSERT INTO users (identity_platform_uid, email) VALUES
         ('by-email-single', 'single-firm@example.com'),
         ('by-email-multi', 'multi-firm@example.com'),
         ('by-email-suspended', 'suspended-only@example.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email`
    );
    await admin.query(`
      INSERT INTO memberships (user_id, tenant_id, role)
      SELECT u.id, t.id, 'owner' FROM users u, tenants t
       WHERE u.identity_platform_uid = 'by-email-single' AND t.idp_tenant_id = 'Meridian-abc12'
      ON CONFLICT (user_id, tenant_id) DO NOTHING
    `);
    await admin.query(`
      INSERT INTO memberships (user_id, tenant_id, role)
      SELECT u.id, t.id, 'consultant' FROM users u, tenants t
       WHERE u.identity_platform_uid = 'by-email-multi' AND t.idp_tenant_id IN ('Meridian-abc12', 'Second-def34')
      ON CONFLICT (user_id, tenant_id) DO NOTHING
    `);
    await admin.query(`
      INSERT INTO memberships (user_id, tenant_id, role)
      SELECT u.id, t.id, 'owner' FROM users u, tenants t
       WHERE u.identity_platform_uid = 'by-email-suspended' AND t.idp_tenant_id = 'Suspended-zzz99'
      ON CONFLICT (user_id, tenant_id) DO NOTHING
    `);
    initPool(APP_URL);
    app = await buildServer({
      config: {
        env: "test", port: 0, databaseUrl: APP_URL, blockFreeTier: false,
      } as never,
      verifier: new NoVerifier(),
      adapters: [],
      meter: async () => {},
    });
  });

  afterAll(async () => {
    delete process.env.SIGNUP_ACCESS_KEY;
    await app?.close();
    await admin?.end();
    await closePool();
  });

  it("resolves a firm by slug", async () => {
    const r = await app.inject({ method: "GET", url: "/api/firm?firm=meridian-advisors" });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.name).toBe("Meridian Advisors");
    expect(b.idpTenantId).toBe("Meridian-abc12");
  });

  it("resolves a firm by verbatim IdP tenant id", async () => {
    const r = await app.inject({ method: "GET", url: "/api/firm?firm=Meridian-abc12" });
    expect(r.statusCode).toBe(200);
    expect(r.json().slug).toBe("meridian-advisors");
  });

  it("resolves a firm by custom domain host", async () => {
    const r = await app.inject({ method: "GET", url: "/api/firm?host=vyne.meridianadvisors.com" });
    expect(r.statusCode).toBe(200);
    expect(r.json().idpTenantId).toBe("Meridian-abc12");
  });

  it("unknown slug/host → 404; missing query → 400", async () => {
    expect((await app.inject({ method: "GET", url: "/api/firm?firm=nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/firm?host=evil.example.com" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/firm" })).statusCode).toBe(400);
  });

  it("suspended firms do not resolve", async () => {
    const r = await app.inject({ method: "GET", url: "/api/firm?firm=suspended-firm" });
    expect(r.statusCode).toBe(404);
  });

  // v5.32: email-based firm lookup — the fourth resolution path, for a
  // brand-new user on a browser that's never logged in before.
  it("GET /api/firm/by-email resolves the one active firm for a single-membership email", async () => {
    const r = await app.inject({ method: "GET", url: "/api/firm/by-email?email=single-firm@example.com" });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.firms).toHaveLength(1);
    expect(b.firms[0].idpTenantId).toBe("Meridian-abc12");
  });

  it("GET /api/firm/by-email is case-insensitive on the email", async () => {
    const r = await app.inject({ method: "GET", url: "/api/firm/by-email?email=SINGLE-FIRM@EXAMPLE.COM" });
    expect(r.statusCode).toBe(200);
    expect(r.json().firms).toHaveLength(1);
  });

  it("GET /api/firm/by-email returns every active firm for a multi-membership email", async () => {
    const r = await app.inject({ method: "GET", url: "/api/firm/by-email?email=multi-firm@example.com" });
    expect(r.statusCode).toBe(200);
    const ids = r.json().firms.map((f: { idpTenantId: string }) => f.idpTenantId).sort();
    expect(ids).toEqual(["Meridian-abc12", "Second-def34"]);
  });

  it("GET /api/firm/by-email excludes memberships at a suspended firm", async () => {
    const r = await app.inject({ method: "GET", url: "/api/firm/by-email?email=suspended-only@example.com" });
    expect(r.statusCode).toBe(200);
    expect(r.json().firms).toEqual([]);
  });

  it("GET /api/firm/by-email returns an empty list (never an error) for an unknown email", async () => {
    const r = await app.inject({ method: "GET", url: "/api/firm/by-email?email=nobody@example.com" });
    expect(r.statusCode).toBe(200);
    expect(r.json().firms).toEqual([]);
  });

  it("GET /api/firm/by-email returns an empty list (not a 400) for a missing/malformed email", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/firm/by-email" });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().firms).toEqual([]);
    const tooShort = await app.inject({ method: "GET", url: "/api/firm/by-email?email=a" });
    expect(tooShort.statusCode).toBe(200);
    expect(tooShort.json().firms).toEqual([]);
  });

  it("PATCH requires the operator key", async () => {
    const r = await app.inject({
      method: "PATCH", url: "/api/firm",
      payload: { idpTenantId: "Meridian-abc12", slug: "meridian" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("PATCH binds a new slug and custom domain", async () => {
    const r = await app.inject({
      method: "PATCH", url: "/api/firm",
      headers: { "x-signup-key": "test-operator-key" },
      payload: { idpTenantId: "Meridian-abc12", slug: "meridian", customDomain: "advisory.meridianadvisors.com" },
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.slug).toBe("meridian");
    expect(b.customDomain).toBe("advisory.meridianadvisors.com");
    // old slug no longer resolves, new one does
    expect((await app.inject({ method: "GET", url: "/api/firm?firm=meridian" })).statusCode).toBe(200);
  });

  it("PATCH rejects a slug already bound to another firm", async () => {
    const r = await app.inject({
      method: "PATCH", url: "/api/firm",
      headers: { "x-signup-key": "test-operator-key" },
      payload: { idpTenantId: "Suspended-zzz99", slug: "meridian" },
    });
    expect(r.statusCode).toBe(409);
  });

  it("GET /api/firms requires the operator key", async () => {
    const r = await app.inject({ method: "GET", url: "/api/firms" });
    expect(r.statusCode).toBe(403);
  });

  it("GET /api/firms lists every tenant for the operator console", async () => {
    const r = await app.inject({
      method: "GET", url: "/api/firms",
      headers: { "x-signup-key": "test-operator-key" },
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(Array.isArray(b.firms)).toBe(true);
    const meridian = b.firms.find((f: { idpTenantId: string }) => f.idpTenantId === "Meridian-abc12");
    expect(meridian).toBeTruthy();
    expect(meridian.name).toBe("Meridian Advisors");
    expect(meridian.status).toBe("active");
    const suspended = b.firms.find((f: { idpTenantId: string }) => f.idpTenantId === "Suspended-zzz99");
    expect(suspended).toBeTruthy();
    expect(suspended.status).toBe("suspended");
  });

  it("PATCH validates slug and domain formats", async () => {
    const bad1 = await app.inject({
      method: "PATCH", url: "/api/firm",
      headers: { "x-signup-key": "test-operator-key" },
      payload: { idpTenantId: "Meridian-abc12", slug: "Has Spaces!" },
    });
    expect(bad1.statusCode).toBe(400);
    const bad2 = await app.inject({
      method: "PATCH", url: "/api/firm",
      headers: { "x-signup-key": "test-operator-key" },
      payload: { idpTenantId: "Meridian-abc12", customDomain: "not a host" },
    });
    expect(bad2.statusCode).toBe(400);
  });

  it("V225-audit MEDIUM: PATCH rejects the platform's own shared hosting domains as a custom domain", async () => {
    // These pass the bare-hostname format check (HOST_RE requires a dot),
    // so they specifically exercise the SHARED_HOSTS guard rather than
    // just generic format validation.
    const shared = ["vyne-platform-prod.web.app", "some-app.firebaseapp.com", "vyne-api-abc123.run.app", "127.0.0.1"];
    for (const customDomain of shared) {
      const r = await app.inject({
        method: "PATCH", url: "/api/firm",
        headers: { "x-signup-key": "test-operator-key" },
        payload: { idpTenantId: "Meridian-abc12", customDomain },
      });
      expect(r.statusCode, `expected ${customDomain} to be rejected`).toBe(400);
      expect(r.json().error).toBe("shared_host_reserved");
    }
    // "localhost" has no dot, so it's already rejected by the bare-hostname
    // format check (HOST_RE) before the SHARED_HOSTS guard even runs —
    // still blocked, just via a different, pre-existing mechanism.
    const localhost = await app.inject({
      method: "PATCH", url: "/api/firm",
      headers: { "x-signup-key": "test-operator-key" },
      payload: { idpTenantId: "Meridian-abc12", customDomain: "localhost" },
    });
    expect(localhost.statusCode).toBe(400);

    // A normal custom domain is unaffected.
    const ok = await app.inject({
      method: "PATCH", url: "/api/firm",
      headers: { "x-signup-key": "test-operator-key" },
      payload: { idpTenantId: "Meridian-abc12", customDomain: "still-fine.meridianadvisors.com" },
    });
    expect(ok.statusCode).toBe(200);
  });
});
