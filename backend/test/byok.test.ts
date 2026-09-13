/**
 * v5.34.50 — BYOK foundation: key storage, key probing, and the attestation
 * the schema refuses to let anyone skip.
 *
 * The probe tests encode the measurement that shaped the whole design: a
 * billed key and an unbilled key are indistinguishable, so nothing here may
 * return a tier verdict. See verifyKey.ts's header for the numbers.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeKey, keyIsUsable } from "../src/llm/byok/verifyKey.js";
import {
  putTenantKey, getTenantKey, disableTenantKey, secretIdFor, _clearByokCache,
} from "../src/llm/byok/secretStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TENANT = "11111111-1111-1111-1111-111111111111";
const OPTS = { projectId: "proj", getAccessToken: async () => "tok" };
/* v5.34.57 — the store is keyed per (tenant, client, provider), not per tenant. */
const REF = { tenantId: TENANT, clientNorm: "nestl", provider: "gemini-aistudio" };
const SECRET_ID = `vyne-byok-${TENANT}-nestl-gemini-aistudio`;

/** A Secret Manager stand-in that records what it was asked to do. */
function fakeSm(overrides: Record<string, { status: number; body?: unknown }> = {}) {
  const calls: { method: string; path: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    const path = String(url).replace("https://secretmanager.googleapis.com/v1", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    for (const [frag, res] of Object.entries(overrides)) {
      if (path.includes(frag)) {
        return { ok: res.status < 400, status: res.status, text: async () => JSON.stringify(res.body ?? {}) };
      }
    }
    if (path.includes(":access")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        payload: { data: Buffer.from("AQ.secret-key-value").toString("base64") } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ name: `${path}/versions/7` }) };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("v5.34.50 — storing a client's key", () => {
  beforeEach(() => _clearByokCache());

  it("never puts the key in our database — only a Secret Manager name and four characters", async () => {
    const sm = fakeSm();
    const out = await putTenantKey({ ...OPTS, fetchImpl: sm.fetchImpl }, REF, "AQ.AAAAAAAAAAAAAAAAwxyz");

    expect(out.secretName).toMatch(new RegExp(`^projects/proj/secrets/${SECRET_ID}/versions/\\d+$`));
    expect(out.keyHint).toBe("wxyz");
    expect(out.keyHint.length).toBe(4);
    // Whatever is persisted must not be reconstructable into the key.
    expect(JSON.stringify(out)).not.toContain("AAAAAAAAAAAAAAAA");
  });

  it("a rotation adds a version rather than replacing the secret", async () => {
    const sm = fakeSm({ "secrets?secretId": { status: 409 } });   // already exists
    await putTenantKey({ ...OPTS, fetchImpl: sm.fetchImpl }, REF, "AQ.second-key");

    // 409 on create is the normal path on every rotation after the first.
    expect(sm.calls.some((c) => c.path.includes("secrets?secretId"))).toBe(true);
    const add = sm.calls.find((c) => c.path.includes(":addVersion"));
    expect(add).toBeTruthy();
    expect(Buffer.from(add!.body.payload.data, "base64").toString()).toBe("AQ.second-key");
  });

  it("a failure to store says what failed without saying what the key was", async () => {
    const sm = fakeSm({ ":addVersion": { status: 500 } });
    await expect(
      putTenantKey({ ...OPTS, fetchImpl: sm.fetchImpl }, REF, "AQ.super-secret-value")
    ).rejects.toThrow(/could not store the key \(HTTP 500\)/);
    await expect(
      putTenantKey({ ...OPTS, fetchImpl: sm.fetchImpl }, REF, "AQ.super-secret-value")
    ).rejects.not.toThrow(/super-secret-value/);
  });

  it("refuses an empty key rather than storing one", async () => {
    const sm = fakeSm();
    await expect(putTenantKey({ ...OPTS, fetchImpl: sm.fetchImpl }, REF, "   "))
      .rejects.toThrow(/empty key/);
    expect(sm.calls.length).toBe(0);
  });

  it("refuses anything that is not a uuid, a norm and a provider — the id is built from all three", () => {
    expect(() => secretIdFor("../../etc/passwd", "nestl", "gemini-aistudio")).toThrow();
    expect(() => secretIdFor("", "nestl", "gemini-aistudio")).toThrow();
    expect(() => secretIdFor(TENANT, "Nestlé", "gemini-aistudio")).toThrow();   // not normalised
    expect(() => secretIdFor(TENANT, "nestl", "../evil")).toThrow();
    expect(() => (secretIdFor as any)(TENANT)).toThrow(/required/);
    expect(secretIdFor(TENANT, "nestl", "gemini-aistudio")).toBe(SECRET_ID);
  });
});

describe("v5.34.50 — reading a client's key", () => {
  beforeEach(() => _clearByokCache());
  const NAME = `projects/proj/secrets/${SECRET_ID}/versions/3`;

  it("reads the key, then serves it from cache rather than re-billing the fetch", async () => {
    const sm = fakeSm();
    const o = { ...OPTS, fetchImpl: sm.fetchImpl };
    expect(await getTenantKey(o, NAME)).toBe("AQ.secret-key-value");
    expect(await getTenantKey(o, NAME)).toBe("AQ.secret-key-value");
    expect(sm.calls.filter((c) => c.path.includes(":access")).length).toBe(1);
  });

  it("the cache expires, so a key rotated elsewhere does not work forever", async () => {
    const sm = fakeSm();
    let clock = 1_000_000;
    const o = { ...OPTS, fetchImpl: sm.fetchImpl, now: () => clock };
    await getTenantKey(o, NAME);
    clock += 6 * 60 * 1000;                      // past the 5-minute TTL
    await getTenantKey(o, NAME);
    expect(sm.calls.filter((c) => c.path.includes(":access")).length).toBe(2);
  });

  it("a rotation yields a DIFFERENT pinned name, so a stale key cannot be served", async () => {
    /*
     * v5.34.57 replaced this test's premise rather than its expectation.
     *
     * It used to assert that rotating evicts the cache entry, because every
     * version shared one name and `versions/latest` was read. Now the persisted
     * name carries the version, so a rotation produces a name that has never
     * been cached — the stale-key window is not shortened, it is removed.
     * The old pinned name still resolving to the old key is correct: that
     * version genuinely still holds it.
     */
    const sm = fakeSm();
    const o = { ...OPTS, fetchImpl: sm.fetchImpl };
    const rotated = await putTenantKey(o, REF, "AQ.rotated");

    expect(rotated.secretName).not.toBe(NAME);
    expect(rotated.secretName).toMatch(/\/versions\/\d+$/);

    // The new name was never cached, so reading it must hit Secret Manager.
    const before = sm.calls.filter((c) => c.path.includes(":access")).length;
    await getTenantKey(o, rotated.secretName);
    expect(sm.calls.filter((c) => c.path.includes(":access")).length).toBe(before + 1);
  });

  it("a missing or forbidden secret is null, not an exception", async () => {
    for (const status of [404, 403]) {
      _clearByokCache();
      const sm = fakeSm({ ":access": { status } });
      expect(await getTenantKey({ ...OPTS, fetchImpl: sm.fetchImpl }, NAME)).toBeNull();
    }
  });

  it("disabling drops the cached copy before anything else", async () => {
    const sm = fakeSm();
    const o = { ...OPTS, fetchImpl: sm.fetchImpl };
    await getTenantKey(o, NAME);
    await disableTenantKey(o, NAME);
    await getTenantKey(o, NAME);
    expect(sm.calls.filter((c) => c.path.includes(":access")).length).toBe(2);
  });
});

/** A Gemini stand-in for the probe. */
function fakeGemini(plan: { generate?: number; models?: number; authTokens?: number; modelNames?: string[] }) {
  const s = { generate: 200, models: 200, authTokens: 200, ...plan };
  const names = plan.modelNames ?? [
    "models/gemini-flash-latest",
    "models/gemini-2.5-flash-native-audio-latest",
  ];
  return (async (url: string) => {
    const u = String(url);
    if (u.includes(":generateContent")) return { ok: s.generate < 400, status: s.generate, json: async () => ({}) };
    if (u.includes("/models?")) {
      return { ok: s.models < 400, status: s.models,
               json: async () => ({ models: names.map((n) => ({ name: n })) }) };
    }
    return { ok: s.authTokens < 400, status: s.authTokens, json: async () => ({ token: "t" }) };
  }) as unknown as typeof fetch;
}

describe("v5.34.50 — probing a key reports evidence, never a tier", () => {
  it("a working key is reported working, in full detail", async () => {
    const p = await probeKey("AQ.k", { fetchImpl: fakeGemini({}) });
    expect(p.canGenerate).toBe(true);
    expect(p.canMintLiveToken).toBe(true);
    expect(p.hasNativeAudio).toBe(true);
    expect(p.modelCount).toBe(2);
    expect(keyIsUsable(p).usable).toBe(true);
  });

  it("has no field that claims to know the billing tier", async () => {
    /*
     * The measurement this rests on: a billed key and an unbilled key returned
     * identical results on all three endpoints, including auth_tokens. Any
     * `paidTier` or `accepted` field here would be a guess wearing the clothes
     * of a check — which is exactly what the schema's `attested` naming exists
     * to prevent.
     */
    const p = await probeKey("AQ.k", { fetchImpl: fakeGemini({}) });
    const keys = Object.keys(p);
    expect(keys).not.toContain("paidTier");
    expect(keys).not.toContain("tier");
    expect(keys).not.toContain("accepted");
    expect(keys).not.toContain("verified");
  });

  it("refuses a key that cannot start a voice session", async () => {
    // Silently falling back to text would mean discovering it mid-interview,
    // with a client executive on the call.
    const p = await probeKey("AQ.k", { fetchImpl: fakeGemini({ authTokens: 403 }) });
    const u = keyIsUsable(p);
    expect(u.usable).toBe(false);
    expect(u.reason).toMatch(/live voice session/);
  });

  it("refuses a key that cannot see the native-audio model", async () => {
    const p = await probeKey("AQ.k", {
      fetchImpl: fakeGemini({ modelNames: ["models/gemini-flash-latest"] }),
    });
    expect(p.hasNativeAudio).toBe(false);
    expect(keyIsUsable(p).reason).toMatch(/native-audio/);
  });

  it("refuses a key that does not work at all", async () => {
    const p = await probeKey("AQ.k", { fetchImpl: fakeGemini({ generate: 401 }) });
    expect(p.status.generate).toBe(401);
    expect(keyIsUsable(p).reason).toMatch(/rejected for text generation/);
  });

  it("a network failure is evidence, not an exception", async () => {
    const boom = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const p = await probeKey("AQ.k", { fetchImpl: boom });
    expect(p.canGenerate).toBe(false);
    expect(p.error).toMatch(/ECONNRESET/);
    expect(keyIsUsable(p).usable).toBe(false);
  });

  it("an empty key is handled before any request is made", async () => {
    let called = false;
    const spy = (async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof fetch;
    const p = await probeKey("  ", { fetchImpl: spy });
    expect(called).toBe(false);
    expect(p.error).toMatch(/no key/);
  });
});

describe("v5.34.53 — the schema will not let the attestation be skipped", () => {
  const MIG = readFileSync(join(__dirname, "..", "src", "db", "migrations", "031_byok_client_grain.sql"), "utf8");

  it("an active BYOK key requires a named attester, a time, and the text shown", () => {
    expect(MIG).toContain("byok_key_active_requires_attestation");
    for (const col of ["paid_tier_attested = true", "attested_by_email IS NOT NULL",
                       "attested_at IS NOT NULL", "attestation_text IS NOT NULL"]) {
      expect(MIG, `constraint is missing: ${col}`).toContain(col);
    }
  });

  it("nothing is named as though the tier were verified", () => {
    /*
     * The whole point. `byok_paid_tier` would read, a year from now, as though
     * the product had checked something it cannot check.
     *
     * Assert against the DDL with comments STRIPPED: the header deliberately
     * writes out the rejected name to explain why it was rejected, and a
     * whole-file match fails on that documentation. Same trap as the
     * readFileSync check in sweepStaleHolds.test.ts — a test that matches
     * prose is testing the wrong thing.
     */
    const ddl = MIG.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(ddl).toContain("paid_tier_attested");
    expect(ddl).not.toMatch(/\bpaid_tier\b(?!_attested)/);
    expect(ddl).not.toContain("tier_verified");
  });

  it("the audit trail cannot be edited by the application", () => {
    expect(MIG).toContain("byok_keys");
    const g = readFileSync(join(__dirname, "..", "src", "db", "migrations", "030_byok.sql"), "utf8");
    expect(g).toContain("GRANT SELECT, INSERT ON byok_events TO vyne_app");
    expect(g).not.toMatch(/GRANT[^;]*DELETE[^;]*byok_events/);
  });

  it("only providers that can actually take an API key are allowed", () => {
    // Vertex authenticates with service-account credentials, so a Vertex BYOK
    // row would be a promise the router cannot keep.
    expect(MIG).toContain("byok_key_provider_known");
    expect(MIG).toContain("provider IN ('gemini-aistudio', 'anthropic-api')");
  });
});

/* ── the constraint, against a real server ────────────────────────────────── */

const RLS_ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

/*
 * The v5.34.50 real-Postgres block that lived here is GONE, not skipped.
 *
 * Migration 031 drops the tenant-grain byok columns it asserted against: BYOK
 * belongs to a CLIENT, not a firm, because a firm runs several engagements at
 * once and it is the client's pilot that should pay for the client's
 * interviews. Those assertions now live in byokClientGrain.test.ts at the right
 * grain, including the same "a live key requires an attestation" constraint.
 *
 * Deleted rather than adapted: 030's grain was the mistake, so there is nothing
 * in those tests worth carrying forward except the idea, which is carried.
 */
