/**
 * A completed interview that did not reach the engagement record says so.
 * (v5.34.69)
 *
 * ── What was happening ──────────────────────────────────────────────────────
 *
 * POST /api/interviews/mine/complete merges the interviewee's session into the
 * shared engagement record — the thing Synthesis, the scorecard, the roadmap
 * and the client deck all read from. That merge was wrapped in:
 *
 *     } catch (e) {
 *       req.log.warn({ err: e }, "engagement auto-merge failed (interview still
 *                                 marked completed)");
 *     }
 *     return "ok" as const;
 *
 * So when it failed: the interviewee saw "completed", the consultant saw a
 * finished interview in the tracker, the engagement record simply did not
 * contain their scores or findings, and the only trace was a log line. Silent
 * loss of the one thing this product exists to collect — and invisible until
 * someone noticed a dimension score looked light in a board deck.
 *
 * ── What is deliberately unchanged ──────────────────────────────────────────
 *
 * The interview STAYS completed. The session blob and the transcript are
 * already written in the same transaction, the interviewee has finished and
 * gone, and re-opening it would invite a second run over data already held.
 * What changes is that somebody is told: the response carries mergeFailed, and
 * audit_log carries the reason.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { interviewRoutes } from "../src/routes/interviews.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

describe.skipIf(!ENABLED)("v5.34.69 — a failed engagement merge is reported", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let tenant: string;
  let consultant: string;
  let interviewee: string;
  let interviewId: string;
  let stateModule: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    initPool(ADMIN_URL);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    tenant = (await db.query(
      `INSERT INTO tenants (name) VALUES ('Merge Failure Firm') RETURNING id`)).rows[0].id;
    consultant = (await db.query(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-mf-cons','c@firm.com')
         ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`)).rows[0].id;
    interviewee = (await db.query(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-mf-exec','exec@client.example')
         ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`)).rows[0].id;
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant]);

    app = Fastify();
    await app.register(async (scope) => {
      scope.addHook("preHandler", async (req: any) => {
        req.ctx = { tenantId: tenant, userId: interviewee, role: "interviewee" };
      });
      await interviewRoutes(scope);
    });
    await app.ready();
  }, 60_000);

  beforeEach(async () => {
    await db.query(`DELETE FROM module_state WHERE tenant_id = $1`, [tenant]);
    await db.query(`DELETE FROM interviews WHERE tenant_id = $1`, [tenant]);
    await db.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenant]);

    stateModule = "iv_" + Math.random().toString(36).slice(2, 10);
    interviewId = (await db.query<{ id: string }>(
      `INSERT INTO interviews
         (tenant_id, client_name, interviewee_name, interviewee_role,
          interviewee_user_id, state_module, status)
       VALUES ($1, 'Acme Industrial', 'A Person', 'CFO', $2, $3, 'in_progress')
       RETURNING id`, [tenant, interviewee, stateModule])).rows[0].id;

    // A session to fold in — without one the merge has nothing to do and the
    // failure path is never reached.
    await db.query(
      `INSERT INTO module_state (tenant_id, module, key, value, updated_by)
       VALUES ($1, $2, 'vynora_session_x', $3, $4)`,
      [tenant, stateModule, JSON.stringify({ v: JSON.stringify({
        scores: { D3: 4 },
        findings: [{ dimension: "D3", text: "strategy is unfunded" }],
        lastSaved: Date.now(),
      }) }), interviewee]);
  });

  afterAll(async () => {
    await app.close();
    await db.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[consultant, interviewee]]);
    await db.end();
    await closePool();
  });

  const complete = () =>
    app.inject({ method: "POST", url: "/api/interviews/mine/complete" });

  /**
   * Make the merge fail for a reason the route cannot foresee: an engagement
   * record that is not JSON. resolveEngagementCode and the adoption scan both
   * read these, and the merge throws on the unparseable one.
   */
  const poisonEngagementRecord = async () => {
    await db.query(
      `INSERT INTO module_state (tenant_id, module, key, value, updated_by)
       VALUES ($1, 'workspace', 'vynora_engagement_index', $2, $3)`,
      [tenant, JSON.stringify({ v: JSON.stringify({ acmeindustrial: "ACME-1" }) }), consultant]);
    await db.query(
      `INSERT INTO module_state (tenant_id, module, key, value, updated_by)
       VALUES ($1, 'workspace', 'vynora_engagement_ACME-1', $2, $3)`,
      [tenant, JSON.stringify({ v: "{ this is not json" }), consultant]);
  };

  it("a healthy completion still reports a plain success", async () => {
    // The negative control. If this ever starts reporting mergeFailed, the
    // reporting itself has become the bug.
    const r = await complete();
    expect(r.statusCode).toBe(200);
    expect(r.json().mergeFailed).toBeUndefined();
  });

  it("the interview is still marked completed when the merge fails", async () => {
    /*
     * Deliberate. The transcript and the session are already written, and the
     * interviewee has finished — re-opening would invite a second run over data
     * already held.
     */
    await poisonEngagementRecord();
    await complete();
    const st = await db.query<{ status: string }>(
      `SELECT status FROM interviews WHERE id = $1`, [interviewId]);
    expect(st.rows[0].status).toBe("completed");
  });

  it("says so in the response instead of claiming an unqualified success", async () => {
    await poisonEngagementRecord();
    const r = await complete();
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.mergeFailed, "a failed merge still reported a clean success").toBe(true);
    // Written for the interviewee, who has just finished and is owed the truth
    // without being asked to do anything about it.
    expect(body.detail).toMatch(/could not be added to the engagement record/i);
    expect(body.detail).toMatch(/nothing you entered has been lost/i);
  });

  it("writes an audit row carrying the reason and the client", async () => {
    await poisonEngagementRecord();
    await complete();
    await new Promise((r) => setTimeout(r, 200));   // auditLog is fire-and-forget
    /*
     * Scoped to THIS interview, not counted across the tenant. (v5.34.71)
     *
     * Counting every engagement_merge_failed row for the tenant made this test
     * flaky — it failed 2 runs in 5 locally and once in the Docker tier, with
     * "expected 2 to be 1". The second row belonged to the PREVIOUS test in
     * this file: auditLog() is deliberately fire-and-forget (routes/interviews.ts
     * `void auditLog(...)`, and audit/log.ts opens its own transaction so a
     * logging failure cannot roll back the operation it records), so that
     * test's write can land AFTER the next test's beforeEach has cleared
     * audit_log. Dumping the rows showed two entries with different
     * interviewIds, which is what identified it.
     *
     * The fire-and-forget is correct and should not change to satisfy a test.
     * The test was asking the wrong question: what matters is that THIS
     * interview produced exactly one row, not what else is in the table.
     */
    const rows = await db.query<{ detail: any }>(
      `SELECT detail FROM audit_log
        WHERE tenant_id = $1 AND action = 'engagement_merge_failed'
          AND detail->>'interviewId' = $2`, [tenant, interviewId]);
    expect(rows.rowCount, "a silent loss stayed silent").toBe(1);
    expect(rows.rows[0].detail.clientName).toBe("Acme Industrial");
    expect(rows.rows[0].detail.reason).toBeTruthy();
  });

  it("writes no audit row when the merge succeeds", async () => {
    await complete();
    await new Promise((r) => setTimeout(r, 200));
    // Scoped by interviewId for the same reason as the test above — a stray
    // row from an earlier test would otherwise fail this one at random.
    const rows = await db.query(
      `SELECT 1 FROM audit_log
        WHERE tenant_id = $1 AND action = 'engagement_merge_failed'
          AND detail->>'interviewId' = $2`, [tenant, interviewId]);
    expect(rows.rowCount).toBe(0);
  });
});
