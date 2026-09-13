/**
 * v5.34.55 — the HTTP surface for client-supplied keys.
 *
 * The public half is the part that needs the most care: it is unauthenticated
 * by design, because a client's administrator has no account here and should
 * not need one to hand over their own credential. The token is the entire trust
 * boundary.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { createHash } from "node:crypto";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { byokRoutes, byokPublicRoutes, ATTESTATION_TEXT } from "../src/routes/byok.js";
import type { KeyProbe } from "../src/llm/byok/verifyKey.js";

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

const GOOD: KeyProbe = {
  checkedAt: new Date().toISOString(), canGenerate: true, canMintLiveToken: true,
  modelCount: 55, hasNativeAudio: true, status: { generate: 200, models: 200, authTokens: 200 },
};
const BAD: KeyProbe = { ...GOOD, canMintLiveToken: false, status: { generate: 200, models: 200, authTokens: 403 } };

describe.skipIf(!ENABLED)("v5.34.55 — BYOK routes", () => {
  let app: FastifyInstance;
  let db: pg.Client;
  let tenant: string;
  let owner: string;
  let stored: { tenantId: string; key: string }[] = [];
  let probeResult: KeyProbe = GOOD;
  /** Every key the Gemini prober was asked to send to Google. */
  let probed: string[] = [];

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    initPool(ADMIN_URL);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    tenant = (await db.query(`INSERT INTO tenants (name) VALUES ('Route Firm') RETURNING id`)).rows[0].id;
    owner = (await db.query(
      `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-byok-routes','o@firm.com')
         ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`)).rows[0].id;

    const deps = {
      secretStore: { projectId: "proj" },
      probe: (async (key: string) => { probed.push(key); return probeResult; }) as any,
      putKey: (async (_o: any, ref: any, key: string) => {
        stored.push({ tenantId: ref.tenantId, key, ...ref });
        return {
          secretName: `projects/proj/secrets/vyne-byok-${ref.tenantId}-${ref.clientNorm}-${ref.provider}/versions/1`,
          version: "1", keyHint: key.slice(-4),
        };
      }) as any,
      appBaseUrl: "https://app.example",
    };

    app = Fastify();
    // Stand-in for the real auth hook: the routes only read req.ctx.
    await app.register(async (scope) => {
      scope.addHook("preHandler", async (req: any) => {
        req.ctx = { tenantId: tenant, userId: owner, role: req.headers["x-role"] ?? "owner" };
      });
      await byokRoutes(scope, deps);
    });
    await byokPublicRoutes(app, deps);
    await app.ready();
  });

  beforeEach(async () => {
    stored = []; probed = []; probeResult = GOOD;
    await db.query(`DELETE FROM byok_invites WHERE tenant_id = $1`, [tenant]);
    await db.query(`DELETE FROM byok_keys WHERE tenant_id = $1`, [tenant]);
    await db.query(`DELETE FROM byok_events WHERE tenant_id = $1`, [tenant]);
  });

  afterAll(async () => {
    await app.close();
    await db.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
    await db.end();
    await closePool();
  });

  const invite = async (clientName = "Nestlé", provider = "gemini-aistudio") =>
    (await app.inject({ method: "POST", url: "/api/byok/invites",
      payload: { clientName, provider } })).json();

  const tokenOf = (url: string) => new URL(url).searchParams.get("t")!;

  it("only the Owner can create a setup link", async () => {
    for (const role of ["consultant", "interviewee"]) {
      const r = await app.inject({ method: "POST", url: "/api/byok/invites",
        headers: { "x-role": role }, payload: { clientName: "Nestlé", provider: "gemini-aistudio" } });
      expect(r.statusCode).toBe(403);
    }
  });

  it("the link's token is never stored in a readable form", async () => {
    const out = await invite();
    const token = tokenOf(out.url);
    const row = await db.query(`SELECT token_hash FROM byok_invites WHERE tenant_id = $1`, [tenant]);
    expect(row.rows[0].token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row.rows[0].token_hash).not.toContain(token);
  });

  it("the client sees who is asking and exactly what they are confirming", async () => {
    const out = await invite();
    const r = await app.inject({ method: "GET", url: `/api/byok/redeem/${tokenOf(out.url)}` });
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.clientName).toBe("Nestlé");
    expect(d.attestationText).toBe(ATTESTATION_TEXT["gemini-aistudio"]);
    // The wording must say plainly that this is NOT verified.
    expect(d.attestationText).toMatch(/cannot be verified automatically/);
  });

  it("a supplied key is probed, stored, and activated — and never echoed back", async () => {
    const out = await invite();
    const r = await app.inject({ method: "POST", url: `/api/byok/redeem/${tokenOf(out.url)}`,
      payload: { apiKey: "AQ.super-secret-key-value", attestedByEmail: "admin@nestle.com", paidTierAttested: true } });

    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("super-secret");     // never echoed
    expect(stored[0].key).toBe("AQ.super-secret-key-value");

    const row = await db.query(
      `SELECT status, key_hint, attested_by_email, attestation_text FROM byok_keys WHERE tenant_id=$1`, [tenant]);
    expect(row.rows[0].status).toBe("active");
    expect(row.rows[0].key_hint).toBe("alue");
    expect(row.rows[0].attested_by_email).toBe("admin@nestle.com");
    expect(row.rows[0].attestation_text).toBe(ATTESTATION_TEXT["gemini-aistudio"]);
  });

  it("a key that cannot run a voice session is refused before it is stored", async () => {
    probeResult = BAD;
    const out = await invite();
    const r = await app.inject({ method: "POST", url: `/api/byok/redeem/${tokenOf(out.url)}`,
      payload: { apiKey: "AQ.no-live-access", attestedByEmail: "a@b.com", paidTierAttested: true } });
    expect(r.statusCode).toBe(400);
    expect(r.json().detail).toMatch(/live voice session/);
    expect(stored.length).toBe(0);                    // nothing written to Secret Manager
  });

  it("a link works once", async () => {
    const out = await invite();
    const t = tokenOf(out.url);
    const body = { apiKey: "AQ.first-key-here", attestedByEmail: "a@b.com", paidTierAttested: true };
    expect((await app.inject({ method: "POST", url: `/api/byok/redeem/${t}`, payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/byok/redeem/${t}`, payload: body })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/byok/redeem/${t}` })).statusCode).toBe(404);
  });

  it("an expired link is refused", async () => {
    const out = await invite();
    await db.query(`UPDATE byok_invites SET expires_at = now() - interval '1 hour' WHERE tenant_id = $1`, [tenant]);
    expect((await app.inject({ method: "GET", url: `/api/byok/redeem/${tokenOf(out.url)}` })).statusCode).toBe(404);
  });

  it("an unknown token is indistinguishable from an expired one", async () => {
    // Same status, same shape: this endpoint must not reveal which tokens exist.
    const a = await app.inject({ method: "GET", url: "/api/byok/redeem/" + "z".repeat(43) });
    const out = await invite();
    await db.query(`UPDATE byok_invites SET used_at = now() WHERE tenant_id = $1`, [tenant]);
    const b = await app.inject({ method: "GET", url: `/api/byok/redeem/${tokenOf(out.url)}` });
    expect(a.statusCode).toBe(b.statusCode);
    expect(a.json()).toEqual(b.json());
  });

  it("refuses the submission when the client has not ticked the confirmation", async () => {
    const out = await invite();
    const r = await app.inject({ method: "POST", url: `/api/byok/redeem/${tokenOf(out.url)}`,
      payload: { apiKey: "AQ.key-value-here", attestedByEmail: "a@b.com", paidTierAttested: false } });
    expect(r.statusCode).toBe(400);
    expect(stored.length).toBe(0);
  });

  it("the Owner's list shows status and the hint, never the key", async () => {
    const out = await invite();
    await app.inject({ method: "POST", url: `/api/byok/redeem/${tokenOf(out.url)}`,
      payload: { apiKey: "AQ.hidden-secret-9999", attestedByEmail: "admin@nestle.com", paidTierAttested: true } });

    const r = await app.inject({ method: "GET", url: "/api/byok/keys" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("9999");
    expect(r.body).not.toContain("hidden-secret");
  });

  it("turning a key off returns that client to the firm's key and their invoice", async () => {
    const out = await invite();
    await app.inject({ method: "POST", url: `/api/byok/redeem/${tokenOf(out.url)}`,
      payload: { apiKey: "AQ.key-value-here", attestedByEmail: "a@b.com", paidTierAttested: true } });

    const r = await app.inject({ method: "POST", url: "/api/byok/keys/disable",
      payload: { clientName: "Nestlé", provider: "gemini-aistudio" } });
    expect(r.statusCode).toBe(200);

    const row = await db.query(`SELECT status FROM byok_keys WHERE tenant_id = $1`, [tenant]);
    expect(row.rows[0].status).toBe("disabled");
  });

  it("an ANTHROPIC key is never sent to Google — the v5.34.57 audit finding", async () => {
    /*
     * probeKey() posts the value to generativelanguage.googleapis.com as
     * `x-goog-api-key`. The redeem route called it above the provider check, so
     * every Anthropic redemption disclosed the client's Anthropic key to
     * Google and then discarded the result: a third-party disclosure of the
     * exact secret this feature exists to protect.
     */
    const out = await invite("Nestlé", "anthropic-api");
    const r = await app.inject({ method: "POST", url: `/api/byok/redeem/${tokenOf(out.url)}`,
      payload: { apiKey: "sk-ant-a-real-anthropic-key", attestedByEmail: "a@b.com", paidTierAttested: true } });

    expect(r.statusCode).toBe(200);
    expect(probed, "the Anthropic key must not reach the Gemini prober").toEqual([]);
    expect(stored[0].key).toBe("sk-ant-a-real-anthropic-key");
  });

  it("a GOOGLE key is still probed — the fix must not disable the check", async () => {
    const out = await invite("Nestlé", "gemini-aistudio");
    await app.inject({ method: "POST", url: `/api/byok/redeem/${tokenOf(out.url)}`,
      payload: { apiKey: "AQ.a-google-key-here", attestedByEmail: "a@b.com", paidTierAttested: true } });
    expect(probed).toEqual(["AQ.a-google-key-here"]);
  });

  it("a rejection returns the reason, not the probe evidence", async () => {
    // Echoing the probe gave the invite holder a bounded oracle over a key's
    // capabilities. Small, and free to remove.
    probeResult = BAD;
    const out = await invite();
    const r = await app.inject({ method: "POST", url: `/api/byok/redeem/${tokenOf(out.url)}`,
      payload: { apiKey: "AQ.no-live-access", attestedByEmail: "a@b.com", paidTierAttested: true } });
    expect(r.json().detail).toBeTruthy();
    expect(r.json().probe).toBeUndefined();
  });

  it("each client gets their OWN secret, per provider — not one per firm", async () => {
    for (const [client, provider] of [["Nestlé", "gemini-aistudio"], ["Acme Corp", "gemini-aistudio"]] as const) {
      const out = await invite(client, provider);
      await app.inject({ method: "POST", url: `/api/byok/redeem/${tokenOf(out.url)}`,
        payload: { apiKey: `AQ.key-for-${client.slice(0, 4)}`, attestedByEmail: "a@b.com", paidTierAttested: true } });
    }
    expect(stored.length).toBe(2);
    expect(stored[0].clientNorm).not.toBe(stored[1].clientNorm);
    expect(stored[0].provider).toBe("gemini-aistudio");
  });

  it("the Anthropic attestation does not talk about free tiers, because there are none", () => {
    expect(ATTESTATION_TEXT["anthropic-api"]).not.toMatch(/free tier/i);
    expect(ATTESTATION_TEXT["gemini-aistudio"]).toMatch(/free tier/i);
  });
});

/* ── the pages themselves ─────────────────────────────────────────────────── */

describe("v5.34.55 — the screens exist and are well-formed", () => {
  const read = async (f: string) => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend", f), "utf8");
  };

  /** Inline <script> bodies only — src= tags have no body to parse. */
  const inlineJs = (html: string) =>
    [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  it("no markup is stranded inside a script block", async () => {
    /*
     * This caught a real one. The BYOK pane was inserted at a JS anchor and
     * landed INSIDE billing.html's main <script>. Counting script tags said
     * "balanced" — because the insertion added a matched pair — while the
     * browser would have ended the outer script at the inner </script> and
     * rendered the rest of the page's JavaScript as text. Balanced is not
     * well-formed.
     */
    for (const f of ["billing.html", "byok.html"]) {
      for (const body of inlineJs(await read(f))) {
        expect(body, `${f}: a <script> body contains a block-level HTML tag`)
          .not.toMatch(/^\s*<(div|table|form|section|input|button)\b/m);
      }
    }
  });

  it("both pages' inline JavaScript parses", async () => {
    const { runInNewContext } = await import("node:vm");
    for (const f of ["billing.html", "byok.html"]) {
      for (const body of inlineJs(await read(f))) {
        // Compile without running: a syntax error throws here.
        expect(() => new (require("node:vm").Script)(body), `${f} has a syntax error`).not.toThrow();
      }
    }
    void runInNewContext;
  });

  it("the client-facing page carries no session, no auth, and no key echo", async () => {
    const page = await read("byok.html");
    /*
     * Assert against TAGS and CODE, not prose. Three tests today failed first
     * time by matching a word inside the comment that explained why the word
     * should not appear. A test that reads documentation is testing the wrong
     * artefact.
     */
    const tags = [...page.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1]);
    expect(tags, "the client page must load no application script").toEqual([]);
    const js = [...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1]).join("\n");
    expect(js).not.toMatch(/\bvyneAuth\b/);
    expect(js).not.toMatch(/authorization\s*:/i);
    // The key field must never be a plain text input in a page left on screen.
    expect(page).toMatch(/<input type="password" id="key"/);
    // And it is cleared once submitted.
    expect(page).toContain('$("key").value = "";');
  });

  it("the firm's panel says plainly what happens when a client has no key", async () => {
    const page = await read("billing.html");
    expect(page).toMatch(/runs on <strong>your<\/strong> API keys/);
    expect(page).toMatch(/appears on the statement you send them/);
  });
});
