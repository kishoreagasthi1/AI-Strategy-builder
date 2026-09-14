/**
 * V225-audit HIGH fix: POST /api/signup used to fail OPEN — when
 * SIGNUP_ACCESS_KEY wasn't set, the gate check was skipped entirely and
 * anyone could provision a tenant unauthenticated. It now shares
 * routes/firms.ts's requireOperator(), which fails CLOSED: no key
 * configured means deny, not allow. These tests hit the route directly
 * (no Postgres needed — the gate rejects before provisionFirm() is ever
 * called, so there's nothing to seed).
 */
import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { signupRoutes } from "../src/routes/signup.js";

async function buildApp() {
  const app = Fastify();
  await app.register(signupRoutes);
  return app;
}

const VALID_BODY = {
  firmName: "Acme Consulting",
  ownerEmail: "owner@acme.com",
  ownerPassword: "correct-horse-battery-staple",
};

describe("POST /api/signup — V225-audit fail-closed gate", () => {
  afterEach(() => {
    delete process.env.SIGNUP_ACCESS_KEY;
  });

  it("denies when SIGNUP_ACCESS_KEY is not configured at all (used to fail OPEN)", async () => {
    delete process.env.SIGNUP_ACCESS_KEY;
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/signup", payload: VALID_BODY });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });

  it("denies when a key is configured but the header is missing or wrong", async () => {
    process.env.SIGNUP_ACCESS_KEY = "correct-key";
    const app = await buildApp();
    const noHeader = await app.inject({ method: "POST", url: "/api/signup", payload: VALID_BODY });
    expect(noHeader.statusCode).toBe(403);
    const wrongHeader = await app.inject({
      method: "POST", url: "/api/signup",
      headers: { "x-signup-key": "wrong-key" }, payload: VALID_BODY,
    });
    expect(wrongHeader.statusCode).toBe(403);
  });

  it("passes the gate with the correct key (fails later at provisioning without a DB — proves the gate, not full end-to-end)", async () => {
    process.env.SIGNUP_ACCESS_KEY = "correct-key";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/api/signup",
      headers: { "x-signup-key": "correct-key" }, payload: VALID_BODY,
    });
    // No live DB in this unit test — provisionFirm() will fail downstream
    // (500), but critically NOT 403: the gate itself let the request through.
    expect(res.statusCode).not.toBe(403);
  });
});
