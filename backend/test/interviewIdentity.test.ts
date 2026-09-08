/**
 * INTERVIEW IDENTITY AND CROSS-CONTAMINATION (v5.32.54)
 *
 * The Interview Agent's correctness rests on one question: when a person signs
 * in, WHICH interview are they in? Everything else — whose briefing they see,
 * whose voice the interviewer uses, where their answers are written, which
 * round their scores land in — follows from that answer.
 *
 * The routing key is the LOGIN, not the client name and not the role:
 *
 *   WHERE interviewee_user_id = <them>
 *     AND (kind = 'initial' OR agenda_status = 'approved')
 *   ORDER BY created_at DESC LIMIT 1
 *
 * These tests exist because that query has three sharp edges that only appear
 * with repeat interviews of the same people — which is the normal case in a
 * consulting engagement, not an edge case:
 *
 *   · a login is one account per email, so re-inviting the same address makes
 *     a SECOND row that shadows the first;
 *   · `LIMIT 1` means the loser is unreachable rather than merely lower in a
 *     list — its state namespace can never be opened by anyone;
 *   · the completion route uses a DIFFERENT predicate from the bootstrap, so
 *     the row a person is looking at and the row they complete can differ.
 *
 * Everything here runs against a real Postgres with RLS on, through the real
 * HTTP app, because these are queries and policies rather than pure functions.
 *
 * Run: RLS_TEST=1 TEST_DATABASE_URL=... RLS_APP_URL=... npx vitest run test/interviewIdentity.test.ts
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
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:change-me-via-ops@localhost:5432/vyne";

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

describe.skipIf(!ENABLED)("interview identity: no interview may cross with another", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;

  const verifierMap: Record<string, VerifiedIdentity> = {
    "tok-cons": { uid: "uid-cons-id", email: "cons@firm.com", idpTenantId: undefined },
    // One shared mailbox, used by two invites — the shadowing case.
    "tok-shared": { uid: "shared@client.com", email: "shared@client.com", idpTenantId: undefined },
    // A stakeholder re-interviewed in a later round under the same login.
    "tok-repeat": { uid: "repeat@client.com", email: "repeat@client.com", idpTenantId: undefined },
    // A colleague interviewed in the same round — the leak case.
    "tok-colleague": { uid: "colleague@client.com", email: "colleague@client.com", idpTenantId: undefined },
    // A stakeholder completing an interview while the engagement index is
    // stale — the duplicate-engagement case (F8).
    "tok-stale": { uid: "stale@client.com", email: "stale@client.com", idpTenantId: undefined },
  };
  const H = (tok: string) => ({ authorization: `Bearer ${tok}` });

  const invite = (name: string, role: string, email: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST", url: "/api/interviews", headers: H("tok-cons"),
      payload: { clientName: "Acme", intervieweeName: name, intervieweeRole: role, email, ...extra },
    });

  beforeAll(async () => {
    process.env.DEV_AUTH = "1";
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Identity Firm') RETURNING id`);
    tenant = t.rows[0].id;
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-cons-id', 'cons@firm.com')
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
    await admin.end();
    await app.close();
    await closePool();
  });

  // ── Shadowing: two invites, one login ─────────────────────────────────────

  it("two invites on ONE login produce two rows, and only the newest is reachable", async () => {
    const first = await invite("First Person", "CFO", "shared@client.com",
      { interviewerName: "Alice", interviewerVoice: "Kore" });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().id;

    // created_at has timestamptz resolution; make the ordering unambiguous
    // rather than relying on two inserts landing in different microseconds.
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(
      `UPDATE interviews SET created_at = now() - interval '1 hour' WHERE id = $1`, [firstId]);
    await admin.query("COMMIT");

    const second = await invite("Second Person", "COO", "shared@client.com",
      { interviewerName: "Bruno", interviewerVoice: "Orus" });
    expect(second.statusCode).toBe(201);

    const boot = await app.inject({
      method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-shared") });
    expect(boot.statusCode).toBe(200);
    // The NEWER invite wins outright — including its interviewer identity.
    expect(boot.json().interview.interviewee_name).toBe("Second Person");
    expect(boot.json().interview.interviewer_voice).toBe("Orus");
    // And the older row is not merely lower in a list: nothing can open it.
    expect(boot.json().interview.id).not.toBe(firstId);
  });

  it("the tracker still shows BOTH rows, so a consultant can see the collision", async () => {
    // This is what the shadowed-login flag in interviews.html renders from. If
    // the API hid the loser, the consultant would have no way to notice that a
    // stakeholder they are chasing can never actually sign in.
    const list = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-cons") });
    const shared = list.json().interviews.filter(
      (i: { email: string }) => i.email === "shared@client.com");
    expect(shared).toHaveLength(2);
    expect(shared.map((i: { interviewee_name: string }) => i.interviewee_name).sort())
      .toEqual(["First Person", "Second Person"]);
  });

  it("writing state as the shared login touches ONLY the winning interview's namespace", async () => {
    const put = await app.inject({
      method: "PUT", url: "/api/interviews/mine/state", headers: H("tok-shared"),
      payload: { sets: { "vynora_session_x": JSON.stringify({ scores: { D1: 4 } }) }, deletes: [] },
    });
    expect(put.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-cons") });
    const rows = list.json().interviews.filter((i: { email: string }) => i.email === "shared@client.com");
    const winner = rows.find((i: { interviewee_name: string }) => i.interviewee_name === "Second Person");
    const loser = rows.find((i: { interviewee_name: string }) => i.interviewee_name === "First Person");

    // The winner advanced to in_progress; the shadowed row is untouched, which
    // is exactly why it looks to a consultant like a stakeholder who never
    // started rather than one who cannot start.
    expect(winner.status).toBe("in_progress");
    expect(loser.status).toBe("invited");

    const loserState = await app.inject({
      method: "GET", url: `/api/interviews/${loser.id}/state`, headers: H("tok-cons") });
    expect(loserState.statusCode).toBe(200);
    expect(Object.keys(loserState.json().state)).toHaveLength(0);
  });

  // ── Repeat rounds: same person, later round ───────────────────────────────

  it("a repeat invite for a later round routes the person to the NEW interview, not the old one", async () => {
    const r1 = await invite("Repeat Exec", "CEO", "repeat@client.com",
      { interviewerName: "Alice", interviewerVoice: "Kore" });
    expect(r1.statusCode).toBe(201);
    const r1Id = r1.json().id;

    await app.inject({
      method: "PUT", url: "/api/interviews/mine/state", headers: H("tok-repeat"),
      payload: { sets: { "vynora_session_r1": JSON.stringify({ scores: { D1: 3 }, lastSaved: 1 }) }, deletes: [] },
    });
    expect((await app.inject({
      method: "POST", url: "/api/interviews/mine/complete", headers: H("tok-repeat") })).statusCode).toBe(200);

    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(`UPDATE interviews SET created_at = now() - interval '90 days' WHERE id = $1`, [r1Id]);
    await admin.query("COMMIT");

    // Next quarter: same executive, same login, new interview, new voice.
    const r2 = await invite("Repeat Exec", "CEO", "repeat@client.com",
      { interviewerName: "Bruno", interviewerVoice: "Charon" });
    expect(r2.statusCode).toBe(201);

    const boot = await app.inject({
      method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-repeat") });
    expect(boot.json().interview.id).toBe(r2.json().id);
    expect(boot.json().interview.interviewer_voice).toBe("Charon");
    expect(boot.json().interview.status).toBe("invited");
  });

  it("round 1's saved answers are NOT visible in the round 2 session", async () => {
    // Each interview owns a private module_state namespace (iv_<uuid>). If the
    // second round inherited the first's state, the exec would be shown last
    // quarter's answers as though they were this quarter's — and the round-over-
    // round delta, which is the entire value of a re-diagnostic, would be zero.
    const boot = await app.inject({
      method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-repeat") });
    expect(boot.statusCode).toBe(200);
    const own = boot.json().own as Record<string, string>;
    expect(own["vynora_session_r1"]).toBeUndefined();
  });

  it("completing round 2 does not reopen or overwrite the completed round 1 row", async () => {
    const before = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-cons") });
    const r1 = before.json().interviews
      .filter((i: { email: string }) => i.email === "repeat@client.com")
      .sort((a: { created_at: string }, b: { created_at: string }) =>
        a.created_at.localeCompare(b.created_at))[0];
    expect(r1.status).toBe("completed");
    const r1CompletedAt = r1.completed_at;

    await app.inject({
      method: "PUT", url: "/api/interviews/mine/state", headers: H("tok-repeat"),
      payload: { sets: { "vynora_session_r2": JSON.stringify({ scores: { D1: 5 }, lastSaved: 2 }) }, deletes: [] },
    });
    expect((await app.inject({
      method: "POST", url: "/api/interviews/mine/complete", headers: H("tok-repeat") })).statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-cons") });
    const rows = after.json().interviews.filter((i: { email: string }) => i.email === "repeat@client.com");
    expect(rows).toHaveLength(2);
    const r1After = rows.find((i: { id: string }) => i.id === r1.id);
    // The older row keeps its original completion stamp. A completion that
    // walked to the wrong row would move this.
    expect(r1After.completed_at).toBe(r1CompletedAt);
    expect(rows.every((i: { status: string }) => i.status === "completed")).toBe(true);
  });

  // ── Mid-round confidentiality ─────────────────────────────────────────────

  it("an interviewee does NOT receive the findings of colleagues in their own round", () => {
    // v5.32.54. The gate used to be `status !== "active"`, and
    // mergeSessionIntoEngagement sets status="complete" after the FIRST
    // completion — so the moment one executive finished, every colleague still
    // to be interviewed received their verbatim findings and the round's
    // scores. Attribution is stripped, but "Nobody owns governance and the
    // board has not been told" identifies its author in a five-person client.
    const eng = JSON.stringify({
      code: "ACME01", client: "Acme", industry: "Manufacturing",
      currentRoundId: "r2",
      rounds: [
        {
          roundId: "r1", roundNumber: 1, status: "complete",
          scores: { D1: 3.1 },
          interviews: [{ role: "CFO", findings: [{ dimension: "D1", text: "PRIOR ROUND FINDING" }] }],
        },
        {
          roundId: "r2", roundNumber: 2, status: "complete",   // ← the trap
          scores: { D6: 1.4 },
          interviews: [{ role: "CFO", findings: [{ dimension: "D6", text: "COLLEAGUE SAID THIS TODAY" }] }],
        },
      ],
    });
    const out = JSON.parse(sanitizeEngagementForInterviewee(eng, null));
    const r2 = out.rounds.find((r: { roundId: string }) => r.roundId === "r2");
    const r1 = out.rounds.find((r: { roundId: string }) => r.roundId === "r1");

    expect(r2.findingsByDimension).toEqual({});
    expect(r2.scores).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("COLLEAGUE SAID THIS TODAY");

    // The PRIOR round is still carried — that is the round-over-round
    // continuity this projection exists to provide, and withholding it would
    // break the feature rather than secure it.
    expect(r1.findingsByDimension.D1).toBe("PRIOR ROUND FINDING");
    expect(r1.scores).toEqual({ D1: 3.1 });
  });

  it("withholds every round when the record names no current round", () => {
    // Fail closed: a record with no currentRoundId gives no way to tell which
    // round is in progress, so nothing is treated as settled.
    const eng = JSON.stringify({
      code: "X", rounds: [{ roundId: "r1", status: "complete", scores: { D1: 2 },
        interviews: [{ findings: [{ dimension: "D1", text: "SECRET" }] }] }],
    });
    const out = JSON.parse(sanitizeEngagementForInterviewee(eng, null));
    expect(out.rounds[0].scores).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  // ── Cross-person isolation ────────────────────────────────────────────────

  it("two different logins in the same client never see each other's state", async () => {
    const c = await invite("Colleague", "CTO", "colleague@client.com");
    expect(c.statusCode).toBe(201);

    await app.inject({
      method: "PUT", url: "/api/interviews/mine/state", headers: H("tok-colleague"),
      payload: { sets: { "vynora_session_colleague": JSON.stringify({ secret: "COLLEAGUE PRIVATE" }) }, deletes: [] },
    });

    const other = await app.inject({
      method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-repeat") });
    expect(JSON.stringify(other.json().own)).not.toContain("COLLEAGUE PRIVATE");
    expect(other.json().interview.interviewee_name).toBe("Repeat Exec");

    // And neither can read the tracker to discover the other exists.
    expect((await app.inject({
      method: "GET", url: "/api/interviews", headers: H("tok-colleague") })).statusCode).toBe(403);
  });

  // ── Deleting one interview must not destroy a person's access ────────────

  it("deleting ONE interview leaves a person's other interview reachable", async () => {
    /*
     * v5.32.57. The orphan check that decides whether to delete an
     * interviewee's membership and Identity Platform login used to run inside
     * withoutTenant(), where `interviews` is invisible under FORCE RLS — so it
     * always concluded "no interviews left" and always deleted the login.
     *
     * This test could not have caught it before the fix, because the check was
     * in the untested branch; what it catches now is a regression back to it.
     * The observable consequence is the assertion below: the person must still
     * be able to bootstrap into their remaining interview.
     */
    const a = await invite("Two Rounds", "CFO", "tworounds@client.com");
    expect(a.statusCode).toBe(201);
    const firstId = a.json().id;
    verifierMap["tok-two"] = { uid: "tworounds@client.com", email: "tworounds@client.com", idpTenantId: undefined };

    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(`UPDATE interviews SET created_at = now() - interval '1 hour' WHERE id = $1`, [firstId]);
    await admin.query("COMMIT");

    const b = await invite("Two Rounds", "CFO", "tworounds@client.com", { roundNumber: 2 });
    expect(b.statusCode).toBe(201);

    // Delete the OLDER interview. The newer one must survive intact.
    const del = await app.inject({
      method: "DELETE", url: `/api/interviews/${firstId}`, headers: H("tok-cons") });
    expect(del.statusCode).toBe(200);

    const boot = await app.inject({
      method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-two") });
    expect(boot.statusCode).toBe(200);
    expect(boot.json().interview.id).toBe(b.json().id);

    // The membership survived — that is what the buggy version destroyed.
    const m = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE u.email = 'tworounds@client.com' AND m.tenant_id = $1`, [tenant]);
    expect(Number(m.rows[0].n)).toBe(1);
  });

  it("deleting a person's LAST interview does remove their membership", async () => {
    // The cleanup still has to happen — a login that grants access to nothing
    // should not linger. This is the other half of the same predicate.
    const c = await invite("Only One", "CTO", "onlyone@client.com");
    expect(c.statusCode).toBe(201);
    const del = await app.inject({
      method: "DELETE", url: `/api/interviews/${c.json().id}`, headers: H("tok-cons") });
    expect(del.statusCode).toBe(200);
    const m = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE u.email = 'onlyone@client.com' AND m.tenant_id = $1`, [tenant]);
    expect(Number(m.rows[0].n)).toBe(0);
  });

  it("an interviewee cannot reach another interview's private namespace directly", async () => {
    const list = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-cons") });
    const target = list.json().interviews.find(
      (i: { email: string }) => i.email === "colleague@client.com");
    const mod = "iv_" + String(target.id).replace(/-/g, "");
    const r = await app.inject({
      method: "GET", url: `/api/module-state/${mod}`, headers: H("tok-repeat") });
    expect([403, 404]).toContain(r.statusCode);
  });

  /*
   * F8 (v5.32.59) — a stale index used to mint a SECOND engagement for a
   * client that already had one, and the portfolio then listed them twice with
   * two different maturity scores. The index is rewritten by a client rename
   * and absent from imported snapshots, so "stale" is a routine state, not a
   * corruption.
   */
  it("a stale engagement index adopts the existing record instead of minting a duplicate", async () => {
    const setWs = async (key: string, value: string) => {
      await admin.query("BEGIN");
      await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      await admin.query(
        `INSERT INTO module_state (tenant_id, module, key, value, updated_by)
         VALUES ($1, 'workspace', $2, $3, NULL)
         ON CONFLICT (tenant_id, module, key) DO UPDATE SET value = EXCLUDED.value`,
        [tenant, key, JSON.stringify({ v: value })]);
      await admin.query("COMMIT");
    };
    const readWs = async () => {
      await admin.query("BEGIN");
      await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      const r = await admin.query<{ key: string; value: { v: string } }>(
        `SELECT key, value FROM module_state WHERE module = 'workspace'
          AND key LIKE 'vynora_engagement_%'`);
      await admin.query("COMMIT");
      return r.rows;
    };

    // Wipe whatever earlier tests left, then plant ONE record for Acme with a
    // completed round — and an index that has never heard of it.
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(
      `DELETE FROM module_state WHERE module = 'workspace' AND key LIKE 'vynora_engagement_%'`);
    await admin.query("COMMIT");
    await setWs("vynora_engagement_index", JSON.stringify({}));
    await setWs("vynora_engagement_ACMEHIST", JSON.stringify({
      code: "ACMEHIST", client: "Acme", industry: "Manufacturing",
      rounds: [{
        roundId: "r1", roundNumber: 1, label: "Initial Diagnostic", type: "initial",
        date: "2026-01-01", scopeDimensions: [], status: "complete",
        interviews: [{ role: "CFO", interviewee: "Prior Person", scores: { D1: 2 }, findings: [] }],
        scores: { D1: 2 },
      }],
    }));

    const inv = await invite("Stale Case", "CEO", "stale@client.com");
    expect(inv.statusCode).toBe(201);
    await app.inject({ method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-stale") });
    // A session must exist for the merge to run at all — the completion route
    // has nothing to fold in otherwise.
    const put = await app.inject({
      method: "PUT", url: "/api/interviews/mine/state", headers: H("tok-stale"),
      payload: { sets: { "vynora_session_stale": JSON.stringify({
        scores: { D3: 4 }, findings: [{ dimension: "D3", text: "strategy is unfunded" }],
        lastSaved: Date.now(),
      }) }, deletes: [] },
    });
    expect(put.statusCode).toBe(200);
    const done = await app.inject({
      method: "POST", url: "/api/interviews/mine/complete", headers: H("tok-stale") });
    expect(done.statusCode).toBe(200);

    const rows = await readWs();
    const engKeys = rows.map((r) => r.key).filter((k) => k !== "vynora_engagement_index").sort();
    // The whole point: ONE engagement for Acme, not two.
    expect(engKeys).toEqual(["vynora_engagement_ACMEHIST"]);

    const idx = JSON.parse(rows.find((r) => r.key === "vynora_engagement_index")!.value.v) as Record<string, string>;
    expect(idx.acme).toBe("ACMEHIST");   // and the index was repaired on the way

    const eng = JSON.parse(rows.find((r) => r.key === "vynora_engagement_ACMEHIST")!.value.v);
    // The prior round's history survived the adoption.
    const r1 = eng.rounds.find((r: { roundNumber: number }) => r.roundNumber === 1);
    expect(r1.interviews.some((i: { interviewee: string }) => i.interviewee === "Prior Person")).toBe(true);
    // ...and the new interview landed in the SAME record.
    const everyone = eng.rounds.flatMap((r: { interviews: { interviewee: string }[] }) => r.interviews ?? []);
    expect(everyone.some((i: { interviewee: string }) => i.interviewee === "Stale Case")).toBe(true);
  });
});

/**
 * ROUND SEPARATION (v5.32.55) — pure-function tests, no database needed.
 *
 * The distributed path had no way to say "this interview is for round 2", so
 * mergeSessionIntoEngagement always targeted the CURRENT round and the upsert
 * replaced the same person's earlier entry. Re-interviewing an executive a
 * quarter later destroyed their original read, and the round-over-round delta —
 * the whole point of a re-diagnostic — was computed against mutated history.
 */
describe("round separation: a later round must not overwrite an earlier one", () => {
  const session = (scores: Record<string, number>, name = "Jane Chen") => ({
    client: "Acme", industry: "Manufacturing",
    stakeholderName: name, stakeholderRole: "CEO",
    scores, findings: [{ dimension: "D1", text: `finding for ${JSON.stringify(scores)}` }],
    lastSaved: Date.now(),
  });

  it("a round-2 interview creates round 2 instead of replacing the round-1 record", async () => {
    const { mergeSessionIntoEngagement } = await import("../src/tenant/engagementMerge.js");
    let eng = mergeSessionIntoEngagement(null, "ACME01", session({ D1: 2, D3: 2 }) as never, {
      sourceInterviewId: "iv-q1", kind: "initial",
    });
    expect(eng.rounds).toHaveLength(1);
    expect(eng.rounds[0].interviews).toHaveLength(1);

    // Next quarter, same executive, same role — invited for round 2.
    eng = mergeSessionIntoEngagement(eng, "ACME01", session({ D1: 4, D3: 5 }) as never, {
      sourceInterviewId: "iv-q2", kind: "initial", roundNumber: 2,
    });

    expect(eng.rounds).toHaveLength(2);
    const r1 = eng.rounds.find((r) => r.roundNumber === 1)!;
    const r2 = eng.rounds.find((r) => r.roundNumber === 2)!;
    // Round 1 is untouched — this is the assertion the whole change exists for.
    expect(r1.interviews).toHaveLength(1);
    expect(r1.interviews[0].scores!.D1).toBe(2);
    expect(r2.interviews[0].scores!.D1).toBe(4);
    // And the delta the client is shown is now real.
    expect(r2.scores!.D1).toBeGreaterThan(r1.scores!.D1);
  });

  it("without a round number it still targets the current round — unchanged behaviour", async () => {
    const { mergeSessionIntoEngagement } = await import("../src/tenant/engagementMerge.js");
    let eng = mergeSessionIntoEngagement(null, "ACME02", session({ D1: 2 }) as never, {
      sourceInterviewId: "iv-a", kind: "initial",
    });
    eng = mergeSessionIntoEngagement(eng, "ACME02", session({ D1: 3 }) as never, {
      sourceInterviewId: "iv-b", kind: "initial",
    });
    // Same person, same role, no round given: still an upsert, as before. A
    // consultant correcting a botched interview relies on this.
    expect(eng.rounds).toHaveLength(1);
    expect(eng.rounds[0].interviews).toHaveLength(1);
    expect(eng.rounds[0].interviews[0].scores!.D1).toBe(3);
  });

  it("a replaced record is archived, not destroyed", async () => {
    const { mergeSessionIntoEngagement } = await import("../src/tenant/engagementMerge.js");
    let eng = mergeSessionIntoEngagement(null, "ACME03", session({ D1: 2 }) as never, {
      sourceInterviewId: "iv-first", kind: "initial",
    });
    eng = mergeSessionIntoEngagement(eng, "ACME03", session({ D1: 5 }) as never, {
      sourceInterviewId: "iv-second", kind: "initial",
    });
    // The engagement record is the ONLY copy of a completed interview's scores
    // and findings. Overwriting stays the default, but the previous version is
    // recoverable rather than gone.
    const round = eng.rounds[0] as unknown as Record<string, unknown>;
    const archived = round.superseded as Array<Record<string, unknown>>;
    expect(archived).toHaveLength(1);
    expect((archived[0].scores as Record<string, number>).D1).toBe(2);
    expect(archived[0].supersededBy).toBe("iv-second");
  });

  it("re-merging the SAME interview stays idempotent and archives nothing", async () => {
    const { mergeSessionIntoEngagement } = await import("../src/tenant/engagementMerge.js");
    let eng = mergeSessionIntoEngagement(null, "ACME04", session({ D1: 3 }) as never, {
      sourceInterviewId: "iv-x", kind: "initial",
    });
    eng = mergeSessionIntoEngagement(eng, "ACME04", session({ D1: 4 }) as never, {
      sourceInterviewId: "iv-x", kind: "initial",
    });
    const round = eng.rounds[0] as unknown as Record<string, unknown>;
    expect(eng.rounds[0].interviews).toHaveLength(1);
    expect(eng.rounds[0].interviews[0].scores!.D1).toBe(4);
    expect(round.superseded).toBeUndefined();
  });
});

/**
 * SCORING CORRECTIONS (v5.32.57) — both of these put wrong numbers in front of
 * a client, and both were found by executing the module rather than reading it.
 */
describe("round scores must not borrow from the future or discount a role", () => {
  it("carries forward from the previous round by NUMBER, not array position", async () => {
    const { mergeSessionIntoEngagement } = await import("../src/tenant/engagementMerge.js");
    const sess = (scores: Record<string, number>) => ({
      client: "Acme", stakeholderRole: "CEO", stakeholderName: "Jane Chen",
      scores, findings: [], lastSaved: Date.now(),
    });
    // Rounds are pushed in COMPLETION order. A consultant can legitimately pin
    // round 3 before round 2 finishes, which leaves the array as [1, 3, 2].
    let e = mergeSessionIntoEngagement(null, "A", sess({ D1: 2.7, D2: 1.0 }) as never,
      { sourceInterviewId: "r1", kind: "initial", roundNumber: 1 });
    e = mergeSessionIntoEngagement(e, "A", sess({ D1: 4.0, D2: 5.0 }) as never,
      { sourceInterviewId: "r3", kind: "initial", roundNumber: 3 });
    e = mergeSessionIntoEngagement(e, "A", sess({ D1: 3.0 }) as never,
      { sourceInterviewId: "r2", kind: "initial", roundNumber: 2 });

    expect(e.rounds.map((r) => r.roundNumber)).toEqual([1, 3, 2]);   // array order IS out of order
    const r2 = e.rounds.find((r) => r.roundNumber === 2)!;
    // D2 was not scored in round 2. It must inherit round 1's 1.0 — NOT round
    // 3's 5.0, which is what walking the array by index produced.
    expect(r2.scores!.D2).toBe(1.0);
    // And nothing in a later round is disturbed by the backfill.
    expect(e.rounds.find((r) => r.roundNumber === 3)!.scores!.D1).toBe(4.0);
  });

  it("weights a role the same whether it arrives as a slug or a display label", async () => {
    const { roleWeight } = await import("../src/tenant/engagementMerge.js");
    // Every catalog label must resolve to its slug's weight. The one that did
    // not was "Operations / Frontline Manager" → "Operations" → unknown → 0.5,
    // which discounted the frontline voice by nearly half on D5 — the
    // dimension they know best — in every synthetic and imported engagement.
    const pairs: Array<[string, string]> = [
      ["CEO", "CEO / Executive Leadership"],
      ["CFO", "CFO / Finance Leadership"],
      ["CTO", "CTO / Technology Leadership"],
      ["COO", "COO / VP Operations"],
      ["VP_Sales", "VP Sales / Revenue"],
      ["IT_Director", "IT Director / CISO"],
      ["Operations_Manager", "Operations / Frontline Manager"],
    ];
    for (const d of ["D1", "D2", "D3", "D4", "D5", "D6", "D7"]) {
      for (const [slug, label] of pairs) {
        expect(roleWeight(d, label), `${d} ${label}`).toBe(roleWeight(d, slug));
      }
    }
    // The specific number that was wrong.
    expect(roleWeight("D5", "Operations / Frontline Manager")).toBe(0.9);
    // A role nobody defined still has no defensible weight.
    expect(roleWeight("D5", "Chief Vibes Officer")).toBe(0.5);
  });
});

/**
 * MODULE-STATE CONCURRENCY (v5.32.58)
 *
 * Two consultants with the same client open is not an edge case — it is a
 * normal Tuesday on an engagement team. Until now the second save silently
 * destroyed the first, returned 200, and left the loser's screen showing work
 * that no longer existed anywhere.
 */
describe.skipIf(!ENABLED)("module_state must not silently overwrite a colleague", () => {
  let admin2: pg.Client;
  let app2: FastifyInstance;
  let tenant2: string;
  const H2 = (tok: string) => ({ authorization: `Bearer ${tok}` });

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin2 = new pg.Client({ connectionString: ADMIN_URL });
    await admin2.connect();
    const t = await admin2.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Concurrency Firm') RETURNING id`);
    tenant2 = t.rows[0].id;
    const u = await admin2.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-conc', 'conc@firm.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin2.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT (user_id, tenant_id) DO NOTHING`, [u.rows[0].id, tenant2]);
    initPool(APP_URL);
    app2 = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier({ "tok-conc": { uid: "uid-conc", email: "conc@firm.com", idpTenantId: undefined } }),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
  });

  afterAll(async () => {
    await admin2.query(`DELETE FROM tenants WHERE id = $1`, [tenant2]);
    await admin2.end();
    await app2.close();
  });

  it("hands out a version with every read", async () => {
    await app2.inject({
      method: "PUT", url: "/api/module-state/workspace", headers: H2("tok-conc"),
      payload: { sets: { vynora_note: "first" }, deletes: [] },
    });
    const g = await app2.inject({
      method: "GET", url: "/api/module-state/workspace", headers: H2("tok-conc") });
    expect(g.statusCode).toBe(200);
    expect(g.json().versions.vynora_note).toBeGreaterThanOrEqual(1);
  });

  it("refuses a write built on a stale read, and returns the current value", async () => {
    const g = await app2.inject({
      method: "GET", url: "/api/module-state/workspace", headers: H2("tok-conc") });
    const staleVersion = g.json().versions.vynora_note;

    // Consultant B saves first.
    const b = await app2.inject({
      method: "PUT", url: "/api/module-state/workspace", headers: H2("tok-conc"),
      payload: { sets: { vynora_note: "B's work" }, deletes: [],
                 expectedVersions: { vynora_note: staleVersion } },
    });
    expect(b.statusCode).toBe(200);

    // Consultant A, still holding the pre-B snapshot, saves second.
    const a = await app2.inject({
      method: "PUT", url: "/api/module-state/workspace", headers: H2("tok-conc"),
      payload: { sets: { vynora_note: "A's work" }, deletes: [],
                 expectedVersions: { vynora_note: staleVersion } },
    });
    expect(a.statusCode).toBe(409);
    expect(a.json().error).toBe("version_conflict");
    // The current value comes back, which is what lets A re-apply rather than
    // retype. A bare rejection would leave a person guessing what they lost.
    expect(a.json().conflicts[0].key).toBe("vynora_note");
    expect(a.json().conflicts[0].value).toBe("B's work");
    expect(a.json().conflicts[0].version).toBeGreaterThan(staleVersion);

    // And B's work is still there — the whole point.
    const after = await app2.inject({
      method: "GET", url: "/api/module-state/workspace", headers: H2("tok-conc") });
    expect(after.json().state.vynora_note).toBe("B's work");
  });

  it("still accepts a write with no expected version, so open tabs keep working", async () => {
    const r = await app2.inject({
      method: "PUT", url: "/api/module-state/workspace", headers: H2("tok-conc"),
      payload: { sets: { vynora_note: "unconditional" }, deletes: [] },
    });
    expect(r.statusCode).toBe(200);
  });

  it("writes the un-conflicted keys even when one key collides", async () => {
    const g = await app2.inject({
      method: "GET", url: "/api/module-state/workspace", headers: H2("tok-conc") });
    const v = g.json().versions.vynora_note;
    await app2.inject({
      method: "PUT", url: "/api/module-state/workspace", headers: H2("tok-conc"),
      payload: { sets: { vynora_note: "moved on" }, deletes: [] },
    });
    const r = await app2.inject({
      method: "PUT", url: "/api/module-state/workspace", headers: H2("tok-conc"),
      payload: { sets: { vynora_note: "stale", vynora_other: "fine" }, deletes: [],
                 expectedVersions: { vynora_note: v } },
    });
    expect(r.statusCode).toBe(409);
    // Rolling back the good key to punish a collision on an unrelated one
    // would discard real work.
    const after = await app2.inject({
      method: "GET", url: "/api/module-state/workspace", headers: H2("tok-conc") });
    expect(after.json().state.vynora_other).toBe("fine");
    expect(after.json().state.vynora_note).toBe("moved on");
  });
});
