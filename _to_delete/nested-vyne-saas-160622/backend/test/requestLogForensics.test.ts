/**
 * The request log has to name the caller (v5.32.72).
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. Measured on production: the frontend is
 * served from Firebase Hosting, which rewrites /api/* to Cloud Run by
 * TERMINATING the visitor's connection and re-originating from Google's own
 * infrastructure. Cloud Run's httpRequest.remoteIp showed 192.178.15.195 /
 * 64.233.172.72 / 74.125.215.227 — Google ranges — while the app resolved the
 * same requests to 169.254.169.126, a link-local hop. The real client appears
 * in neither log, and no TRUST_PROXY_HOPS value recovers what was never sent.
 *
 * The remaining gap was forensic, so the fix is to record the raw
 * X-Forwarded-For chain beside the resolved address. That fix lives in a
 * serializer — a config object several layers below any route — which is
 * exactly the kind of thing a later logger change silently drops. Nothing else
 * in the app would fail if it vanished; the only symptom would be a blank
 * column in an incident six months from now.
 *
 * Two properties, and the second matters as much as the first:
 *   · the chain IS captured
 *   · it is captured as EVIDENCE and never consulted for authorization —
 *     req.ip must keep obeying the hop count, not the header
 */
import { describe, it, expect } from "vitest";
import Fastify, { type FastifyRequest } from "fastify";
import { scrubUrl } from "../src/monitoring/sentry.js";

/** The serializer exactly as server.ts installs it. */
function reqSerializer(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: scrubUrl(request.url) as string,
    hostname: request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
    xff: request.headers["x-forwarded-for"],
  };
}

/** Build a server that captures what the serializer produced for one request. */
const PROD_TRUST = ["loopback", "linklocal", "uniquelocal"];

async function serializedFor(
  headers: Record<string, string>,
  trustProxy: number | boolean | string[]
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const app = Fastify({ trustProxy, logger: false });
  app.get("/probe", async (req) => {
    captured = reqSerializer(req);
    return { ok: true };
  });
  await app.inject({ method: "GET", url: "/probe", headers });
  await app.close();
  return captured;
}

describe("request log forensics behind Firebase Hosting (v5.32.72)", () => {
  it("records the whole X-Forwarded-For chain, not just the resolved hop", () => {
    // The production shape: a client, a Firebase edge, a Google front end.
    // Without this, an incident investigation has one link-local address and
    // nothing else.
    return serializedFor(
      { "x-forwarded-for": "203.0.113.9, 192.178.15.195, 64.233.172.72" }, PROD_TRUST
    ).then((s) => {
      expect(s.xff).toBe("203.0.113.9, 192.178.15.195, 64.233.172.72");
      expect(String(s.xff)).toContain("203.0.113.9");
    });
  });

  it("still resolves remoteAddress by HOP COUNT, not by trusting the header", async () => {
    // The whole reason trustProxy is a number and not `true`. If capturing the
    // chain ever turned into believing it, an attacker could name their own
    // address by prepending to the header — the IP-rotation knob server.ts's
    // comment warns about. Evidence and authorization must stay separate.
    const s = await serializedFor(
      { "x-forwarded-for": "1.2.3.4, 203.0.113.9, 192.178.15.195" }, PROD_TRUST
    );
    expect(s.remoteAddress).not.toBe("1.2.3.4");
    expect(String(s.xff)).toContain("1.2.3.4");
  });

  it("captures a forged header without adopting it", async () => {
    // This case is why trustProxy stopped being a hop count in v5.32.72 — see
    // trustProxyForgery.test.ts. With the number 2 this assertion FAILED:
    // req.ip came back 6.6.6.6. Under the production trust list the forged
    // entry is recorded as evidence and ignored as identity, which is the
    // whole distinction this file exists to hold.
    const s = await serializedFor(
      { "x-forwarded-for": "6.6.6.6, 198.51.100.7" }, PROD_TRUST);
    expect(s.xff).toBe("6.6.6.6, 198.51.100.7");
    expect(s.remoteAddress).toBe("198.51.100.7");
  });

  it("is undefined rather than fabricated when there is no proxy at all", async () => {
    // Local dev and direct hits. An empty string here would read in the logs
    // like a chain that was checked and found empty.
    const s = await serializedFor({}, false);
    expect(s.xff).toBeUndefined();
  });

  it("keeps the fields the previous serializer had", async () => {
    // Replacing Fastify's default serializer silently drops whatever is not
    // re-listed. method/url/remoteAddress are what every existing log query
    // and preflight check 3 read.
    const s = await serializedFor({ "x-forwarded-for": "203.0.113.9" }, PROD_TRUST);
    expect(s.method).toBe("GET");
    expect(s.url).toBe("/probe");
    expect(s).toHaveProperty("remoteAddress");
    expect(s).toHaveProperty("hostname");
  });
});

describe("access logs do not retain client identity in the URL (v5.32.76, audit Low)", () => {
  it("drops the query string, keeping the path", async () => {
    // A consulting product's URLs name the CUSTOMER'S customers, and an access
    // log is readable by anyone with Cloud Logging read on the project — a much
    // wider audience than an incident responder. The Sentry path already
    // scrubbed; the request log did not.
    const app = Fastify({ trustProxy: false, logger: false });
    let captured: Record<string, unknown> = {};
    app.get("/api/solution-design", async (req) => {
      captured = reqSerializer(req); return { ok: true };
    });
    await app.inject({ method: "GET",
      url: "/api/solution-design?client=Acme%20Manufacturing&email=cfo%40acme.com" });
    await app.close();
    expect(captured.url).toBe("/api/solution-design");
    expect(String(captured.url)).not.toContain("Acme");
    expect(String(captured.url)).not.toContain("acme.com");
  });

  it("a URL with no query string is unchanged", async () => {
    // The false-positive direction: over-trimming would make every log line
    // useless for finding the endpoint.
    const app = Fastify({ trustProxy: false, logger: false });
    let captured: Record<string, unknown> = {};
    app.get("/api/version", async (req) => { captured = reqSerializer(req); return {}; });
    await app.inject({ method: "GET", url: "/api/version" });
    await app.close();
    expect(captured.url).toBe("/api/version");
  });
});
