/**
 * The live-session hold/release pair, and what happens when they age apart.
 *
 * v5.32.63 (audit V2-CR-1). A live session writes TWO rows: a positive HOLD
 * when it opens (a pre-authorisation for the whole 45-minute grant) and a
 * negative RELEASE when it closes. Both are non-billable, and the aging clause
 * the spend caps apply was written per ROW:
 *
 *   AND (NOT (task = ANY($1)) OR created_at > now() - make_interval(secs => $2))
 *
 * That clause exists so an abandoned hold — a crashed tab, a close that never
 * arrived — stops occupying the tenant's budget once no session could still be
 * alive. Applied to a row on its own it is right. Applied to a PAIR whose halves
 * carry different timestamps it is not: the release is always newer than its
 * hold, so a session held open past the grant window closes into a state where
 * the hold has aged OUT of the sum and the negative release has not. Each such
 * session contributes about minus 135,000 tokens, and they stack.
 *
 * Once the sum goes negative, `used >= limit` is false and every spend cap in
 * the tenant switches off — for all users, not just whoever caused it.
 *
 * EVERY ASSERTION HERE GOES THROUGH dbLimitCheck. An earlier version of this
 * file re-implemented the cap query inline and asserted against its own copy,
 * which proved nothing about the shipped code and passed the fix by. If a test
 * has to restate the logic it is testing, it is testing itself.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { dbLimitCheck, dbMeter, capsCheckOn } from "../src/llm/metering.js";
import { TASK_HOLD, TASK_HOLD_RELEASE, MAX_SESSION_SECONDS } from "../src/llm/liveSession.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5433/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:apppw@localhost:5433/vyne";

const MONTHLY = 100_000;
const DAILY = 50_000;

describe.skipIf(!ENABLED)("live-session holds and releases must age together", () => {
  let admin: pg.Client;
  let tenant: string;
  let userId: string;

  /** Write a usage row directly, with a chosen age — the whole point here. */
  async function row(task: string, tokens: number, ageSeconds: number, sessionId: string | null) {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(
      `INSERT INTO usage_events
         (tenant_id, user_id, module, task, provider, model, tokens_in, tokens_out,
          cost_est_usd, latency_ms, ok, session_id, created_at)
       VALUES ($1, $2, 'interview_agent', $3, 'gemini-live', 'live', $4, 0, 0, 1, true, $5,
               now() - make_interval(secs => $6))`,
      [tenant, userId, task, tokens, sessionId, ageSeconds]
    );
    await admin.query("COMMIT");
  }

  async function clearUsage() {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(`DELETE FROM usage_events WHERE tenant_id = $1`, [tenant]);
    await admin.query("COMMIT");
  }

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name, monthly_token_limit, daily_user_token_limit)
       VALUES ('Aging Firm', $1, $2) RETURNING id`, [MONTHLY, DAILY]);
    tenant = t.rows[0].id;
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-aging', 'aging@firm.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    userId = u.rows[0].id;
    initPool(APP_URL);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await admin.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await admin.end();
    await closePool();
  });

  /** Put the tenant genuinely over its monthly cap with REAL billable spend. */
  async function spendOverTheMonthlyCap() {
    await clearUsage();
    await dbMeter({
      tenantId: tenant, userId, module: "m", task: "interview_turn",
      provider: "p", model: "m", tokensIn: MONTHLY + 5_000, tokensOut: 0,
      costEstUsd: 0, latencyMs: 1, ok: true,
    });
  }

  it("a tenant genuinely over its cap is denied", async () => {
    await spendOverTheMonthlyCap();
    const r = await dbLimitCheck(tenant, userId);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("monthly_token_limit_exceeded");
  });

  it("ONE aged session closing must not reopen a cap that is genuinely exhausted", async () => {
    await spendOverTheMonthlyCap();
    // The session sat open past the grant window, then closed. Hold is old,
    // release is seconds old.
    await row(TASK_HOLD, 135_000, MAX_SESSION_SECONDS + 300, "s-aged");
    await row(TASK_HOLD_RELEASE, -135_000, 5, "s-aged");

    const r = await dbLimitCheck(tenant, userId);
    // Before the fix the sum went to about −30,000 and this came back allowed:
    // an exhausted firm-wide spend cap switched off by an interviewee waiting
    // 45 minutes before hanging up.
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("monthly_token_limit_exceeded");
  });

  it("a burst of aged sessions cannot drive the cap arbitrarily open", async () => {
    await spendOverTheMonthlyCap();
    for (let i = 0; i < 8; i++) {
      await row(TASK_HOLD, 135_000, MAX_SESSION_SECONDS + 600, `s-burst-${i}`);
      await row(TASK_HOLD_RELEASE, -135_000, 2, `s-burst-${i}`);
    }
    const r = await dbLimitCheck(tenant, userId);
    expect(r.allowed).toBe(false);
  });

  it("the same trick must not reopen the per-user DAILY cap either", async () => {
    await clearUsage();
    // Over the daily cap but under the monthly one, so only the daily can deny.
    await dbMeter({
      tenantId: tenant, userId, module: "m", task: "interview_turn",
      provider: "p", model: "m", tokensIn: DAILY + 1_000, tokensOut: 0,
      costEstUsd: 0, latencyMs: 1, ok: true,
    });
    expect((await dbLimitCheck(tenant, userId)).reason).toBe("daily_user_token_limit_exceeded");

    await row(TASK_HOLD, 135_000, MAX_SESSION_SECONDS + 300, "s-daily");
    await row(TASK_HOLD_RELEASE, -135_000, 5, "s-daily");
    const r = await dbLimitCheck(tenant, userId);
    // The two caps read the same table; fixing one and not the other is how
    // this class of bug got shipped in the first place.
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("daily_user_token_limit_exceeded");
  });

  it("a released hold inside the window still nets to zero", async () => {
    await clearUsage();
    await row(TASK_HOLD, 135_000, 60, "s-recent");
    await row(TASK_HOLD_RELEASE, -135_000, 10, "s-recent");
    await dbMeter({
      tenantId: tenant, userId, module: "m", task: "interview_turn",
      provider: "p", model: "m", tokensIn: 400, tokensOut: 0, costEstUsd: 0,
      latencyMs: 1, ok: true,
    });
    // 400 real tokens against a 100,000 cap.
    expect((await dbLimitCheck(tenant, userId)).allowed).toBe(true);
  });

  it("an ABANDONED hold still ages out — the behaviour the clause exists for", async () => {
    await clearUsage();
    // A hold whose release never arrived. It must NOT hold the budget hostage:
    // one 45-minute grant is 135,000 tokens against a 100,000 cap, so if it
    // still counted, this tenant would be locked out having spent nothing.
    await row(TASK_HOLD, 135_000, MAX_SESSION_SECONDS + 900, "s-abandoned");
    const r = await dbLimitCheck(tenant, userId);
    expect(r.allowed).toBe(true);
  });

  it("a hold from a session that could STILL be running counts", async () => {
    await clearUsage();
    // Concurrent sessions must not each see a budget the others have claimed,
    // so a fresh unreleased hold has to occupy it.
    await row(TASK_HOLD, 135_000, 30, "s-live-now");
    const r = await dbLimitCheck(tenant, userId);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("monthly_token_limit_exceeded");
  });

  it("legacy rows with no session_id keep the original per-row rule", async () => {
    await clearUsage();
    await row(TASK_HOLD, 135_000, MAX_SESSION_SECONDS + 300, null);
    // Nothing to pair it to, so per-row aging is all that can be said about it.
    expect((await dbLimitCheck(tenant, userId)).allowed).toBe(true);
    await clearUsage();
    await row(TASK_HOLD, 135_000, 30, null);
    expect((await dbLimitCheck(tenant, userId)).allowed).toBe(false);
  });
});

/**
 * The window boundary — the half of V2-CR-1 that v5.32.77 clamped instead of
 * fixing (v5.32.83).
 *
 * Pairing a session by its earliest non-billable row only works while both
 * halves sit inside the accounting window. At a boundary they do not: a session
 * opened at 23:52 and closed at 00:03 leaves its POSITIVE hold in yesterday and
 * its NEGATIVE release alone in today. Today's CTE sees one row for that
 * session, seconds old, judges it live, and counts minus a whole grant.
 *
 * v5.32.77 wrapped the total in GREATEST(..., 0) and recorded the residual as
 * "briefly under-counting by one session's hold". That is not what a clamp
 * does. It floors the WHOLE window at zero, so every real token spent in it
 * disappears along with the artifact, and a tenant that is genuinely over its
 * cap reads as having spent nothing. The number stopped being negative and the
 * cap stayed off.
 *
 * These tests are deliberately built to fail against the clamped-but-unfixed
 * code, which the previous suite could not do:
 *
 *  - the orphan tests need no particular time of day. An orphaned negative
 *    release is the residue a straddle leaves behind, and it is reproducible
 *    at 3pm.
 *  - the midnight test reproduces the real boundary at any wall-clock time by
 *    moving the boundary instead of waiting for it: the connection's TimeZone
 *    is set to the offset that puts local midnight five minutes in the past,
 *    so `date_trunc('day', now())` — the shipped expression, unmodified — lands
 *    between the hold and the release. It goes through `capsCheckOn`, which is
 *    the whole of `dbLimitCheck` bar the advisory lock; the lock is what forces
 *    the separate connection, and the session TimeZone is what has to be set on
 *    it.
 *
 * The monthly cap is not separately reproducible mid-month — no legal TimeZone
 * offset moves `now()` across a month boundary — but it is not separately
 * implemented either: both caps interpolate the same excludedSessionsCte, and
 * the first test below asserts the monthly cap against the same orphan.
 */
describe.skipIf(!ENABLED)("a session that nets negative in the window is an artifact, not headroom", () => {
  let admin: pg.Client;
  let tenant: string;
  let userId: string;

  async function row(task: string, tokens: number, ageSeconds: number, sessionId: string | null) {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(
      `INSERT INTO usage_events
         (tenant_id, user_id, module, task, provider, model, tokens_in, tokens_out,
          cost_est_usd, latency_ms, ok, session_id, created_at)
       VALUES ($1, $2, 'interview_agent', $3, 'gemini-live', 'live', $4, 0, 0, 1, true, $5,
               now() - make_interval(secs => $6))`,
      [tenant, userId, task, tokens, sessionId, ageSeconds]
    );
    await admin.query("COMMIT");
  }

  async function clearUsage() {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(`DELETE FROM usage_events WHERE tenant_id = $1`, [tenant]);
    await admin.query("COMMIT");
  }

  /**
   * The UTC offset that puts local midnight `agoSec` seconds in the past, as a
   * Postgres `INTERVAL ... HOUR TO MINUTE` literal. Offsets are legal to
   * ±15:59, so the far side of the clock is reached by going the other way
   * round.
   */
  function offsetPuttingMidnightAgo(agoSec: number): string {
    const d = new Date();
    const utcSec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    let off = agoSec - utcSec;
    if (off < -15.5 * 3600) off += 24 * 3600;
    if (off > 15.5 * 3600) off -= 24 * 3600;
    const abs = Math.abs(off);
    const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
    const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
    return `${off < 0 ? "-" : "+"}${hh}:${mm}`;
  }

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name, monthly_token_limit, daily_user_token_limit)
       VALUES ('Boundary Firm', $1, $2) RETURNING id`, [MONTHLY, DAILY]);
    tenant = t.rows[0].id;
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-boundary', 'boundary@firm.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    userId = u.rows[0].id;
    initPool(APP_URL);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await admin.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await admin.end();
    await closePool();
  });

  it("an orphaned release does not switch off the MONTHLY cap", async () => {
    await clearUsage();
    // Genuinely over the monthly cap, in billable spend.
    await dbMeter({
      tenantId: tenant, userId, module: "m", task: "interview_turn",
      provider: "p", model: "m", tokensIn: MONTHLY + 5_000, tokensOut: 0,
      costEstUsd: 0, latencyMs: 1, ok: true,
    });
    expect((await dbLimitCheck(tenant, userId)).reason).toBe("monthly_token_limit_exceeded");

    // The residue of a session whose hold is in the previous window: a lone
    // negative release, seconds old, so the aging clause cannot reach it.
    await row(TASK_HOLD_RELEASE, -135_000, 5, "s-orphan-month");

    const r = await dbLimitCheck(tenant, userId);
    // Unclamped this read −29,000. Clamped it reads 0 — which is still under
    // the limit, so the cap is still off. Only excluding the session restores
    // the 105,000 that was actually spent.
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("monthly_token_limit_exceeded");
  });

  it("an orphaned release does not switch off the per-user DAILY cap", async () => {
    await clearUsage();
    await dbMeter({
      tenantId: tenant, userId, module: "m", task: "interview_turn",
      provider: "p", model: "m", tokensIn: DAILY + 1_000, tokensOut: 0,
      costEstUsd: 0, latencyMs: 1, ok: true,
    });
    expect((await dbLimitCheck(tenant, userId)).reason).toBe("daily_user_token_limit_exceeded");

    await row(TASK_HOLD_RELEASE, -135_000, 5, "s-orphan-day");

    const r = await dbLimitCheck(tenant, userId);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("daily_user_token_limit_exceeded");
  });

  it("a session straddling local midnight does not switch off the DAILY cap", async () => {
    await clearUsage();
    // Real billable spend over the daily cap, one minute ago.
    await row("interview_turn", DAILY + 1_000, 60, null);
    // Opened ten minutes before local midnight, closed five seconds ago.
    await row(TASK_HOLD, 135_000, 300 + 600, "s-straddle");
    await row(TASK_HOLD_RELEASE, -135_000, 5, "s-straddle");

    const offset = offsetPuttingMidnightAgo(300);
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(`SET LOCAL TIME ZONE INTERVAL '${offset}' HOUR TO MINUTE`);

    // The fixture is only meaningful if the boundary really does fall between
    // the two halves. Assert that rather than trusting the arithmetic — a test
    // whose setup silently misses reports the property as held.
    const placed = await admin.query<{ task: string; in_window: boolean }>(
      `SELECT task, created_at >= date_trunc('day', now()) AS in_window
         FROM usage_events WHERE tenant_id = $1 AND session_id = 's-straddle'`, [tenant]);
    const byTask = Object.fromEntries(placed.rows.map((x) => [x.task, x.in_window]));
    expect(byTask[TASK_HOLD]).toBe(false);
    expect(byTask[TASK_HOLD_RELEASE]).toBe(true);

    const r = await capsCheckOn(admin as unknown as Parameters<typeof capsCheckOn>[0], userId);
    await admin.query("ROLLBACK");

    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("daily_user_token_limit_exceeded");
  });

  it("still lets a normal in-window session net to zero", async () => {
    // The exclusion must not be so eager that an ordinary hold/release pair
    // stops cancelling out — that would over-count every closed session.
    await clearUsage();
    await row(TASK_HOLD, 135_000, 60, "s-normal");
    await row(TASK_HOLD_RELEASE, -135_000, 10, "s-normal");
    await dbMeter({
      tenantId: tenant, userId, module: "m", task: "interview_turn",
      provider: "p", model: "m", tokensIn: 400, tokensOut: 0, costEstUsd: 0,
      latencyMs: 1, ok: true,
    });
    expect((await dbLimitCheck(tenant, userId)).allowed).toBe(true);
  });

  it("still lets a live unreleased hold occupy the budget", async () => {
    await clearUsage();
    await row(TASK_HOLD, 135_000, 30, "s-live");
    const r = await dbLimitCheck(tenant, userId);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("monthly_token_limit_exceeded");
  });
});

/**
 * The paywall wrapper must not lose the user (audit V2-H1).
 *
 * Pure composition — no database. The defect was a dropped argument, and a
 * dropped argument is only visible if something records what the inner check
 * was actually called with. Both halves are injected so this test observes the
 * real wrapper rather than restating it.
 */
describe("withSubscriptionGate", () => {
  it("passes the userId through to BOTH the gate and the inner limit check", async () => {
    const { withSubscriptionGate } = await import("../src/billing/subscriptions.js");
    const gateSaw: Array<[string, string | null | undefined]> = [];
    const innerSaw: Array<[string, string | null | undefined]> = [];

    const gated = withSubscriptionGate(
      async (t, u) => { gateSaw.push([t, u]); return { allowed: true }; },
      async (t, u) => { innerSaw.push([t, u]); return { allowed: true }; }
    );
    const r = await gated("tenant-1", "user-9");

    expect(r.allowed).toBe(true);
    expect(gateSaw).toEqual([["tenant-1", "user-9"]]);
    // This is the assertion that was failing in production: before the fix the
    // wrapper called the inner check with the tenant only, so dbLimitCheck's
    // `if (userId)` daily-cap block never ran.
    expect(innerSaw).toEqual([["tenant-1", "user-9"]]);
  });

  it("does not reach the token caps at all when the subscription gate denies", async () => {
    const { withSubscriptionGate } = await import("../src/billing/subscriptions.js");
    let innerCalls = 0;
    const gated = withSubscriptionGate(
      async () => ({ allowed: false, reason: "subscription_inactive" }),
      async () => { innerCalls++; return { allowed: true }; }
    );
    const r = await gated("tenant-1", "user-9");
    expect(r).toEqual({ allowed: false, reason: "subscription_inactive" });
    expect(innerCalls).toBe(0);
  });
});
