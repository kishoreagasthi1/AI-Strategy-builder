/**
 * Admitting a live session has to be one decision, not three (audit V2-H2).
 *
 * v5.32.65. Opening a live session used to run three separate transactions:
 *
 *   1. countRecentGrants()  — how many sessions has this user got open?
 *   2. gateway.checkLimit() — is the firm/user inside its spend caps?
 *   3. reserveSession()     — write the HOLD that makes this session visible.
 *
 * Steps 1 and 2 each took the per-tenant advisory lock, so each was internally
 * consistent. But the lock is `pg_advisory_xact_lock`, released at COMMIT, and
 * step 3 ran afterwards in a transaction of its own. The write that makes a
 * new session visible to the NEXT counter therefore landed after the lock that
 * was supposed to be guarding the decision had already gone.
 *
 * Two opens arriving together both read the pre-existing state, both pass, and
 * both reserve. The code comment on the old path conceded as much — "narrows,
 * not closes". What it costs: the concurrency ceiling is exceeded, and — the
 * expensive half — a firm one reservation away from its monthly cap grants two
 * or ten sessions at ~$1.42 of pre-authorised spend each, because none of them
 * can see the others' holds.
 *
 * A serial test cannot see any of this: run one at a time and the old code is
 * correct. So every assertion below fires the opens with Promise.all against a
 * real Postgres, and the fixture is arranged so that ONE is admissible and the
 * rest must not be.
 *
 * The reservation write now happens inside the same transaction, under the
 * same advisory lock, as the count and the caps check — so the second caller
 * blocks on the lock and, when it gets it, sees the first caller's committed
 * hold.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { admitLiveSession, dbMeter } from "../src/llm/metering.js";
import { TASK_HOLD, TASK_HOLD_RELEASE, reserveTokensFor } from "../src/llm/liveSession.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5433/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:apppw@localhost:5433/vyne";

/** A 15-minute grant, the product default. 22,500 in + 22,500 out. */
const GRANT_SECONDS = 15 * 60;
const GRANT = reserveTokensFor(GRANT_SECONDS);
const GRANT_TOKENS = GRANT.tokensIn + GRANT.tokensOut;

/**
 * Room for exactly ONE grant — never two.
 *
 * Set to the grant size exactly, not grant + headroom, because the caps ask
 * "is this tenant ALREADY over?" rather than "would this grant take it over".
 * So with a limit of 45,000 the first opener passes on used = 0 and the second
 * is refused on used = 45,000. (That asymmetry means a tenant can always
 * overshoot by up to one grant. It is inherent to reserving before the spend
 * happens, it is bounded and it is not what V2-H2 is about — but a fixture
 * with headroom would have hidden this test's real subject behind it, which is
 * how the first draft of this file passed with the bug present.)
 */
const MONTHLY = GRANT_TOKENS;
const DAILY = MONTHLY;

const WINDOW = 60 * 60;   // "open session" window for the concurrency count

describe.skipIf(!ENABLED)("live-session admission is atomic (V2-H2)", () => {
  let admin: pg.Client;
  let tenant: string;
  let userId: string;

  const open = (sessionId: string, maxConcurrent: number) =>
    admitLiveSession({
      tenantId: tenant, userId, module: "interview_agent",
      model: "gemini-live-2.5-flash-preview", clientName: "Race Co",
      sessionId, maxSeconds: GRANT_SECONDS,
      maxConcurrent, openWindowSeconds: WINDOW,
    });

  async function clearUsage() {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(`DELETE FROM usage_events WHERE tenant_id = $1`, [tenant]);
    await admin.query("COMMIT");
  }

  /** How many holds actually landed — the reservations, not the verdicts. */
  async function holds(): Promise<number> {
    const r = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM usage_events WHERE tenant_id = $1 AND task = $2`,
      [tenant, TASK_HOLD]
    );
    return Number(r.rows[0].n);
  }

  async function reservedTokens(): Promise<number> {
    const r = await admin.query<{ n: string | null }>(
      `SELECT coalesce(sum(tokens_in + tokens_out), 0) AS n
         FROM usage_events WHERE tenant_id = $1 AND task = $2`,
      [tenant, TASK_HOLD]
    );
    return Number(r.rows[0].n ?? 0);
  }

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name, monthly_token_limit, daily_user_token_limit)
       VALUES ('Race Firm', $1, $2) RETURNING id`, [MONTHLY, DAILY]);
    tenant = t.rows[0].id;
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-race', 'race@firm.com')
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

  beforeEach(clearUsage);

  it("admits a first session at all (a test where nothing is admitted proves nothing)", async () => {
    const r = await open("s-solo", 3);
    expect(r.allowed).toBe(true);
    expect(await holds()).toBe(1);
  });

  /**
   * RACERS, and why it is not two.
   *
   * The audit describes the race with two callers, and two is enough to
   * exhibit it in principle. It is NOT enough to exhibit it reliably. With the
   * fix reverted and measured over twenty bursts, a pair almost always came
   * out correct: the loser of the advisory lock rarely got its counting query
   * in before the winner's follow-up transaction had committed the
   * reservation, because a backend woken from a lock wait is slower off the
   * mark than one already running. The window is narrow — which is exactly
   * what the old code's own comment conceded when it said the lock "narrows,
   * not closes" the race.
   *
   * A test that only fails on the seventh run is a test that will be believed
   * when it is wrong, so this is not left to chance. Measured against the
   * reverted code: 8 racers violated the invariant in 14 bursts out of 20, 16
   * racers in 15 of 20, and 32 racers in 20 of 20. Thirty-two it is. The fix
   * has to hold under fan-out anyway — "both count the pre-existing state"
   * generalises to N, and N is what a firm running parallel interviews looks
   * like.
   */
  const RACERS = 32;

  it("simultaneous opens at a ceiling of one admit exactly one", async () => {
    const rs = await Promise.all(
      Array.from({ length: RACERS }, (_, i) => open(`s-one-${i}`, 1))
    );

    expect(rs.filter((r) => r.allowed)).toHaveLength(1);
    expect(rs.filter((r) => r.reason === "too_many_live_sessions")).toHaveLength(RACERS - 1);

    // The verdict is not the point — the WRITE is. Before the fix several
    // callers were told yes and every one of their reservations landed.
    expect(await holds()).toBe(1);
  });

  it("simultaneous opens with budget for one are stopped by the SPEND cap", async () => {
    // Concurrency deliberately not the gate here: the ceiling is above the
    // number of racers, so the only thing that can refuse the rest is the caps
    // check seeing the first caller's hold. That hold is exactly what used to
    // land too late to be seen.
    const rs = await Promise.all(
      Array.from({ length: RACERS }, (_, i) => open(`s-cap-${i}`, RACERS + 5))
    );

    expect(rs.filter((r) => r.allowed)).toHaveLength(1);
    expect(rs.find((r) => !r.allowed)?.reason).toMatch(/token_limit_exceeded/);

    expect(await holds()).toBe(1);
    // The real damage was measured in money, so assert it in tokens: eight
    // grants is 360,000 pre-authorised tokens against a 45,000 cap.
    expect(await reservedTokens()).toBe(GRANT_TOKENS);
  });

  it("simultaneous opens at a ceiling of three admit exactly three", async () => {
    // A ceiling above one, because "exactly one" can be satisfied by accident
    // by a lock that serialises everything into a queue of length one.
    // Budget deliberately far out of the way so the ONLY thing refusing the
    // last three is the concurrency ceiling.
    await admin.query(`UPDATE tenants SET monthly_token_limit = $2, daily_user_token_limit = $2
                        WHERE id = $1`, [tenant, GRANT_TOKENS * 20]);
    try {
      const rs = await Promise.all(
        Array.from({ length: RACERS }, (_, i) => open(`s-fan-${i}`, 3))
      );
      expect(rs.filter((r) => r.allowed)).toHaveLength(3);
      expect(await holds()).toBe(3);
      expect(rs.filter((r) => r.reason === "too_many_live_sessions")).toHaveLength(RACERS - 3);
    } finally {
      await admin.query(`UPDATE tenants SET monthly_token_limit = $2, daily_user_token_limit = $2
                          WHERE id = $1`, [tenant, MONTHLY]);
    }
  });

  it("a session that closes frees its slot for the next opener", async () => {
    // The ceiling has to be a ceiling on OPEN sessions, not a lifetime quota.
    // Serial on purpose — this is the behaviour the race must not have broken.
    expect((await open("s-e", 1)).allowed).toBe(true);
    expect((await open("s-f", 1)).reason).toBe("too_many_live_sessions");

    await dbMeter({
      tenantId: tenant, userId, module: "interview_agent", task: TASK_HOLD_RELEASE,
      provider: "gemini-live", model: "live",
      tokensIn: -GRANT.tokensIn, tokensOut: -GRANT.tokensOut,
      costEstUsd: 0, latencyMs: 0, ok: true, sessionId: "s-e",
    });

    expect((await open("s-g", 1)).allowed).toBe(true);
  });

  it("refusing a session writes NO reservation — a denied open must cost nothing", async () => {
    await open("s-h", 1);
    const before = await reservedTokens();
    const r = await open("s-i", 1);
    expect(r.allowed).toBe(false);
    expect(await reservedTokens()).toBe(before);
  });

  it("a tenant already over its cap admits nobody, however many arrive at once", async () => {
    await dbMeter({
      tenantId: tenant, userId, module: "m", task: "interview_turn",
      provider: "p", model: "m", tokensIn: MONTHLY + 5_000, tokensOut: 0,
      costEstUsd: 0, latencyMs: 1, ok: true,
    });
    const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => open(`s-over-${i}`, 10)));
    expect(rs.filter((r) => r.allowed)).toHaveLength(0);
    expect(await holds()).toBe(0);
  });
});
