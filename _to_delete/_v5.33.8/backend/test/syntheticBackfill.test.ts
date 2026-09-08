/**
 * Backfilling logins onto pre-v5.32.81 synthetic interviews.
 *
 * Until v5.32.81 the generator inserted synthetic interviews with a NULL
 * interviewee_user_id, and the follow-up draft route refuses on exactly that
 * (`if (!p.interviewee_user_id) return "no_login"` → 409). Every synthetic
 * sitting generated before .81 shows a Request-follow-up button that cannot
 * work, and until this route the only fix was to regenerate the engagement —
 * discarding whatever had been done with it.
 *
 * The assertion that matters in every case below is the LAST one: not "the
 * column is populated" but "the follow-up the consultant actually clicks
 * returns 201". A row can carry a user id and still fail the route.
 *
 * The fixtures are built by INSERTING rows in the pre-.81 shape directly,
 * rather than by generating and then nulling the column. Generating first
 * would build them with today's code, which is the code whose absence this
 * repairs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
    if (!id) throw new Error("bad");
    return id;
  }
}

const idleAdapter: ProviderAdapter = {
  name: "gemini-aistudio", model: "fake", freeTier: true,
  isConfigured: () => true,
  async generate() {
    return { text: "{}", model: "fake", usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0 } };
  },
};

describe.skipIf(!ENABLED)("synthetic login backfill", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;
  let ownerId: string;
  let consultantId: string;
  const OWNER = { authorization: "Bearer tok-owner" };
  const CONSULTANT = { authorization: "Bearer tok-con" };

  /** An interview row exactly as the pre-v5.32.81 generator wrote it. */
  async function legacyRow(args: {
    client: string; name: string; role: string; round: number; seq: number; codeSlug: string;
  }) {
    const slug = args.role.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "role";
    const r = await admin.query<{ id: string }>(
      `INSERT INTO interviews
         (tenant_id, client_name, interviewee_name, interviewee_role, status, state_module,
          created_by, started_at, completed_at, round_number, interviewer_name, kind,
          interviewee_user_id)
       VALUES ($1, $2, $3, $4, 'completed', $5, $6, now(), now(), $7, 'Vyn', 'initial', NULL)
       RETURNING id`,
      [tenant, args.client, args.name + " [Synthetic]", args.role,
       "iv_synth_" + args.codeSlug + "_" + slug + "_r" + args.round + "_" + args.seq,
       ownerId, args.round]
    );
    return r.rows[0].id;
  }

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Backfill Firm') RETURNING id`);
    tenant = t.rows[0].id;

    const o = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-bf-owner', 'o@bf.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    ownerId = o.rows[0].id;
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`,
      [ownerId, tenant]);

    const cns = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-bf-con', 'c@bf.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    consultantId = cns.rows[0].id;
    await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'consultant')`,
      [consultantId, tenant]);
    // Assigned to Alpha only. Beta is the client they must not touch.
    await admin.query(
      `INSERT INTO client_assignments (tenant_id, user_id, client_name, client_norm)
       VALUES ($1, $2, 'Alpha Legacy', 'alphalegacy')`,
      [tenant, consultantId]);

    initPool(APP_URL);
    app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier({
        "tok-owner": { uid: "uid-bf-owner", email: "o@bf.com", idpTenantId: undefined },
        "tok-con": { uid: "uid-bf-con", email: "c@bf.com", idpTenantId: undefined },
      }),
      adapters: [idleAdapter],
      meter: async () => {},
    });
  });

  afterAll(async () => {
    await app?.close();
    await closePool();
    if (admin) {
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
      await admin.query(`DELETE FROM users WHERE identity_platform_uid LIKE 'uid-bf-%'`);
      await admin.query(`DELETE FROM users WHERE identity_platform_uid LIKE 'synthetic:%'`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await admin.query(`DELETE FROM interviews WHERE tenant_id = $1`, [tenant]);
  });

  const backfill = (headers: Record<string, string>, body: unknown = {}) =>
    app.inject({ method: "POST", url: "/api/synthetic/backfill-logins", headers, payload: body });

  it("repairs a legacy row so the follow-up draft returns 201 instead of 409", async () => {
    const id = await legacyRow({
      client: "Alpha Legacy", name: "Victoria Hale", role: "CEO",
      round: 1, seq: 0, codeSlug: "alphsyn1",
    });

    // The 409 this exists to remove — asserted first, so the test cannot pass
    // by repairing something that was never broken.
    const before = await app.inject({
      method: "POST", url: `/api/interviews/${id}/followup/draft`, headers: OWNER });
    expect(before.statusCode).toBe(409);

    const r = await backfill(OWNER);
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    expect(r.json().repaired).toBe(1);

    const after = await app.inject({
      method: "POST", url: `/api/interviews/${id}/followup/draft`, headers: OWNER });
    expect(after.statusCode, after.body.slice(0, 300)).toBe(201);
    expect(after.json().id).toBeTruthy();
  });

  it("is idempotent — a second run repairs nothing and changes nothing", async () => {
    await legacyRow({ client: "Alpha Legacy", name: "Victoria Hale", role: "CEO",
      round: 1, seq: 0, codeSlug: "alphsyn1" });

    expect((await backfill(OWNER)).json().repaired).toBe(1);
    const firstIds = await admin.query<{ interviewee_user_id: string }>(
      `SELECT interviewee_user_id FROM interviews WHERE tenant_id = $1`, [tenant]);

    const second = await backfill(OWNER);
    expect(second.statusCode).toBe(200);
    expect(second.json().repaired).toBe(0);

    const afterIds = await admin.query<{ interviewee_user_id: string }>(
      `SELECT interviewee_user_id FROM interviews WHERE tenant_id = $1`, [tenant]);
    // Not merely "still populated" — the SAME user, so a second run cannot
    // quietly re-point a row at a freshly minted login.
    expect(afterIds.rows).toEqual(firstIds.rows);
  });

  it("gives the same person ONE login across rounds, not one per sitting", async () => {
    await legacyRow({ client: "Alpha Legacy", name: "Victoria Hale", role: "CEO",
      round: 1, seq: 0, codeSlug: "alphsyn1" });
    await legacyRow({ client: "Alpha Legacy", name: "Victoria Hale", role: "CEO",
      round: 2, seq: 1, codeSlug: "alphsyn1" });
    await legacyRow({ client: "Alpha Legacy", name: "Marcus Webb", role: "COO",
      round: 1, seq: 2, codeSlug: "alphsyn1" });

    expect((await backfill(OWNER)).json().repaired).toBe(3);

    const rows = await admin.query<{ interviewee_name: string; interviewee_user_id: string }>(
      `SELECT interviewee_name, interviewee_user_id FROM interviews WHERE tenant_id = $1`, [tenant]);
    const hale = rows.rows.filter((r) => r.interviewee_name.startsWith("Victoria"));
    expect(hale).toHaveLength(2);
    // A follow-up reuses the interviewee's login. Two logins for one person
    // means a follow-up can reuse a stranger's.
    expect(new Set(hale.map((r) => r.interviewee_user_id)).size).toBe(1);
    expect(new Set(rows.rows.map((r) => r.interviewee_user_id)).size).toBe(2);
  });

  /**
   * The same property, ACROSS runs — and this is the version with teeth.
   *
   * Within one run the route keeps a per-persona cache, which means the
   * assertion above holds even if the uid were derived per ROW rather than
   * from (code, name, role): the second sitting never reaches the derivation.
   * Verified, not assumed — swapping the derivation to a per-row one leaves
   * the test above green.
   *
   * What cannot be faked is a second run, where the cache is empty and the
   * derivation is all there is. That is also what production does: a row is
   * repaired today and the engagement is regenerated next week.
   */
  it("a person repaired in one run gets the SAME login in the next", async () => {
    await legacyRow({ client: "Alpha Legacy", name: "Victoria Hale", role: "CEO",
      round: 1, seq: 0, codeSlug: "alphsyn1" });
    expect((await backfill(OWNER)).json().repaired).toBe(1);
    const first = await admin.query<{ interviewee_user_id: string }>(
      `SELECT interviewee_user_id FROM interviews WHERE tenant_id = $1`, [tenant]);

    // Round 2 for the same person arrives later — a fresh process, an empty
    // cache, nothing but the derivation to go on.
    await legacyRow({ client: "Alpha Legacy", name: "Victoria Hale", role: "CEO",
      round: 2, seq: 1, codeSlug: "alphsyn1" });
    expect((await backfill(OWNER)).json().repaired).toBe(1);

    const both = await admin.query<{ interviewee_user_id: string }>(
      `SELECT interviewee_user_id FROM interviews WHERE tenant_id = $1`, [tenant]);
    expect(both.rows).toHaveLength(2);
    expect(new Set(both.rows.map((r) => r.interviewee_user_id)).size).toBe(1);
    expect(both.rows[0].interviewee_user_id).toBe(first.rows[0].interviewee_user_id);
  });

  /**
   * The property the whole design turns on. syntheticLogin() is deterministic
   * in (code, name, role); the backfill recovers `code` from state_module so a
   * repaired row and a LATER regeneration land on the same uid. Get this wrong
   * and regeneration silently mints a second user for the same person, leaving
   * the repaired one orphaned.
   */
  it("uses the uid a later regeneration will also derive", async () => {
    await legacyRow({ client: "Alpha Legacy", name: "Victoria Hale", role: "CEO",
      round: 1, seq: 0, codeSlug: "alphsyn1" });
    await backfill(OWNER);

    const uid = await admin.query<{ identity_platform_uid: string; email: string }>(
      `SELECT u.identity_platform_uid, u.email FROM users u
         JOIN interviews i ON i.interviewee_user_id = u.id
        WHERE i.tenant_id = $1`, [tenant]);
    expect(uid.rows).toHaveLength(1);
    expect(uid.rows[0].identity_platform_uid).toBe("synthetic:alphsyn1:victoria.hale.synthetic");
    // Unusable as real credentials: RFC 2606 reserves .invalid so it can never
    // resolve or receive mail, and the prefix keeps it off any real sign-in.
    expect(uid.rows[0].email.endsWith(".synthetic.invalid")).toBe(true);
    expect(uid.rows[0].identity_platform_uid.startsWith("synthetic:")).toBe(true);
  });

  it("a consultant repairs only the clients they are assigned to", async () => {
    const alpha = await legacyRow({ client: "Alpha Legacy", name: "Victoria Hale", role: "CEO",
      round: 1, seq: 0, codeSlug: "alphsyn1" });
    const beta = await legacyRow({ client: "Beta Legacy", name: "Marcus Webb", role: "COO",
      round: 1, seq: 0, codeSlug: "betasyn1" });

    const r = await backfill(CONSULTANT);
    expect(r.statusCode).toBe(200);
    expect(r.json().repaired).toBe(1);
    expect(r.json().clients).toEqual(["Alpha Legacy"]);

    const rows = await admin.query<{ id: string; interviewee_user_id: string | null }>(
      `SELECT id, interviewee_user_id FROM interviews WHERE tenant_id = $1`, [tenant]);
    expect(rows.rows.find((x) => x.id === alpha)!.interviewee_user_id).toBeTruthy();
    // Untouched, not merely unreported.
    expect(rows.rows.find((x) => x.id === beta)!.interviewee_user_id).toBeNull();
  });

  it("scopes to one client when asked, and refuses one the caller cannot reach", async () => {
    await legacyRow({ client: "Alpha Legacy", name: "Victoria Hale", role: "CEO",
      round: 1, seq: 0, codeSlug: "alphsyn1" });
    await legacyRow({ client: "Beta Legacy", name: "Marcus Webb", role: "COO",
      round: 1, seq: 0, codeSlug: "betasyn1" });

    const scoped = await backfill(OWNER, { clientName: "Alpha Legacy" });
    expect(scoped.json().repaired).toBe(1);
    expect(scoped.json().clients).toEqual(["Alpha Legacy"]);

    const denied = await backfill(CONSULTANT, { clientName: "Beta Legacy" });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("client_not_assigned");
  });

  /**
   * `_` is a single-character wildcard in LIKE, so an unescaped 'iv_synth_%'
   * also matches 'ivXsynthY…'. This row is what that mistake would catch: a
   * REAL interview, with a real interviewee, whose state_module happens to
   * differ from the synthetic prefix only in the separators. Writing a
   * synthetic login onto it would hand a genuine interview an unusable
   * .invalid identity.
   */
  it("does not touch a real interview whose state_module merely resembles the prefix", async () => {
    const real = await admin.query<{ id: string }>(
      `INSERT INTO interviews
         (tenant_id, client_name, interviewee_name, interviewee_role, status, state_module,
          created_by, round_number, kind, interviewee_user_id)
       VALUES ($1, 'Alpha Legacy', 'Dana Reed', 'CFO', 'invited', 'ivAsynthB_real_r1_0', $2, 1,
               'initial', NULL)
       RETURNING id`, [tenant, ownerId]);

    const r = await backfill(OWNER);
    expect(r.json().repaired).toBe(0);

    const after = await admin.query<{ interviewee_user_id: string | null }>(
      `SELECT interviewee_user_id FROM interviews WHERE id = $1`, [real.rows[0].id]);
    expect(after.rows[0].interviewee_user_id).toBeNull();
  });

  it("leaves an already-repaired row alone rather than re-pointing it", async () => {
    const id = await legacyRow({ client: "Alpha Legacy", name: "Victoria Hale", role: "CEO",
      round: 1, seq: 0, codeSlug: "alphsyn1" });
    const other = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-bf-existing', 'e@bf.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(`UPDATE interviews SET interviewee_user_id = $1 WHERE id = $2`,
      [other.rows[0].id, id]);

    const r = await backfill(OWNER);
    expect(r.json().repaired).toBe(0);
    const after = await admin.query<{ interviewee_user_id: string }>(
      `SELECT interviewee_user_id FROM interviews WHERE id = $1`, [id]);
    expect(after.rows[0].interviewee_user_id).toBe(other.rows[0].id);
    await admin.query(`DELETE FROM users WHERE identity_platform_uid = 'uid-bf-existing'`);
  });

  it("an interviewee cannot run the backfill", async () => {
    const iu = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-bf-iv', 'iv@bf.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'interviewee')
       ON CONFLICT (user_id, tenant_id) DO NOTHING`, [iu.rows[0].id, tenant]);
    const app2 = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier({ "tok-iv": { uid: "uid-bf-iv", email: "iv@bf.com", idpTenantId: undefined } }),
      adapters: [idleAdapter],
      meter: async () => {},
    });
    try {
      const r = await app2.inject({
        method: "POST", url: "/api/synthetic/backfill-logins",
        headers: { authorization: "Bearer tok-iv" }, payload: {},
      });
      expect(r.statusCode).toBe(403);
    } finally {
      await app2.close();
    }
  });
});
