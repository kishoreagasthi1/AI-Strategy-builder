/**
 * Phase 2.5 gate — the role-isolation matrix, through the real HTTP app:
 *
 *   consultant  creates invites, sees the tracker, reads sessions
 *   interviewee CANNOT read the workspace (candid briefing lives there)
 *               CANNOT see the tracker or another person's session
 *               gets a SANITIZED bootstrap (political flags/observations
 *               stripped), saves own state (auto → in_progress), completes
 *
 * Run: RLS_TEST=1 ... npx vitest run test/interviews.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import { sanitizeBriefing } from "../src/routes/interviews.js";
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

describe.skipIf(!ENABLED)("Phase 2.5 role isolation", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;
  const verifierMap: Record<string, VerifiedIdentity> = {
    "tok-consultant": { uid: "uid-cons", email: "cons@firm.com", idpTenantId: undefined },
    // Interviewee tokens registered dynamically after invites are created:
    "tok-ada": { uid: "ada@client.com", email: "ada@client.com", idpTenantId: undefined },
    "tok-bob": { uid: "bob@client.com", email: "bob@client.com", idpTenantId: undefined },
  };

  beforeAll(async () => {
    process.env.DEV_AUTH = "1"; // invite path creates dev users
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Isolation Firm') RETURNING id`);
    tenant = t.rows[0].id;
    const u = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-cons', 'cons@firm.com') ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'consultant')`,
      [u.rows[0].id, tenant]);
    // Phase 5: consultants are deny-by-default — assign the clients this
    // suite works with ("Acme", later renamed to "Acme Industrial").
    // client_assignments has FORCE RLS, so even the admin seed needs
    // tenant context.
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    for (const [name, norm] of [["Acme", "acme"], ["Acme Industrial", "acmeindustrial"]]) {
      await admin.query(
        `INSERT INTO client_assignments (tenant_id, user_id, client_name, client_norm)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [tenant, u.rows[0].id, name, norm]);
    }
    await admin.query("COMMIT");

    initPool(APP_URL);
    app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false,
      },
      verifier: new FakeVerifier(verifierMap),
      adapters: [fakeAdapter],
      meter: async () => {},
    });

    // Consultant seeds a briefing WITH consultant-only material into workspace.
    const briefing = JSON.stringify({
      client: "Acme", industry: "Manufacturing", hypotheses: [{ index: 0, text: "H1" }],
      politicalSensitivityFlags: [{ text: "CFO vs CIO tension" }],
      observations: [{ label: "obs", text: "candid note" }],
      peContext: "PE thesis: cut costs 30%",
    });
    await app.inject({
      method: "PUT", url: "/api/module-state/workspace",
      headers: { authorization: "Bearer tok-consultant" },
      payload: { sets: { "vynora_briefing_acme": briefing, "vynora_refresh_agenda_acme": "secret agenda" }, deletes: [] },
    });
  });

  afterAll(async () => {
    await app?.close();
    await closePool();
    if (admin) {
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
      await admin.query(`DELETE FROM users WHERE identity_platform_uid LIKE '%client.com'`);
      await admin.end();
    }
    delete process.env.DEV_AUTH;
  });

  const H = (tok: string) => ({ authorization: `Bearer ${tok}` });
  let intAda: string;

  it("consultant creates invites; tracker lists them", async () => {
    const mk = (name: string, email: string) =>
      app.inject({
        method: "POST", url: "/api/interviews", headers: H("tok-consultant"),
        payload: { clientName: "Acme", intervieweeName: name, intervieweeRole: "CFO", email },
      });
    const a = await mk("Ada", "ada@client.com");
    expect(a.statusCode).toBe(201);
    intAda = a.json().id;
    expect((await mk("Bob", "bob@client.com")).statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-consultant") });
    expect(list.json().interviews).toHaveLength(2);
    expect(list.json().interviews.every((i: { status: string }) => i.status === "invited")).toBe(true);
  });

  it("interviewee is BLOCKED from the workspace store and the tracker", async () => {
    expect((await app.inject({ method: "GET", url: "/api/module-state/workspace", headers: H("tok-ada") })).statusCode).toBe(403);
    expect((await app.inject({
      method: "PUT", url: "/api/module-state/workspace", headers: H("tok-ada"),
      payload: { sets: { hack: "x" }, deletes: [] },
    })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-ada") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/engagements", headers: H("tok-ada") })).statusCode).toBe(403);
  });

  it("interviewee bootstrap is SANITIZED — no political flags, observations, or PE context", async () => {
    const r = await app.inject({ method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-ada") });
    expect(r.statusCode).toBe(200);
    const data = r.json();
    expect(data.interview.interviewee_name).toBe("Ada");
    const briefing = JSON.parse(data.injected["vynora_briefing_acme"]);
    expect(briefing.hypotheses).toBeTruthy();               // interview steering: kept
    expect(briefing.politicalSensitivityFlags).toBeUndefined();
    expect(briefing.observations).toBeUndefined();
    expect(briefing.peContext).toBeUndefined();
    expect(data.injected["vynora_refresh_agenda_acme"]).toBeUndefined(); // blocked prefix
  });

  it("interviewee saves state → auto in_progress; consultant sees it; other interviewee does NOT", async () => {
    const put = await app.inject({
      method: "PUT", url: "/api/interviews/mine/state", headers: H("tok-ada"),
      payload: { sets: { "session_ada": '{"answers":[1]}' }, deletes: [] },
    });
    expect(put.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-consultant") });
    const ada = list.json().interviews.find((i: { interviewee_name: string }) => i.interviewee_name === "Ada");
    expect(ada.status).toBe("in_progress");

    // Consultant reads Ada's session.
    const st = await app.inject({ method: "GET", url: `/api/interviews/${intAda}/state`, headers: H("tok-consultant") });
    expect(st.json().state["session_ada"]).toBe('{"answers":[1]}');

    // Bob's bootstrap must NOT contain Ada's session.
    const bob = await app.inject({ method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-bob") });
    expect(bob.json().own["session_ada"]).toBeUndefined();
  });

  it("interviewee completes; tracker shows completed; LLM gateway still serves interviewees", async () => {
    const llm = await app.inject({
      method: "POST", url: "/api/llm/generate", headers: H("tok-ada"),
      payload: { task: "interview_turn", module: "interview_agent", messages: [{ role: "user", content: "hi" }] },
    });
    expect(llm.statusCode).toBe(200);

    const done = await app.inject({ method: "POST", url: "/api/interviews/mine/complete", headers: H("tok-ada") });
    expect(done.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-consultant") });
    const ada = list.json().interviews.find((i: { interviewee_name: string }) => i.interviewee_name === "Ada");
    expect(ada.status).toBe("completed");
    expect(ada.completed_at).toBeTruthy();
  });

  it("consultant edits interview details; interviewee cannot", async () => {
    const edit = await app.inject({
      method: "PATCH", url: `/api/interviews/${intAda}`, headers: H("tok-consultant"),
      payload: { intervieweeRole: "Chief Financial Officer", clientName: "Acme Industrial" },
    });
    expect(edit.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-consultant") });
    const ada = list.json().interviews.find((i: { id: string }) => i.id === intAda);
    expect(ada.interviewee_role).toBe("Chief Financial Officer");
    expect(ada.client_name).toBe("Acme Industrial");

    expect((await app.inject({
      method: "PATCH", url: `/api/interviews/${intAda}`, headers: H("tok-ada"),
      payload: { status: "completed" },
    })).statusCode).toBe(403);
  });

  it("consultant deletes an interview: row + state gone, login loses access", async () => {
    const del = await app.inject({
      method: "DELETE", url: `/api/interviews/${intAda}`, headers: H("tok-consultant"),
    });
    expect(del.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-consultant") });
    expect(list.json().interviews.find((i: { id: string }) => i.id === intAda)).toBeUndefined();

    // Ada's membership was cleaned up (no other interviews) → 403 now.
    expect((await app.inject({
      method: "GET", url: "/api/interviews/mine/bootstrap", headers: H("tok-ada"),
    })).statusCode).toBe(403);

    // Interviewee delete attempts are forbidden (Bob still exists).
    const listB = await app.inject({ method: "GET", url: "/api/interviews", headers: H("tok-consultant") });
    const bob = listB.json().interviews[0];
    expect((await app.inject({
      method: "DELETE", url: `/api/interviews/${bob.id}`, headers: H("tok-bob"),
    })).statusCode).toBe(403);
  });

  it("sanitizeBriefing is resilient to non-JSON input", () => {
    expect(sanitizeBriefing("not json")).toBe("not json");
  });
});
