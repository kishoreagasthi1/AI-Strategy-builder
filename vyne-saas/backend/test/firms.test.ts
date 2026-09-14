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
              ('Suspended Firm', 'Suspended-zzz99', 'suspended-firm', NULL)
       ON CONFLICT (idp_tenant_id) DO UPDATE SET slug = EXCLUDED.slug, custom_domain = EXCLUDED.custom_domain`
    );
    await admin.query(`UPDATE tenants SET status = 'suspended' WHERE idp_tenant_id = 'Suspended-zzz99'`);
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
});
