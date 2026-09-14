/**
 * Error monitoring (v5.30) — src/monitoring/sentry.ts.
 *
 * Fully env-gated (SENTRY_DSN): with no DSN, initSentry() must be an inert
 * no-op and captureError() must never throw — the app's behavior with
 * monitoring unconfigured (every test run, and any deploy that hasn't set
 * SENTRY_DSN) must be identical to before this file existed. Doesn't
 * exercise an actual Sentry.init()+capture round trip against a real DSN —
 * that would mean network calls from the test suite; the DSN-configured
 * path is covered by initSentry()'s try/catch returning true/false and by
 * manual verification against a real Sentry project.
 */
import { describe, it, expect, afterEach } from "vitest";
import { initSentry, captureError, isActive, _resetForTests } from "../src/monitoring/sentry.js";

describe("monitoring/sentry — off by default", () => {
  afterEach(() => _resetForTests());

  it("initSentry() with no DSN is inactive", () => {
    const on = initSentry({ dsn: undefined, environment: "test" });
    expect(on).toBe(false);
    expect(isActive()).toBe(false);
  });

  it("captureError() never throws when inactive", () => {
    expect(() => captureError(new Error("boom"))).not.toThrow();
    expect(() => captureError("a string error", { some: "context" })).not.toThrow();
    expect(() => captureError(null)).not.toThrow();
    expect(() => captureError(undefined)).not.toThrow();
  });

  it("captureError() is a true no-op — doesn't throw even with weird context objects", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => captureError(new Error("boom"), circular)).not.toThrow();
  });
});

describe("monitoring/sentry — DSN configured", () => {
  afterEach(() => _resetForTests());

  it("initSentry() with a syntactically valid DSN activates monitoring", () => {
    const on = initSentry({
      dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      environment: "test",
      release: "5.30.0",
    });
    expect(on).toBe(true);
    expect(isActive()).toBe(true);
  });

  it("initSentry() never throws even with a malformed DSN", () => {
    expect(() => initSentry({ dsn: "not-a-real-dsn", environment: "test" })).not.toThrow();
  });
});
