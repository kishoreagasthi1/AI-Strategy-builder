/**
 * V225-audit MEDIUM fix: buildServer() now registers a global
 * setErrorHandler (server.ts) as a backstop for any error that escapes a
 * route handler uncaught — without it, Fastify's default handler
 * serializes `err.message` straight into the JSON response, which can leak
 * internal detail (a raw Postgres error, a stack-adjacent message) that
 * was never meant for a client. This registers a throwaway route AFTER
 * buildServer() returns (Fastify allows adding routes right up until the
 * app starts serving) specifically to exercise the global handler in
 * isolation from any particular route's own try/catch.
 */
import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";

class NoVerifier implements TokenVerifier {
  async verify(): Promise<VerifiedIdentity> {
    throw new Error("unused");
  }
}

describe("global Fastify error handler", () => {
  it("turns an uncaught route error into a generic 500, never the raw message", async () => {
    const app = await buildServer({
      config: {
        env: "test", port: 0, databaseUrl: "postgres://unused/unused", blockFreeTier: false,
      } as never,
      verifier: new NoVerifier(),
      adapters: [],
      meter: async () => {},
    });

    app.get("/__throws_for_test__", async () => {
      throw new Error("SELECT column \"secret_internal_column\" does not exist on table users — full stack trace detail");
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/__throws_for_test__" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe("internal_error");
    expect(JSON.stringify(body)).not.toContain("secret_internal_column");

    await app.close();
  });
});
