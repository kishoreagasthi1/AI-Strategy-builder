/**
 * Which round's material an interviewee may see (audit V2-H3).
 *
 * v5.32.65. `sanitizeEngagementForInterviewee` decides, per round, whether to
 * hand an interviewee that round's aggregate scores and one verbatim finding
 * per dimension. The rule it is meant to enforce is "prior rounds only" — the
 * round-over-round continuity the projection exists for — and it must never
 * hand over the round the person is currently being interviewed in, because a
 * candid sentence from a colleague is frequently self-identifying even with
 * attribution stripped.
 *
 * This is the THIRD attempt at that predicate, and the first two both failed in
 * the same shape: the code keyed on something that correlates with "their
 * round" until it doesn't.
 *
 *   v5.32.29 → `r.status !== "active"`. mergeSessionIntoEngagement sets a
 *              round's status to "complete" after the FIRST completion, so the
 *              round opened up while four colleagues were still to be seen.
 *   v5.32.54 → `r.roundId !== eng.currentRoundId`. Better — an identity rather
 *              than a status — but the identity belongs to the ENGAGEMENT, and
 *              it moves the moment a consultant plans the next round. Round 2's
 *              stragglers then read round 2 in full, because from the
 *              engagement's point of view round 2 is no longer current.
 *
 * Planning the next round before the previous one is fully collected is not an
 * exotic sequence; it is how a refresh gets scheduled. So the fix keys on the
 * only fact that actually answers the question — `interviews.round_number`, set
 * by the consultant at invite time — and delivers rounds STRICTLY BEFORE it.
 *
 * Two levels are tested, because the previous two fixes were both correct in
 * the sanitiser and the gap was elsewhere:
 *   · the predicate itself, as a pure function;
 *   · the bootstrap ROUTE, over HTTP against a real database, because a
 *     sanitiser that is never told the interviewee's round is a sanitiser with
 *     the bug still in it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import { sanitizeEngagementForInterviewee } from "../src/routes/interviews.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";
import type { ProviderAdapter } from "../src/llm/types.js";
import type { FastifyInstance } from "fastify";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5433/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:apppw@localhost:5433/vyne";

/**
 * Three rounds. The engagement has moved on to round 3; round 2 is the one
 * still being collected from the point of view of anyone invited into it.
 */
const ENGAGEMENT = {
  code: "RND01", client: "Acme", industry: "Manufacturing",
  currentRoundId: "r3",
  rounds: [
    {
      roundId: "r1", roundNumber: 1, status: "complete", scores: { D1: 3.1 },
      interviews: [{ role: "CFO", findings: [{ dimension: "D1", text: "ROUND ONE FINDING" }] }],
    },
    {
      roundId: "r2", roundNumber: 2, status: "complete", scores: { D6: 1.4 },
      interviews: [{ role: "CFO", findings: [{ dimension: "D6", text: "MY COLLEAGUE SAID THIS" }] }],
    },
    {
      roundId: "r3", roundNumber: 3, status: "complete", scores: { D2: 2.2 },
      interviews: [{ role: "COO", findings: [{ dimension: "D2", text: "SOMEONE ELSES ROUND THREE" }] }],
    },
  ],
};

const sanitize = (own: number | null) =>
  JSON.parse(sanitizeEngagementForInterviewee(JSON.stringify(ENGAGEMENT), own));
const round = (out: { rounds: { roundId: string }[] }, id: string) =>
  out.rounds.find((r) => r.roundId === id) as unknown as {
    scores?: Record<string, number>; findingsByDimension: Record<string, string>;
  };

describe("the round predicate (V2-H3)", () => {
  it("withholds the interviewee's OWN round even though the engagement has moved past it", () => {
    // The whole finding, in one assertion. currentRoundId is r3, so under the
    // v5.32.54 predicate round 2 was 'not the current round' and was therefore
    // delivered in full — to somebody sitting down to be interviewed in it.
    const out = sanitize(2);
    expect(round(out, "r2").scores).toBeUndefined();
    expect(round(out, "r2").findingsByDimension).toEqual({});
    expect(JSON.stringify(out)).not.toContain("MY COLLEAGUE SAID THIS");
  });

  it("still delivers earlier rounds — withholding everything would not be a fix", () => {
    // The projection exists to give an interviewee last time's picture. A
    // "secure" version that hands over nothing has removed the feature rather
    // than protected it, and would pass every leak assertion above.
    const out = sanitize(2);
    expect(round(out, "r1").findingsByDimension.D1).toBe("ROUND ONE FINDING");
    expect(round(out, "r1").scores).toEqual({ D1: 3.1 });
  });

  it("withholds rounds LATER than the interviewee's own", () => {
    // Round 3 is not theirs and is not prior to theirs: there is nothing in it
    // they need for continuity, and it is being collected from other people
    // right now. Reachable whenever rounds are created out of order, or an
    // invite is issued against an earlier round after a newer one exists.
    const out = sanitize(2);
    expect(round(out, "r3").scores).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("SOMEONE ELSES ROUND THREE");
  });

  it("withholds the current round for a legacy invite with no round number", () => {
    // NULL keeps migration 016's meaning — "whatever round is current" — so
    // the v5.32.54 behaviour has to survive unchanged for every invite issued
    // before the field existed.
    const out = sanitize(null);
    expect(round(out, "r3").scores).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("SOMEONE ELSES ROUND THREE");
    expect(round(out, "r1").findingsByDimension.D1).toBe("ROUND ONE FINDING");
    // r2 is prior from the engagement's point of view and there is no better
    // information available, so it is delivered. That is the pre-existing
    // contract for round-less invites, stated rather than assumed.
    expect(round(out, "r2").findingsByDimension.D6).toBe("MY COLLEAGUE SAID THIS");
  });

  it("fails closed on a round that carries no round number", () => {
    // Cannot be proven to be earlier than theirs, so it is not delivered.
    const eng = JSON.stringify({
      code: "X", currentRoundId: "rX",
      rounds: [
        { roundId: "rA", status: "complete", scores: { D1: 2 },
          interviews: [{ findings: [{ dimension: "D1", text: "UNNUMBERED" }] }] },
        { roundId: "rX", roundNumber: 9, status: "complete" },
      ],
    });
    const out = JSON.parse(sanitizeEngagementForInterviewee(eng, 5));
    expect(out.rounds[0].scores).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("UNNUMBERED");
  });

  it("fails closed when the record names no current round at all", () => {
    const eng = JSON.stringify({
      code: "X",
      rounds: [{ roundId: "r1", roundNumber: 1, status: "complete", scores: { D1: 2 },
        interviews: [{ findings: [{ dimension: "D1", text: "NO CURRENT ROUND" }] }] }],
    });
    const out = JSON.parse(sanitizeEngagementForInterviewee(eng, 4));
    expect(out.rounds[0].scores).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("NO CURRENT ROUND");
  });

  it("never carries the raw interviews array, whatever the round", () => {
    // The V225-audit CRITICAL. Re-asserted here because every change to this
    // function is a chance to reintroduce it by widening the projection.
    for (const own of [null, 1, 2, 3, 99]) {
      const out = sanitize(own as number | null);
      for (const r of out.rounds) expect(r.interviews).toBeUndefined();
    }
  });
});

/**
 * The wiring. A unit test on the predicate would have passed on the day V2-H3
 * shipped, because the predicate was fine — it was being handed the wrong
 * round. So this drives the real route: consultant invites someone into round
 * 2, the workspace record says the engagement is on round 3, and the
 * interviewee's own bootstrap response is inspected.
 */
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

describe.skipIf(!ENABLED)("the bootstrap route passes the interviewee's own round (V2-H3)", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;

  const verifierMap: Record<string, VerifiedIdentity> = {
    "tok-cons": { uid: "uid-rnd-cons", email: "cons@rnd.com", idpTenantId: undefined },
    "tok-r2": { uid: "r2@acme.com", email: "r2@acme.com", idpTenantId: undefined },
    "tok-plain": { uid: "plain@acme.com", email: "plain@acme.com", idpTenantId: undefined },
  };
  const H = (tok: string) => ({ authorization: `Bearer ${tok}` });

  async function putWorkspace(key: string, raw: string) {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(
      `INSERT INTO module_state (tenant_id, module, key, value)
       VALUES ($1, 'workspace', $2, $3::jsonb)
       ON CONFLICT (tenant_id, module, key) DO UPDATE SET value = EXCLUDED.value`,
      [tenant, key, JSON.stringify({ v: raw })]
    );
    await admin.query("COMMIT");
  }

  beforeAll(async () => {
    process.env.DEV_AUTH = "1";
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Round Firm') RETURNING id`);
    tenant = t.rows[0].id;
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-rnd-cons', 'cons@rnd.com')
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

    await putWorkspace("vynora_engagement_index", JSON.stringify({ acme: "RND01" }));
    await putWorkspace("vynora_engagement_RND01", JSON.stringify(ENGAGEMENT));
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await admin.query(`DELETE FROM users WHERE identity_platform_uid = ANY($1::text[])`,
      [["uid-rnd-cons", "r2@acme.com", "plain@acme.com"]]);
    await admin.end();
    await app.close();
    await closePool();
  });

  it("an interviewee invited into round 2 does not receive round 2 over HTTP", async () => {
    const inv = await app.inject({
      method: "POST", url: "/api/interviews", headers: H("tok-cons"),
      payload: {
        clientName: "Acme", intervieweeName: "Dana Reed", intervieweeRole: "CFO",
        email: "r2@acme.com", roundNumber: 2,
      },
    });
    expect(inv.statusCode).toBe(201);

    const boot = await app.inject({
      method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-r2"),
    });
    expect(boot.statusCode).toBe(200);
    const body = boot.body;

    // The leak, at the level a browser would have seen it.
    expect(body).not.toContain("MY COLLEAGUE SAID THIS");
    expect(body).not.toContain("SOMEONE ELSES ROUND THREE");
    // Continuity still works: their prior round comes through.
    expect(body).toContain("ROUND ONE FINDING");

    // And the row really did carry a round number — otherwise the assertions
    // above would be satisfied by the legacy NULL path and prove nothing about
    // the wiring this test exists to check.
    const rn = await admin.query<{ round_number: number | null }>(
      `SELECT round_number FROM interviews WHERE tenant_id = $1 AND interviewee_name = $2`,
      [tenant, "Dana Reed"]);
    expect(rn.rows[0]?.round_number).toBe(2);
  });

  it("an invite with no round number still gets prior-round continuity", async () => {
    // The regression risk in this fix is over-withholding. A round-less invite
    // must behave exactly as it did before: current round withheld, earlier
    // rounds delivered.
    const inv = await app.inject({
      method: "POST", url: "/api/interviews", headers: H("tok-cons"),
      payload: {
        clientName: "Acme", intervieweeName: "Sam Vale", intervieweeRole: "COO",
        email: "plain@acme.com",
      },
    });
    expect(inv.statusCode).toBe(201);

    const boot = await app.inject({
      method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-plain"),
    });
    expect(boot.statusCode).toBe(200);
    expect(boot.body).toContain("ROUND ONE FINDING");
    expect(boot.body).not.toContain("SOMEONE ELSES ROUND THREE");
  });
});
