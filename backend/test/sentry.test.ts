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
import { describe, it, expect, afterEach, vi } from "vitest";
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

/**
 * What must NOT reach the monitoring vendor (audit V2-M3).
 *
 * The global error handler reported `req.url`, and this product's URLs are not
 * opaque: `/api/solution-design?client=Acme%20Manufacturing`,
 * `?code=ACME01`, `?email=...`. The path names the endpoint, which is what a
 * stack trace needs. The query string names the customer of a customer, which
 * a third-party error tracker has no business holding — and which no contract
 * with the consulting firm's client contemplates.
 *
 * Two layers, tested separately, because they fail independently: the call site
 * scrubs what the app passes in, and beforeSend scrubs what the SDK's own
 * request integration collected without being asked.
 */
describe("monitoring/sentry — URLs are scrubbed before leaving (V2-M3)", () => {
  afterEach(() => _resetForTests());

  it("strips the query string and keeps the path", async () => {
    const { scrubUrl } = await import("../src/monitoring/sentry.js");
    expect(scrubUrl("/api/solution-design?client=Acme%20Manufacturing"))
      .toBe("/api/solution-design");
    expect(scrubUrl("/api/scorecard?code=ACME01&email=cfo%40acme.com"))
      .toBe("/api/scorecard");
    expect(scrubUrl("https://api.example.com/api/me?token=abc#frag"))
      .toBe("https://api.example.com/api/me");
  });

  it("leaves a URL with nothing to strip alone", async () => {
    // A scrubber that mangles clean input gets turned off.
    const { scrubUrl } = await import("../src/monitoring/sentry.js");
    expect(scrubUrl("/api/me")).toBe("/api/me");
    expect(scrubUrl("")).toBe("");
    expect(scrubUrl(undefined)).toBe(undefined);
    expect(scrubUrl(42)).toBe(42);
  });

  it("beforeSend strips request.url, request.query_string and breadcrumb URLs", async () => {
    const { scrubEvent } = await import("../src/monitoring/sentry.js");
    const out = scrubEvent({
      request: { url: "https://x/api/clients?client=Acme", query_string: "client=Acme" },
      breadcrumbs: [
        { data: { url: "/api/engagements?code=ACME01" } },
        { data: { method: "GET" } },
        {},
      ],
    });
    expect(out.request!.url).toBe("https://x/api/clients");
    expect(out.request!.query_string).toBeUndefined();
    expect(out.breadcrumbs![0].data!.url).toBe("/api/engagements");
    expect(JSON.stringify(out)).not.toContain("Acme");
  });

});
