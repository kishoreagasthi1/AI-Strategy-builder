/**
 * Deleting a client must not leave their API key live. (v5.34.68)
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 *
 * DELETE /api/clients removed interviews, workspace state, engagements and
 * consultant assignments — and nothing belonging to BYOK. Combined with 037's
 * `ON DELETE SET NULL`, that produced a specific and bad shape:
 *
 *   1. the engagement went, so byok_keys.engagement_id became NULL;
 *   2. a NULL engagement_id means the key falls back to matching on the
 *      client's NAME (engagementBinding.ts);
 *   3. so the firm went on holding a live, ACTIVE credential belonging to a
 *      client it had just deleted — invisible on every screen except the keys
 *      table;
 *   4. and anyone who later created a client with the same name INHERITED it.
 *
 * (4) is the one that matters. "Delete Nestle, re-create Nestle" is an ordinary
 * thing to do after a false start, and it silently reconnected someone else's
 * credential to a new engagement.
 *
 * Found while preparing to delete two test clients from production — which is
 * to say, found by asking what a destructive operation would actually do
 * before running it, rather than afterwards.
 *
 * ── What it does now ────────────────────────────────────────────────────────
 *
 * The key row is KEPT and switched off. It carries the attestation — the words
 * the client's administrator agreed to, who agreed, and when — which is the
 * record behind charges the client has already paid. The preference and the
 * grant carry no such record and are deleted outright; a standing grant in
 * particular must not outlive the client it was made for.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { assignmentRoutes } from "../src/routes/assignments.js";
import { activeKeyFor } from "../src/llm/byok/byokRepo.js";
import { routingFor } from "../src/llm/byok/clientRouting.js";
import { hasFallbackGrant } from "../src/llm/byok/fallbackGrant.js";
import { normClient } from "../src/auth/clients.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

describe.skipIf(!ENABLED)("v5.34.68 — deleting a client takes their key out of service", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let tenant: string;
  let owner: string;

  const CLIENT = "ZZ Delete Me";
  const NORM = normClient(CLIENT);

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    initPool(ADMIN_URL);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    tenant = (await db.query(
      `INSERT INTO tenants (name) VALUES ('Deletion Firm') RETURNING id`)).rows[0].id;
    owner = (await db.query(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-del-owner','d@firm.com')
         ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`)).rows[0].id;
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant]);

    app = Fastify();
    await app.register(async (scope) => {
      scope.addHook("preHandler", async (req: any) => {
        req.ctx = { tenantId: tenant, userId: owner, role: "owner" };
      });
      await assignmentRoutes(scope);
    });
    await app.ready();
  }, 60_000);

  beforeEach(async () => {
    for (const t of ["byok_keys", "client_routing", "byok_fallback_grant", "engagements"]) {
      await db.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenant]);
    }
    await db.query(
      `INSERT INTO engagements (tenant_id, code, client_name) VALUES ($1,'DEL-1',$2)`,
      [tenant, CLIENT]);
    const eng = (await db.query<{ id: string }>(
      `SELECT id FROM engagements WHERE tenant_id = $1 AND client_name = $2`,
      [tenant, CLIENT])).rows[0].id;
    await db.query(
      `INSERT INTO byok_keys (tenant_id, client_norm, client_name, provider, status, secret_name,
         key_hint, paid_tier_attested, attested_by_email, attested_at, attestation_text, engagement_id)
       VALUES ($1,$2,$3,'gemini-aistudio','active','projects/p/s/versions/1','wxyz',
               true,'admin@client.example',now(),'I confirm this key belongs to a billed account.',$4)`,
      [tenant, NORM, CLIENT, eng]);
    await db.query(
      `INSERT INTO client_routing (tenant_id, client_norm, client_name, text_vendor, engagement_id)
       VALUES ($1,$2,$3,'anthropic-api',$4)`, [tenant, NORM, CLIENT, eng]);
    await db.query(
      `INSERT INTO byok_fallback_grant (tenant_id, client_norm, client_name, reason, engagement_id)
       VALUES ($1,$2,$3,'pilot',$4)`, [tenant, NORM, CLIENT, eng]);
  });

  afterAll(async () => {
    await app.close();
    await db.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await db.end();
    await closePool();
  });

  const deleteClient = (clientName = CLIENT) =>
    app.inject({ method: "DELETE", url: "/api/clients", payload: { clientName } });

  it("the key is no longer usable afterwards", async () => {
    expect(await activeKeyFor(tenant, CLIENT, "gemini-aistudio")).not.toBeNull();
    const r = await deleteClient();
    expect(r.statusCode).toBe(200);
    expect(await activeKeyFor(tenant, CLIENT, "gemini-aistudio"),
      "the firm still holds a live credential for a client it deleted").toBeNull();
  });

  it("re-creating a client with the same name does NOT inherit the old key", async () => {
    /*
     * The worst version of this, and an ordinary thing to do: delete a client
     * after a false start, then create them again. Before v5.34.68 the second
     * engagement silently picked up the first client's credential, because the
     * key had reverted to name-matching when its engagement was removed.
     */
    await deleteClient();
    await db.query(
      `INSERT INTO engagements (tenant_id, code, client_name) VALUES ($1,'DEL-2',$2)`,
      [tenant, CLIENT]);
    expect(await activeKeyFor(tenant, CLIENT, "gemini-aistudio"),
      "a newly created client inherited a deleted client's API key").toBeNull();
  });

  it("the preference and the grant are removed outright", async () => {
    await deleteClient();
    expect(await routingFor(tenant, CLIENT)).toBeNull();
    // The grant above all: it is standing permission to spend the firm's money
    // on this client, and it must not outlive them.
    expect(await hasFallbackGrant(tenant, CLIENT)).toBe(false);
  });

  it("keeps the key ROW, with its attestation, as the record of what was agreed", async () => {
    /*
     * Deleted, not destroyed. The attestation is the evidence behind charges
     * the client already paid on their own account — same reasoning that made
     * 037's foreign key SET NULL rather than CASCADE. What makes it safe is the
     * status, not the absence of the row.
     */
    await deleteClient();
    const r = await db.query<{ status: string; attestation_text: string; attested_by_email: string }>(
      `SELECT status, attestation_text, attested_by_email FROM byok_keys
        WHERE tenant_id = $1 AND client_norm = $2`, [tenant, NORM]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].status).toBe("disabled");
    expect(r.rows[0].attestation_text).toMatch(/billed account/);
    expect(r.rows[0].attested_by_email).toBe("admin@client.example");
  });

  it("says which keys it switched off, rather than leaving it to be discovered", async () => {
    const body = (await deleteClient()).json();
    expect(body.byokKeysDisabled).toEqual([`${CLIENT}:gemini-aistudio`]);
  });

  it("records it in the audit log", async () => {
    await deleteClient();
    await new Promise((r) => setTimeout(r, 150));
    const rows = await db.query<{ detail: any }>(
      `SELECT detail FROM audit_log WHERE tenant_id = $1 AND action = 'client_deleted'
        ORDER BY created_at DESC LIMIT 1`, [tenant]);
    expect(rows.rows[0].detail.byokKeysDisabled).toEqual([`${CLIENT}:gemini-aistudio`]);
  });

  it("leaves another client's key completely alone", async () => {
    // The delete matches on norm across a set; a mistake here would take out
    // credentials for clients nobody asked to remove.
    await db.query(
      `INSERT INTO engagements (tenant_id, code, client_name) VALUES ($1,'KEEP-1','Keep Me Ltd')`,
      [tenant]);
    await db.query(
      `INSERT INTO byok_keys (tenant_id, client_norm, client_name, provider, status, secret_name,
         key_hint, paid_tier_attested, attested_by_email, attested_at, attestation_text)
       VALUES ($1,$2,'Keep Me Ltd','gemini-aistudio','active','projects/p/s/versions/2','keep',
               true,'a@b.com',now(),'attested')`,
      [tenant, normClient("Keep Me Ltd")]);

    await deleteClient();
    expect(await activeKeyFor(tenant, "Keep Me Ltd", "gemini-aistudio")).not.toBeNull();
  });

  it("deleting a client who never had a key reports nothing disabled", async () => {
    await db.query(
      `INSERT INTO engagements (tenant_id, code, client_name) VALUES ($1,'NOK-1','No Key Ltd')`,
      [tenant]);
    const body = (await deleteClient("No Key Ltd")).json();
    expect(body.byokKeysDisabled).toEqual([]);
  });
});
