/**
 * V225-audit M5 fix — LLM/voice endpoints now carry a per-user rate limit
 * (server.ts wraps them in a nested @fastify/rate-limit-scoped context,
 * keyed on req.ctx.userId). This is its own isolated app instance so the
 * limit's in-memory counter starts fresh and isn't shared with other test
 * files' calls to the same route.
 *
 * Run: RLS_TEST=1 ... npx vitest run test/rateLimit.test.ts
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

describe.skipIf(!ENABLED)("LLM/voice rate limiting", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();

    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Rate Limit Firm') RETURNING id`);
    tenant = t.rows[0].id;
    const u1 = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-rl-1', 'rl1@firm.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    const u2 = await admin.query<{ id: string }>(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-rl-2', 'rl2@firm.com')
       ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    await admin.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`,
      [u1.rows[0].id, tenant]);
    await admin.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`,
      [u2.rows[0].id, tenant]);

    initPool(APP_URL);
    app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier({
        "tok-user-1": { uid: "uid-rl-1", email: "rl1@firm.com", idpTenantId: undefined },
        "tok-user-2": { uid: "uid-rl-2", email: "rl2@firm.com", idpTenantId: undefined },
      }),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await closePool();
    await admin?.query("DELETE FROM tenants WHERE id = $1", [tenant]);
    await admin?.end();
  });

  const call = (tok: string) =>
    app.inject({
      method: "POST", url: "/api/llm/generate",
      headers: { authorization: `Bearer ${tok}` },
      payload: { task: "benchmarks", module: "pre_engagement", messages: [{ role: "user", content: "hi" }] },
    });

  it("allows the first 60 calls from one user within the window, then 429s", async () => {
    let lastStatus = 0;
    for (let i = 0; i < 60; i++) {
      const res = await call("tok-user-1");
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(200);

    const overLimit = await call("tok-user-1");
    expect(overLimit.statusCode).toBe(429);
  }, 30_000);

  it("does not rate-limit routes outside the llm/voice scope even after the LLM limit trips", async () => {
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: "Bearer tok-user-1" } });
    expect(me.statusCode).toBe(200);
  });

  it("rate-limits per user, not globally — a second user is unaffected by the first's limit", async () => {
    const res = await call("tok-user-2");
    expect(res.statusCode).toBe(200);
  });
});

/**
 * The BASELINE limit, and the routes that were never inside it (audit V2-M6).
 *
 * server.ts registers a 300/minute per-user baseline on the protected scope and
 * says so in a comment: "a baseline now applies to EVERY authenticated route".
 * It did not. Fastify applies a hook to routes registered AFTER it in the same
 * encapsulation context, and the registration sat below `/api/me` and the
 * engagement routes — so the two cheapest authenticated surfaces in the product
 * inherited nothing.
 *
 * The comment being right about intent is what made this survive review. These
 * tests check the ordering rather than the sentence, and they are written
 * per-route rather than as one assertion about the scope, because "the scope is
 * configured" was exactly what was already believed.
 *
 * Its own app instance so the in-memory counter starts empty.
 */
describe.skipIf(!ENABLED)("the authenticated baseline covers /api/me and engagements (V2-M6)", () => {
  let admin: pg.Client;
  let app: FastifyInstance;
  let tenant: string;

  const H = (tok: string) => ({ authorization: `Bearer ${tok}` });

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('Baseline Firm') RETURNING id`);
    tenant = t.rows[0].id;
    for (const uid of ["uid-bl-1", "uid-bl-2"]) {
      const u = await admin.query<{ id: string }>(
        `INSERT INTO users (identity_platform_uid, email) VALUES ($1, $2)
         ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
        [uid, `${uid}@firm.com`]);
      await admin.query(
        `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')
         ON CONFLICT (user_id, tenant_id) DO NOTHING`, [u.rows[0].id, tenant]);
    }
    initPool(APP_URL);
    app = await buildServer({
      config: {
        port: 0, env: "test", databaseUrl: APP_URL,
        gcpProject: undefined, vertexLocation: "us-east5",
        geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
        llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
      },
      verifier: new FakeVerifier({
        "tok-bl-1": { uid: "uid-bl-1", email: "uid-bl-1@firm.com", idpTenantId: undefined },
        "tok-bl-2": { uid: "uid-bl-2", email: "uid-bl-2@firm.com", idpTenantId: undefined },
      }),
      adapters: [fakeAdapter],
      meter: async () => {},
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await closePool();
    await admin?.query("DELETE FROM tenants WHERE id = $1", [tenant]);
    await admin?.query(`DELETE FROM users WHERE identity_platform_uid = ANY($1::text[])`,
      [["uid-bl-1", "uid-bl-2"]]);
    await admin?.end();
  });

  it("/api/me is inside the 300/minute baseline", async () => {
    // The cheapest authenticated probe in the product, and the natural loop for
    // checking whether a stolen token is still live.
    let last = 0;
    for (let i = 0; i < 300; i++) {
      last = (await app.inject({ method: "GET", url: "/api/me", headers: H("tok-bl-1") })).statusCode;
    }
    expect(last).toBe(200);
    const over = await app.inject({ method: "GET", url: "/api/me", headers: H("tok-bl-1") });
    expect(over.statusCode).toBe(429);
  }, 60_000);

  it("the engagement routes are inside it too, and share the same per-user budget", async () => {
    // Registered in a nested consultant scope BELOW /api/me in the old
    // ordering, so it missed the baseline for the same reason. Sharing one
    // budget is the point: a limit per route is trivially defeated by rotating
    // routes.
    const r = await app.inject({
      method: "GET", url: "/api/engagements", headers: H("tok-bl-1"),
    });
    expect(r.statusCode).toBe(429);
  });

  it("a second user is unaffected — the baseline is per user, not global", async () => {
    const r = await app.inject({ method: "GET", url: "/api/me", headers: H("tok-bl-2") });
    expect(r.statusCode).toBe(200);
  });
});
