/**
 * Realtime voice on a CLIENT's own key — the whole ledger, end to end. (v5.34.59)
 *
 * Voice is where the money is: a 90-minute interview is about $2 of live audio,
 * and "Gemini for the voice interviews" is the BYOK request this product
 * actually receives. It is also the path with the most ways to get the ledger
 * wrong, because one session writes THREE rows — a hold, a release and the
 * actual usage — and all three have to agree about who paid. If they do not,
 * the statement carries a reservation the release never cancels, which is the
 * $6.62-of-phantom-charges shape v5.34.48 spent a release fixing.
 *
 * So these run against a real Postgres and then read usage_events back.
 * Everything else (Google itself) is faked; nothing here mints a real token.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { voiceRoutes } from "../src/routes/voice.js";
import { LlmGateway } from "../src/llm/gateway.js";
import { dbMeter } from "../src/llm/metering.js";
import { PROD_POLICY } from "../src/llm/router.js";
import type { ByokLiveBinding } from "../src/llm/byok/resolveLive.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

/** A stand-in LiveSession. `minted` records that this key served a session. */
function fakeLive(opts: { key: string; freeTier?: boolean; fail?: string }) {
  const minted: string[] = [];
  return {
    minted,
    live: {
      isConfigured: () => true,
      model: "models/gemini-3.1-flash-live-preview",
      voice: "Aoede",
      freeTier: opts.freeTier ?? false,
      async mint(sessionId: string, maxSeconds: number) {
        if (opts.fail) throw new Error(opts.fail);
        minted.push(opts.key);
        return {
          token: `tok-${sessionId}`, model: "models/gemini-3.1-flash-live-preview",
          voice: "Aoede", maxSeconds, expiresAt: new Date(Date.now() + 60_000).toISOString(),
          sessionId, pinned: true,
        };
      },
    } as any,
  };
}

/**
 * One app, whose platform key and client binding are chosen per test.
 *
 * Built fresh each time rather than rebound through a proxy: a shared app whose
 * behaviour depends on module state is exactly the kind of thing that makes a
 * test pass for the wrong reason.
 */
async function appWith(opts: {
  tenant: string;
  user: string;
  platform: ReturnType<typeof fakeLive>;
  binding?: ByokLiveBinding | null;
  onRejected?: (i: { tenantId: string; clientName: string; detail: string }) => void;
}): Promise<FastifyInstance> {
  const app = Fastify();
  const gateway = new LlmGateway({
    adapters: [], policy: PROD_POLICY, meter: dbMeter, blockFreeTier: true,
  });
  await app.register(async (scope) => {
    scope.addHook("preHandler", async (req: any) => {
      // Owner, so resolveBillingClient passes the requested client straight
      // through — client assignment is tested elsewhere and is not the subject.
      req.ctx = { tenantId: opts.tenant, userId: opts.user, role: "owner" };
    });
    await voiceRoutes(
      scope, gateway,
      { isConfigured: () => false, freeTier: false, model: "tts" } as any,
      dbMeter,
      opts.platform.live,
      {
        forClient: async (_t, clientName) => (clientName ? opts.binding ?? null : null),
        onRejected: opts.onRejected,
      }
    );
  });
  await app.ready();
  return app;
}

describe.skipIf(!ENABLED)("v5.34.59 — voice sessions on a client's own key", () => {
  let db: pg.Client;
  let tenant: string;
  let user: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    initPool(ADMIN_URL);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    tenant = (await db.query(`INSERT INTO tenants (name) VALUES ('Voice BYOK Firm') RETURNING id`)).rows[0].id;
    user = (await db.query(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-byok-voice','v@firm.com')
         ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`)).rows[0].id;
    /*
     * usage_events is FORCE row-level security, so this inspection connection
     * sees NOTHING until it names a tenant — including its own DELETEs, which
     * would silently no-op and let holds pile up across tests until the
     * concurrency guard started returning 429.
     *
     * Set here rather than assumed: on a machine where the test role happens
     * to be SUPERUSER, RLS is bypassed entirely and every assertion below
     * would pass for the wrong reason. That mistake has been made in this
     * repo before.
     */
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant]);
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM usage_events WHERE tenant_id = $1`, [tenant]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM usage_events WHERE tenant_id = $1`, [tenant]);
    await db.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await db.end();
    await closePool();
  });

  const clientBinding = (over: Partial<ByokLiveBinding> = {}): ByokLiveBinding => ({
    live: fakeLive({ key: "CLIENT-LIVE-KEY" }).live,
    keyHint: "3xyz", clientName: "Nestle", ...over,
  });

  const open = (app: FastifyInstance, clientName?: string) =>
    app.inject({ method: "POST", url: "/api/voice/live-session",
      payload: { module: "interview_agent", maxSeconds: 900, ...(clientName ? { clientName } : {}) } });

  const rows = async () =>
    (await db.query(
      `SELECT task, payer, payer_key_hint, cost_est_usd, session_id
         FROM usage_events WHERE tenant_id = $1 ORDER BY created_at, task`, [tenant])).rows as any[];

  it("without a client key, everything is platform-paid — unchanged behaviour", async () => {
    const app = await appWith({ tenant, user, platform: fakeLive({ key: "PLATFORM" }), binding: null });
    const r = await open(app, "Nestle");
    await app.close();

    expect(r.statusCode).toBe(200);
    expect(r.json().payer).toBe("platform");
    const ledger = await rows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].task).toBe("live_session_hold");
    expect(ledger[0].payer).toBe("platform");
    expect(ledger[0].payer_key_hint).toBeNull();
  });

  it("mints on the client's key and marks the HOLD as client-paid", async () => {
    const clientLive = fakeLive({ key: "CLIENT-LIVE-KEY" });
    const platform = fakeLive({ key: "PLATFORM" });
    const app = await appWith({
      tenant, user, platform, binding: clientBinding({ live: clientLive.live }),
    });
    const r = await open(app, "Nestle");
    await app.close();

    expect(r.statusCode).toBe(200);
    expect(r.json().payer).toBe("client_key");
    expect(clientLive.minted).toEqual(["CLIENT-LIVE-KEY"]);
    expect(platform.minted).toHaveLength(0);          // the firm's key sat idle

    const ledger = await rows();
    expect(ledger[0].task).toBe("live_session_hold");
    expect(ledger[0].payer).toBe("client_key");
    expect(ledger[0].payer_key_hint).toBe("3xyz");
  });

  it("the close path takes the payer from the LEDGER, not from the browser", async () => {
    const app = await appWith({ tenant, user, platform: fakeLive({ key: "PLATFORM" }), binding: clientBinding() });
    const sessionId = (await open(app, "Nestle")).json().sessionId;

    const close = await app.inject({
      method: "POST", url: "/api/voice/live-session/close",
      payload: {
        module: "interview_agent", sessionId, maxSeconds: 900,
        tokensIn: 4000, tokensOut: 9000, seconds: 400, clientName: "Nestle",
        // A hostile browser trying to move its own cost onto the firm. There
        // is no field for it, and there must never be one.
        payer: "platform",
      },
    });
    await app.close();
    expect(close.statusCode).toBe(200);

    const byTask = Object.fromEntries((await rows()).map((r) => [r.task, r]));
    expect(byTask["live_session_hold"].payer).toBe("client_key");
    expect(byTask["live_session_hold_release"].payer).toBe("client_key");
    expect(byTask["live_session"].payer).toBe("client_key");
    // The hold nets to zero against its release, within the same payer.
    expect(Number(byTask["live_session_hold"].cost_est_usd) +
           Number(byTask["live_session_hold_release"].cost_est_usd)).toBeCloseTo(0, 9);
    // The actual usage is what the client is charged by Google — recorded, and
    // kept off the invoice by routes/billing.ts.
    expect(Number(byTask["live_session"].cost_est_usd)).toBeGreaterThan(0);
  });

  it("a session that never started leaves nothing on the client's account", async () => {
    const app = await appWith({
      tenant, user,
      platform: fakeLive({ key: "PLATFORM" }),
      binding: clientBinding({ live: fakeLive({ key: "C", fail: "live-session 500: internal" }).live }),
    });
    const r = await open(app, "Nestle");
    await app.close();

    // A 500 is not a credential refusal, so there is no fallback: the session
    // failed, and the reservation must be given back in full.
    expect(r.statusCode).toBe(502);
    const ledger = await rows();
    expect(ledger.reduce((s, x) => s + Number(x.cost_est_usd), 0)).toBeCloseTo(0, 9);
    expect(new Set(ledger.map((x) => x.payer))).toEqual(new Set(["client_key"]));
  });

  it("a REFUSED client key falls back to the firm's, and the interview still starts", async () => {
    const rejections: { clientName: string; detail: string }[] = [];
    const platform = fakeLive({ key: "PLATFORM" });
    const app = await appWith({
      tenant, user, platform,
      binding: clientBinding({ live: fakeLive({ key: "DEAD", fail: "live-session 403: PERMISSION_DENIED" }).live }),
      onRejected: (i) => rejections.push({ clientName: i.clientName, detail: i.detail }),
    });
    const r = await open(app, "Nestle");
    await app.close();

    expect(r.statusCode).toBe(200);
    expect(r.json().payer).toBe("platform");       // the firm pays for this one
    expect(platform.minted).toEqual(["PLATFORM"]);
    expect(rejections).toHaveLength(1);            // and the Owner is told why
    expect(rejections[0].clientName).toBe("Nestle");

    const ledger = await rows();
    const clientRows = ledger.filter((x) => x.payer === "client_key");
    const platformRows = ledger.filter((x) => x.payer === "platform");
    // The abandoned client-paid attempt nets to exactly zero.
    expect(clientRows.reduce((s, x) => s + Number(x.cost_est_usd), 0)).toBeCloseTo(0, 9);
    expect(platformRows.some((x) => x.task === "live_session_hold")).toBe(true);
    /*
     * The retry is a SEPARATE session id. Reusing the first one would make the
     * second hold unreleasable — migration 015's partial unique index allows
     * one release per session — stranding the whole reservation on the firm's
     * budget for as long as the sweep takes to find it.
     */
    expect(platformRows[0].session_id).not.toBe(clientRows[0].session_id);
  });

  it("does NOT fall back to the firm when the client's key is merely rate-limited", async () => {
    // Falling back here would quietly migrate a client's costs onto the firm
    // every time Google had a bad minute.
    const rejections: any[] = [];
    const platform = fakeLive({ key: "PLATFORM" });
    const app = await appWith({
      tenant, user, platform,
      binding: clientBinding({ live: fakeLive({ key: "BUSY", fail: "live-session 429: RESOURCE_EXHAUSTED" }).live }),
      onRejected: (i) => rejections.push(i),
    });
    const r = await open(app, "Nestle");
    await app.close();

    expect(r.statusCode).toBe(502);
    expect(platform.minted).toHaveLength(0);
    expect(rejections).toHaveLength(0);            // the key is not demoted
    expect((await rows()).reduce((s, x) => s + Number(x.cost_est_usd), 0)).toBeCloseTo(0, 9);
  });

  it("a client's attested key runs even where the firm's own key is free-tier blocked", async () => {
    // The firm pilots on a free Google key; the client brings a billed one.
    // Refusing here would mean the client supplied a credential that is never
    // used, and kept paying the firm.
    const freePlatform = fakeLive({ key: "FREE-PLATFORM", freeTier: true });
    const paidClient = fakeLive({ key: "CLIENT-PAID", freeTier: false });
    const app = await appWith({
      tenant, user, platform: freePlatform, binding: clientBinding({ live: paidClient.live }),
    });
    const r = await open(app, "Nestle");
    await app.close();

    expect(r.statusCode).toBe(200);
    expect(r.json().payer).toBe("client_key");
    expect(paidClient.minted).toHaveLength(1);
    expect(freePlatform.minted).toHaveLength(0);
  });

  it("still blocks a free-tier session when nobody has a paid key", async () => {
    // The lockdown must not have been weakened into uselessness by the change
    // above: with no client key, a free-tier platform key is still refused.
    const app = await appWith({
      tenant, user, platform: fakeLive({ key: "FREE-PLATFORM", freeTier: true }), binding: null,
    });
    const r = await open(app, "Nestle");
    await app.close();

    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("live_free_tier_blocked");
    expect(await rows()).toHaveLength(0);           // nothing reserved
  });

  it("unattributed work never touches a client's key", async () => {
    const clientLive = fakeLive({ key: "CLIENT-LIVE-KEY" });
    const app = await appWith({ tenant, user, platform: fakeLive({ key: "PLATFORM" }),
                                binding: clientBinding({ live: clientLive.live }) });
    const r = await open(app);                      // no clientName
    await app.close();

    expect(r.statusCode).toBe(200);
    expect(r.json().payer).toBe("platform");
    expect(clientLive.minted).toHaveLength(0);
  });
});
