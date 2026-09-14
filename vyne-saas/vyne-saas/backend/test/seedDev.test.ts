/**
 * V225-audit LOW fix: seedDev.ts (npm run seed:dev) creates an owner
 * account tied to DevVerifier's unauthenticated "dev:<uid>" token scheme —
 * fine in local dev, a real backdoor if it ever ran against a production
 * database (wrong DATABASE_URL copy-pasted, a misconfigured CI job). It now
 * refuses outright when NODE_ENV=production, before ever touching
 * DATABASE_URL or opening a DB connection.
 */
import { describe, it, expect, afterEach } from "vitest";
import { main } from "../src/db/seedDev.js";

describe("seedDev NODE_ENV production guard", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedDbUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedDbUrl;
  });

  it("refuses to run when NODE_ENV=production, even with no DATABASE_URL set (guard runs first)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    await expect(main()).rejects.toThrow(/refuses to run with NODE_ENV=production/);
  });

  it("still requires DATABASE_URL outside production (guard doesn't block legitimate dev use)", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.DATABASE_URL;
    await expect(main()).rejects.toThrow(/DATABASE_URL required/);
  });
});
