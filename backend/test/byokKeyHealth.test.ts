/**
 * "active" has to mean it worked, and a setup link has to be withdrawable.
 * (v5.34.61)
 *
 * The incident these close, measured on production 2026-09-13: the service
 * account lost one Secret Manager permission, every call for a BYOK client
 * silently fell back to the firm's own credentials, and the keys screen went on
 * saying `active` the whole time. Nothing errored. The only trace was a log
 * line, and the only symptom would have been a larger Google bill weeks later.
 *
 * Against a real Postgres, because the point is what is durably recorded.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import {
  upsertActiveKey, listKeys, recordResolveError, clearResolveError,
  listOpenInvites, revokeInvite,
} from "../src/llm/byok/byokRepo.js";
import { makeByokResolver } from "../src/llm/byok/resolve.js";
import type { KeyProbe } from "../src/llm/byok/verifyKey.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

const PROBE: KeyProbe = {
  checkedAt: new Date().toISOString(), canGenerate: true, canMintLiveToken: true,
  modelCount: 55, hasNativeAudio: true, status: { generate: 200, models: 200, authTokens: 200 },
};

describe.skipIf(!ENABLED)("v5.34.61 — key health and invite revocation", () => {
  let db: pg.Client;
  let tenant: string;
  let owner: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    initPool(ADMIN_URL);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    tenant = (await db.query(`INSERT INTO tenants (name) VALUES ('Health Firm') RETURNING id`)).rows[0].id;
    owner = (await db.query(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-health','h@firm.com')
         ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`)).rows[0].id;
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant]);
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM byok_events WHERE tenant_id = $1`, [tenant]);
    await db.query(`DELETE FROM byok_keys WHERE tenant_id = $1`, [tenant]);
    await db.query(`DELETE FROM byok_invites WHERE tenant_id = $1`, [tenant]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM byok_events WHERE tenant_id = $1`, [tenant]);
    await db.query(`DELETE FROM byok_keys WHERE tenant_id = $1`, [tenant]);
    await db.query(`DELETE FROM byok_invites WHERE tenant_id = $1`, [tenant]);
    await db.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await db.end();
    await closePool();
  });

  const addKey = () => upsertActiveKey({
    tenantId: tenant, clientName: "Nestle", provider: "gemini-aistudio",
    secretName: "projects/p/secrets/s/versions/1", keyHint: "wxyz", probe: PROBE,
    attestedByEmail: "admin@nestle.com", attestationText: "attested",
  });

  const only = async () => (await listKeys(tenant))[0];

  it("a healthy key carries no failure", async () => {
    await addKey();
    const k = await only();
    expect(k.status).toBe("active");
    expect(k.lastError).toBeNull();
  });

  it("records WHY a key could not be used, without demoting it", async () => {
    /*
     * Status stays active on purpose. Secret Manager being briefly unreachable
     * is not a client's key going bad, and demoting a good key over a blip
     * would move that client's costs onto the firm for real. The screen shows
     * both facts side by side instead.
     */
    await addKey();
    await recordResolveError(tenant, "nestle", "gemini-aistudio", "the key could not be read from Secret Manager");
    const k = await only();
    expect(k.status).toBe("active");
    expect(k.lastError).toMatch(/could not be read/);
    expect(k.lastErrorAt).not.toBeNull();
  });

  it("clears the failure once the key works again", async () => {
    await addKey();
    await recordResolveError(tenant, "nestle", "gemini-aistudio", "boom");
    await clearResolveError(tenant, "nestle", "gemini-aistudio");
    const k = await only();
    expect(k.lastError).toBeNull();
    expect(k.lastErrorAt).toBeNull();
  });

  it("writes only when the health state CHANGES", async () => {
    /*
     * This runs in the request path, so a write per generation would be a real
     * cost for bookkeeping. Repeating the same failure, or succeeding when
     * nothing was wrong, must touch nothing — measured on updated_at.
     */
    await addKey();
    await recordResolveError(tenant, "nestle", "gemini-aistudio", "same reason");
    const first = (await db.query(
      `SELECT updated_at FROM byok_keys WHERE tenant_id=$1`, [tenant])).rows[0].updated_at;

    await new Promise((r) => setTimeout(r, 25));
    await recordResolveError(tenant, "nestle", "gemini-aistudio", "same reason");
    const second = (await db.query(
      `SELECT updated_at FROM byok_keys WHERE tenant_id=$1`, [tenant])).rows[0].updated_at;
    expect(second.getTime()).toBe(first.getTime());          // no write

    await clearResolveError(tenant, "nestle", "gemini-aistudio");
    await new Promise((r) => setTimeout(r, 25));
    const cleared = (await db.query(
      `SELECT updated_at FROM byok_keys WHERE tenant_id=$1`, [tenant])).rows[0].updated_at;
    expect(cleared.getTime()).toBeGreaterThan(first.getTime());  // state changed → write

    await new Promise((r) => setTimeout(r, 25));
    await clearResolveError(tenant, "nestle", "gemini-aistudio");
    const again = (await db.query(
      `SELECT updated_at FROM byok_keys WHERE tenant_id=$1`, [tenant])).rows[0].updated_at;
    expect(again.getTime()).toBe(cleared.getTime());          // nothing to clear → no write
  });

  it("a new reason replaces the old one", async () => {
    await addKey();
    await recordResolveError(tenant, "nestle", "gemini-aistudio", "first reason");
    await recordResolveError(tenant, "nestle", "gemini-aistudio", "second reason");
    expect((await only()).lastError).toBe("second reason");
  });

  it("the resolver itself records the failure that caused the fallback", async () => {
    /*
     * End to end, through the real resolver: an unreadable secret must leave a
     * mark on the row, not only in a log. This is the exact production state
     * from 2026-09-13.
     */
    await addKey();
    const resolve = makeByokResolver({
      secretStore: { projectId: "p" },
      fetchKey: async () => null,                       // 403 → "no key", by design
      onResolveError: ({ tenantId, clientNorm, provider, reason }) => {
        if (clientNorm && reason) void recordResolveError(tenantId, clientNorm, provider, reason);
      },
    });
    const out = await resolve({ tenantId: tenant, clientName: "Nestle" });
    expect(out.adapters.size).toBe(0);                  // fell back, as designed
    await new Promise((r) => setTimeout(r, 120));       // the record is fire-and-forget
    const k = await only();
    expect(k.status).toBe("active");
    expect(k.lastError).toMatch(/Secret Manager/);
  });

  it("never throws when the key it describes has vanished", async () => {
    // Bookkeeping must not become the reason a call fails.
    await expect(recordResolveError(tenant, "nobody", "gemini-aistudio", "x")).resolves.toBeUndefined();
    await expect(clearResolveError(tenant, "nobody", "gemini-aistudio")).resolves.toBeUndefined();
  });

  /* ── invites ────────────────────────────────────────────────────────────── */

  const addInvite = async (clientName = "Nestle") =>
    (await db.query(
      `INSERT INTO byok_invites (tenant_id, client_norm, client_name, provider, token_hash, expires_at)
       VALUES ($1, lower($2), $2, 'gemini-aistudio', $3, now() + interval '72 hours') RETURNING id`,
      [tenant, clientName, "hash-" + Math.random()])).rows[0].id;

  it("lists only links still worth showing", async () => {
    const open = await addInvite("Nestle");
    const used = await addInvite("Humana");
    const gone = await addInvite("Acme");
    await db.query(`UPDATE byok_invites SET used_at = now() WHERE id = $1`, [used]);
    await db.query(`UPDATE byok_invites SET expires_at = now() - interval '1 hour' WHERE id = $1`, [gone]);

    const list = await listOpenInvites(tenant);
    expect(list.map((i) => i.id)).toEqual([open]);
  });

  it("never exposes anything that could be used as a link", async () => {
    // Only the token's HASH is stored, deliberately — so a lost link is
    // replaced, never re-sent. Nothing here may leak a usable value.
    await addInvite();
    const list = await listOpenInvites(tenant);
    expect(JSON.stringify(list)).not.toMatch(/token|hash/i);
  });

  it("revoking makes the link stop working, and says who did it", async () => {
    const id = await addInvite();
    expect(await revokeInvite(tenant, id, owner)).toBe(true);

    const row = (await db.query(
      `SELECT revoked_at, revoked_by, used_at FROM byok_invites WHERE id = $1`, [id])).rows[0];
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_by).toBe(owner);
    // Revoked is NOT the same as used — the audit trail keeps them apart.
    expect(row.used_at).toBeNull();
    expect(await listOpenInvites(tenant)).toHaveLength(0);
  });

  it("refuses to revoke twice, or to revoke a used link", async () => {
    const id = await addInvite();
    expect(await revokeInvite(tenant, id, owner)).toBe(true);
    expect(await revokeInvite(tenant, id, owner)).toBe(false);

    const used = await addInvite("Humana");
    await db.query(`UPDATE byok_invites SET used_at = now() WHERE id = $1`, [used]);
    expect(await revokeInvite(tenant, used, owner)).toBe(false);
  });

  it("cannot revoke another firm's link, and cannot tell it exists", async () => {
    const other = (await db.query(
      `INSERT INTO tenants (name) VALUES ('Other Firm') RETURNING id`)).rows[0].id;
    const theirs = (await db.query(
      `INSERT INTO byok_invites (tenant_id, client_norm, client_name, provider, token_hash, expires_at)
       VALUES ($1,'x','X','gemini-aistudio','hash-other', now() + interval '1 hour') RETURNING id`,
      [other])).rows[0].id;

    // Same false a non-existent id returns — no way to probe for other tenants.
    expect(await revokeInvite(tenant, theirs, owner)).toBe(false);
    expect(await revokeInvite(tenant, "00000000-0000-0000-0000-000000000000", owner)).toBe(false);

    const still = (await db.query(
      `SELECT revoked_at FROM byok_invites WHERE id = $1`, [theirs])).rows[0];
    expect(still.revoked_at).toBeNull();
    await db.query(`DELETE FROM byok_invites WHERE tenant_id = $1`, [other]);
    await db.query(`DELETE FROM tenants WHERE id = $1`, [other]);
  });
});
