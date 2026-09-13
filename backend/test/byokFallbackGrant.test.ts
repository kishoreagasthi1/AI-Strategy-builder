/**
 * The grant, and the preference guard that depends on it. (v5.34.64)
 *
 * Two screens' worth of behaviour, both about the same thing: a client who
 * supplies a key pays for their own work, and the only way that stops being
 * true is somebody deciding it should, by name, on the record.
 *
 * Runs against a real Postgres because both features are row existence — a
 * grant IS a row, and the preference guard reads byok_keys — and stubbing that
 * out would leave the RLS policy and the unique index untested, which is most
 * of what these tables are.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { byokRoutes } from "../src/routes/byok.js";
import { hasFallbackGrant } from "../src/llm/byok/fallbackGrant.js";
import { normClient } from "../src/auth/clients.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

describe.skipIf(!ENABLED)("v5.34.64 — fallback grant", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let tenant: string;
  let other: string;
  let owner: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    initPool(ADMIN_URL);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    tenant = (await db.query(`INSERT INTO tenants (name) VALUES ('Grant Firm') RETURNING id`)).rows[0].id;
    other  = (await db.query(`INSERT INTO tenants (name) VALUES ('Other Grant Firm') RETURNING id`)).rows[0].id;
    owner = (await db.query(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-byok-grant','g@firm.com')
         ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`)).rows[0].id;

    app = Fastify();
    await app.register(async (scope) => {
      scope.addHook("preHandler", async (req: any) => {
        req.ctx = { tenantId: tenant, userId: owner, role: req.headers["x-role"] ?? "owner" };
      });
      await byokRoutes(scope, {
        secretStore: { projectId: "proj" },
        probe: (async () => ({
          checkedAt: new Date().toISOString(), canGenerate: true, canMintLiveToken: true,
          modelCount: 9, hasNativeAudio: true, status: { generate: 200, models: 200, authTokens: 200 },
        })) as any,
        putKey: (async (_o: any, ref: any, key: string) => ({
          secretName: `projects/p/secrets/s-${ref.clientNorm}-${ref.provider}/versions/1`,
          version: "1", keyHint: key.slice(-4),
        })) as any,
        appBaseUrl: "https://app.example",
      });
    });
    await app.ready();
  });

  beforeEach(async () => {
    for (const t of [tenant, other]) {
      await db.query(`DELETE FROM byok_fallback_grant WHERE tenant_id = $1`, [t]);
      await db.query(`DELETE FROM client_routing WHERE tenant_id = $1`, [t]);
      await db.query(`DELETE FROM byok_keys WHERE tenant_id = $1`, [t]);
      // audit_log too: every grant in this file writes one, so without this the
      // ordering assertion below counts rows left behind by earlier tests.
      await db.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [t]);
    }
  });

  afterAll(async () => {
    await app.close();
    await db.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenant, other]]);
    await db.end();
    await closePool();
  });

  /** A client with an ACTIVE key on file, which is what triggers confinement. */
  const giveKey = async (
    clientName: string, provider = "gemini-aistudio", tenantId = tenant
  ) => {
    /*
     * byok_key_active_requires_attestation (migration 030) makes an ACTIVE key
     * without a stored attestation impossible — including attestation_text,
     * which is the verbatim record of what the client's administrator agreed
     * to. A fixture that omits it is not a shortcut; it is a row the product
     * cannot produce, and the constraint says so.
     */
    await db.query(
      `INSERT INTO byok_keys
         (tenant_id, client_norm, client_name, provider, status, secret_name, key_hint,
          paid_tier_attested, attested_by_email, attested_at, attestation_text)
       VALUES ($1, $4, $2, $3, 'active', 'projects/p/secrets/s/versions/1', 'wxyz',
               true, 'admin@client.example', now(), 'I confirm this key belongs to a billed account.')`,
      // normClient(), not lower(): it also strips spaces and punctuation, so
      // "ZZ BYOK Test" is "zzbyoktest". A fixture that writes 'zz byok test'
      // creates a row the lookup can never find, and the guard under test
      // would pass its client through as if they had no key at all.
      [tenantId, clientName, provider, normClient(clientName)]
    );
  };

  const post = (url: string, payload: unknown, role?: string) =>
    app.inject({ method: "POST", url, payload: payload as any,
                 ...(role ? { headers: { "x-role": role } } : {}) });

  /* ── the grant itself ─────────────────────────────────────────────────── */

  it("is absent until somebody grants it", async () => {
    // The safe state, and the one every client starts in.
    expect(await hasFallbackGrant(tenant, "Nestlé")).toBe(false);
  });

  it("granting makes the lookup true, revoking makes it false again", async () => {
    await post("/api/byok/fallback-grants", { clientName: "Nestlé", reason: "pilot, procurement pending" });
    expect(await hasFallbackGrant(tenant, "Nestlé")).toBe(true);

    await post("/api/byok/fallback-grants/revoke", { clientName: "Nestlé" });
    expect(await hasFallbackGrant(tenant, "Nestlé")).toBe(false);
  });

  it("matches the client the same way every other per-client fact does", async () => {
    // normClient lower-cases and strips punctuation, so the grant has to follow
    // the same rule or a consultant would grant "Nestlé" and confine "nestle".
    await post("/api/byok/fallback-grants", { clientName: "Nestlé" });
    expect(await hasFallbackGrant(tenant, "NESTLÉ")).toBe(true);
    expect(await hasFallbackGrant(tenant, "  Nestlé  ")).toBe(true);
  });

  it("granting twice updates the reason rather than failing on the unique index", async () => {
    await post("/api/byok/fallback-grants", { clientName: "Nestlé", reason: "first" });
    const r = await post("/api/byok/fallback-grants", { clientName: "Nestlé", reason: "second" });
    expect(r.statusCode).toBe(200);
    const list = (await app.inject({ method: "GET", url: "/api/byok/fallback-grants" })).json();
    expect(list.grants).toHaveLength(1);
    expect(list.grants[0].reason).toBe("second");
  });

  it("never leaks across tenants", async () => {
    await post("/api/byok/fallback-grants", { clientName: "Nestlé" });
    // The same client name, a different firm: RLS must keep these apart, or one
    // firm's decision would start spending another firm's money.
    expect(await hasFallbackGrant(other, "Nestlé")).toBe(false);
  });

  it("is Owner-only — a consultant cannot commit the firm's money", async () => {
    for (const role of ["consultant", "interviewee"]) {
      const r = await post("/api/byok/fallback-grants", { clientName: "Nestlé" }, role);
      expect(r.statusCode, role).toBe(403);
    }
    expect(await hasFallbackGrant(tenant, "Nestlé")).toBe(false);
  });

  it("writes an audit row, because this is a money decision made months early", async () => {
    await post("/api/byok/fallback-grants", { clientName: "Nestlé", reason: "pilot" });
    await post("/api/byok/fallback-grants/revoke", { clientName: "Nestlé" });
    // auditLog is deliberately not awaited by the route (fire and forget), so
    // give it the tick it needs before reading.
    await new Promise((r) => setTimeout(r, 150));
    const rows = await db.query(
      `SELECT action, detail FROM audit_log WHERE tenant_id = $1 AND action LIKE 'byok_fallback%'
        ORDER BY created_at`, [tenant]);
    expect(rows.rows.map((r) => r.action))
      .toEqual(["byok_fallback_granted", "byok_fallback_revoked"]);
    expect(rows.rows[0].detail.clientName).toBe("Nestlé");
  });

  it("revoking something never granted is not an error", async () => {
    const r = await post("/api/byok/fallback-grants/revoke", { clientName: "Never Granted" });
    expect(r.statusCode).toBe(200);
  });

  /* ── the preference guard ─────────────────────────────────────────────── */

  it("refuses a preference for a vendor the client has not keyed", async () => {
    /*
     * The production bug, at the point it can now be caught. ZZ BYOK Test holds
     * a GOOGLE key; preferring Anthropic used to move every document, deck and
     * synthesis onto the firm's Anthropic account while the panel said a
     * preference "never changes who pays".
     */
    await giveKey("ZZ BYOK Test", "gemini-aistudio");
    const r = await post("/api/client-routing",
      { clientName: "ZZ BYOK Test", textVendor: "anthropic-api" });

    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("vendor_not_keyed");
    // The message has to explain the consequence, not just say no.
    const detail = r.json().detail as string;
    expect(detail).toContain("Google (Gemini)");
    expect(detail).toContain("Anthropic (Claude)");
    expect(detail).toMatch(/your account/i);
    // Nothing was written.
    const rows = await db.query(`SELECT 1 FROM client_routing WHERE tenant_id = $1`, [tenant]);
    expect(rows.rowCount).toBe(0);
  });

  it("names the vendors in words a consultant uses, never the wire values", async () => {
    await giveKey("ZZ BYOK Test", "gemini-aistudio");
    const detail = (await post("/api/client-routing",
      { clientName: "ZZ BYOK Test", textVendor: "anthropic-api" })).json().detail as string;
    expect(detail).not.toContain("anthropic-api");
    expect(detail).not.toContain("gemini-aistudio");
  });

  it("allows the preference for a vendor they HAVE keyed", async () => {
    await giveKey("Both Corp", "gemini-aistudio");
    await giveKey("Both Corp", "anthropic-api");
    const r = await post("/api/client-routing",
      { clientName: "Both Corp", textVendor: "anthropic-api" });
    expect(r.statusCode).toBe(200);
    expect(r.json().routing.textVendor).toBe("anthropic-api");
  });

  it("leaves a client with NO key completely free to choose", async () => {
    // They are on the firm's account by arrangement; every vendor in the firm's
    // policy is payable, and choosing between them is the v5.34.63 feature.
    const r = await post("/api/client-routing",
      { clientName: "Acme Industrial", textVendor: "anthropic-api" });
    expect(r.statusCode).toBe(200);
  });

  it("ignores a key that is switched off when deciding what they may prefer", async () => {
    /*
     * A disabled key is not a credential they can pay with. Counting it would
     * pin a client to a vendor they can no longer use, and the preference guard
     * would be enforcing a constraint that no longer exists.
     */
    await db.query(
      `INSERT INTO byok_keys (tenant_id, client_norm, client_name, provider, status, key_hint)
       VALUES ($1, 'lapsed corp', 'Lapsed Corp', 'gemini-aistudio', 'disabled', 'wxyz')`,
      [tenant]
    );
    const r = await post("/api/client-routing",
      { clientName: "Lapsed Corp", textVendor: "anthropic-api" });
    expect(r.statusCode).toBe(200);
  });

  it("records that the preference was checked, so old rows stay distinguishable", async () => {
    await post("/api/client-routing", { clientName: "Acme Industrial", textVendor: "anthropic-api" });
    const row = await db.query(
      `SELECT checked_against_keys FROM client_routing WHERE tenant_id = $1`, [tenant]);
    expect(row.rows[0].checked_against_keys).toBe(true);
  });
});
