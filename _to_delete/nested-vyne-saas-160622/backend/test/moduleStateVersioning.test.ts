/**
 * The optimistic-concurrency token has to be told the truth (audit V2-M2).
 *
 * v5.32.65. Migration 018 gave module_state a `version`, and PUT
 * /api/module-state uses it properly: a client sends the version it read, the
 * UPDATE only lands if the row is still at that version, and a 409 comes back
 * otherwise.
 *
 * PUT was the only writer that maintained it. Six other code paths write the
 * same table — the Design Studio, the assignment matrix, the synthetic
 * generator, the client-norm migration, an interviewee saving their session,
 * and the completion merge — and every one of them left `version` where it was.
 * So the guard did not fail loudly when a row changed underneath a reader; it
 * quietly stopped guarding, and the reader's stale write was accepted as
 * current. A lock that reports success when it is not holding anything is worse
 * than no lock, because the caller stops checking.
 *
 * Fixed in the database rather than in the six call sites, because the seventh
 * writer would have forgotten as well: migration 022 puts a BEFORE UPDATE
 * trigger on module_state that derives `version` from OLD. The tests below go
 * through the real HTTP routes, so what they prove is that a write made by a
 * DIFFERENT feature invalidates a token — which is the property that was
 * missing, and which no unit test of the PUT route could have shown.
 *
 * The second half of this file is the lost update the missing bump was hiding.
 * Every use case for a client lives in ONE row, so saving one use case rewrites
 * the whole store; that was read in one transaction and written back in
 * another. Two consultants on the same client silently lost one another's work.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";
import type { ProviderAdapter } from "../src/llm/types.js";
import type { FastifyInstance } from "fastify";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5433/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:apppw@localhost:5433/vyne";

class FakeVerifier implements TokenVerifier {
  constructor(private map: Record<string, VerifiedIdentity>) {}
  async verify(t: string): Promise<VerifiedIdentity> {
    const id = this.map[t];
    if (!id) throw new Error("bad token");
    return id;
  }
}

const fakeAdapter: ProviderAdapter = {
  name: "gemini-aistudio", model: "fake", freeTier: true,
  isConfigured: () => true,
  async generate() {
    return { text: "ok", model: "fake", usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0 } };
  },
};

/** A minimally valid SolutionDesignDoc. */
const doc = (marker: string) => ({
  problemStatement: marker,
  currentState: "c", targetState: "t",
  recommendation: { approach: "build" as const, rationale: "r" },
  dataAndIntegrationRequirements: ["d"],
  phasedPlan: [{ phase: 1, name: "p", description: "d", durationWeeks: 4 }],
  risksAndDependencies: [{ risk: "r", mitigation: "m" }],
  successMetrics: [{ metric: "m", target: "t" }],
});

describe.skipIf(!ENABLED)("module_state.version survives writers that do not maintain it (V2-M2)", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;

  const verifierMap: Record<string, VerifiedIdentity> = {
    "tok-a": { uid: "uid-ver-a", email: "a@ver.com", idpTenantId: undefined },
    "tok-b": { uid: "uid-ver-b", email: "b@ver.com", idpTenantId: undefined },
  };
  const H = (tok: string) => ({ authorization: `Bearer ${tok}` });

  const save = (tok: string, useCaseId: string, marker: string) =>
    app.inject({
      method: "PUT", url: "/api/solution-design", headers: H(tok),
      payload: { clientName: "Acme", useCaseId, useCaseName: useCaseId, doc: doc(marker) },
    });

  const versionOf = async (key: string): Promise<number> => {
    const r = await admin.query<{ version: string }>(
      `SELECT version FROM module_state WHERE tenant_id = $1 AND module = 'workspace' AND key = $2`,
      [tenant, key]
    );
    return Number(r.rows[0]?.version ?? -1);
  };

  beforeAll(async () => {
    process.env.DEV_AUTH = "1";
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Version Firm') RETURNING id`);
    tenant = t.rows[0].id;
    for (const [uid, email] of [["uid-ver-a", "a@ver.com"], ["uid-ver-b", "b@ver.com"]]) {
      const u = await admin.query<{ id: string }>(
        `INSERT INTO users (identity_platform_uid, email) VALUES ($1, $2)
         ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
        [uid, email]);
      await admin.query(
        `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'consultant')
         ON CONFLICT (user_id, tenant_id) DO NOTHING`, [u.rows[0].id, tenant]);
      await admin.query("BEGIN");
      await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      await admin.query(
        `INSERT INTO client_assignments (tenant_id, user_id, client_name, client_norm)
         VALUES ($1, $2, 'Acme', 'acme') ON CONFLICT DO NOTHING`, [tenant, u.rows[0].id]);
      await admin.query("COMMIT");
    }

    initPool(APP_URL);
    app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier(verifierMap),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await admin.query(`DELETE FROM users WHERE identity_platform_uid = ANY($1::text[])`,
      [["uid-ver-a", "uid-ver-b"]]);
    await admin.end();
    await app.close();
    await closePool();
  });

  const KEY = "vynora_solution_design_acme";

  it("a Design Studio save bumps the version — the write that used not to", async () => {
    expect((await save("tok-a", "uc-1", "first")).statusCode).toBe(200);
    const v1 = await versionOf(KEY);
    expect(v1).toBeGreaterThan(0);

    expect((await save("tok-a", "uc-1", "second")).statusCode).toBe(200);
    const v2 = await versionOf(KEY);
    expect(v2).toBe(v1 + 1);
  });

  it("rewriting a row with an IDENTICAL value does not bump", async () => {
    // Otherwise every idempotent re-save invalidates a colleague's read token
    // and the conflict dialog becomes noise people click through.
    await save("tok-a", "uc-same", "x");
    const before = await versionOf(KEY);
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(
      `UPDATE module_state SET updated_at = now()
        WHERE tenant_id = $1 AND module = 'workspace' AND key = $2`, [tenant, KEY]);
    await admin.query("COMMIT");
    expect(await versionOf(KEY)).toBe(before);
  });

  it("a conditional PUT with a version the Design Studio has moved past is REFUSED", async () => {
    // The finding, end to end and across features. Consultant A reads the
    // workspace; consultant B saves a use case; A's conditional write must not
    // be accepted as current.
    await save("tok-a", "uc-2", "before-read");

    const read = await app.inject({
      method: "GET", url: "/api/module-state/workspace", headers: H("tok-a"),
    });
    expect(read.statusCode).toBe(200);
    const stale = read.json().versions[KEY] as number;
    expect(stale, "the read must return a version for this key, or this test proves nothing")
      .toBeGreaterThan(0);

    // B changes the row through a route that knows nothing about versions.
    expect((await save("tok-b", "uc-3", "b-was-here")).statusCode).toBe(200);

    const write = await app.inject({
      method: "PUT", url: "/api/module-state/workspace", headers: H("tok-a"),
      payload: { sets: { [KEY]: JSON.stringify({ "uc-2": "A's stale whole-store rewrite" }) },
                 deletes: [], expectedVersions: { [KEY]: stale } },
    });
    expect(write.statusCode).toBe(409);
    expect(write.json().error).toBe("version_conflict");

    // And B's work is still there — the point of refusing.
    const after = await app.inject({
      method: "GET", url: "/api/solution-design?client=Acme", headers: H("tok-a"),
    });
    expect(Object.keys(after.json().designs)).toContain("uc-3");
  });

  it("a conditional PUT at the CURRENT version still succeeds", async () => {
    // The other half. A guard that refuses everything is not a guard.
    const read = await app.inject({
      method: "GET", url: "/api/module-state/workspace", headers: H("tok-a"),
    });
    const current = read.json().versions[KEY] as number;
    const write = await app.inject({
      method: "PUT", url: "/api/module-state/workspace", headers: H("tok-a"),
      payload: { sets: { [KEY]: JSON.stringify({ ok: true }) }, deletes: [],
                 expectedVersions: { [KEY]: current } },
    });
    expect(write.statusCode).toBe(200);
  });
});

describe.skipIf(!ENABLED)("the Design Studio store is not lost-updateable (V2-M2)", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;

  const verifierMap: Record<string, VerifiedIdentity> = {
    "tok-x": { uid: "uid-lu-x", email: "x@lu.com", idpTenantId: undefined },
  };
  const H = (tok: string) => ({ authorization: `Bearer ${tok}` });

  const save = (useCaseId: string) =>
    app.inject({
      method: "PUT", url: "/api/solution-design", headers: H("tok-x"),
      payload: { clientName: "Acme", useCaseId, useCaseName: useCaseId, doc: doc(useCaseId) },
    });

  beforeAll(async () => {
    process.env.DEV_AUTH = "1";
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('LostUpdate Firm') RETURNING id`);
    tenant = t.rows[0].id;
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-lu-x', 'x@lu.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'consultant')
       ON CONFLICT (user_id, tenant_id) DO NOTHING`, [u.rows[0].id, tenant]);
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(
      `INSERT INTO client_assignments (tenant_id, user_id, client_name, client_norm)
       VALUES ($1, $2, 'Acme', 'acme') ON CONFLICT DO NOTHING`, [tenant, u.rows[0].id]);
    await admin.query("COMMIT");

    initPool(APP_URL);
    app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier(verifierMap),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await admin.query(`DELETE FROM users WHERE identity_platform_uid = 'uid-lu-x'`);
    await admin.end();
    await app.close();
    await closePool();
  });

  it("twelve concurrent saves of DIFFERENT use cases all survive", async () => {
    // Every use case for a client lives in one row, so each save rewrites the
    // whole store. Read-in-one-transaction, write-in-another loses all but the
    // last; measured against the pre-fix code, twelve concurrent saves left one
    // or two entries behind. Twelve rather than two for the same reason as the
    // live-session race: a pair is a coin toss, and a coin-toss test gets
    // believed when it lands the wrong way.
    const ids = Array.from({ length: 12 }, (_, i) => `uc-${i}`);
    const rs = await Promise.all(ids.map(save));
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);

    const get = await app.inject({
      method: "GET", url: "/api/solution-design?client=Acme", headers: H("tok-x"),
    });
    const designs = get.json().designs as Record<string, unknown>;
    expect(Object.keys(designs).sort()).toEqual(ids.sort());
  });

  it("a delete concurrent with saves removes exactly one entry", async () => {
    for (const id of ["keep-1", "keep-2", "drop-me"]) await save(id);
    const [, del] = await Promise.all([
      save("keep-3"),
      app.inject({
        method: "DELETE", url: "/api/solution-design", headers: H("tok-x"),
        payload: { clientName: "Acme", useCaseId: "drop-me" },
      }),
    ]);
    expect(del.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET", url: "/api/solution-design?client=Acme", headers: H("tok-x"),
    });
    const keys = Object.keys(get.json().designs as Record<string, unknown>);
    expect(keys).not.toContain("drop-me");
    for (const k of ["keep-1", "keep-2", "keep-3"]) expect(keys).toContain(k);
  });
});
