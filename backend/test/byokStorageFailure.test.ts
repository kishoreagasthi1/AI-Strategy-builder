/**
 * What a client is told when their key cannot be stored. (v5.34.60)
 *
 * On 2026-09-13 the first real redemption returned "Something went wrong
 * (500). Please try again." The key had passed every check; the service
 * account simply had no permission to create a secret, which is not transient
 * and not something retrying fixes. The person who had just handed over a
 * credential was left unable to tell whether it had been saved.
 *
 * These pin the three things that were wrong: the status, the message, and
 * whether the firm finds out.
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { byokPublicRoutes } from "../src/routes/byok.js";
import { keyIsUsable, type KeyProbe } from "../src/llm/byok/verifyKey.js";

const GOOD: KeyProbe = {
  checkedAt: new Date().toISOString(), canGenerate: true, canMintLiveToken: true,
  modelCount: 55, hasNativeAudio: true, status: { generate: 200, models: 200, authTokens: 200 },
};

/**
 * The public route with its database seam replaced.
 *
 * findInvite reads through db/pool, so these tests stub the pool module rather
 * than standing up Postgres — the subject here is the failure path after a
 * successful probe, not the invite lookup (byokRoutes.test.ts owns that).
 */
async function appWith(opts: { putKey?: any; upsert?: any }) {
  vi.doMock("../src/db/pool.js", () => ({
    getPool: () => ({
      query: async () => ({
        rows: [{
          id: "inv-1", tenant_id: "11111111-1111-1111-1111-111111111111",
          client_norm: "nestle", client_name: "Nestle", provider: "gemini-aistudio",
          expires_at: new Date(Date.now() + 3600_000), used_at: null,
        }],
      }),
    }),
    withTenant: async (_t: string, fn: any) => fn({ query: async () => ({ rows: [] }) }),
  }));
  if (opts.upsert) {
    vi.doMock("../src/llm/byok/byokRepo.js", async (orig) => ({
      ...(await (orig as any)()),
      upsertActiveKey: opts.upsert,
    }));
  }
  vi.resetModules();
  const { byokPublicRoutes: routes } = await import("../src/routes/byok.js");

  const logged: any[] = [];
  const app = Fastify();
  app.addHook("onRequest", async (req: any) => {
    req.log = { error: (o: any, m: string) => logged.push({ o, m }), warn() {}, info() {} };
  });
  await routes(app, {
    secretStore: { projectId: "p" },
    probe: (async () => GOOD) as any,
    putKey: opts.putKey ?? (async () => ({ secretName: "projects/p/secrets/s/versions/1", keyHint: "wxyz" })),
  });
  await app.ready();
  return { app, logged };
}

const redeem = (app: any) => app.inject({
  method: "POST", url: "/api/byok/redeem/" + "t".repeat(40),
  payload: { apiKey: "AQ.a-perfectly-good-key-value", attestedByEmail: "admin@nestle.com", paidTierAttested: true },
});

describe("v5.34.60 — a key that cannot be stored", () => {
  it("does NOT report success, and says plainly that nothing was saved", async () => {
    const { app } = await appWith({
      putKey: async () => { throw new Error("byok: could not create the secret (HTTP 403)"); },
    });
    const r = await redeem(app);
    await app.close();

    expect(r.statusCode).toBe(502);          // downstream, not "internal error"
    const d = r.json();
    expect(d.error).toBe("key_not_stored");
    // The sentence a person actually needs: it is not saved.
    expect(d.detail).toMatch(/NOT been saved/i);
    // And that retrying the link is possible, since the invite is not consumed.
    expect(d.detail).toMatch(/link still works/i);
  });

  it("never leaks the key, or the provider's raw error, to the client", async () => {
    const { app } = await appWith({
      putKey: async () => { throw new Error("byok: could not create the secret (HTTP 403) PERMISSION_DENIED on projects/vyne-platform-prod"); },
    });
    const r = await redeem(app);
    await app.close();
    expect(r.body).not.toContain("AQ.a-perfectly-good-key-value");
    expect(r.body).not.toContain("PERMISSION_DENIED");
    expect(r.body).not.toContain("403");
  });

  it("tells the FIRM the technical reason, with the client named", async () => {
    // The half that was missing: the cause existed only in a Cloud Run log with
    // nothing tying it to which client had just been turned away.
    const { app, logged } = await appWith({
      putKey: async () => { throw new Error("byok: could not create the secret (HTTP 403)"); },
    });
    await redeem(app);
    await app.close();
    expect(logged).toHaveLength(1);
    expect(logged[0].o.clientName).toBe("Nestle");
    expect(String(logged[0].o.err)).toMatch(/403/);
    expect(logged[0].m).toMatch(/could NOT be stored/);
  });

  it("refuses to claim success when the secret is stored but never activated", async () => {
    /*
     * The orphan case: Secret Manager kept the key, the byok_keys row did not
     * land, so nothing will ever resolve it. Reporting "that's done" here would
     * leave a client believing their account is paying when the firm's is.
     */
    const { app, logged } = await appWith({
      upsert: async () => { throw new Error("insert failed"); },
    });
    const r = await redeem(app);
    await app.close();
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe("key_not_activated");
    expect(r.json().detail).toMatch(/not in use/i);
    expect(logged[0].m).toMatch(/orphaned/);
  });
});

describe("v5.34.60 — a refusal says what to do about it", () => {
  const probe = (over: Partial<KeyProbe>): KeyProbe => ({ ...GOOD, ...over });

  it("names the status and the likely remedy rather than just 'rejected'", () => {
    const r = keyIsUsable(probe({ canGenerate: false, status: { generate: 403, models: 0, authTokens: 0 } }));
    expect(r.usable).toBe(false);
    // The distinction that cost a detour through curl: propagation vs restriction.
    expect(r.reason).toMatch(/403/);
    expect(r.reason).toMatch(/created in the last minute/i);
    expect(r.reason).toMatch(/restrictions/i);
  });

  it("distinguishes a rate limit from a bad key", () => {
    const r = keyIsUsable(probe({ canGenerate: false, status: { generate: 429, models: 0, authTokens: 0 } }));
    expect(r.reason).toMatch(/rate limit/i);
    expect(r.reason).not.toMatch(/restrictions/i);
  });

  it("says so when the failure is OURS, not the key's", () => {
    const r = keyIsUsable(probe({ canGenerate: false, status: { generate: 0, models: 0, authTokens: 0 } }));
    expect(r.reason).toMatch(/our end/i);
  });

  it("still withholds the probe evidence — the reason is not a capability map", () => {
    // A capability map of someone's credential, handed to whoever holds an
    // invite link, is what v5.34.57 removed. The status code is what the key's
    // own owner already sees; the model list is not.
    const r = keyIsUsable(probe({ canGenerate: false, modelCount: 55, hasNativeAudio: true,
                                  status: { generate: 403, models: 200, authTokens: 200 } }));
    expect(r.reason).not.toMatch(/55|native-audio|modelCount/);
  });

  it("a usable key still passes cleanly", () => {
    expect(keyIsUsable(GOOD)).toEqual({ usable: true });
  });
});
