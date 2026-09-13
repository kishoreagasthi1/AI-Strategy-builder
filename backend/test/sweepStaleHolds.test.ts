/**
 * v5.34.48 — stale live-session holds must leave the client's invoice.
 *
 * Run against REAL Postgres, not a fake client. What makes this statement safe
 * is a database property — migration 015's partial unique index, and the
 * explicit tenant predicate in the statement itself. A mocked query() would
 * assert a SQL string and prove neither.
 *
 * NOTE on the connection: TEST_DATABASE_URL is the ADMIN role, which bypasses
 * row-level security — that is the repo convention for fixtures (see
 * billing.test.ts, which uses a separate vyne_app connection for RLS
 * behaviour). So the isolation asserted below is delivered by the statement's
 * own `tenant_id = current_setting(...)` clause, NOT by the RLS policy. That
 * distinction was found the hard way: an earlier version of this comment
 * credited RLS, and a cross-tenant check written against a superuser
 * connection passed for the wrong reason. Belt and braces is deliberate here —
 * the statement must be correct even when the policy is not applying.
 *
 *   RLS_TEST=1 TEST_DATABASE_URL=postgres://vyne:vyne@localhost:5432/vyne \
 *     npx vitest run backend/test/sweepStaleHolds.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { migrate } from "../src/db/migrate.js";
import { sweepStaleHolds, SWEEP_AGE_SECONDS, SWEEP_SQL } from "../src/llm/sweepStaleHolds.js";
import { MAX_SESSION_SECONDS } from "../src/llm/liveSession.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

describe.skipIf(!ENABLED)("v5.34.48 — sweeping holds whose /close never arrived", () => {
  let db: pg.Client;
  let tenant: string;
  let other: string;
  let user: string;

  /** A hold row, aged by `agoSeconds`, for `session`. */
  async function hold(session: string, agoSeconds: number, t = tenant, usd = 1.4175) {
    await db.query(
      `INSERT INTO usage_events
         (tenant_id, user_id, module, task, provider, model, tokens_in, tokens_out,
          cost_est_usd, latency_ms, ok, client_name, client_norm, session_id, created_at)
       VALUES ($1,$2,'interview_agent','live_session_hold','gemini-live','m',
               67500,67500,$3,0,true,'Acme','acme',$4, now() - make_interval(secs => $5))`,
      [t, user, usd, session, agoSeconds]
    );
  }

  async function release(session: string, t = tenant) {
    await db.query(
      `INSERT INTO usage_events
         (tenant_id, user_id, module, task, provider, model, tokens_in, tokens_out,
          cost_est_usd, latency_ms, ok, session_id)
       VALUES ($1,$2,'interview_agent','live_session_hold_release','gemini-live','m',
               -67500,-67500,-1.4175,0,true,$3)`,
      [t, user, session]
    );
  }

  /** What billing would sum for this tenant's voice line. */
  async function ledgerUsd(t = tenant): Promise<number> {
    const r = await db.query<{ s: string | null }>(
      `SELECT sum(cost_est_usd) AS s FROM usage_events WHERE tenant_id = $1 AND provider = 'gemini-live'`,
      [t]
    );
    return Number(r.rows[0].s ?? 0);
  }

  /** Run the sweep the way admitLiveSession does: inside a tenant-scoped tx. */
  async function sweep(t = tenant, age = SWEEP_AGE_SECONDS) {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [t]);
    const out = await sweepStaleHolds(db, age);
    await db.query("COMMIT");
    return out;
  }

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    const t = await db.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('Sweep Firm') RETURNING id`);
    tenant = t.rows[0].id;
    const o = await db.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('Other Firm') RETURNING id`);
    other = o.rows[0].id;
    const u = await db.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-sweep','sweep@firm.com')
         ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    user = u.rows[0].id;
    await db.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1,$2,'owner')`, [user, tenant]);
  });

  beforeEach(async () => {
    for (const t of [tenant, other]) {
      await db.query(`DELETE FROM usage_events WHERE tenant_id = $1`, [t]);
    }
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenant, other]]);
    await db.end();
  });

  it("a hold older than the session ceiling is released, and leaves the invoice", async () => {
    await hold("sess-old", 3 * 3600);
    expect(await ledgerUsd()).toBeCloseTo(1.4175, 4);   // the phantom charge

    const out = await sweep();

    expect(out.swept).toBe(1);
    expect(out.sessionIds).toEqual(["sess-old"]);
    expect(out.releasedUsd).toBeCloseTo(1.4175, 4);
    expect(await ledgerUsd()).toBeCloseTo(0, 6);        // gone
  });

  it("a hold that could still be a running interview is left alone", async () => {
    // The whole safety argument: only holds that CANNOT still be live.
    await hold("sess-live", 60);
    await hold("sess-edge", MAX_SESSION_SECONDS - 60);  // long, but inside the ceiling

    const out = await sweep();

    expect(out.swept).toBe(0);
    expect(await ledgerUsd()).toBeCloseTo(2.835, 4);    // both still held
  });

  it("a hold already released by its own /close is not released twice", async () => {
    await hold("sess-done", 4 * 3600);
    await release("sess-done");
    expect(await ledgerUsd()).toBeCloseTo(0, 6);

    const out = await sweep();

    expect(out.swept).toBe(0);
    expect(await ledgerUsd()).toBeCloseTo(0, 6);        // not driven negative
  });

  it("running it twice changes nothing the second time", async () => {
    await hold("sess-a", 3 * 3600);
    await hold("sess-b", 3 * 3600);

    const first = await sweep();
    const second = await sweep();

    expect(first.swept).toBe(2);
    expect(second.swept).toBe(0);
    expect(await ledgerUsd()).toBeCloseTo(0, 6);
  });

  it("two holds for one session still produce exactly one release", async () => {
    /*
     * The risk being guarded is an invoice CREDIT invented out of nothing: two
     * releases for one hold would drive the voice line negative.
     *
     * Migration 015's partial unique index is what prevents it, via ON
     * CONFLICT DO NOTHING — verified by removing DISTINCT ON and re-running
     * this test, which still passed. So this asserts the index does its job,
     * not that DISTINCT ON does.
     */
    await hold("sess-dup", 3 * 3600);
    await hold("sess-dup", 3 * 3600);

    const out = await sweep();

    expect(out.swept).toBe(1);
    expect(await ledgerUsd()).toBeCloseTo(1.4175, 4);   // one hold remains, not -1.4175
  });

  it("never touches another firm's rows", async () => {
    await hold("theirs", 3 * 3600, other);
    await hold("ours", 3 * 3600);

    const out = await sweep();

    expect(out.swept).toBe(1);
    expect(out.sessionIds).toEqual(["ours"]);
    expect(await ledgerUsd(other)).toBeCloseTo(1.4175, 4);
  });

  it("with no tenant set it sweeps nothing rather than everything", async () => {
    await hold("sess-x", 3 * 3600);

    await db.query("BEGIN");
    const out = await sweepStaleHolds(db);              // no set_config
    await db.query("COMMIT");

    expect(out.swept).toBe(0);
    expect(await ledgerUsd()).toBeCloseTo(1.4175, 4);
  });

  it("a failure leaves the transaction usable, so admission still proceeds", async () => {
    /*
     * The reason this uses a SAVEPOINT rather than a try/catch: in Postgres a
     * failed statement aborts the whole transaction, so a swallowed error
     * would take admitLiveSession's concurrency and spend-cap queries down
     * with it — while looking handled.
     */
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const out = await sweepStaleHolds(db, Number.NaN);  // make_interval(NaN) fails
    expect(out.swept).toBe(0);
    expect(out.failed).toBeTruthy();

    // The transaction must still work. Before the savepoint, this threw
    // "current transaction is aborted, commands ignored until end of block".
    const still = await db.query<{ n: string }>("SELECT count(*) AS n FROM usage_events");
    expect(Number(still.rows[0].n)).toBeGreaterThanOrEqual(0);
    await db.query("COMMIT");
  });

  it("the age floor is the session ceiling plus grace, not an arbitrary number", () => {
    expect(SWEEP_AGE_SECONDS).toBeGreaterThan(MAX_SESSION_SECONDS);
  });

  it("the statement is inline, not read from disk at runtime", () => {
    /*
     * This was a readFileSync of a .sql file next to the module. The Dockerfile
     * copies only src/db/migrations into the image and tsc copies no .sql at
     * all, so the import would have thrown and the service would not have
     * booted. A string constant has no build-configuration dependency.
     */
    expect(SWEEP_SQL).toContain("INSERT INTO usage_events");
    expect(SWEEP_SQL).toContain("ON CONFLICT DO NOTHING");
    // Match the IMPORT, not the word — the comment in that file explains this
    // bug and therefore contains "readFileSync" legitimately. A substring
    // check failed on its own documentation.
    const src = readFileSync(join(__dirname, "..", "src", "llm", "sweepStaleHolds.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import .*["']node:fs["']/m);
  });

  it("the one-time backfill matches the statement the server runs", () => {
    // Two copies of this SQL exist by design — one runs on every admission,
    // one is run by hand for rows stranded before v5.34.48. They must not
    // drift into disagreeing about which holds are safe to release.
    const backfill = readFileSync(join(__dirname, "..", "..", "deploy", "backfill_stale_holds.sql"), "utf8");
    for (const clause of [
      "task = 'live_session_hold'",
      "AND h.session_id IS NOT NULL",
      "task = 'live_session_hold_release'",
      "ON CONFLICT DO NOTHING",
      "NULLIF(current_setting('app.tenant_id', true), '')::uuid",
    ]) {
      expect(backfill, `backfill is missing: ${clause}`).toContain(clause);
      expect(SWEEP_SQL, `runtime statement is missing: ${clause}`).toContain(clause);
    }
  });
});
