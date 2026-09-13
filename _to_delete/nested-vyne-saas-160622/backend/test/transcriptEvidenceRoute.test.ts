/**
 * The wiring: a completed interview leaves a transcript that can be reasoned
 * about (v5.32.66).
 *
 * transcriptEvidence.test.ts proves the shaping rules. It would pass in full
 * with the completion route never calling them and the read route never
 * selecting the columns — which is exactly how the last two round-confidentiality
 * fixes managed to be correct in the function and wrong in the product. So this
 * drives the real thing: an interviewee saves a session, completes over HTTP,
 * and a consultant reads the transcript back through the API they actually use.
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

const SECRET_FINDING = "Nobody owns model governance and the board has not been told.";

describe.skipIf(!ENABLED)("a completed interview carries its own reasoning (v5.32.66)", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;

  const H = (tok: string) => ({ authorization: `Bearer ${tok}` });

  beforeAll(async () => {
    process.env.DEV_AUTH = "1";
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Evidence Firm') RETURNING id`);
    tenant = t.rows[0].id;
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-ev-cons', 'cons@ev.com')
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
      verifier: new FakeVerifier({
        "tok-cons": { uid: "uid-ev-cons", email: "cons@ev.com", idpTenantId: undefined },
        "tok-dana": { uid: "dana@ev.com", email: "dana@ev.com", idpTenantId: undefined },
        "tok-sam": { uid: "sam@ev.com", email: "sam@ev.com", idpTenantId: undefined },
      }),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await admin.query(`DELETE FROM users WHERE identity_platform_uid = ANY($1::text[])`,
      [["uid-ev-cons", "dana@ev.com", "sam@ev.com"]]);
    await admin.end();
    await app.close();
    await closePool();
  });

  /** Invite someone, have them save `session`, complete, return the row id. */
  async function runInterview(
    name: string, email: string, tok: string, session: Record<string, unknown>
  ): Promise<string> {
    const inv = await app.inject({
      method: "POST", url: "/api/interviews", headers: H("tok-cons"),
      payload: {
        clientName: "Acme", intervieweeName: name, intervieweeRole: "CFO",
        email, roundNumber: 1,
      },
    });
    expect(inv.statusCode).toBe(201);
    const id = inv.json().id as string;

    const put = await app.inject({
      method: "PUT", url: "/api/interviews/mine/state", headers: H(tok),
      payload: { sets: { [`vynora_session_${session.sessionId}`]: JSON.stringify(session) }, deletes: [] },
    });
    expect(put.statusCode).toBe(200);

    const done = await app.inject({
      method: "POST", url: "/api/interviews/mine/complete", headers: H(tok), payload: {},
    });
    expect(done.statusCode).toBe(200);
    return id;
  }

  const displayMessages = [
    { role: "ai", text: "Tell me how data is managed today.", at: 1_000 },
    { role: "user", text: "We have a warehouse but no catalogue.", at: 2_000 },
    { role: "ai", text: "And who signs off on a model going live?", at: 3_000 },
    { role: "user", text: "Honestly, nobody does.", at: 4_000 },
  ];

  it("stores the findings and the score movements, and hands them back to the consultant", async () => {
    const id = await runInterview("Dana Reed", "dana@ev.com", "tok-dana", {
      sessionId: "sess-ev-1",
      sessionCode: "VYNE-EVD1-0001",
      client: "Acme", stakeholderRole: "CFO", stakeholderName: "Dana Reed",
      scores: { D1: 2.5, D6: 1.5 },
      findings: [{ dimension: "D6", text: SECRET_FINDING }],
      displayMessages,
      messages: [{ role: "user", content: "hi" }],
      scoreEvents: [
        { dimension: "D1", from: null, to: 2, afterTurn: 2, at: 2_100 },
        { dimension: "D6", from: null, to: 1.5, afterTurn: 4, at: 4_100 },
        { dimension: "D1", from: 2, to: 2.5, afterTurn: 4, at: 4_200 },
      ],
      findingEvents: [{ dimension: "D6", text: SECRET_FINDING, afterTurn: 4, at: 4_150 }],
      lastSaved: Date.now(),
    });

    const r = await app.inject({
      method: "GET", url: `/api/interviews/${id}/transcript`, headers: H("tok-cons"),
    });
    expect(r.statusCode).toBe(200);
    const t = r.json().transcripts[0];

    // The words, as before.
    expect(t.turn_count).toBe(4);
    expect(t.turns[1].text).toBe("We have a warehouse but no catalogue.");

    // The reasoning, which is the whole point of the release.
    expect(t.score_events).toHaveLength(3);
    expect(t.score_events[2]).toMatchObject({ dimension: "D1", from: 2, to: 2.5, afterTurn: 4 });
    expect(t.findings).toHaveLength(1);
    expect(t.findings[0].text).toBe(SECRET_FINDING);
    // Anchored, so the viewer can put it against the exchange that produced it
    // rather than in a list at the bottom.
    expect(t.findings[0].afterTurn).toBe(4);
  });

  it("keeps each turn's original index, so an anchor survives a blank message", async () => {
    // `turns` filters out empty text. Without the original index every anchor
    // after the first blank message points one turn too far down — a score
    // attributed to the wrong answer, which is worse than no attribution.
    const id = await runInterview("Sam Vale", "sam@ev.com", "tok-sam", {
      sessionId: "sess-ev-2",
      sessionCode: "VYNE-EVD2-0001",
      client: "Acme", stakeholderRole: "CFO", stakeholderName: "Sam Vale",
      scores: { D1: 3 },
      displayMessages: [
        { role: "ai", text: "First question.", at: 1 },
        { role: "user", text: "   ", at: 2 },          // dropped from `turns`
        { role: "user", text: "Real answer.", at: 3 },
      ],
      messages: [{ role: "user", content: "hi" }],
      scoreEvents: [{ dimension: "D1", from: null, to: 3, afterTurn: 3, at: 4 }],
      lastSaved: Date.now(),
    });

    const r = await app.inject({
      method: "GET", url: `/api/interviews/${id}/transcript`, headers: H("tok-cons"),
    });
    const t = r.json().transcripts[0];
    expect(t.turn_count).toBe(2);
    // The real answer sat at position 2 in displayMessages and position 1 in
    // `turns`. The anchor (afterTurn 3) has to land on it either way.
    expect(t.turns[1].text).toBe("Real answer.");
    expect(t.turns[1].idx).toBe(2);
  });

  it("an interview with no journal reads back as NULL, not as an empty finding list", async () => {
    // "This predates the trail" and "this interview found nothing" are
    // different facts, and a consultant looking at an empty panel has no way to
    // tell them apart. The column stays null so the viewer can say which.
    const r = await admin.query<{ findings: unknown; score_events: unknown }>(
      `SELECT findings, score_events FROM interview_transcripts
        WHERE tenant_id = $1 AND interviewee_name = 'Sam Vale'`, [tenant]);
    expect(r.rows[0].findings).toBeNull();
    expect(r.rows[0].score_events).not.toBeNull();
  });

  it("the evidence is client-scoped like the rest of the transcript", async () => {
    // The read route filters on clientAllowed. Adding columns to a SELECT is
    // exactly the kind of change that quietly widens a projection, so this
    // pins that it did not.
    const other = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-ev-other', 'other@ev.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'consultant')
       ON CONFLICT (user_id, tenant_id) DO NOTHING`, [other.rows[0].id, tenant]);
    // Assigned to nothing, so Acme is not theirs.
    const localApp = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier({
        "tok-other": { uid: "uid-ev-other", email: "other@ev.com", idpTenantId: undefined },
      }),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
    const row = await admin.query<{ interview_id: string }>(
      `SELECT interview_id FROM interview_transcripts
        WHERE tenant_id = $1 AND interviewee_name = 'Dana Reed'`, [tenant]);
    const r = await localApp.inject({
      method: "GET", url: `/api/interviews/${row.rows[0].interview_id}/transcript`,
      headers: H("tok-other"),
    });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain("governance");
    await localApp.close();
    await admin.query(`DELETE FROM users WHERE identity_platform_uid = 'uid-ev-other'`);
  });
});
