/**
 * A refused key must not look like no key at all. (v5.34.70)
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * v5.34.64 confined a BYOK client to their own credentials so a refused key
 * failed the call instead of moving the charge to the firm. v5.34.69 extended
 * that to survive the refusal: a `failed` row is reported as unusable rather
 * than skipped, so the protection covers the SECOND call too.
 *
 * Neither worked past the first call, because activeKeyFor() filtered
 * `status = 'active'` in SQL. The resolvers' `row.status === "failed"` branch
 * sat one layer above a query that could never hand it such a row. A refused
 * key arrived as null — indistinguishable from a client who never brought one —
 * so `confined` was false, the firm's chain ran, and the firm paid for every
 * call until somebody noticed the key was red on a screen nobody had open.
 *
 * ── Why the existing tests all passed ───────────────────────────────────────
 *
 * Every test over this path injects a `lookup:` stub returning a hand-made
 * `{ status: "failed" }` row (byokConfinement.test.ts, byokFallbackGrant.test.ts).
 * The stub answered a question production's query refused to ask. So this file
 * deliberately does NOT stub the lookup: it writes a real row to a real table
 * and calls the real function. That is the only reason it catches this.
 *
 * Found by an external audit of v5.34.69.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { activeKeyFor } from "../src/llm/byok/byokRepo.js";
import { makeByokResolver } from "../src/llm/byok/resolve.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

/** Raw text of the kind recordResolveError() stores verbatim on the row. */
const RAW_LEAK =
  "Error: 7 PERMISSION_DENIED: projects/vyne-platform-prod/secrets/" +
  "vyne-byok-621127cf-36fd-48c8-b0be-02a7da22f59d-acmeindustrial-gemini-aistudio/versions/3";

describe.skipIf(!ENABLED)("v5.34.70 — activeKeyFor surfaces refused keys", () => {
  let db: pg.Client;
  let tenant: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    initPool(ADMIN_URL);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    tenant = (await db.query(
      `INSERT INTO tenants (name) VALUES ('Refused Key Firm') RETURNING id`)).rows[0].id;
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant]);
  }, 60_000);

  beforeEach(async () => {
    await db.query(`DELETE FROM byok_keys WHERE tenant_id = $1`, [tenant]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM byok_keys WHERE tenant_id = $1`, [tenant]);
    await db.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await db.end();
    await closePool();
  });

  /** A real row, in the real table, at whatever status the case needs. */
  const seed = async (status: string, lastError: string | null = null) => {
    await db.query(
      /*
       * attestation_text is not decoration: byok_key_active_requires_attestation
       * (migration 031) refuses an ACTIVE row without it, along with the email,
       * the timestamp and the secret name. An active key nobody attested to
       * cannot exist, which is what makes paidTier: true safe in resolve.ts.
       */
      `INSERT INTO byok_keys
         (tenant_id, client_norm, client_name, provider, status, secret_name,
          key_hint, paid_tier_attested, attested_by_email, attested_at,
          attestation_text, last_error)
       VALUES ($1, 'acmeindustrial', 'Acme Industrial', 'gemini-aistudio', $2,
               'projects/p/secrets/vyne-byok-t-acmeindustrial-gemini-aistudio/versions/3',
               'wxyz', true, 'cfo@acme.example', now(),
               'the client administrator attested this key belongs to a billed project', $3)`,
      [tenant, status, lastError]);
  };

  it("returns a refused key rather than null — the regression itself", async () => {
    await seed("failed", "refused by the provider during a call");
    const row = await activeKeyFor(tenant, "Acme Industrial", "gemini-aistudio");
    expect(row, "a refused key came back as null, which reads as 'no key' and bills the firm")
      .not.toBeNull();
    expect(row!.status).toBe("failed");
  });

  it("still returns an active key", async () => {
    // The negative control. Widening the predicate must not have broken the
    // ordinary case, which is every call for every healthy BYOK client.
    await seed("active");
    const row = await activeKeyFor(tenant, "Acme Industrial", "gemini-aistudio");
    expect(row?.status).toBe("active");
  });

  it.each(["disabled", "pending"])(
    "keeps filtering %s — those genuinely mean the firm pays", async (status) => {
      /*
       * Load-bearing, and not symmetry for its own sake. `disabled` is the
       * Owner pressing "turn off"; `pending` is a client who never supplied a
       * key. Returning either would make the resolvers refuse calls the Owner
       * expects to run on the firm's account, and would contradict the keys
       * screen, which says "disabled — running on your key" in as many words.
       * routes/assignments.ts's client deletion relies on this too: it switches
       * keys to `disabled` and trusts that to take them out of circulation.
       */
      await seed(status);
      expect(await activeKeyFor(tenant, "Acme Industrial", "gemini-aistudio")).toBeNull();
    });

  it("reports the client as unusable through the REAL lookup, not as keyless", async () => {
    /*
     * The end-to-end consequence, with no `lookup:` stub — which is the whole
     * point of this file. An empty `unusable` here means gateway.ts computes
     * confined = false and quietly spends the firm's credential.
     */
    await seed("failed", "refused by the provider during a call");
    const resolve = makeByokResolver({
      secretStore: { projectId: "test-project" },
      fetchKey: async () => { throw new Error("must not be reached for a failed row"); },
    });
    const out = await resolve({ tenantId: tenant, clientName: "Acme Industrial" });

    expect(out.adapters.size, "a refused key must not produce a usable adapter").toBe(0);
    expect(out.unusable.length, "the refused key was skipped — the firm would pay from here on")
      .toBe(1);
    expect(out.unusable[0].clientName).toBe("Acme Industrial");
    expect(out.unusable[0].provider).toBe("gemini-aistudio");
  });

  it("keeps raw recorded error text out of the response-bound reason", async () => {
    /*
     * byok_keys.last_error has two writers: deactivateKey stores a fixed
     * literal, recordResolveError stores err.message verbatim. gateway.ts
     * interpolates `reason` into the 402 MESSAGE, which route handlers send to
     * whoever was in the interview; `detail` is server-side only. So `reason`
     * has to be vetted prose whatever the column happens to hold.
     */
    await seed("failed", RAW_LEAK);
    const resolve = makeByokResolver({ secretStore: { projectId: "test-project" } });
    const out = await resolve({ tenantId: tenant, clientName: "Acme Industrial" });

    const { reason, detail } = out.unusable[0];
    expect(reason).not.toContain("PERMISSION_DENIED");
    expect(reason, "the GCP project id reached a string bound for an HTTP response")
      .not.toContain("vyne-platform-prod");
    expect(reason, "the tenant uuid reached a string bound for an HTTP response")
      .not.toContain("621127cf");
    expect(reason).toMatch(/refused by the provider/i);
    // Not discarded — an operator still needs it, in the log.
    expect(detail).toBe(RAW_LEAK);
  });
});
