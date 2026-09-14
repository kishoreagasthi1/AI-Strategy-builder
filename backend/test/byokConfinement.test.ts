/**
 * A client's key failing must not become the firm's bill. (v5.34.64)
 *
 * ── The two holes this closes, both found in one minute of live use ─────────
 *
 * 1. SILENT FALLBACK. Through v5.34.63 a refused client key fell through to the
 *    firm's credential and the work carried on. gateway.ts said so on purpose:
 *    "a lapsed client key must never be the reason an interview stops." What it
 *    actually produced was a revoked key, a red status on a screen nobody was
 *    watching, and every subsequent call billed to the consultancy — the key
 *    turned red AFTER the work had been paid for.
 *
 * 2. PREFERENCE AS A BILLING LEVER. v5.34.63 let a client state a vendor
 *    preference, applied as a reorder BEFORE their credential was interleaved.
 *    A client holding a GOOGLE key who asked for Anthropic therefore got the
 *    FIRM's Anthropic adapter first: their key untouched, the firm billed, and
 *    the panel asserting in plain words that a preference "never changes who
 *    pays". Reproduced against production data on 2026-09-13 with a real
 *    client, a real key, and the shipped chain-building code.
 *
 * Both are one rule now: a client with a key on file runs on their own
 * credentials and nothing else, unless the firm has granted otherwise for that
 * client. These tests pin the rule at the level it can actually be violated —
 * which adapter ran, and therefore whose money was spent — rather than at the
 * level of what the chain array looks like.
 */
import { describe, it, expect } from "vitest";
import {
  applyByokToChain, confineToClientCredentials, makeByokResolver,
} from "../src/llm/byok/resolve.js";
import { applyClientVendorPreference } from "../src/llm/byok/clientRouting.js";
import { makeByokLiveResolver } from "../src/llm/byok/resolveLive.js";
import { LlmGateway, GatewayError, type MeterEvent } from "../src/llm/gateway.js";
import { PROD_POLICY } from "../src/llm/router.js";
import type { ProviderAdapter, GenerateRequest } from "../src/llm/types.js";
import type { ByokKeyRow, ByokProvider } from "../src/llm/byok/byokRepo.js";

/* ── fixtures ─────────────────────────────────────────────────────────────── */

function keyRow(over: Partial<ByokKeyRow> = {}): ByokKeyRow {
  return {
    clientNorm: "nestle", clientName: "Nestle", provider: "gemini-aistudio",
    status: "active", secretName: "projects/p/secrets/s/versions/3", keyHint: "aaaa",
    verifiedAt: new Date().toISOString(), paidTierAttested: true,
    attestedByEmail: "admin@nestle.example", attestedAt: new Date().toISOString(),
    probe: null, lastError: null, lastErrorAt: null, ...over,
  };
}

/**
 * A platform adapter that RECORDS every call, so "the firm's key was never
 * spent" is a fact about what ran and not an inference from a chain array.
 */
function platform(
  name: string, ran: string[], opts: { fail?: string } = {}
): ProviderAdapter {
  return {
    name, model: `${name}-model`, freeTier: false,
    isConfigured: () => true,
    async generate() {
      ran.push(name);
      if (opts.fail) throw new Error(opts.fail);
      return { text: `platform:${name}`, model: `${name}-model`,
               usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0.0001 } };
    },
  };
}

/** The client's own credential, refused by its vendor — a real 403 shape. */
const REFUSED = "gemini-aistudio 403: {\"error\":{\"status\":\"PERMISSION_DENIED\"}}";

function resolverWith(opts: {
  rows?: Partial<Record<string, Partial<ByokKeyRow>>>;
  keys?: Record<string, string>;
  ran?: string[];
  fail?: string;
}) {
  return makeByokResolver({
    secretStore: { projectId: "p" },
    lookup: async (_t, clientName, provider) => {
      const over = opts.rows?.[`${clientName}:${provider}`];
      return over ? keyRow({ ...over, provider, clientName }) : null;
    },
    fetchKey: async (_o, secretName) => opts.keys?.[secretName] ?? null,
    fetchImpl: (async () => {
      // Every client adapter built by this resolver shares one behaviour:
      // record that it ran, then succeed or fail as the test asked.
      opts.ran?.push("CLIENT-KEY");
      if (opts.fail) throw new Error(opts.fail);
      return {
        ok: true, status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "client output" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
        text: async () => "",
      };
    }) as unknown as typeof fetch,
  });
}

const REQ: GenerateRequest = { task: "hypotheses", messages: [{ role: "user", content: "x" }] };

function gatewayFor(opts: {
  adapters: ProviderAdapter[];
  resolve?: ReturnType<typeof makeByokResolver>;
  events?: MeterEvent[];
  prefer?: ByokProvider | null;
  granted?: boolean;
}) {
  return new LlmGateway({
    adapters: opts.adapters,
    policy: PROD_POLICY,
    meter: async (e) => { opts.events?.push(e); },
    blockFreeTier: true,
    byok: opts.resolve,
    clientRouting: opts.prefer !== undefined ? async () => opts.prefer ?? null : undefined,
    fallbackGrant: opts.granted !== undefined ? async () => !!opts.granted : undefined,
    transientRetries: 0,
  });
}

/* ── the rule, as a pure function ─────────────────────────────────────────── */

describe("v5.34.64 — confineToClientCredentials", () => {
  const CHAIN = ["gemini-aistudio", "gemini-vertex", "anthropic-vertex"];

  it("drops the firm's adapters for a client who brought a key", () => {
    expect(confineToClientCredentials(CHAIN, new Set(["gemini-aistudio"]), { granted: false }))
      .toEqual(["gemini-aistudio"]);
  });

  it("leaves a non-BYOK client's chain completely alone", () => {
    // The common case, and the one a mistake here would break for every firm.
    expect(confineToClientCredentials(CHAIN, new Set(), { granted: false })).toEqual(CHAIN);
  });

  it("restores the full chain when the firm has granted fallback", () => {
    expect(confineToClientCredentials(CHAIN, new Set(["gemini-aistudio"]), { granted: true }))
      .toEqual(CHAIN);
  });

  it("keeps the client's own adapters in chain order, not table order", () => {
    // `transcribe` puts gemini-aistudio-2 first deliberately (router.ts). The
    // confinement must not quietly re-rank a client's own two adapters, or a
    // client key would be handed a model that cannot do the job.
    const transcribeish = ["gemini-aistudio-2", "gemini-aistudio", "gemini-vertex"];
    expect(confineToClientCredentials(
      transcribeish, new Set(["gemini-aistudio", "gemini-aistudio-2"]), { granted: false }
    )).toEqual(["gemini-aistudio-2", "gemini-aistudio"]);
  });

  it("never invents an adapter that was not already in the chain", () => {
    // The output is always a subsequence of the input — the property that makes
    // this safe to apply to any chain the router produces.
    const out = confineToClientCredentials(CHAIN, new Set(["anthropic-api"]), { granted: false });
    for (const n of out) expect(CHAIN).toContain(n);
  });
});

/* ── the bug that started this, reproduced and closed ─────────────────────── */

describe("v5.34.64 — a preference can no longer move the money", () => {
  /*
   * The exact production combination: ZZ BYOK Test holds a GOOGLE key and is
   * set to prefer Anthropic. Before this release the first attempt went to the
   * firm's anthropic-vertex.
   */
  const firmPolicy = ["gemini-vertex", "gemini-aistudio", "anthropic-vertex"];

  it("used to put the FIRM's Anthropic first — the behaviour being removed", () => {
    // Kept as the regression's own fingerprint: this is what the two steps
    // produce WITHOUT confinement, and it is why confinement exists.
    const reordered = applyClientVendorPreference(firmPolicy, "anthropic-api");
    const interleaved = applyByokToChain(reordered, new Set(["gemini-aistudio"]));
    expect(interleaved[0]).toBe("anthropic-vertex");
  });

  it("now runs on the client's own key, whatever they prefer", () => {
    const reordered = applyClientVendorPreference(firmPolicy, "anthropic-api");
    const interleaved = applyByokToChain(reordered, new Set(["gemini-aistudio"]));
    const confined = confineToClientCredentials(
      interleaved, new Set(["gemini-aistudio"]), { granted: false });
    expect(confined).toEqual(["gemini-aistudio"]);
  });

  it("end to end: the firm's Anthropic adapter is never called", async () => {
    const ran: string[] = [];
    const events: MeterEvent[] = [];
    const gw = gatewayFor({
      adapters: [platform("gemini-vertex", ran), platform("anthropic-vertex", ran)],
      resolve: resolverWith({
        rows: { "Nestle:gemini-aistudio": {} },
        keys: { "projects/p/secrets/s/versions/3": "NESTLE-KEY" },
        ran,
      }),
      prefer: "anthropic-api",
      granted: false,
      events,
    });

    const res = await gw.generate(
      { tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ);

    expect(res.provider).toBe("gemini-aistudio");
    expect(ran).toEqual(["CLIENT-KEY"]);
    expect(ran).not.toContain("anthropic-vertex");
    expect(events.at(-1)!.payer).toBe("client_key");
  });
});

/* ── a refused key stops the call instead of moving the bill ──────────────── */

describe("v5.34.64 — a refused client key fails the call", () => {
  it("does not fall through to the firm's credential", async () => {
    const ran: string[] = [];
    const gw = gatewayFor({
      adapters: [platform("gemini-vertex", ran), platform("anthropic-vertex", ran)],
      resolve: resolverWith({
        rows: { "Nestle:gemini-aistudio": {} },
        keys: { "projects/p/secrets/s/versions/3": "NESTLE-KEY" },
        ran, fail: REFUSED,
      }),
      granted: false,
    });

    await expect(
      gw.generate({ tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ)
    ).rejects.toBeInstanceOf(GatewayError);

    // The whole point: nothing of the firm's ran.
    expect(ran).not.toContain("gemini-vertex");
    expect(ran).not.toContain("anthropic-vertex");
  });

  it("says whose key failed, and that nothing was charged", async () => {
    const ran: string[] = [];
    const gw = gatewayFor({
      adapters: [platform("gemini-vertex", ran)],
      resolve: resolverWith({
        rows: { "Nestle:gemini-aistudio": {} },
        keys: { "projects/p/secrets/s/versions/3": "K" },
        ran, fail: REFUSED,
      }),
      granted: false,
    });

    const err = await gw.generate(
      { tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ
    ).catch((e) => e) as GatewayError;

    expect(err).toBeInstanceOf(GatewayError);
    // 402, not 502: this is not an outage and must not send a consultant
    // looking at the platform when the problem is their client's key.
    expect(err.statusCode).toBe(402);
    expect(err.message).toContain("Nestle");
    expect(err.message).toMatch(/nothing was charged to your account/i);
    // And the remedy, because the person reading it can act on exactly one thing.
    expect(err.message).toMatch(/fallback grant/i);
  });

  it("meters nothing as platform-paid when the call is refused", async () => {
    const events: MeterEvent[] = [];
    const ran: string[] = [];
    const gw = gatewayFor({
      adapters: [platform("gemini-vertex", ran)],
      resolve: resolverWith({
        rows: { "Nestle:gemini-aistudio": {} },
        keys: { "projects/p/secrets/s/versions/3": "K" },
        ran, fail: REFUSED,
      }),
      granted: false, events,
    });
    await gw.generate({ tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ)
      .catch(() => {});
    // The failed attempt on the CLIENT's key may be metered; a platform-paid
    // row must not exist, because the firm spent nothing.
    expect(events.filter((e) => e.payer === "platform")).toHaveLength(0);
  });

  it("falls back exactly as before when the firm has granted it", async () => {
    const ran: string[] = [];
    const events: MeterEvent[] = [];
    const gw = gatewayFor({
      adapters: [platform("gemini-vertex", ran)],
      resolve: resolverWith({
        rows: { "Nestle:gemini-aistudio": {} },
        keys: { "projects/p/secrets/s/versions/3": "K" },
        ran, fail: REFUSED,
      }),
      granted: true, events,
    });

    const res = await gw.generate(
      { tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ);

    expect(res.provider).toBe("gemini-vertex");
    expect(ran).toContain("gemini-vertex");
    expect(events.at(-1)!.payer).toBe("platform");
  });

  it("a client with NO key is untouched by any of this", async () => {
    const ran: string[] = [];
    const events: MeterEvent[] = [];
    const gw = gatewayFor({
      adapters: [platform("gemini-vertex", ran)],
      resolve: resolverWith({ rows: {}, keys: {}, ran }),
      granted: false, events,
    });
    const res = await gw.generate(
      { tenantId: "t1", userId: "u1", module: "m", clientName: "Acme" }, REQ);
    expect(res.provider).toBe("gemini-vertex");
    expect(events.at(-1)!.payer).toBe("platform");
  });

  it("a capacity blip on the client's key is still reported as capacity", async () => {
    /*
     * A 429 is Google rate-limiting a perfectly good key. Reporting that as
     * "your client's key was refused, check it" would send a consultant to
     * re-issue a key that was never broken — and the advice ("try again in a
     * few seconds") is different and correct.
     */
    const ran: string[] = [];
    const gw = gatewayFor({
      adapters: [platform("gemini-vertex", ran)],
      resolve: resolverWith({
        rows: { "Nestle:gemini-aistudio": {} },
        keys: { "projects/p/secrets/s/versions/3": "K" },
        ran, fail: "gemini-aistudio 429: RESOURCE_EXHAUSTED",
      }),
      granted: false,
    });
    const err = await gw.generate(
      { tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ
    ).catch((e) => e) as GatewayError;

    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/briefly at capacity/i);
    // Still no firm spend — confinement holds regardless of why it failed.
    expect(ran).not.toContain("gemini-vertex");
  });

  it("unattributed firm work never goes near any of this", async () => {
    // Cross-client admin work has no client to bill and no key to confine to.
    const ran: string[] = [];
    const gw = gatewayFor({
      adapters: [platform("gemini-vertex", ran)],
      resolve: resolverWith({ rows: { "Nestle:gemini-aistudio": {} }, ran }),
      granted: false,
    });
    const res = await gw.generate({ tenantId: "t1", userId: "u1", module: "m" }, REQ);
    expect(res.provider).toBe("gemini-vertex");
  });
});

/* ── live voice: the expensive path ───────────────────────────────────────── */

describe("v5.34.64 — the live resolver distinguishes 'no key' from 'broken key'", () => {
  const live = (over: {
    row?: Partial<ByokKeyRow> | null; key?: string | null; throws?: boolean;
  }) => makeByokLiveResolver({
    secretStore: { projectId: "p" },
    lookup: async () => {
      if (over.throws) throw new Error("secretmanager unreachable");
      return over.row === null ? null : keyRow(over.row ?? {});
    },
    fetchKey: async () => over.key ?? null,
  });

  it("'none' when the client has no key — the firm pays, as always", async () => {
    expect(await live({ row: null })("t1", "Nestle")).toEqual({ kind: "none" });
  });

  it("'none' for unattributed work", async () => {
    expect(await live({ row: {} })("t1", undefined)).toEqual({ kind: "none" });
  });

  it("'ok' when the key resolves", async () => {
    const r = await live({ key: "NESTLE-KEY" })("t1", "Nestle");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.binding.keyHint).toBe("aaaa");
  });

  it("'unusable' only when the vendor REFUSED the key", async () => {
    /*
     * v5.34.69 narrowed this, and the narrowing is the point.
     *
     * v5.34.64 treated every non-active status as unusable, which over-applied
     * the rule. `disabled` means the OWNER pressed "turn off" — a deliberate
     * decision to put this client back on the firm's account — and `pending`
     * means no key was ever supplied. Refusing an interview in either case
     * contradicts the Owner's own instruction, and contradicted the keys screen,
     * which said in as many words "disabled — running on your key".
     *
     * Only a credential the vendor refused belongs here, because that is the
     * one that silently moves the bill.
     */
    const refused = await live({ row: { status: "failed" }, key: "K" })("t1", "Nestle");
    expect(refused.kind).toBe("unusable");

    for (const status of ["disabled", "pending"] as const) {
      const r = await live({ row: { status }, key: "K" })("t1", "Nestle");
      expect(r.kind, `${status} is the firm's own choice, not a broken key`).toBe("none");
    }
  });

  it("text and voice agree about what a switched-off key means", async () => {
    /*
     * The two paths answered differently for months: text skipped any
     * non-active row (so the firm paid), voice called all of them unusable (so
     * the interview was refused). Same key, same client, opposite outcomes,
     * neither matching the screen. Pinned together so they cannot drift again.
     */
    const resolveText = makeByokResolver({
      secretStore: { projectId: "p" },
      lookup: async (_t, _c, provider) =>
        provider === "gemini-aistudio" ? keyRow({ status: "disabled" }) : null,
      fetchKey: async () => "K",
    });
    const text = await resolveText({ tenantId: "t1", clientName: "Nestle" });
    expect(text.adapters.size).toBe(0);
    expect(text.unusable, "text called a disabled key unusable").toEqual([]);

    const voice = await live({ row: { status: "disabled" }, key: "K" })("t1", "Nestle");
    expect(voice.kind).toBe("none");
  });

  it("a REFUSED key is unusable on both paths, so the firm is not billed twice over", async () => {
    const resolveText = makeByokResolver({
      secretStore: { projectId: "p" },
      // Only the GOOGLE key is on file. A lookup that answers for every provider
      // would report this client as having two refused keys when they have one.
      lookup: async (_t, _c, provider) =>
        provider === "gemini-aistudio"
          ? keyRow({ status: "failed", lastError: "403 PERMISSION_DENIED" })
          : null,
      fetchKey: async () => "K",
    });
    const text = await resolveText({ tenantId: "t1", clientName: "Nestle" });
    expect(text.adapters.size).toBe(0);
    expect(text.unusable).toHaveLength(1);
    /*
     * v5.34.70. This used to assert the raw recorded error INSIDE `reason`.
     * gateway.ts interpolates `reason` into the 402 MESSAGE, which reaches
     * whoever was in the interview, and byok_keys.last_error holds whatever its
     * last writer put there — recordResolveError stores driver and Secret
     * Manager messages verbatim, which carry the secret's resource name and so
     * the GCP project, the tenant uuid and the client_norm. The split is the
     * fix; asserting it here is what keeps the two from being merged again.
     */
    expect(text.unusable[0].reason).not.toMatch(/PERMISSION_DENIED/);
    expect(text.unusable[0].reason).toMatch(/refused by the provider/i);
    expect(text.unusable[0].detail, "the operator still needs the real reason")
      .toMatch(/403 PERMISSION_DENIED/);

    const voice = await live({ row: { status: "failed" }, key: "K" })("t1", "Nestle");
    expect(voice.kind).toBe("unusable");
  });

  it("'unusable' when the secret behind an active key cannot be read", async () => {
    const r = await live({ key: null })("t1", "Nestle");
    expect(r.kind).toBe("unusable");
    if (r.kind === "unusable") {
      expect(r.reason).toMatch(/Secret Manager/);
      expect(r.clientName).toBe("Nestle");
    }
  });

  it("'unusable' when the lookup itself throws — our outage, still their key", async () => {
    // Fail closed. An infrastructure fault on our side must not move a paying
    // client's bill onto the firm just because the error came from us.
    const r = await live({ throws: true })("t1", "Nestle");
    expect(r.kind).toBe("unusable");
  });
});
