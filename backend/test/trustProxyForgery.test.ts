/**
 * req.ip must not be attacker-chosen (v5.32.72 SECURITY).
 *
 * THE BUG. trustProxy was the number 2. proxy-addr truncates X-Forwarded-For at
 * the first UNtrusted hop and returns whatever is leftmost in what remains, so a
 * count larger than the actual chain runs off the end and hands back the
 * attacker's own entry. Cloud Run appends the connecting peer to the header, so
 * a caller hitting the run.app URL with `X-Forwarded-For: 6.6.6.6` produces
 * exactly two entries — and two entries is one fewer than the count assumed:
 *
 *     trustProxy 2, "6.6.6.6, 198.51.100.7"  ->  req.ip = 6.6.6.6
 *
 * Rotating the header then yields a fresh req.ip per request, which defeats
 * both IP-keyed limiters in server.ts: the operator scope (20/min on FAILED
 * platform-key attempts — the credential that provisions firms) and the
 * firm-email lookup (10/min anti-enumeration). The v5.32.65 comment on that
 * setting asserted this could not happen; it reasoned about a three-entry chain
 * and never considered a shorter one.
 *
 * THE FIX is to stop counting hops and name the address classes that are
 * infrastructure, so the walk stops at the first address the caller did not
 * choose.
 *
 * WHAT THESE TESTS ARE FOR. The security property depends on an assumption
 * about someone else's platform — that Cloud Run appends the peer — and on a
 * library's truncation semantics. Neither is visible at the call site, and a
 * future "simplify this to a number" would look like tidying. So the forgery is
 * performed here rather than described.
 */
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { resolveTrustProxy } from "../src/server.js";

const PEER = "169.254.169.126";   // what Cloud Run's socket peer actually is
const ATTACKER = "6.6.6.6";       // what the caller wants req.ip to say
const REAL = "198.51.100.7";      // what Cloud Run appends: the caller's real IP

/** Resolve req.ip for a given trustProxy setting and X-Forwarded-For header. */
async function resolvedIp(
  trustProxy: boolean | number | string | string[],
  xff?: string
): Promise<string> {
  const app = Fastify({ trustProxy, logger: false });
  app.get("/p", async (req) => ({ ip: req.ip }));
  const r = await app.inject({
    method: "GET", url: "/p",
    headers: xff ? { "x-forwarded-for": xff } : {},
    remoteAddress: PEER,
  });
  await app.close();
  return r.json().ip as string;
}

/*
 * THE REAL SETTING, read from server.ts — not a copy of it.
 *
 * The first version of this file declared its own array here. Reverting
 * server.ts to the exploitable hop count then failed nothing at all, because
 * every assertion below was exercising proxy-addr against a hard-coded literal
 * rather than exercising VYNE. A test that cannot observe the change it exists
 * to prevent is worse than no test: it reports the property as held.
 */
const PROD_TRUST = resolveTrustProxy("production", undefined);

describe("the forgery the old hop count allowed", () => {
  it("PROVES the old setting was exploitable — trustProxy 2 returns the forged value", async () => {
    // Kept as a live demonstration rather than prose. If a future change makes
    // this stop being true, the reason for the current setting has changed and
    // somebody should find out why.
    expect(await resolvedIp(2, `${ATTACKER}, ${REAL}`)).toBe(ATTACKER);
    expect(await resolvedIp(2, `${ATTACKER}, 7.7.7.7, ${REAL}`)).toBe("7.7.7.7");
  });
});

describe("infrastructure-only trust (v5.32.72)", () => {
  it("ignores a forged entry and resolves the address Cloud Run appended", async () => {
    expect(await resolvedIp(PROD_TRUST, `${ATTACKER}, ${REAL}`)).toBe(REAL);
  });

  it("ignores ANY number of forged entries — no chain length is safe to assume", async () => {
    // The whole failure mode was an assumption about length. There must not be
    // a length at which the attacker wins.
    expect(await resolvedIp(PROD_TRUST, `${ATTACKER}, 7.7.7.7, ${REAL}`)).toBe(REAL);
    expect(await resolvedIp(PROD_TRUST, `1.1.1.1, 2.2.2.2, 3.3.3.3, ${REAL}`)).toBe(REAL);
    expect(await resolvedIp(PROD_TRUST, `${ATTACKER}, ${ATTACKER}, ${ATTACKER}, ${ATTACKER}, ${REAL}`))
      .toBe(REAL);
  });

  it("an honest caller still resolves to their real address", async () => {
    // The false-positive direction. A rule that protects by resolving everyone
    // to one bucket would pass every test above and break rate limiting.
    expect(await resolvedIp(PROD_TRUST, REAL)).toBe(REAL);
    expect(await resolvedIp(PROD_TRUST, `${REAL}`)).not.toBe(PEER);
  });

  it("distinct callers land in distinct buckets", async () => {
    const a = await resolvedIp(PROD_TRUST, `${ATTACKER}, 198.51.100.7`);
    const b = await resolvedIp(PROD_TRUST, `${ATTACKER}, 203.0.113.42`);
    expect(a).not.toBe(b);
  });

  it("behind Firebase Hosting, with no header at all, falls back to the peer", async () => {
    // Production logs show no X-Forwarded-For on the Firebase-rewritten path.
    // The peer is useless for forensics — that is what the serializer's xff
    // field covers — but it is not forgeable, and no setting could recover a
    // client address that was never transmitted.
    expect(await resolvedIp(PROD_TRUST, undefined)).toBe(PEER);
  });

  it("an attacker cannot claim to BE infrastructure to reach further left", async () => {
    // If a caller pads the chain with private addresses, the walk would keep
    // going left past them. It must still stop at the first address Cloud Run
    // appended, because that one is not chosen by the caller.
    expect(await resolvedIp(PROD_TRUST, `${ATTACKER}, 10.0.0.1, 192.168.1.1, ${REAL}`)).toBe(REAL);
  });

  it("outside production nothing is trusted, so no header can move req.ip", async () => {
    expect(await resolvedIp(false, `${ATTACKER}, ${REAL}`)).toBe(PEER);
  });
});

describe("the app's OWN configuration, not a copy of it", () => {
  it("production resolves a forged chain to the address Cloud Run appended", async () => {
    // Reverting server.ts to `Number(TRUST_PROXY_HOPS ?? 2)` must fail HERE.
    expect(await resolvedIp(resolveTrustProxy("production", undefined),
      `${ATTACKER}, ${REAL}`)).toBe(REAL);
  });

  it("production does not trust the header wholesale either", async () => {
    // trustProxy: true is the other way to make req.ip attacker-chosen, and it
    // would satisfy a naive "not a hop count" check.
    expect(await resolvedIp(resolveTrustProxy("production", undefined),
      `${ATTACKER}, 10.0.0.1, ${REAL}`)).toBe(REAL);
  });

  it("dev and test trust nothing", () => {
    expect(resolveTrustProxy("test", undefined)).toBe(false);
    expect(resolveTrustProxy("development", undefined)).toBe(false);
  });

  it("TRUST_PROXY_HOPS still overrides as a number, for other proxy setups", () => {
    expect(resolveTrustProxy("production", "1")).toBe(1);
    expect(resolveTrustProxy("production", "0")).toBe(0);
  });
});
