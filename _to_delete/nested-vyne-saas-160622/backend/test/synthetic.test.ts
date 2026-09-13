/**
 * Synthetic engagement generator — integration test with a fake adapter.
 * Verifies: consultant-only access, workspace keys written in the shapes
 * Synthesis reads (index merged, engagement with flat interviews + refresh
 * tags, briefing), tracker rows created as completed synthetics.
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
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:change-me-via-ops@localhost:5432/vyne";

class FakeVerifier implements TokenVerifier {
  constructor(private map: Record<string, VerifiedIdentity>) {}
  async verify(t: string): Promise<VerifiedIdentity> {
    const id = this.map[t];
    if (!id) throw new Error("bad");
    return id;
  }
}

const fakeAdapter: ProviderAdapter = {
  name: "gemini-aistudio", model: "fake", freeTier: true,
  isConfigured: () => true,
  async generate() {
    return {
      text: JSON.stringify({
        scores: { D1: 2.1, D2: 2.4, D3: 3.1, D4: 2.0, D5: 2.5, D6: 1.4, D7: 2.6 },
        findings: [
          { dimension: "D1", text: "Three data warehouses operate without a single source of truth." },
          { dimension: "D6", text: "No function currently owns AI governance." },
        ],
        /*
         * A trail, because a real model returns one (v5.32.89).
         *
         * This adapter used to omit `scoreEvents` entirely, so the "writes
         * findings and a score trail" case below passed through
         * synthScoreEvents' FALLBACK — the branch that manufactures a trail
         * out of the final scores when the model gave nothing — while reading
         * as though it covered the path production actually takes. The second
         * entry is anchored past the end of any transcript this fixture
         * produces, so the clamp is exercised through the route and not only
         * in syntheticScoreTrail.test.ts.
         */
        scoreEvents: [
          { dimension: "D1", from: 3, to: 2, afterTurn: 2 },
          { dimension: "D6", from: null, to: 1, afterTurn: 999 },
        ],
        summary: "Candid view of fragmented data landscape.",
      }),
      model: "fake",
      usage: { tokensIn: 100, tokensOut: 200, costEstUsd: 0 },
    };
  },
};

describe.skipIf(!ENABLED)("Synthetic engagement generator", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Synth Firm') RETURNING id`);
    tenant = t.rows[0].id;
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-synth', 's@f.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    // Owner role: this suite tests generation mechanics; client-assignment
    // scoping (Phase 5) is covered in clients.test.ts.
    await admin.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`,
      [u.rows[0].id, tenant]);
    const iu = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-synth-iv', 'i@f.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'interviewee')`,
      [iu.rows[0].id, tenant]);

    initPool(APP_URL);
    app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier({
        "tok-c": { uid: "uid-synth", email: "s@f.com", idpTenantId: undefined },
        "tok-i": { uid: "uid-synth-iv", email: "i@f.com", idpTenantId: undefined },
      }),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
  });

  afterAll(async () => {
    await app?.close();
    await closePool();
    if (admin) {
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
      await admin.query(`DELETE FROM users WHERE identity_platform_uid LIKE 'uid-synth%'`);
      await admin.end();
    }
  });

  it("generates a full engagement in the exact shapes Synthesis reads", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/synthetic/engagement",
      headers: { authorization: "Bearer tok-c" },
      payload: { clientName: "TestCo Industrial", industry: "Manufacturing", includeRefresh: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().interviews).toBe(10); // 5 initial + 5 refresh
    expect(r.json().rounds).toBe(2);
    const code = r.json().code;

    const ws = await app.inject({
      method: "GET", url: "/api/module-state/workspace",
      headers: { authorization: "Bearer tok-c" },
    });
    const state = ws.json().state;

    const idx = JSON.parse(state["vynora_engagement_index"]);
    expect(idx["testcoindustrial"]).toBe(code);

    const eng = JSON.parse(state["vynora_engagement_" + code]);
    expect(eng.interviews).toHaveLength(10);
    expect(eng.rounds).toHaveLength(1); // Synthesis's loader creates round 2 from tags
    const refresh = eng.interviews.filter((i: { isRefresh?: boolean }) => i.isRefresh);
    expect(refresh).toHaveLength(5);
    expect(refresh[0].refreshRound).toBe(2);
    expect(refresh[0].coverageByDim.D6).toBe(1.0);
    expect(eng.interviews[0].scores.D6).toBe(1.4);
    expect(eng.interviews[0].findings.length).toBeGreaterThan(0);

    const briefing = JSON.parse(state["vynora_briefing_testcoindustrial"]);
    expect(briefing.hypotheses).toHaveLength(4);

    const tracker = await app.inject({
      method: "GET", url: "/api/interviews", headers: { authorization: "Bearer tok-c" },
    });
    const synthRows = tracker.json().interviews.filter(
      (i: { interviewee_name: string }) => i.interviewee_name.includes("[Synthetic]"));
    /* v5.32.60: was 5. The generator used to write tracker rows for the
     * INITIAL round only, so a synthetic engagement showed five sittings in
     * the tracker and ten in Synthesis — and the Round column had nothing to
     * show a second value for. Now: 5 initial + 5 refresh + 1 follow-up. */
    expect(synthRows).toHaveLength(11);
    expect(synthRows.every((i: { status: string }) => i.status === "completed")).toBe(true);

    // Every sitting knows which round it belongs to.
    const rounds = synthRows.map((i: { round_number: number }) => i.round_number).sort();
    expect(rounds.filter((n: number) => n === 1)).toHaveLength(5);
    expect(rounds.filter((n: number) => n === 2)).toHaveLength(6);   // 5 + the follow-up
    expect(synthRows.every((i: { interviewer_name: string }) => !!i.interviewer_name)).toBe(true);
    expect(synthRows.every((i: { interviewer_voice: string }) => !!i.interviewer_voice)).toBe(true);

    // A genuine follow-up, hung off a real parent — a shape nothing else in
    // the product could produce for testing.
    const fu = synthRows.filter((i: { kind: string }) => i.kind === "follow_up");
    expect(fu).toHaveLength(1);
    expect(fu[0].parent_interview_id).toBeTruthy();
    expect(synthRows.some((i: { id: string }) => i.id === fu[0].parent_interview_id)).toBe(true);

    // ...and every sitting has a readable transcript behind the tracker's
    // Transcript button. This is the whole reason a consultant can rehearse
    // the audit trail without running eleven real interviews.
    for (const row of synthRows) {
      const t = await app.inject({
        method: "GET", url: `/api/interviews/${row.id}/transcript`,
        headers: { authorization: "Bearer tok-c" },
      });
      expect(t.statusCode, `transcript for ${row.interviewee_name} r${row.round_number}`).toBe(200);
      const turns = t.json().transcripts[0].turns;
      expect(turns.length).toBeGreaterThanOrEqual(4);
      expect(turns.some((x: { who: string }) => x.who === "Interviewer")).toBe(true);
      expect(turns.some((x: { who: string }) => x.who === "Interviewee")).toBe(true);
      expect(turns.every((x: { text: string }) => x.text.trim().length > 0)).toBe(true);
    }

    /* The synthesis is persisted too, so the Synthesis box, the strategy deck
     * and the roadmap's full-synthesis loader all have something to read
     * without a real ~90-second paid AI call first. */
    const full = JSON.parse(state["vynora_synthesis_full_" + code]);
    expect(full.synthesis.maturityFingerprint.overallPattern.length).toBeGreaterThan(40);
    expect(full.synthesis.maturityFingerprint.criticalGaps.length).toBeGreaterThan(0);
    expect(full.synthesis.hypothesisVerdict).toHaveLength(4);
    expect(full.synthesis.sequencedRecommendations[0].priority).toBe(1);
    expect(full.synthesis.blindSpots.length).toBeGreaterThan(0);
    // Marked, so a reader can always tell this was generated rather than found.
    expect(full.synthetic).toBe(true);
    expect(full.synthesis.synthetic).toBe(true);
  });


  /**
   * v5.32.81: synthetic interviews had no interviewee login, so the follow-up
   * draft route refused every one of them with 409 no_login. The tracker showed
   * a "Request follow-up" button on each synthetic sitting that could not
   * succeed — which meant the single most intricate flow in the product was the
   * one flow synthetic data could not rehearse.
   *
   * The assertion that matters is the LAST one: not "a user id is present" but
   * "the follow-up the consultant actually clicks now works". A row can carry a
   * user id and still fail the route for some other reason.
   */
  it("synthetic interviewees get a login, so a follow-up can actually be drafted", async () => {
    const gen = await app.inject({
      method: "POST", url: "/api/synthetic/engagement",
      headers: { authorization: "Bearer tok-c" },
      payload: { clientName: "Followup Testco", industry: "Manufacturing", includeRefresh: true },
    });
    expect(gen.statusCode).toBe(200);

    const rows = await admin.query<{
      id: string; interviewee_name: string; interviewee_role: string;
      interviewee_user_id: string | null; kind: string; round_number: number;
    }>(`SELECT id, interviewee_name, interviewee_role, interviewee_user_id, kind, round_number
          FROM interviews WHERE client_name = 'Followup Testco' ORDER BY round_number, id`);
    expect(rows.rows.length).toBeGreaterThan(0);

    // Every row, follow-up included — a null here is the 409.
    expect(rows.rows.filter((r) => !r.interviewee_user_id)).toEqual([]);

    // One login per PERSON, not per sitting: the same interviewee in rounds 1
    // and 2 must be the same login, or a follow-up reuses a stranger's.
    const byPersona = new Map<string, Set<string>>();
    for (const r of rows.rows) {
      const k = r.interviewee_name + "|" + r.interviewee_role;
      if (!byPersona.has(k)) byPersona.set(k, new Set());
      byPersona.get(k)!.add(r.interviewee_user_id!);
    }
    for (const [persona, ids] of byPersona) {
      expect(ids.size, persona + " has " + ids.size + " logins across rounds").toBe(1);
    }

    // The credentials must be unusable. `.invalid` is reserved by RFC 2606 so it
    // can never resolve or receive mail, and the uid prefix keeps a synthetic
    // persona from ever colliding with a real Identity Platform sign-in.
    const u = await admin.query<{ email: string; identity_platform_uid: string }>(
      `SELECT email, identity_platform_uid FROM users WHERE id = ANY($1::uuid[])`,
      [[...new Set(rows.rows.map((r) => r.interviewee_user_id!))]]
    );
    expect(u.rows.length).toBeGreaterThan(0);
    for (const row of u.rows) {
      expect(row.email.endsWith(".synthetic.invalid"), row.email).toBe(true);
      expect(row.identity_platform_uid.startsWith("synthetic:"), row.identity_platform_uid).toBe(true);
    }

    // They are interviewees of this firm, which is what the follow-up reuses.
    const m = await admin.query<{ role: string }>(
      `SELECT role FROM memberships WHERE user_id = ANY($1::uuid[])`,
      [[...new Set(rows.rows.map((r) => r.interviewee_user_id!))]]
    );
    expect(m.rows.length).toBeGreaterThan(0);
    expect(m.rows.every((r) => r.role === "interviewee")).toBe(true);

    // THE POINT: draft a follow-up on a completed synthetic interview through
    // the same route the tracker button calls.
    const parent = rows.rows.find((r) => r.kind === "initial")!;
    const draft = await app.inject({
      method: "POST", url: `/api/interviews/${parent.id}/followup/draft`,
      headers: { authorization: "Bearer tok-c" },
    });
    // 201, not 200 — the route CREATES a follow-up row. Asserted on the real
    // status rather than the assumed one.
    expect(draft.statusCode, draft.body.slice(0, 200)).toBe(201);
    expect(draft.json().id).toBeTruthy();
    expect(Array.isArray(draft.json().agenda)).toBe(true);
  });

  /**
   * Generating TWICE for the same client (v5.32.83, migration 024).
   *
   * Every case in this file before today used a client name no other case
   * used, so the route's delete-then-insert branch — the one its own comment
   * describes as "Regeneration replaces the previous synthetic set" — was never
   * reached. When it finally was, it raised `permission denied for table
   * interview_transcripts`: migration 017 deliberately grants vyne_app only
   * SELECT and INSERT there, and the route deletes prior transcripts first
   * because 017 equally deliberately declines a foreign key. Two correct
   * decisions that had never been executed in the same statement.
   *
   * A consultant hits this on their SECOND generation for a client, which is
   * the common case, not the edge one — the first thing anyone does with a
   * generator they are learning is run it again.
   *
   * This case is deliberately last-but-one in the file and reuses a client
   * name from an earlier case rather than inventing one, because inventing one
   * is precisely how the gap survived.
   */
  it("generating a second time for the SAME client replaces rather than 500s", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/synthetic/engagement",
      headers: { authorization: "Bearer tok-c" },
      payload: { clientName: "Followup Testco", industry: "Manufacturing", includeRefresh: false },
    });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    expect(r.json().rounds).toBe(1);

    const rows = await admin.query<{ synthetic: boolean; kind: string }>(
      `SELECT synthetic, kind FROM interviews WHERE client_name = 'Followup Testco'`);
    // v5.33.10. Regeneration REPLACES the synthetic set: five personas plus the
    // one specimen follow-up = 6 rows, all synthetic=true, and the previous
    // ten-interview two-round set is gone rather than stacked underneath. The
    // seventh row is the REAL follow-up the earlier case drafted through the
    // tracker's own route (synthetic=false): genuine work on the engagement,
    // which regeneration must preserve, not delete. (Before the specimen
    // follow-up was marked synthetic, this path 500'd on the duplicate
    // state_module and this count never ran — the old expectation of 6 was for
    // a world where the specimen collided with itself instead of replacing.)
    expect(rows.rows.length).toBe(7);
    expect(rows.rows.filter((r) => r.synthetic).length).toBe(6);
    expect(rows.rows.filter((r) => !r.synthetic).length).toBe(1);

    // The superseded transcripts went with their interviews. An orphan here
    // means the transcript delete silently did nothing.
    const orphans = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM interview_transcripts t
        WHERE t.client_name = 'Followup Testco'
          AND NOT EXISTS (SELECT 1 FROM interviews i WHERE i.id = t.interview_id)`);
    expect(orphans.rows[0].n).toBe(0);
  });


  /**
   * Synthetic transcripts carry their evidence (v5.32.89).
   *
   * Migration 023 added `findings` and `score_events` so a consultant can
   * answer "why is D6 a 1.5?" by pointing at a turn. The synthetic route's
   * transcript insert named only turns, count and mode — so every synthetic
   * interview rendered "No score trail was kept", at every version, and the
   * viewer blamed the interview's age for it.
   *
   * That defeats the stated purpose of the generator. v5.32.60's argument for
   * persisting a synthesis was that a synthetic engagement must let a
   * consultant rehearse the parts of the product that come AFTER interviewing,
   * and the evidence panel is one of them.
   */
  it("writes findings and a score trail onto synthetic transcripts", async () => {
    const gen = await app.inject({
      method: "POST", url: "/api/synthetic/engagement",
      headers: { authorization: "Bearer tok-c" },
      payload: { clientName: "Evidence Testco", industry: "Manufacturing", includeRefresh: false },
    });
    expect(gen.statusCode, gen.body.slice(0, 300)).toBe(200);

    /*
     * `kind` is joined in deliberately. A synthetic engagement writes two
     * different kinds of row and they carry trails from two different places:
     * the persona interviews carry whatever the model returned, and the one
     * specimen follow-up carries a hand-written trail anchored to its own
     * hand-written turns. Selecting the transcripts alone makes those
     * indistinguishable, and an assertion that has to hold for both can only
     * be weak enough to hold for neither in particular.
     */
    const rows = await admin.query<{
      interviewee_name: string; kind: string; turn_count: number;
      findings: { dimension: string; text: string }[] | null;
      score_events: { dimension: string; to: number; afterTurn: number }[] | null;
    }>(`SELECT t.interviewee_name, i.kind, t.turn_count, t.findings, t.score_events
          FROM interview_transcripts t
          JOIN interviews i ON i.id = t.interview_id
         WHERE t.client_name = 'Evidence Testco'`);
    expect(rows.rows.length).toBeGreaterThan(0);

    // NULL is the failure this fixes — every row must carry both.
    expect(rows.rows.filter((r) => r.findings === null)).toEqual([]);
    expect(rows.rows.filter((r) => r.score_events === null)).toEqual([]);

    for (const r of rows.rows) {
      expect(r.findings!.length, r.interviewee_name).toBeGreaterThan(0);
      expect(r.score_events!.length, r.interviewee_name).toBeGreaterThan(0);
      for (const e of r.score_events!) {
        // Bounded, because a trail pointing at a turn that does not exist is
        // worse than no trail.
        expect(["D1", "D2", "D3", "D4", "D5", "D6", "D7"]).toContain(e.dimension);
        expect(e.to).toBeGreaterThanOrEqual(1);
        expect(e.to).toBeLessThanOrEqual(5);
        expect(e.afterTurn).toBeGreaterThanOrEqual(1);
        expect(e.afterTurn).toBeLessThanOrEqual(Math.max(1, r.turn_count));
      }
    }

    /*
     * The MODEL's trail, not a substitute for it (v5.32.89).
     *
     * The adapter returns D1 moving 3→2 after turn 2. Asserting that specific
     * event is what separates "the route carried the model's trail through"
     * from "the route wrote a trail it invented from the final scores" — the
     * two are indistinguishable if all we check is non-null, and the fallback
     * would satisfy every assertion in the loop above.
     */
    const persona = rows.rows.filter((r) => r.kind !== "follow_up");
    expect(persona.length).toBe(5);
    for (const r of persona) {
      const d1 = r.score_events!.find((e) => e.dimension === "D1");
      expect(d1, r.interviewee_name).toBeTruthy();
      expect(d1!.to).toBe(2);
      expect(d1!.afterTurn).toBe(2);

      // And the adapter's out-of-range anchor was clamped to the last turn
      // rather than written through as 999.
      const d6 = r.score_events!.find((e) => e.dimension === "D6");
      expect(d6, r.interviewee_name).toBeTruthy();
      expect(d6!.afterTurn).toBe(r.turn_count);
    }

    /*
     * The specimen follow-up is the row a consultant opens to see what a
     * follow-up looks like, so its trail has to be about the follow-up
     * conversation — not the model's persona trail copied onto it. Its two
     * events are D6 at turn 4 and D2 at turn 6, which are the turns in its own
     * hand-written transcript where those things are actually said.
     */
    const followUps = rows.rows.filter((r) => r.kind === "follow_up");
    expect(followUps).toHaveLength(1);
    expect(followUps[0].score_events!.map((e) => [e.dimension, e.afterTurn]))
      .toEqual([["D6", 4], ["D2", 6]]);
    expect(followUps[0].findings!.map((f) => f.dimension)).toEqual(["D6", "D2"]);
  });

  it("uses the client's Pre-Engagement roles + hypotheses and preserves the real briefing", async () => {
    const H = { authorization: "Bearer tok-c" };
    await app.inject({ method: "PUT", url: "/api/module-state/workspace", headers: H, payload: { sets: {
      "vynora_engagement_index": JSON.stringify({ roleco: "ROLE-REAL" }),
      "vynora_engagement_ROLE-REAL": JSON.stringify({ client: "RoleCo", code: "ROLE-REAL", industry: "Healthcare", rounds: [{ roundId: "r1" }], interviews: [{ role: "CMO", name: "Real Person" }] }),
      "vynora_briefing_roleco": JSON.stringify({
        client: "RoleCo", industry: "Healthcare",
        roleCatalog: [
          { value: "cmo", display: "Chief Medical Officer", priorityDims: ["D4", "D6"] },
          { value: "cio", display: "Chief Information Officer", priorityDims: ["D1", "D2"] },
        ],
        hypotheses: [{ index: 0, text: "Clinical data silos block AI", status: "open" }],
      }),
    }, deletes: [] } });

    const r = await app.inject({ method: "POST", url: "/api/synthetic/engagement", headers: H,
      payload: { clientName: "RoleCo", includeRefresh: false } });
    expect(r.statusCode).toBe(200);
    expect(r.json().interviews).toBe(2); // one per configured role
    expect(r.json().code).toBe("ROLE-REAL"); // reuses the REAL engagement

    const ws = await app.inject({ method: "GET", url: "/api/module-state/workspace", headers: H });
    const st = ws.json().state;
    const briefing = JSON.parse(st["vynora_briefing_roleco"]);
    expect(briefing.hypotheses[0].text).toContain("Clinical data silos"); // untouched
    const eng = JSON.parse(st["vynora_engagement_ROLE-REAL"]);
    const roles = eng.interviews.map((i: { role: string }) => i.role);
    expect(roles).toContain("CMO"); // real interview kept
    expect(roles).toContain("Chief Medical Officer"); // synthetic from roleCatalog
    expect(roles).toContain("Chief Information Officer");
    expect(JSON.parse(st["vynora_engagement_index"]).roleco).toBe("ROLE-REAL");
  });

  it("interviewees cannot generate synthetic data", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/synthetic/engagement",
      headers: { authorization: "Bearer tok-i" },
      payload: { clientName: "Nope Co" },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe.skipIf(!ENABLED)("state_module uniqueness is per-tenant, not global (v5.32.60)", () => {
  /* Migration 019 (v5.32.58) made uq_interviews_state_module GLOBAL. The
   * synthetic generator builds state_module deterministically from the client
   * name and role, with nothing tenant-scoped in it — so the second firm to
   * generate test data for a client of the same name got a 500 and no
   * explanation, permanently. An index is not subject to row-level security:
   * it sees every tenant's rows whether or not the querying role can.
   *
   * Two tenants, one client name, both must succeed. */
  let admin2: pg.Client;
  const created: string[] = [];

  beforeAll(async () => {
    admin2 = new pg.Client({ connectionString: ADMIN_URL });
    await admin2.connect();
  });
  afterAll(async () => {
    for (const id of created) await admin2.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    await admin2.end();
  });

  it("two different firms can both hold the same interview namespace", async () => {
    const mk = async (name: string) => {
      const t = await admin2.query<{ id: string }>(
        `INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [name]);
      created.push(t.rows[0].id);
      return t.rows[0].id;
    };
    const a = await mk("Firm A (uniq)");
    const b = await mk("Firm B (uniq)");
    const insert = async (tenantId: string) => {
      await admin2.query("BEGIN");
      await admin2.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await admin2.query(
        `INSERT INTO interviews (tenant_id, client_name, interviewee_name, interviewee_role, status, state_module)
         VALUES ($1, 'Acme', 'Someone', 'CEO', 'completed', 'iv_synth_acmesyn1_ceo_r1_0')`,
        [tenantId]);
      await admin2.query("COMMIT");
    };
    await insert(a);
    // Before migration 020 this second insert threw 23505 and took the whole
    // synthetic-generation request down with it.
    await expect(insert(b)).resolves.toBeUndefined();
  });

  it("still refuses a duplicate namespace WITHIN one firm", async () => {
    const t = await admin2.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Firm C (uniq)') RETURNING id`);
    created.push(t.rows[0].id);
    const tenantId = t.rows[0].id;
    const insert = async () => {
      await admin2.query("BEGIN");
      await admin2.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await admin2.query(
        `INSERT INTO interviews (tenant_id, client_name, interviewee_name, interviewee_role, status, state_module)
         VALUES ($1, 'Acme', 'Someone', 'CEO', 'completed', 'iv_dupe_within_firm')`,
        [tenantId]);
      await admin2.query("COMMIT");
    };
    await insert();
    // Two interviews sharing a private namespace inside one firm IS the
    // cross-contamination bug 019 was reaching for. That protection stays.
    await expect(insert()).rejects.toThrow(/unique/i);
    await admin2.query("ROLLBACK").catch(() => {});
  });
});
