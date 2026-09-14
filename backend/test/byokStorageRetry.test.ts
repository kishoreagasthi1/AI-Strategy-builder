/**
 * A storage failure must leave the client able to retry. (v5.34.69)
 *
 * ── Why this is a separate file from byokStorageFailure.test.ts ─────────────
 *
 * That file stubs db/pool with vi.doMock + vi.resetModules(), which is right
 * for the subject it owns — what the CLIENT is told when their key cannot be
 * stored. But resetModules() wipes the module registry, so a test in the same
 * file that wants the REAL pool gets a different instance from the one
 * initPool() set up, and every query fails for a reason that has nothing to do
 * with the behaviour under test. Mocked and unmocked belong in separate files.
 *
 * ── What only a real database can show ─────────────────────────────────────
 *
 * The invite row. The route marks a setup link used only AFTER the key is
 * safely stored, so a storage failure must leave it live — and the message the
 * client reads says so in as many words: "this link still works". If that were
 * wrong the sentence would be a lie, and a client who had just handed over a
 * credential would need a new link from a firm that does not yet know anything
 * failed. A stub cannot prove it; this runs the real route against a real
 * invite, fails it, and then succeeds on the same token.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import { byokPublicRoutes } from "../src/routes/byok.js";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import type { KeyProbe } from "../src/llm/byok/verifyKey.js";

const GOOD: KeyProbe = {
  checkedAt: new Date().toISOString(), canGenerate: true, canMintLiveToken: true,
  modelCount: 55, hasNativeAudio: true, status: { generate: 200, models: 200, authTokens: 200 },
};

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

describe.skipIf(!ENABLED)("v5.34.69 — storage failure, against a real database", () => {
  let db: pg.Client;
  let tenant: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    initPool(ADMIN_URL);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    tenant = (await db.query(
      `INSERT INTO tenants (name) VALUES ('Storage Failure Firm') RETURNING id`)).rows[0].id;
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant]);
  }, 60_000);

  beforeEach(async () => {
    await db.query(`DELETE FROM byok_invites WHERE tenant_id = $1`, [tenant]);
    await db.query(`DELETE FROM byok_keys WHERE tenant_id = $1`, [tenant]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await db.end();
    await closePool();
  });

  /** A live setup link, exactly as POST /api/byok/invites creates one. */
  const makeInvite = async () => {
    const token = randomBytes(32).toString("base64url");
    await db.query(
      `INSERT INTO byok_invites
         (tenant_id, client_norm, client_name, provider, token_hash, expires_at)
       VALUES ($1, 'realclient', 'Real Client', 'gemini-aistudio', $2, now() + interval '72 hours')`,
      [tenant, createHash("sha256").update(token).digest("hex")]);
    return token;
  };

  const appWithRealDb = async (putKey: any) => {
    const app = Fastify();
    await byokPublicRoutes(app, {
      secretStore: { projectId: "p" },
      probe: (async () => GOOD) as any,
      putKey,
      appBaseUrl: "https://app.example",
    });
    await app.ready();
    return app;
  };

  const redeem = (app: any, token: string) =>
    app.inject({ method: "POST", url: `/api/byok/redeem/${token}`,
      payload: { apiKey: "AQ.a-real-looking-key", attestedByEmail: "a@b.com", paidTierAttested: true } });

  it("returns 502 and leaves the link USABLE, so the client can retry", async () => {
    const token = await makeInvite();
    const app = await appWithRealDb(async () => { throw new Error("PERMISSION_DENIED: secrets.create"); });
    const r = await redeem(app, token);
    await app.close();

    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe("key_not_stored");
    // The message promises the link still works. This is that promise, checked.
    expect(r.json().detail).toMatch(/this link still works/i);
    const inv = await db.query<{ used_at: Date | null }>(
      `SELECT used_at FROM byok_invites WHERE tenant_id = $1`, [tenant]);
    expect(inv.rows[0].used_at, "the link was consumed by a failure that stored nothing").toBeNull();
  });

  it("stores no key row when the secret could not be written", async () => {
    const token = await makeInvite();
    const app = await appWithRealDb(async () => { throw new Error("PERMISSION_DENIED: secrets.create"); });
    await redeem(app, token);
    await app.close();
    const keys = await db.query(`SELECT 1 FROM byok_keys WHERE tenant_id = $1`, [tenant]);
    expect(keys.rowCount, "a key row exists for a secret that was never stored").toBe(0);
  });

  it("the retry succeeds once the permission is fixed", async () => {
    /*
     * The whole point of leaving the link live. Same token, same client, a
     * putKey that now works — and the client is done, with no second link and
     * no conversation with the firm.
     */
    const token = await makeInvite();
    const failing = await appWithRealDb(async () => { throw new Error("PERMISSION_DENIED"); });
    expect((await redeem(failing, token)).statusCode).toBe(502);
    await failing.close();

    const working = await appWithRealDb(async (_o: any, ref: any, key: string) => ({
      secretName: `projects/p/secrets/s-${ref.clientNorm}/versions/1`,
      version: "1", keyHint: key.slice(-4),
    }));
    const ok = await redeem(working, token);
    await working.close();

    expect(ok.statusCode).toBe(200);
    const keys = await db.query<{ status: string }>(
      `SELECT status FROM byok_keys WHERE tenant_id = $1`, [tenant]);
    expect(keys.rows[0].status).toBe("active");
    // And NOW the link is spent.
    const inv = await db.query<{ used_at: Date | null }>(
      `SELECT used_at FROM byok_invites WHERE tenant_id = $1`, [tenant]);
    expect(inv.rows[0].used_at).not.toBeNull();
  });
});
