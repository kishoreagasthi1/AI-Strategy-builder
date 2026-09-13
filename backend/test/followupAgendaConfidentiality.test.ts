/**
 * What a follow-up agenda may say to the person receiving it (audit V2-M1).
 *
 * v5.32.65. A follow-up interview is drafted from what the interviewee's
 * COLLEAGUES said, and the draft used to put their sentences straight into the
 * item's `text`. That field is not internal: interview_agent.html renders it on
 * the welcome screen before the conversation starts, and the interview prompt
 * is centred on it.
 *
 * Three things made this worse than it looks.
 *
 *  · It read `rounds[rounds.length - 1]` — the LATEST round. For a follow-up
 *    that is the round the interviewee has just been through, which is exactly
 *    the round `sanitizeEngagementForInterviewee` withholds. The agenda was a
 *    second channel out of the same data, with none of the same rules.
 *  · The product states the rule plainly elsewhere: the courtesy-preview prompt
 *    in interview_agent.html tells the model to never state or imply that
 *    anyone said anything specific, and to reframe every item as a neutral
 *    topic. The agenda did the opposite.
 *  · The defence was consultant approval — but approving was one click on a
 *    default, and a default nobody has to change is the thing that ships.
 *
 * So the default is now the neutral probe and the colleagues' sentences are
 * kept beside it as consultant-only `evidence`, which the interviewee bootstrap
 * projects away. A consultant who wants to say something specific still can, by
 * writing it into `text` — which is then a decision somebody made.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import { neutralAgendaProbe, projectAgendaForInterviewee } from "../src/routes/interviews.js";
import { DIMENSION_NAMES } from "../src/routes/scorecard.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";
import type { ProviderAdapter } from "../src/llm/types.js";
import type { FastifyInstance } from "fastify";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5433/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:apppw@localhost:5433/vyne";

const SECRET = "Nobody owns governance and the board has not been told.";
const SECRET_2 = "Finance quietly maintains its own shadow data warehouse.";

describe("the interviewee projection of an agenda (V2-M1)", () => {
  it("drops evidence and keeps the topic", () => {
    const out = projectAgendaForInterviewee([
      { dimension: "D6", text: neutralAgendaProbe("D6"), evidence: [SECRET] },
    ]);
    expect(out).toEqual([{ dimension: "D6", text: neutralAgendaProbe("D6") }]);
    expect(JSON.stringify(out)).not.toContain("board has not been told");
  });

  it("names the dimension in the probe, so the topic is still a topic", () => {
    // A projection that is safe because it says nothing has removed the
    // feature. The executive has to know what they are being asked back about.
    for (const [code, name] of Object.entries(DIMENSION_NAMES)) {
      expect(neutralAgendaProbe(code)).toContain(name);
    }
  });

  it("says nothing about anyone having said anything", () => {
    // The standard the product already states in its own courtesy-preview
    // prompt: no contradiction, no who-said-what, no "a colleague mentioned".
    const probe = neutralAgendaProbe("D6").toLowerCase();
    for (const tell of ["said", "colleague", "another", "raised", "disagree", "contradic", "someone"]) {
      expect(probe).not.toContain(tell);
    }
  });

  it("survives junk without throwing or passing junk through", () => {
    expect(projectAgendaForInterviewee(null)).toEqual([]);
    expect(projectAgendaForInterviewee("not an array")).toEqual([]);
    expect(projectAgendaForInterviewee([null, 7, { dimension: "D1" }, { text: "x" }])).toEqual([]);
  });
});

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

describe.skipIf(!ENABLED)("drafting and delivering a follow-up agenda (V2-M1)", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;
  let consultantId: string;

  const verifierMap: Record<string, VerifiedIdentity> = {
    "tok-cons": { uid: "uid-fu-cons", email: "cons@fu.com", idpTenantId: undefined },
    "tok-dana": { uid: "dana@fu.com", email: "dana@fu.com", idpTenantId: undefined },
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
      `INSERT INTO tenants (name) VALUES ('Followup Firm') RETURNING id`);
    tenant = t.rows[0].id;
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-fu-cons', 'cons@fu.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    consultantId = u.rows[0].id;
    await admin.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'consultant')
       ON CONFLICT (user_id, tenant_id) DO NOTHING`, [consultantId, tenant]);
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(
      `INSERT INTO client_assignments (tenant_id, user_id, client_name, client_norm)
       VALUES ($1, $2, 'Acme', 'acme') ON CONFLICT DO NOTHING`, [tenant, consultantId]);
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
    await admin.query(`DELETE FROM users WHERE identity_platform_uid = ANY($1::text[])`,
      [["uid-fu-cons", "dana@fu.com"]]);
    await admin.end();
    await app.close();
    await closePool();
  });

  /*
   * Every test below builds the SAME fixture: Dana Reed, at Acme, round 1.
   *
   * That was fine until v5.34.11 added the duplicate-interview guard, which
   * refuses a second interview for the same (person, client, round) with a
   * 409 — correctly. From that release on, the first test in this file passed
   * and every later one failed at its own fixture, on a 409 that has nothing
   * to do with what the test is about. Seven red tests that looked like a
   * confidentiality regression and were not.
   *
   * The guard is right and stays; the fixture is what was wrong. Clearing
   * Dana's rows between tests restores the isolation each test always assumed
   * it had, without weakening a single assertion.
   */
  beforeEach(async () => {
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(
      `DELETE FROM interview_transcripts WHERE tenant_id = $1 AND interviewee_name = 'Dana Reed'`,
      [tenant]);
    await admin.query(
      `DELETE FROM interviews WHERE tenant_id = $1 AND interviewee_name = 'Dana Reed'`, [tenant]);
    await admin.query("COMMIT");
  });

  /** Invite Dana, complete her interview, and put the round in the workspace. */
  async function setUpCompletedInterview(): Promise<string> {
    const inv = await app.inject({
      method: "POST", url: "/api/interviews", headers: H("tok-cons"),
      payload: {
        clientName: "Acme", intervieweeName: "Dana Reed", intervieweeRole: "CFO",
        email: "dana@fu.com", roundNumber: 1,
      },
    });
    expect(inv.statusCode).toBe(201);
    const id = inv.json().id as string;

    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await admin.query(
      `UPDATE interviews SET status = 'completed', completed_at = now() WHERE id = $1`, [id]);
    await admin.query("COMMIT");

    await putWorkspace("vynora_engagement_index", JSON.stringify({ acme: "FU001" }));
    await putWorkspace("vynora_engagement_FU001", JSON.stringify({
      code: "FU001", client: "Acme", currentRoundId: "r1",
      rounds: [{
        roundId: "r1", roundNumber: 1, status: "complete",
        interviews: [
          // Dana's own entry — must be excluded by IDENTITY, not by role.
          { role: "CFO", sourceInterviewId: id, name: "Dana Reed",
            findings: [{ dimension: "D1", text: "MY OWN ANSWER" }] },
          // A colleague who happens to share her job title. Role-based
          // exclusion silently dropped this one; it is the material the
          // follow-up exists to probe.
          { role: "CFO", sourceInterviewId: "other-1", name: "Lee Park",
            findings: [{ dimension: "D6", text: SECRET }] },
          { role: "COO", sourceInterviewId: "other-2", name: "Sam Vale",
            findings: [{ dimension: "D1", text: SECRET_2 }] },
        ],
      }],
    }));
    return id;
  }

  /**
   * Same completed interview, but the engagement's rounds array is written by
   * the caller — so the ORDER of the array can be made to differ from the order
   * of the round numbers.
   */
  async function setUpWithRounds(rounds: unknown[]): Promise<string> {
    const id = await setUpCompletedInterview();
    await putWorkspace("vynora_engagement_FU001", JSON.stringify({
      code: "FU001", client: "Acme", currentRoundId: "r1", rounds,
    }));
    return id;
  }

  /**
   * WHICH ROUND THE DRAFT READS (v5.32.87).
   *
   * It took `rounds[rounds.length - 1]` — the last ARRAY element, not the
   * highest round number. v5.32.55 let a consultant pin a round number at
   * invite time, so a round can be appended out of order; `sortRounds` exists
   * for exactly that reason and the synthesis fixture is deliberately built
   * `[2, 1]`. On such an engagement the follow-up drew on the OLDER round while
   * presenting itself as the latest picture — silently, because the agenda
   * still rendered.
   */
  it("drafts from the highest-numbered round even when the array is out of order", async () => {
    const parentId = await setUpWithRounds([
      // Round TWO first in the array — the F23 shape.
      { roundId: "r2", roundNumber: 2, status: "complete",
        interviews: [{ role: "COO", sourceInterviewId: "o-2", name: "Sam Vale",
          findings: [{ dimension: "D7", text: "ROUND TWO MATERIAL" }] }] },
      { roundId: "r1", roundNumber: 1, status: "complete",
        interviews: [{ role: "COO", sourceInterviewId: "o-1", name: "Sam Vale",
          findings: [{ dimension: "D3", text: "ROUND ONE MATERIAL" }] }] },
    ]);
    const draft = await app.inject({
      method: "POST", url: `/api/interviews/${parentId}/followup/draft`, headers: H("tok-cons"),
    });
    expect(draft.statusCode).toBe(201);
    const agenda = draft.json().agenda as { dimension: string; evidence?: string[] }[];
    const dims = agenda.map((a) => a.dimension);
    // D7 is round two's dimension; D3 is round one's.
    expect(dims, JSON.stringify(agenda)).toContain("D7");
    expect(dims, JSON.stringify(agenda)).not.toContain("D3");
  });

  /**
   * And not from an EMPTY round either. A round is created empty when the
   * consultant plans it, so the highest-numbered round is frequently one nobody
   * has been interviewed for. Selecting it yields no findings and drops every
   * follow-up to the generic fallback item — the same silent wrongness in the
   * opposite direction.
   */
  it("skips a planned-but-empty round rather than drafting from nothing", async () => {
    const parentId = await setUpWithRounds([
      { roundId: "r1", roundNumber: 1, status: "complete",
        interviews: [{ role: "COO", sourceInterviewId: "o-1", name: "Sam Vale",
          findings: [{ dimension: "D3", text: "ROUND ONE MATERIAL" }] }] },
      // Planned, nobody interviewed yet.
      { roundId: "r2", roundNumber: 2, status: "active", interviews: [] },
    ]);
    const draft = await app.inject({
      method: "POST", url: `/api/interviews/${parentId}/followup/draft`, headers: H("tok-cons"),
    });
    expect(draft.statusCode).toBe(201);
    const agenda = draft.json().agenda as { dimension: string; text: string }[];
    expect(agenda.map((a) => a.dimension), JSON.stringify(agenda)).toContain("D3");
    // Not the "no specific findings were available" fallback.
    expect(agenda.some((a) => /no specific findings were available/i.test(a.text)),
      JSON.stringify(agenda)).toBe(false);
  });

  it("drafts a neutral topic and keeps the colleague's words as consultant-only evidence", async () => {
    const parentId = await setUpCompletedInterview();
    const draft = await app.inject({
      method: "POST", url: `/api/interviews/${parentId}/followup/draft`, headers: H("tok-cons"),
    });
    expect(draft.statusCode).toBe(201);
    const agenda = draft.json().agenda as { dimension: string; text: string; evidence?: string[] }[];

    // The item exists — a draft that found nothing would satisfy every "does
    // not contain" assertion below while doing nothing.
    const d6 = agenda.find((a) => a.dimension === "D6");
    expect(d6, JSON.stringify(agenda)).toBeTruthy();

    expect(d6!.text).toBe(neutralAgendaProbe("D6"));
    expect(d6!.evidence).toContain(SECRET);
    // A same-title colleague is a colleague. Exclusion is by interview identity.
    expect(agenda.some((a) => (a.evidence ?? []).includes(SECRET))).toBe(true);

    /*
     * v5.32.88 narrowed this assertion, and the narrowing is the point.
     *
     * It used to be `JSON.stringify(agenda)).not.toContain("MY OWN ANSWER")` —
     * Dana's own words nowhere in the payload at all. That conflated two
     * different properties:
     *
     *   1. her own answers must not be the SOURCE of topics — a follow-up
     *      probes what others said, not a recap of her own interview
     *   2. her own answers must not appear as EVIDENCE — evidence is the
     *      colleagues' consultant-only material
     *
     * Both still hold, and both are asserted below. What no longer holds is
     * the broader reading, because quoting somebody back to themselves
     * discloses nothing and is what lets the probe be specific at all. Her
     * D1 item now opens with the sentence she actually said.
     */
    expect((d6!.evidence ?? []).join(" ")).not.toContain("MY OWN ANSWER");
    expect(agenda.every((a) => !(a.evidence ?? []).some((e) => e.includes("MY OWN ANSWER")))).toBe(true);
    // Topics still come from colleagues: D6 exists because Lee Park raised it,
    // and Dana said nothing about D6 at all.
    expect(agenda.map((a) => a.dimension).sort()).toEqual(["D1", "D6"]);
  });

  /**
   * The probe quotes the interviewee's own last words (v5.32.88).
   *
   * The old probe was a fixed sentence, identical for every engagement in the
   * product, and it was fixed for a reason: the only specific material the
   * draft had was other people's, which can never be shown. Their own last
   * statement can be, and it turns "revisit Data & Data Management" into the
   * sentence they actually said.
   */
  it("opens with the interviewee's own last words on that dimension", async () => {
    const parentId = await setUpCompletedInterview();
    const draft = await app.inject({
      method: "POST", url: `/api/interviews/${parentId}/followup/draft`, headers: H("tok-cons"),
    });
    expect(draft.statusCode).toBe(201);
    const agenda = draft.json().agenda as { dimension: string; text: string; evidence?: string[] }[];
    const d1 = agenda.find((a) => a.dimension === "D1")!;
    expect(d1, JSON.stringify(agenda)).toBeTruthy();
    // Her own sentence, attributed to her, in the text SHE will read.
    expect(d1.text).toContain("MY OWN ANSWER");
    expect(d1.text).toMatch(/Last time in round 1 you said/);
    // And still not a colleague's, which is the whole reason the old probe was
    // generic.
    expect(d1.text).not.toContain(SECRET);
    expect(d1.text).not.toContain(SECRET_2);
    // D6 — nothing of her own to quote — falls back to the neutral probe.
    expect(agenda.find((a) => a.dimension === "D6")!.text).toBe(neutralAgendaProbe("D6"));
  });

  /**
   * And the consultant's own direction survives (v5.32.88). A follow-up is a
   * directed conversation; the draft should keep the dimensions it is given
   * rather than only what the last round happened to produce.
   */
  it("keeps the dimensions and note the consultant supplies", async () => {
    const parentId = await setUpCompletedInterview();
    const draft = await app.inject({
      method: "POST", url: `/api/interviews/${parentId}/followup/draft`, headers: H("tok-cons"),
      payload: { dimensions: ["D4", "D6"], note: "focus on the reskilling budget" },
    });
    expect(draft.statusCode).toBe(201);
    const agenda = draft.json().agenda as { dimension: string; text: string }[];
    expect(agenda.map((a) => a.dimension).sort()).toEqual(["D4", "D6"]);
    // D4 is a dimension NOBODY has said anything about. Asking for it is the
    // reason to name it, so it still gets an item rather than being dropped.
    expect(agenda.find((a) => a.dimension === "D4")).toBeTruthy();
    expect(agenda.every((a) => /focus on the reskilling budget/.test(a.text))).toBe(true);
    // D1 came from the findings and was NOT asked for — so it is gone.
    expect(agenda.find((a) => a.dimension === "D1")).toBeFalsy();
  });

  it("the interviewee's bootstrap carries the topic and not the evidence", async () => {
    const parentId = await setUpCompletedInterview();
    const draft = await app.inject({
      method: "POST", url: `/api/interviews/${parentId}/followup/draft`, headers: H("tok-cons"),
    });
    const followUpId = draft.json().id as string;

    // Approve it exactly as a consultant would: no edit, one click.
    const patch = await app.inject({
      method: "PATCH", url: `/api/interviews/${followUpId}/followup`, headers: H("tok-cons"),
      payload: { approve: true },
    });
    expect(patch.statusCode).toBe(200);

    const boot = await app.inject({
      method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-dana"),
    });
    expect(boot.statusCode).toBe(200);

    // The whole finding, at the level the interviewee's browser would have
    // rendered it — on the welcome screen, before a word was spoken.
    expect(boot.body).not.toContain("board has not been told");
    expect(boot.body).not.toContain("shadow data warehouse");
    expect(boot.body).not.toContain("evidence");
    // And the follow-up still works: they get their topics.
    expect(boot.json().interview.agenda.length).toBeGreaterThan(0);
    expect(boot.body).toContain("Governance & Risk");
  });

  it("a consultant edit round-trips the evidence instead of destroying it", async () => {
    const parentId = await setUpCompletedInterview();
    const draft = await app.inject({
      method: "POST", url: `/api/interviews/${parentId}/followup/draft`, headers: H("tok-cons"),
    });
    const followUpId = draft.json().id as string;
    const agenda = draft.json().agenda as { dimension: string; text: string; evidence?: string[] }[];

    await app.inject({
      method: "PATCH", url: `/api/interviews/${followUpId}/followup`, headers: H("tok-cons"),
      payload: { agenda: agenda.map((a) => ({ ...a, text: "Consultant's own wording." })) },
    });

    const row = await admin.query<{ agenda: { evidence?: string[]; text: string }[] }>(
      `SELECT agenda FROM interviews WHERE id = $1`, [followUpId]);
    const saved = row.rows[0].agenda;
    expect(saved[0].text).toBe("Consultant's own wording.");
    expect(saved.some((a) => (a.evidence ?? []).includes(SECRET))).toBe(true);
  });

  it("a consultant who writes something specific gets it delivered — the control is real", async () => {
    // The counterpart to every assertion above. If nothing a consultant writes
    // can reach the interviewee, this is censorship rather than a default, and
    // the tests would pass just as well with the agenda hard-coded.
    const parentId = await setUpCompletedInterview();
    const draft = await app.inject({
      method: "POST", url: `/api/interviews/${parentId}/followup/draft`, headers: H("tok-cons"),
    });
    const followUpId = draft.json().id as string;

    await app.inject({
      method: "PATCH", url: `/api/interviews/${followUpId}/followup`, headers: H("tok-cons"),
      payload: {
        agenda: [{ dimension: "D6", text: "Who signs off on model risk today?" }],
        approve: true,
      },
    });

    const boot = await app.inject({
      method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-dana"),
    });
    expect(boot.body).toContain("Who signs off on model risk today?");
  });
});
