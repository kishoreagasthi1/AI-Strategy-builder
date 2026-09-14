/**
 * Renaming a client must not detach their key, preference or grant. (v5.34.67)
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 *
 * byok_keys (031), client_routing (035) and byok_fallback_grant (036) were all
 * keyed on the client's normalised NAME. /api/clients/rename updates
 * module_state, engagements, interviews, client_assignments and usage_events —
 * and has never touched those three. So renaming "Nestle" to "Nestlé USA":
 *
 *   * activeKeyFor() found nothing, the client silently stopped being a BYOK
 *     client, and every call ran on the FIRM's credential;
 *   * the keys screen still showed the key healthy, under a name that no
 *     longer existed;
 *   * hasFallbackGrant() also found nothing — and that one fails CLOSED, so a
 *     client the firm had explicitly agreed to cover had their interviews
 *     refused instead.
 *
 * Migration 025 had settled this in v5.32.96 — "a name that is a key cannot be
 * renamed safely; a name that is a display string can" — and BYOK, built months
 * later, went back onto the name anyway.
 *
 * ── What this asserts ───────────────────────────────────────────────────────
 *
 * The rename is performed the way the product performs it (UPDATE engagements
 * .client_name, exactly what routes/assignments.ts does), and then every BYOK
 * lookup is asked the same question under the NEW name. No test may pass by
 * also updating the BYOK tables — that would be asserting the fix that does not
 * exist. The binding has to survive on its own.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { activeKeyFor } from "../src/llm/byok/byokRepo.js";
import { routingFor, setRouting } from "../src/llm/byok/clientRouting.js";
import { hasFallbackGrant, grantFallback } from "../src/llm/byok/fallbackGrant.js";
import { engagementIdFor } from "../src/llm/byok/engagementBinding.js";
import { normClient } from "../src/auth/clients.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

describe.skipIf(!ENABLED)("v5.34.67 — BYOK survives a client rename", () => {
  let db: pg.Client;
  let tenant: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    initPool(ADMIN_URL);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    tenant = (await db.query(
      `INSERT INTO tenants (name) VALUES ('Rename Binding Firm') RETURNING id`)).rows[0].id;
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant]);
  }, 60_000);

  beforeEach(async () => {
    for (const t of ["byok_keys", "client_routing", "byok_fallback_grant", "engagements"]) {
      await db.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenant]);
    }
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await db.end();
    await closePool();
  });

  /** A client, the way POST /api/engagements creates one. */
  const makeClient = async (name: string, code = "TEST-" + Math.random().toString(36).slice(2, 6).toUpperCase()) =>
    (await db.query<{ id: string }>(
      `INSERT INTO engagements (tenant_id, code, client_name) VALUES ($1, $2, $3) RETURNING id`,
      [tenant, code, name])).rows[0].id;

  const giveKey = async (name: string, provider = "gemini-aistudio") => {
    const engagementId = await engagementIdFor(tenant, name);
    await db.query(
      `INSERT INTO byok_keys
         (tenant_id, client_norm, client_name, provider, status, secret_name, key_hint,
          paid_tier_attested, attested_by_email, attested_at, attestation_text, engagement_id)
       VALUES ($1, $2, $3, $4, 'active', 'projects/p/secrets/s/versions/1', 'wxyz',
               true, 'admin@client.example', now(), 'attested', $5)`,
      [tenant, normClient(name), name, provider, engagementId]
    );
  };

  /** Exactly what routes/assignments.ts does to the engagement row. */
  const rename = async (id: string, newName: string) =>
    db.query(`UPDATE engagements SET client_name = $1, updated_at = now() WHERE id = $2`,
             [newName, id]);

  it("the key is still found under the new name", async () => {
    const id = await makeClient("Nestle");
    await giveKey("Nestle");
    expect(await activeKeyFor(tenant, "Nestle", "gemini-aistudio")).not.toBeNull();

    await rename(id, "Nestlé USA");

    const found = await activeKeyFor(tenant, "Nestlé USA", "gemini-aistudio");
    expect(found, "the key was orphaned by the rename — the firm is now paying").not.toBeNull();
    expect(found!.keyHint).toBe("wxyz");
  });

  it("the model preference survives too", async () => {
    const id = await makeClient("Nestle");
    await setRouting({ tenantId: tenant, clientName: "Nestle", textVendor: "anthropic-api" });
    await rename(id, "Nestlé USA");
    expect((await routingFor(tenant, "Nestlé USA"))?.textVendor).toBe("anthropic-api");
  });

  it("the fallback grant survives — and this one fails CLOSED when it does not", async () => {
    /*
     * Worth its own test because the symptom differs. A lost KEY silently moves
     * the bill to the firm; a lost GRANT refuses a live interview for a client
     * the firm had agreed to cover, with an executive already in the room.
     */
    const id = await makeClient("Nestle");
    await grantFallback({ tenantId: tenant, clientName: "Nestle", reason: "pilot" });
    await rename(id, "Nestlé USA");
    expect(await hasFallbackGrant(tenant, "Nestlé USA")).toBe(true);
  });

  it("the OLD name stops resolving, so a stale reference cannot reach the key", async () => {
    /*
     * The other half of a correct rename. If both names worked forever, a
     * consultant could keep spending a client's credential through a name the
     * client no longer goes by — and two names for one client is the ambiguity
     * migration 025 removed.
     */
    const id = await makeClient("Nestle");
    await giveKey("Nestle");
    await rename(id, "Nestlé USA");
    expect(await activeKeyFor(tenant, "Nestle", "gemini-aistudio")).toBeNull();
  });

  it("a key attached before the client existed still works, on the norm", async () => {
    /*
     * The fallback arm. A setup link can be redeemed before anyone fills in
     * Pre-Engagement, and every key attached before v5.34.67 has no
     * engagement_id at all. Those must keep working exactly as they did.
     */
    await db.query(
      `INSERT INTO byok_keys
         (tenant_id, client_norm, client_name, provider, status, secret_name, key_hint,
          paid_tier_attested, attested_by_email, attested_at, attestation_text, engagement_id)
       VALUES ($1, $2, $3, 'gemini-aistudio', 'active', 'projects/p/s/versions/1', 'oldk',
               true, 'a@b.com', now(), 'attested', NULL)`,
      [tenant, normClient("Orphan Corp"), "Orphan Corp"]
    );
    const found = await activeKeyFor(tenant, "Orphan Corp", "gemini-aistudio");
    expect(found, "a pre-v5.34.67 key stopped working").not.toBeNull();
    expect(found!.keyHint).toBe("oldk");
  });

  it("never reaches another client's key through a shared norm", async () => {
    // Two engagements, two keys, one lookup. The engagement arm must not widen
    // what a client name can reach.
    await makeClient("Alpha Co");
    await makeClient("Beta Co");
    await giveKey("Alpha Co");
    await giveKey("Beta Co");
    const a = await activeKeyFor(tenant, "Alpha Co", "gemini-aistudio");
    expect(a!.clientName).toBe("Alpha Co");
    const b = await activeKeyFor(tenant, "Beta Co", "gemini-aistudio");
    expect(b!.clientName).toBe("Beta Co");
  });

  it("the SQL normaliser agrees with the TypeScript one", async () => {
    /*
     * The backfill in migration 037 matches on vyne_norm_client(). If it drifts
     * from normClient(), rows bind to the wrong engagement or to none — silently,
     * because a NULL engagement_id just falls back to the norm and looks fine
     * until a rename.
     */
    const cases = ["Nestlé USA", "Acme Industrial", "  Newell  Brands ", "ZZ BYOK Test",
                   "Ünïcodé & Co.", "123 Numbers", "", "a".repeat(140)];
    for (const c of cases) {
      const r = await db.query<{ n: string }>(`SELECT vyne_norm_client($1) AS n`, [c]);
      expect(r.rows[0].n, `disagreement on ${JSON.stringify(c)}`).toBe(normClient(c));
    }
  });
});
