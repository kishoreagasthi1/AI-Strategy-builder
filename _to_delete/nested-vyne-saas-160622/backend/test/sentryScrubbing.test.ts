/**
 * What captureError actually hands to the SDK (audit V2-M3).
 *
 * Separate file because it mocks @sentry/node wholesale, and the rest of
 * sentry.test.ts needs the real module to check that init behaves. The
 * assertion here is the one that matters most: not that a scrubbing FUNCTION
 * exists, but that the path from a call site to the vendor runs through it.
 * A scrubber nobody calls is the same as no scrubber.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const captureException = vi.fn(() => "event-id");
const init = vi.fn();

vi.mock("@sentry/node", () => ({ captureException, init }));

describe("captureError scrubs before it reaches Sentry (V2-M3)", () => {
  beforeEach(async () => {
    captureException.mockClear();
    init.mockClear();
    const { _resetForTests, initSentry } = await import("../src/monitoring/sentry.js");
    _resetForTests();
    initSentry({ dsn: "https://examplePublicKey@o0.ingest.sentry.io/0", environment: "test" });
  });

  it("removes the query string from URL-shaped context keys", async () => {
    const { captureError } = await import("../src/monitoring/sentry.js");
    captureError(new Error("boom"), {
      url: "/api/solution-design?client=Acme%20Manufacturing",
      referer: "https://app/engagements?code=ACME01",
      method: "GET",
      tenantId: "t-1",
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    const extra = (captureException.mock.calls[0] as unknown as [unknown, { extra: Record<string, unknown> }])[1].extra;
    expect(extra.url).toBe("/api/solution-design");
    expect(extra.referer).toBe("https://app/engagements");
    // Everything that is not a URL survives untouched: the point of this fix is
    // to keep error reports useful, not to empty them.
    expect(extra.method).toBe("GET");
    expect(extra.tenantId).toBe("t-1");
    expect(JSON.stringify(extra)).not.toContain("Acme");
    expect(JSON.stringify(extra)).not.toContain("ACME01");
  });

  it("installs a beforeSend hook, so the SDK's own collection is covered too", async () => {
    // The request integration fills in request.url and request.query_string
    // without the app passing anything. Scrubbing only at the call site would
    // have left that channel open.
    const opts = init.mock.calls[0][0] as unknown as {
      beforeSend?: (e: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(typeof opts.beforeSend).toBe("function");
    const out = opts.beforeSend!({
      request: { url: "/api/clients?client=Acme", query_string: "client=Acme" },
    }) as { request: { url: string; query_string?: unknown } };
    expect(out.request.url).toBe("/api/clients");
    expect(out.request.query_string).toBeUndefined();
  });
});

describe("scrubEvent strips request headers, body and cookies (v5.32.76, audit Low)", () => {
  it("removes the Authorization header — a captured error must not hand over a session", async () => {
    const { scrubEvent } = await import("../src/monitoring/sentry.js");
    const ev = scrubEvent({
      request: {
        url: "/api/engagements?code=ACME01",
        headers: { authorization: "Bearer eyJhbGciOi.LIVE.TOKEN", cookie: "sid=abc" },
        data: { briefing: "Acme's CFO believes the CEO is overstating readiness." },
        cookies: { sid: "abc" },
      },
    } as Record<string, unknown> as Parameters<typeof scrubEvent>[0]);
    const json = JSON.stringify(ev);
    expect(json).not.toContain("LIVE.TOKEN");
    expect(json).not.toContain("Bearer");
    expect(json).not.toContain("sid=abc");
    expect(json).not.toContain("overstating");
    expect(json).not.toContain("ACME01");
    expect(ev.request?.url).toBe("/api/engagements");
  });

  it("an event with no request object is untouched and does not throw", async () => {
    const { scrubEvent } = await import("../src/monitoring/sentry.js");
    expect(() => scrubEvent({} as Parameters<typeof scrubEvent>[0])).not.toThrow();
  });
});

describe("exception messages and stacks are scrubbed (v5.32.78, external audit)", () => {
  it("removes emails, query strings and Postgres parameter dumps from the message", async () => {
    const { scrubEvent } = await import("../src/monitoring/sentry.js");
    const ev = scrubEvent({
      exception: { values: [{
        value: 'insert failed for cfo@acmemanufacturing.com at '
             + '/api/engagements?client=Acme%20Manufacturing — parameters: ["Acme Manufacturing","ACME01"]',
      }] },
    } as Parameters<typeof scrubEvent>[0]);
    const v = String(ev.exception?.values?.[0].value);
    expect(v).not.toContain("acmemanufacturing.com");
    expect(v).not.toContain("Acme%20Manufacturing");
    expect(v).not.toContain('"Acme Manufacturing"');
    expect(v).not.toContain("ACME01");
    // ...and it is still a usable diagnostic.
    expect(v).toContain("insert failed");
    expect(v).toContain("/api/engagements");
    expect(v).toContain("[email]");
  });

  it("keeps the stack usable — a scrubbed-to-nothing error is unfixable", async () => {
    const { scrubEvent } = await import("../src/monitoring/sentry.js");
    const ev = scrubEvent({
      exception: { values: [{
        value: "TypeError: cannot read property 'id' of undefined",
        stacktrace: { frames: [{ filename: "/app/dist/routes/engagements.js" }] },
      }] },
    } as Parameters<typeof scrubEvent>[0]);
    expect(String(ev.exception?.values?.[0].value)).toContain("TypeError");
    expect(ev.exception?.values?.[0].stacktrace?.frames?.[0].filename)
      .toBe("/app/dist/routes/engagements.js");
  });

  it("scrubs a top-level event.message too", async () => {
    const { scrubEvent } = await import("../src/monitoring/sentry.js");
    const ev = scrubEvent({ message: "notify failed for dana@meridianfoods.com" } as Parameters<typeof scrubEvent>[0]);
    expect(String(ev.message)).toBe("notify failed for [email]");
  });
});
