/**
 * V225-audit M2 fix — DevVerifier now requires an HMAC-signed token instead
 * of accepting a bare "dev:<uid>" gated only by the DEV_AUTH env flag. See
 * auth/devVerifier.ts's doc comment for the full threat this closes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DevVerifier } from "../src/auth/devVerifier.js";
import { buildServer } from "../src/server.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";

describe("DevVerifier", () => {
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
  });
  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
  });

  it("refuses to construct with an empty secret (fail closed)", () => {
    expect(() => new DevVerifier("")).toThrow(/non-empty DEV_AUTH_SECRET/);
  });

  it("refuses to construct in production even with a secret", () => {
    process.env.NODE_ENV = "production";
    expect(() => new DevVerifier("some-secret")).toThrow(/must never be constructed in production/);
  });

  it("rejects a bare, unsigned dev:<uid> token — the old vulnerable format", async () => {
    const v = new DevVerifier("secret-a");
    await expect(v.verify("dev:owner-1")).rejects.toThrow(/missing signature/);
  });

  it("accepts a token it signed itself", async () => {
    const v = new DevVerifier("secret-a");
    const token = v.sign("owner-1");
    const identity = await v.verify(token);
    expect(identity.uid).toBe("owner-1");
    expect(identity.email).toBe("owner-1@dev.local");
  });

  it("rejects a token signed with a different secret (forged impersonation attempt)", async () => {
    const attacker = new DevVerifier("attacker-secret");
    const forged = attacker.sign("victim-owner-uid");
    const real = new DevVerifier("real-secret");
    await expect(real.verify(forged)).rejects.toThrow(/invalid dev token signature/);
  });

  it("rejects a token for a different uid than it was signed for (no cross-uid replay)", async () => {
    const v = new DevVerifier("secret-a");
    const tokenForAlice = v.sign("alice");
    // Swap the uid but keep alice's signature — must not verify as "bob".
    const [, , sig] = tokenForAlice.split(":");
    const tampered = `dev:bob:${sig}`;
    await expect(v.verify(tampered)).rejects.toThrow(/invalid dev token signature/);
  });
});

class NoVerifier implements TokenVerifier {
  async verify(): Promise<VerifiedIdentity> {
    throw new Error("unused");
  }
}

describe("POST /api/dev/mint-token", () => {
  it("is not mounted when no devVerifier is supplied (production-shaped build)", async () => {
    const app = await buildServer({
      config: { env: "test", port: 0, databaseUrl: "postgres://unused/unused", blockFreeTier: false } as never,
      verifier: new NoVerifier(),
      adapters: [],
      meter: async () => {},
    });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/dev/mint-token", payload: { uid: "x" } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("mints a token that DevVerifier itself accepts, when devVerifier is supplied", async () => {
    const verifier = new DevVerifier("test-secret");
    const app = await buildServer({
      config: { env: "test", port: 0, databaseUrl: "postgres://unused/unused", blockFreeTier: false } as never,
      verifier,
      devVerifier: verifier,
      adapters: [],
      meter: async () => {},
    });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/dev/mint-token", payload: { uid: "dev-owner" } });
    expect(res.statusCode).toBe(200);
    const { token } = res.json();
    expect(token).toMatch(/^dev:dev-owner:[0-9a-f]{64}$/);
    const identity = await verifier.verify(token);
    expect(identity.uid).toBe("dev-owner");
    await app.close();
  });
});
