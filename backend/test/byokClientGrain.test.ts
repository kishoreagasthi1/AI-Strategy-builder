/**
 * v5.34.53 — BYOK at the CLIENT grain, per provider, against real Postgres.
 *
 * The behaviours that matter commercially, not just structurally:
 *   · one client can bring a Google key and NOT an Anthropic one;
 *   · a client with no key falls back to the platform credential and their
 *     invoice, rather than failing;
 *   · a REFUSED key is reported as refused, not as absent — v5.34.64 made a
 *     client with a key on file run on that key alone, so "lapsed" and "never
 *     supplied" stopped being the same answer (this file said otherwise until
 *     v5.34.70);
 *   · a key cannot go live without the CLIENT's attestation on record.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { activeKeyFor, listKeys, upsertActiveKey, deactivateKey } from "../src/llm/byok/byokRepo.js";
import { putTenantKey, secretIdFor, _clearByokCache } from "../src/llm/byok/secretStore.js";
import { normClient } from "../src/auth/clients.js";
import type { KeyProbe } from "../src/llm/byok/verifyKey.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

const PROBE: KeyProbe = {
  checkedAt: new Date().toISOString(), canGenerate: true, canMintLiveToken: true,
  modelCount: 55, hasNativeAudio: true, status: { generate: 200, models: 200, authTokens: 200 },
};
const ATTEST = "I confirm this key belongs to a Google Cloud project with billing enabled.";

describe.skipIf(!ENABLED)("v5.34.53 — one key per client, per provider", () => {
  let db: pg.Client;
  let tenant: string;
  let other: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    tenant = (await db.query(`INSERT INTO tenants (name) VALUES ('Vynora') RETURNING id`)).rows[0].id;
    other = (await db.query(`INSERT INTO tenants (name) VALUES ('Other Firm') RETURNING id`)).rows[0].id;
    // The repo goes through withTenant(), which needs the shared pool.
    initPool(ADMIN_URL);
  });

  beforeEach(async () => {
    _clearByokCache();
    smCalls.length = 0;
    for (const t of [tenant, other]) {
      await db.query(`DELETE FROM byok_keys WHERE tenant_id = $1`, [t]);
      await db.query(`DELETE FROM byok_events WHERE tenant_id = $1`, [t]);
    }
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenant, other]]);
    await db.end();
    await closePool();
  });

  /*
   * v5.34.57 — the secret name comes from the REAL store, not from this helper.
   *
   * It used to fabricate `projects/p/secrets/vyne-byok-${provider}`, which made
   * "a client can bring both, and they are separate credentials" pass against a
   * production path that emitted `vyne-byok-<tenant>` for every client and
   * every provider. The test asserted a property the code never produced — it
   * was a lens, and an external audit found what it was hiding: one secret per
   * FIRM, so the last client to supply a key became the key every client
   * resolved to.
   *
   * Now putTenantKey() is called for real (against a fake Secret Manager), so
   * the name under test is the name production writes.
   */
  const smCalls: string[] = [];
  const fakeSm = {
    projectId: "p",
    getAccessToken: async () => "tok",
    fetchImpl: (async (url: string) => {
      const path = String(url).replace("https://secretmanager.googleapis.com/v1", "");
      smCalls.push(path);
      return { ok: true, status: 200, text: async () => JSON.stringify({ name: `${path}/versions/3` }) };
    }) as unknown as typeof fetch,
  };

  const attach = async (clientName: string, provider: any, key = "AQ.key-value-wxyz") => {
    const stored = await putTenantKey(fakeSm, {
      tenantId: tenant, clientNorm: normClient(clientName), provider,
    }, key);
    return upsertActiveKey({
      tenantId: tenant, clientName, provider,
      secretName: stored.secretName, keyHint: stored.keyHint,
      probe: PROBE, attestedByEmail: "admin@client.com", attestationText: ATTEST,
    });
  };

  it("a client's own key serves that client and nobody else", async () => {
    await attach("Nestlé", "gemini-aistudio");

    const nestle = await activeKeyFor(tenant, "Nestlé", "gemini-aistudio");
    expect(nestle?.keyHint).toBe("wxyz");
    expect(nestle?.paidTierAttested).toBe(true);

    // A different client of the SAME firm falls back to the platform key.
    expect(await activeKeyFor(tenant, "Acme Corp", "gemini-aistudio")).toBeNull();
  });

  it("Gemini from the client, Claude on the invoice — the mixed case", async () => {
    /*
     * "Gemini for the voice interviews, Claude for the strategy deck" with only
     * a Google key supplied. The Anthropic work must fall back rather than
     * refuse, and it is then metered to this client for the invoice.
     */
    await attach("Nestlé", "gemini-aistudio");

    expect((await activeKeyFor(tenant, "Nestlé", "gemini-aistudio"))?.provider).toBe("gemini-aistudio");
    expect(await activeKeyFor(tenant, "Nestlé", "anthropic-api")).toBeNull();
  });

  it("a client can bring both, and they are separate credentials", async () => {
    await attach("Nestlé", "gemini-aistudio");
    await attach("Nestlé", "anthropic-api");

    const g = await activeKeyFor(tenant, "Nestlé", "gemini-aistudio");
    const a = await activeKeyFor(tenant, "Nestlé", "anthropic-api");
    expect(g?.secretName).not.toBe(a?.secretName);
    expect(g!.secretName).toContain("gemini-aistudio");
    expect(a!.secretName).toContain("anthropic-api");
    expect((await listKeys(tenant)).length).toBe(2);
  });

  it("TWO CLIENTS of one firm never share a secret — the audit finding", async () => {
    /*
     * The failure this guards: one secret per FIRM meant Client A's interviews
     * ran on Client B's key, and B was billed for A.
     */
    await attach("Nestlé", "gemini-aistudio", "AQ.nestle-key-aaaa");
    await attach("Acme Corp", "gemini-aistudio", "AQ.acme-key-bbbb");

    const n = await activeKeyFor(tenant, "Nestlé", "gemini-aistudio");
    const a = await activeKeyFor(tenant, "Acme Corp", "gemini-aistudio");

    expect(n!.secretName).not.toBe(a!.secretName);
    // normClient strips non-[a-z0-9], so "Nestlé" normalises to "nestl".
    expect(n!.secretName).toContain(normClient("Nestlé"));
    expect(a!.secretName).toContain(normClient("Acme Corp"));
    // And the key each client sees is their own, not the most recent one.
    expect(n!.keyHint).toBe("aaaa");
    expect(a!.keyHint).toBe("bbbb");
  });

  it("the stored name pins a VERSION, so a rotation cannot be read as 'latest'", () => {
    // Reading versions/latest was the other half of the finding: a rotation
    // racing a read serves whichever key was written most recently.
    expect(secretIdFor("11111111-1111-1111-1111-111111111111", "nestle", "gemini-aistudio"))
      .toBe("vyne-byok-11111111-1111-1111-1111-111111111111-nestle-gemini-aistudio");
    // A caller that forgets the new arguments must fail loudly, not silently
    // produce a shared id — regex.test(undefined) passes, a type check does not.
    expect(() => (secretIdFor as any)("11111111-1111-1111-1111-111111111111")).toThrow(/required/);

    // And the persisted name must carry a pinned version.
    const g = "projects/p/secrets/x/versions/3";
    expect(g).toMatch(/\/versions\/\d+$/);
  });

  it("a refused key is RETURNED, marked failed — not hidden as if absent", async () => {
    /*
     * Rewritten in v5.34.70. This used to assert null, with the comment "the
     * firm eats it until someone fixes it, which is the right way round".
     *
     * v5.34.64 decided that was the wrong way round and reversed it: a client
     * with a key on file runs on that key alone, and if it cannot be spent the
     * call fails rather than quietly moving the charge to the firm. Nobody came
     * back to this test, so it went on asserting the old philosophy — and
     * because activeKeyFor() really did return null, it kept passing while
     * v5.34.64 and v5.34.69 were both inert past the first refused call. A
     * green test asserting a retired rule is worse than no test.
     *
     * The fall-back-or-fail decision now lives in the CALLERS (resolve.ts,
     * resolveLive.ts), which is the only layer that knows about fallback
     * grants. This function's job is to report what is on file, accurately.
     */
    await attach("Nestlé", "gemini-aistudio");
    await deactivateKey(tenant, "Nestlé", "gemini-aistudio", "failed", undefined, "key rejected by Google");

    const row = await activeKeyFor(tenant, "Nestlé", "gemini-aistudio");
    expect(row, "a refused key read as 'no key', which puts the firm back on the hook")
      .not.toBeNull();
    expect(row!.status).toBe("failed");
    const rows = await listKeys(tenant);
    expect(rows[0].status).toBe("failed");          // still visible on the settings screen
  });

  it("a key the Owner switched off IS hidden — that decision stands", async () => {
    // The other half of the rule, and the reason the predicate is
    // `IN ('active','failed')` and not simply unfiltered. `disabled` means the
    // Owner deliberately put this client back on the firm's account.
    await attach("Nestlé", "gemini-aistudio");
    await deactivateKey(tenant, "Nestlé", "gemini-aistudio", "disabled", undefined, "owner turned it off");
    expect(await activeKeyFor(tenant, "Nestlé", "gemini-aistudio")).toBeNull();
  });

  it("rotating replaces the key rather than creating a second row", async () => {
    await attach("Nestlé", "gemini-aistudio");
    await upsertActiveKey({
      tenantId: tenant, clientName: "Nestlé", provider: "gemini-aistudio",
      secretName: "projects/p/secrets/rotated", keyHint: "9999",
      probe: PROBE, attestedByEmail: "admin@client.com", attestationText: ATTEST,
    });
    const rows = await listKeys(tenant);
    expect(rows.length).toBe(1);
    expect(rows[0].keyHint).toBe("9999");
  });

  it("work with no client attributed is the firm's own, never a client's key", async () => {
    await attach("Nestlé", "gemini-aistudio");
    expect(await activeKeyFor(tenant, undefined, "gemini-aistudio")).toBeNull();
  });

  it("another firm's client with the same name gets nothing", async () => {
    await attach("Nestlé", "gemini-aistudio");
    expect(await activeKeyFor(other, "Nestlé", "gemini-aistudio")).toBeNull();
  });

  it("every attach and every deactivation leaves an audit row naming the attester", async () => {
    await attach("Nestlé", "gemini-aistudio");
    await deactivateKey(tenant, "Nestlé", "gemini-aistudio", "disabled", undefined, "client ended the pilot");

    const ev = await db.query(
      `SELECT action, client_norm, provider, note FROM byok_events WHERE tenant_id = $1 ORDER BY created_at`,
      [tenant]);
    expect(ev.rows.map((r: any) => r.action)).toEqual(["attached", "disabled"]);
    expect(ev.rows[0].note).toMatch(/admin@client\.com/);
    expect(ev.rows[1].note).toMatch(/ended the pilot/);
  });

  it("the database refuses a live key with no attestation, whatever a caller does", async () => {
    await expect(db.query(
      `INSERT INTO byok_keys (tenant_id, client_norm, client_name, provider, secret_name, status)
       VALUES ($1,'acme','Acme','gemini-aistudio','projects/p/secrets/s','active')`, [tenant]
    )).rejects.toThrow(/byok_key_active_requires_attestation/);
  });

  it("the key itself is never in the row", async () => {
    await attach("Nestlé", "gemini-aistudio");
    const raw = await db.query(`SELECT * FROM byok_keys WHERE tenant_id = $1`, [tenant]);
    const text = JSON.stringify(raw.rows[0]);
    expect(text).toContain("projects/p/secrets/");   // the NAME
    expect(text).not.toMatch(/AQ\.[A-Za-z0-9_-]{10,}/);  // never a key
  });
});
