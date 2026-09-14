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
import { activeKeyFor } from "../src/llm/byok/byokRepo.js";
import { normClient } from "../src/auth/clients.js";
import { engagementIdFor } from "../src/llm/byok/engagementBinding.js";

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
      await db.query(`DELETE FROM engagements WHERE tenant_id = $1`, [t]);
    }
    // The clients these tests act on, registered the way the product does.
    for (const n of ["Nestlé", "Acme Industrial", "Lapsed Corp", "Never Granted"]) {
      await makeClient(n);
    }
    await db.query(
      `INSERT INTO engagements (tenant_id, code, client_name) VALUES ($1, $2, 'Nestlé')
         ON CONFLICT DO NOTHING`, [other, "O-" + Math.random().toString(36).slice(2, 8).toUpperCase()]);
  });

  afterAll(async () => {
    await app.close();
    await db.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenant, other]]);
    await db.end();
    await closePool();
  });

  /**
   * v5.34.67: the routes now refuse a client who does not exist as an
   * engagement, so every client these tests name has to be created the way the
   * product creates one. That is the point of the change — a key could
   * previously be attached to a name nobody had ever registered, which stored
   * fine, showed as active, and was never used.
   */
  const makeClient = async (name: string) => {
    await db.query(
      `INSERT INTO engagements (tenant_id, code, client_name) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
      [tenant, "T-" + Math.random().toString(36).slice(2, 8).toUpperCase(), name]);
  };

  /** A client with an ACTIVE key on file, which is what triggers confinement. */
  const giveKey = async (
    clientName: string, provider = "gemini-aistudio", tenantId = tenant
  ) => {
    if (tenantId === tenant) await makeClient(clientName);
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
    /*
     * v5.34.66. The message used to end "or grant fallback for this client
     * first" — a remedy that does not exist. Found by following my own
     * instruction in production: granted the fallback, retried, got the same
     * refusal telling me to grant the fallback. The two features answer
     * different questions and the message must not conflate them.
     */
    expect(detail).not.toMatch(/grant fallback for this client first/i);
    expect(detail).toMatch(/a fallback grant does not change this/i);
    expect(detail).toMatch(/ask them for an Anthropic \(Claude\) key/i);   // "an", not "a"
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

  it("a fallback grant does NOT unlock a preference for an unkeyed vendor", async () => {
    /*
     * The two are deliberately independent. A grant says who pays when a
     * client's key FAILS; it is not permission to route their work to a vendor
     * they never keyed, which would move the charge on every call rather than
     * on a failure. Pinned because the refusal message once implied otherwise.
     */
    await giveKey("Granted Corp", "gemini-aistudio");
    await post("/api/byok/fallback-grants", { clientName: "Granted Corp", reason: "pilot" });
    const r = await post("/api/client-routing",
      { clientName: "Granted Corp", textVendor: "anthropic-api" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("vendor_not_keyed");
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

  /* ── the client must exist first (v5.34.67) ───────────────────────────── */

  it("refuses to issue a setup link for a client who does not exist", async () => {
    /*
     * The ordering flaw. The Owner could issue a link for any string; a
     * consultant later typed the client name into Pre-Engagement; the two were
     * joined only by normClient(). "Newell Brands" and "Newell Brands Inc"
     * produced a key that stored fine, showed as active, and was never used
     * while the work ran on the firm's credential.
     */
    const r = await post("/api/byok/invites",
      { clientName: "Nobody Ever Heard Of Them", provider: "gemini-aistudio" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("no_such_client");
    expect(r.json().detail).toMatch(/create them first/i);
    // And the reason it matters, in the message, because "no such client" alone
    // reads like a bug rather than an ordering rule.
    expect(r.json().detail).toMatch(/stored, shows as active, and is never used/i);
  });

  it("refuses a grant for a client who does not exist", async () => {
    const r = await post("/api/byok/fallback-grants", { clientName: "Ghost Industries" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("no_such_client");
    expect(await hasFallbackGrant(tenant, "Ghost Industries")).toBe(false);
  });

  it("refuses a preference for a client who does not exist", async () => {
    const r = await post("/api/client-routing",
      { clientName: "Ghost Industries", textVendor: "anthropic-api" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("no_such_client");
  });

  it("accepts all three once the client exists", async () => {
    // The same three calls, after the client is registered — so the guard is
    // an ordering rule and not a wall.
    await makeClient("Real Client Ltd");
    expect((await post("/api/byok/invites",
      { clientName: "Real Client Ltd", provider: "gemini-aistudio" })).statusCode).toBe(200);
    expect((await post("/api/byok/fallback-grants",
      { clientName: "Real Client Ltd" })).statusCode).toBe(200);
    expect((await post("/api/client-routing",
      { clientName: "Real Client Ltd", textVendor: "anthropic-api" })).statusCode).toBe(200);
  });

  it("matches the client however the name is punctuated", async () => {
    // The guard must not become a new way to fail on a typo it should forgive:
    // normClient() already decides what "the same client" means everywhere.
    await makeClient("Meridian Foods");
    expect((await post("/api/byok/fallback-grants",
      { clientName: "  meridian  foods " })).statusCode).toBe(200);
  });

  it("a client with a key but no engagement stays manageable", async () => {
    /*
     * Found in production immediately after the pickers shipped. A client can
     * have an active key and no engagement row — the key still works, because
     * the lookup falls back to the norm — and the first version of the guard
     * refused every operation on them. Their grant could not be re-issued and
     * their preference could not be set: tightening what may be ATTACHED had
     * made what already WAS attached unreachable.
     */
    await db.query(
      `INSERT INTO byok_keys
         (tenant_id, client_norm, client_name, provider, status, secret_name, key_hint,
          paid_tier_attested, attested_by_email, attested_at, attestation_text)
       VALUES ($1, $2, 'ZZ BYOK Test', 'gemini-aistudio', 'active',
               'projects/p/s/versions/1', 'wxyz', true, 'a@b.com', now(), 'attested')`,
      [tenant, normClient("ZZ BYOK Test")]);
    // No engagement for them — deliberately.
    expect(await engagementIdFor(tenant, "ZZ BYOK Test")).toBeNull();

    const r = await post("/api/byok/fallback-grants",
      { clientName: "ZZ BYOK Test", reason: "legacy key, client not registered yet" });
    expect(r.statusCode, "a client with a key on file was refused a grant").toBe(200);
    expect(await hasFallbackGrant(tenant, "ZZ BYOK Test")).toBe(true);
  });

  it("lists such a client, marked as not registered", async () => {
    await giveKey("Registered Co");            // giveKey also creates the engagement
    await db.query(
      `INSERT INTO byok_keys
         (tenant_id, client_norm, client_name, provider, status, secret_name, key_hint,
          paid_tier_attested, attested_by_email, attested_at, attestation_text)
       VALUES ($1, $2, 'Legacy Co', 'anthropic-api', 'active',
               'projects/p/s/versions/9', 'lgcy', true, 'a@b.com', now(), 'attested')`,
      [tenant, normClient("Legacy Co")]);

    const list = (await app.inject({ method: "GET", url: "/api/byok/clients" })).json();
    const byName = Object.fromEntries(
      list.clients.map((c: any) => [c.clientName, c.registered]));
    expect(byName["Registered Co"]).toBe(true);
    expect(byName["Legacy Co"], "a client with a key on file is missing from the picker").toBe(false);
  });

  it("still refuses a name that is neither an engagement nor on file", async () => {
    // The guard must not have been loosened into nothing.
    const r = await post("/api/byok/fallback-grants", { clientName: "Entirely Invented Ltd" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("no_such_client");
  });

  /* ── turning a key back on (v5.34.69) ─────────────────────────────────── */

  it("a disabled key can be turned back on", async () => {
    /*
     * "turn off" shipped without a "turn on". The only route back was a fresh
     * setup link and the CLIENT's administrator pasting their key again — a
     * round trip to the client, to undo a click the firm made on its own
     * screen, with nothing warning it was one-way. Nothing was ever destroyed:
     * the secret is still in Secret Manager and secret_name is still on the
     * row, so this is the status flip it always should have been.
     */
    await giveKey("Toggle Corp");
    await post("/api/byok/keys/disable",
      { clientName: "Toggle Corp", provider: "gemini-aistudio" });
    expect(await activeKeyFor(tenant, "Toggle Corp", "gemini-aistudio")).toBeNull();

    const r = await post("/api/byok/keys/enable",
      { clientName: "Toggle Corp", provider: "gemini-aistudio" });
    expect(r.statusCode).toBe(200);
    const back = await activeKeyFor(tenant, "Toggle Corp", "gemini-aistudio");
    expect(back, "a switched-off key could not be switched back on").not.toBeNull();
    expect(back!.keyHint).toBe("wxyz");
  });

  it("refuses to re-enable a key the provider REFUSED, and says why", async () => {
    /*
     * A `failed` key was rejected by its vendor. Flipping it back to active
     * would show "active" for a credential that fails on the very next call —
     * the screen would be lying again, in the other direction.
     */
    await giveKey("Refused Corp");
    await db.query(
      `UPDATE byok_keys SET status = 'failed', last_error = '403 PERMISSION_DENIED'
        WHERE tenant_id = $1 AND client_norm = $2`,
      [tenant, normClient("Refused Corp")]);

    const r = await post("/api/byok/keys/enable",
      { clientName: "Refused Corp", provider: "gemini-aistudio" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("not_disabled");
    expect(r.json().detail).toMatch(/has to be replaced/i);
    /*
     * v5.34.70. Asserting null here was a PROXY for "still not active", and the
     * proxy stopped holding when activeKeyFor started reporting refused keys so
     * the resolvers could tell them apart from absent ones. Assert the thing
     * this test is actually about: the row did not go back into service.
     */
    const still = await activeKeyFor(tenant, "Refused Corp", "gemini-aistudio");
    expect(still?.status, "a refused key was quietly re-activated").toBe("failed");
  });

  it("clears the recorded failure, so the screen does not stay red", async () => {
    // last_error is what renders "active — but not working". A key put back
    // into service carrying an old error would look broken from the moment it
    // was fixed.
    await giveKey("Cleared Corp");
    await db.query(
      `UPDATE byok_keys SET last_error = 'stale failure', last_error_at = now()
        WHERE tenant_id = $1 AND client_norm = $2`,
      [tenant, normClient("Cleared Corp")]);
    await post("/api/byok/keys/disable",
      { clientName: "Cleared Corp", provider: "gemini-aistudio" });
    await post("/api/byok/keys/enable",
      { clientName: "Cleared Corp", provider: "gemini-aistudio" });

    const row = await db.query<{ last_error: string | null }>(
      `SELECT last_error FROM byok_keys WHERE tenant_id = $1 AND client_norm = $2`,
      [tenant, normClient("Cleared Corp")]);
    expect(row.rows[0].last_error).toBeNull();
  });

  it("is Owner-only, like every other key action", async () => {
    await giveKey("Role Corp");
    await post("/api/byok/keys/disable",
      { clientName: "Role Corp", provider: "gemini-aistudio" });
    for (const role of ["consultant", "interviewee"]) {
      const r = await post("/api/byok/keys/enable",
        { clientName: "Role Corp", provider: "gemini-aistudio" }, role);
      expect(r.statusCode, role).toBe(403);
    }
  });

  it("records that the preference was checked, so old rows stay distinguishable", async () => {
    await post("/api/client-routing", { clientName: "Acme Industrial", textVendor: "anthropic-api" });
    const row = await db.query(
      `SELECT checked_against_keys FROM client_routing WHERE tenant_id = $1`, [tenant]);
    expect(row.rows[0].checked_against_keys).toBe(true);
  });
});
