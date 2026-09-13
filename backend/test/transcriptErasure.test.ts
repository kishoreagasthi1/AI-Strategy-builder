/**
 * Deleting an interview erases its transcript — and nothing else can. (v5.34.63)
 *
 * Before this, DELETE /api/interviews/:id removed the interview row and the
 * saved session state, and left the CONVERSATION — a named executive at a named
 * client, verbatim, plus the findings drawn from it — in the database with no
 * code path anywhere able to remove it. "Delete this interview" did not delete
 * the interview, and a firm asked to honour an erasure request could not.
 *
 * The half that must NOT change is migration 024's: the synthetic generator
 * wipes and regenerates a client's fixtures, and it must still be incapable of
 * destroying real records as a side effect. So the erasure is gated on an
 * explicit `SET LOCAL app.erase_transcripts`, and the tests below prove both
 * directions — the deliberate path works, and every other path still cannot.
 *
 * Against real Postgres, as the RESTRICTED app role. Running these as the owner
 * would bypass row-level security entirely and every assertion would pass for
 * the wrong reason — which has happened in this repo before.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool, withTenant } from "../src/db/pool.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:apppw@localhost:5432/vyne";

describe.skipIf(!ENABLED)("v5.34.63 — transcript erasure", () => {
  let admin: pg.Client;
  let tenant: string;
  let other: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    tenant = (await admin.query(`INSERT INTO tenants (name) VALUES ('Erasure Firm') RETURNING id`)).rows[0].id;
    other = (await admin.query(`INSERT INTO tenants (name) VALUES ('Other Erasure Firm') RETURNING id`)).rows[0].id;
    // The RESTRICTED role — the one the server actually runs as.
    initPool(APP_URL);
  });

  beforeEach(async () => {
    for (const t of [tenant, other]) {
      await admin.query(`DELETE FROM interview_transcripts WHERE tenant_id = $1`, [t]);
      await admin.query(`DELETE FROM interviews WHERE tenant_id = $1`, [t]);
    }
  });

  afterAll(async () => {
    for (const t of [tenant, other]) {
      await admin.query(`DELETE FROM interview_transcripts WHERE tenant_id = $1`, [t]);
      await admin.query(`DELETE FROM interviews WHERE tenant_id = $1`, [t]);
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [t]);
    }
    await admin.end();
    await closePool();
  });

  /**
   * A transcript. `synthetic` defaults to false — a REAL one.
   *
   * state_module is unique per tenant (migration 020), so each seed needs its
   * own; the first draft reused one literal and the second call in a test died
   * on the constraint rather than on anything under test.
   */
  let seq = 0;
  async function seed(t: string, name = "Dana Reed", synthetic = false): Promise<string> {
    const iv = await admin.query<{ id: string }>(
      `INSERT INTO interviews (tenant_id, client_name, interviewee_name, interviewee_role, state_module)
       VALUES ($1, 'Acme', $2, 'CFO', $3) RETURNING id`, [t, name, `iv_seed_${++seq}`]);
    await admin.query(
      `INSERT INTO interview_transcripts
         (tenant_id, interview_id, client_name, interviewee_name, interviewee_role, turns, turn_count, synthetic)
       VALUES ($1, $2, 'Acme', $3, 'CFO', $4::jsonb, 2, $5)`,
      [t, iv.rows[0].id, name, JSON.stringify([{ role: "user", text: "something confidential" }]), synthetic]
    );
    return iv.rows[0].id;
  }

  const countFor = async (t: string) =>
    Number((await admin.query(
      `SELECT count(*)::int AS n FROM interview_transcripts WHERE tenant_id = $1`, [t])).rows[0].n);

  it("the app role STILL cannot delete a real transcript without asking", async () => {
    /*
     * The negative control, and the property migration 024 exists for. If this
     * ever passes silently, the synthetic generator can destroy real interview
     * records during an ordinary regeneration.
     */
    const id = await seed(tenant);
    await withTenant(tenant, async (c) => {
      const r = await c.query(`DELETE FROM interview_transcripts WHERE interview_id = $1`, [id]);
      expect((r as { rowCount?: number }).rowCount).toBe(0);
    });
    expect(await countFor(tenant)).toBe(1);
  });

  it("erases it when the transaction explicitly asks", async () => {
    const id = await seed(tenant);
    const erased = await withTenant(tenant, async (c) => {
      await c.query(`SET LOCAL app.erase_transcripts = 'on'`);
      const r = await c.query(`DELETE FROM interview_transcripts WHERE interview_id = $1`, [id]);
      return (r as { rowCount?: number }).rowCount;
    });
    expect(erased).toBe(1);
    expect(await countFor(tenant)).toBe(0);
  });

  it("the permission does NOT survive the transaction", async () => {
    /*
     * SET LOCAL, not SET. On a pooled connection a leaked permission would mean
     * the next request — any request — could delete transcripts. This asserts
     * the leak is impossible by running a second transaction on the same pool
     * immediately afterwards.
     */
    const first = await seed(tenant, "First Person");
    await withTenant(tenant, async (c) => {
      await c.query(`SET LOCAL app.erase_transcripts = 'on'`);
      await c.query(`DELETE FROM interview_transcripts WHERE interview_id = $1`, [first]);
    });
    const second = await seed(tenant, "Second Person");
    await withTenant(tenant, async (c) => {
      const r = await c.query(`DELETE FROM interview_transcripts WHERE interview_id = $1`, [second]);
      expect((r as { rowCount?: number }).rowCount, "the erase permission leaked to a later transaction").toBe(0);
    });
    expect(await countFor(tenant)).toBe(1);
  });

  it("cannot reach another firm's transcripts even while erasing", async () => {
    // The GUC lifts the synthetic-only restriction, never the tenant one.
    await seed(other, "Someone Else");
    const mine = await seed(tenant);
    await withTenant(tenant, async (c) => {
      await c.query(`SET LOCAL app.erase_transcripts = 'on'`);
      await c.query(`DELETE FROM interview_transcripts`);   // deliberately unqualified
    });
    expect(await countFor(tenant)).toBe(0);
    expect(await countFor(other), "erasure crossed a tenant boundary").toBe(1);
    void mine;
  });

  it("a synthetic transcript is still deletable without the flag", async () => {
    /*
     * 024's path, untouched: the generator cleans up its own fixtures.
     *
     * Keyed on the `synthetic` BOOLEAN, not on the '[Synthetic]' name suffix —
     * 024 used the name, 026 replaced it with the column, and the first draft
     * of this test asserted against the wording of 024's comment rather than
     * the policy that is actually installed.
     */
    const id = await seed(tenant, "Pat Vale [Synthetic]", true);
    await withTenant(tenant, async (c) => {
      const r = await c.query(`DELETE FROM interview_transcripts WHERE interview_id = $1`, [id]);
      expect((r as { rowCount?: number }).rowCount).toBe(1);
    });
    expect(await countFor(tenant)).toBe(0);
  });
});
