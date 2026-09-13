/**
 * BYOK slice 2 — the gateway actually SPENDS a client's key. (v5.34.59)
 *
 * The tests that matter here are the ones about CREDENTIAL BLEED: not "does a
 * client key get used" but "can one client's key ever serve another client's
 * call". Those are the negative controls, and several of them fail loudly
 * against the obvious implementations (a mutated singleton, a cached adapter).
 *
 * No network, no database. The resolver's two dependencies — the key row and
 * the secret — are injected.
 */
import { describe, it, expect, vi } from "vitest";
import {
  makeByokResolver,
  applyByokToChain,
  isCredentialRejection,
  BYOK_ADAPTER_NAMES,
  VENDOR_OF_ADAPTER,
} from "../src/llm/byok/resolve.js";
import { makeByokLiveResolver } from "../src/llm/byok/resolveLive.js";
import { LlmGateway, type MeterEvent } from "../src/llm/gateway.js";
import { PROD_POLICY, DEV_POLICY } from "../src/llm/router.js";
import type { ProviderAdapter, GenerateRequest } from "../src/llm/types.js";
import type { ByokKeyRow, ByokProvider } from "../src/llm/byok/byokRepo.js";

/* ── fixtures ─────────────────────────────────────────────────────────────── */

function keyRow(over: Partial<ByokKeyRow> = {}): ByokKeyRow {
  return {
    clientNorm: "nestle", clientName: "Nestle", provider: "gemini-aistudio",
    status: "active", secretName: "projects/p/secrets/s/versions/3", keyHint: "aaaa",
    verifiedAt: new Date().toISOString(), paidTierAttested: true,
    attestedByEmail: "admin@nestle.example", attestedAt: new Date().toISOString(),
    probe: null, ...over,
  };
}

/** A resolver whose row lookup and secret read are both under test control. */
function resolverWith(opts: {
  rows?: Partial<Record<string, Partial<ByokKeyRow>>>;   // `${clientName}:${provider}`
  keys?: Record<string, string>;                          // secretName -> key
  fetchImpl?: typeof fetch;
  onResolveError?: (i: { provider: ByokProvider; clientName: string; err: unknown }) => void;
}) {
  return makeByokResolver({
    secretStore: { projectId: "p" },
    fetchImpl: opts.fetchImpl,
    onResolveError: opts.onResolveError,
    lookup: async (_tenantId, clientName, provider) => {
      const over = opts.rows?.[`${clientName}:${provider}`];
      return over ? keyRow({ ...over, provider }) : null;
    },
    fetchKey: async (_o, secretName) => opts.keys?.[secretName] ?? null,
  });
}

/** Records the api key each request carried, so a bleed is visible. */
function keyRecordingFetch(seen: string[]): typeof fetch {
  return (async (_url: string, init: any) => {
    const h = init?.headers ?? {};
    seen.push(h["x-goog-api-key"] ?? h["x-api-key"] ?? "(none)");
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
      // Anthropic shape, so the same stub serves both adapters.
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 5, output_tokens: 7 },
      stop_reason: "end_turn",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function platform(name: string, opts: { freeTier?: boolean; fail?: string } = {}): ProviderAdapter {
  return {
    name, model: `${name}-model`, freeTier: opts.freeTier ?? false,
    isConfigured: () => true,
    async generate(_r: GenerateRequest) {
      if (opts.fail) throw new Error(opts.fail);
      return { text: `platform:${name}`, model: `${name}-model`,
               usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0.0001 } };
    },
  };
}

const REQ: GenerateRequest = { task: "hypotheses", messages: [{ role: "user", content: "x" }] };

/* ── the tables that decide which credential can serve what ───────────────── */

describe("BYOK adapter tables", () => {
  it("never lets a Vertex adapter be served by a client's API key", () => {
    // Vertex authenticates with the PLATFORM's service-account credentials.
    // Listing one here would run a client's work on the firm's account while
    // recording it as client-paid: the firm pays and the invoice says nobody
    // owes anything. Migration 031's CHECK says the same about the database.
    const all = Object.values(BYOK_ADAPTER_NAMES).flat();
    expect(all).not.toContain("gemini-vertex");
    expect(all).not.toContain("anthropic-vertex");
    expect(all).not.toContain("openai");
  });

  it("maps every BYOK adapter name back to its own provider", () => {
    for (const [provider, names] of Object.entries(BYOK_ADAPTER_NAMES)) {
      for (const n of names) expect(VENDOR_OF_ADAPTER[n]).toBe(provider);
    }
  });

  it("has no substitute for openai — nothing may silently stand in for it", () => {
    expect(VENDOR_OF_ADAPTER["openai"]).toBeUndefined();
  });
});

describe("applyByokToChain", () => {
  it("substitutes in the router's own order of preference", () => {
    // A strategy deck prefers Claude. A client with both keys must still get
    // Claude first — the credential decides WHO PAYS, never WHICH MODEL.
    const chain = ["anthropic-vertex", "gemini-vertex"];
    const out = applyByokToChain(chain, new Set(["gemini-aistudio", "gemini-aistudio-2", "anthropic-api"]));
    expect(out[0]).toBe("anthropic-api");

    /*
     * v5.34.62. This previously asserted that the client's GEMINI key came
     * before the firm's anthropic-vertex — which was true only because every
     * substitution was prepended to the front of the chain, the bug that let a
     * client's Anthropic key take over a Gemini-routed deck.
     *
     * The rule now is vendor order first, payer second WITHIN a vendor. So a
     * chain that wants Claude then Gemini yields the client's Claude, the
     * firm's Claude, then the client's Gemini: if the client's credential
     * fails, the fallback is the SAME MODEL on the firm's account rather than
     * a different model on the client's. The deliverable does not change shape
     * because a key expired; the firm absorbs that cost, which is the trade
     * this module makes everywhere else.
     */
    expect(out).toEqual([
      "anthropic-api", "anthropic-vertex",
      "gemini-aistudio", "gemini-aistudio-2", "gemini-vertex",
    ]);
  });

  it("a client's Anthropic key does NOT jump ahead of a Gemini-first chain", () => {
    /*
     * The production case, and the bug v5.34.62 fixed. PROD_POLICY routes every
     * task to Gemini first. A client who banks with Anthropic must not thereby
     * get their strategy deck written by Claude — a credential decides who
     * pays, never which model produces a client deliverable.
     */
    const out = applyByokToChain(["gemini-vertex", "anthropic-vertex"], new Set(["anthropic-api"]));
    expect(out).toEqual(["gemini-vertex", "anthropic-api", "anthropic-vertex"]);
  });

  it("a client's key still beats the firm's for the SAME vendor", () => {
    // The other half of the rule: within a vendor, the client's credential is
    // preferred — otherwise supplying a key would change nothing.
    const out = applyByokToChain(["gemini-vertex", "anthropic-vertex"],
                                 new Set(["gemini-aistudio", "gemini-aistudio-2", "anthropic-api"]));
    expect(out.indexOf("gemini-aistudio")).toBeLessThan(out.indexOf("gemini-vertex"));
    expect(out.indexOf("anthropic-api")).toBeLessThan(out.indexOf("anthropic-vertex"));
  });

  it("keeps the platform chain intact behind the client's keys", () => {
    const chain = ["gemini-vertex", "anthropic-vertex"];
    const out = applyByokToChain(chain, new Set(["gemini-aistudio", "gemini-aistudio-2"]));
    expect(out).toEqual([
      "gemini-aistudio", "gemini-aistudio-2", "gemini-vertex", "anthropic-vertex",
    ]);
  });

  it("does NOT re-route a task to a vendor its chain never mentions", () => {
    // A gemini-only task must not move onto Claude just because the client
    // happens to have an Anthropic key. That would change the model behind a
    // client deliverable based on who supplied a credential.
    const out = applyByokToChain(["gemini-vertex"], new Set(["anthropic-api"]));
    expect(out).toEqual(["gemini-vertex"]);
  });

  it("keeps the CHAIN's preference between two adapters on the same key", () => {
    /*
     * `transcribe` prefers gemini-aistudio-2 because audio understanding needs
     * a full Flash model and the lite primary rejects it. Substituting in the
     * table's order would give a client's own key a model that cannot do the
     * job — and it would read as the key being broken.
     */
    const chain = DEV_POLICY.taskChains.transcribe;
    expect(chain[0]).toBe("gemini-aistudio-2");
    const out = applyByokToChain(chain, new Set(["gemini-aistudio", "gemini-aistudio-2"]));
    expect(out[0]).toBe("gemini-aistudio-2");
    expect(out[1]).toBe("gemini-aistudio");
  });

  it("does not duplicate a name already in the chain", () => {
    const out = applyByokToChain(DEV_POLICY.defaultChain, new Set(["gemini-aistudio", "gemini-aistudio-2"]));
    expect(new Set(out).size).toBe(out.length);
    expect(out[0]).toBe("gemini-aistudio");
  });
});

describe("isCredentialRejection", () => {
  it("treats a refused key as refused", () => {
    expect(isCredentialRejection("gemini-aistudio 403: {PERMISSION_DENIED}")).toBe(true);
    expect(isCredentialRejection("anthropic-api 401: {authentication_error}")).toBe(true);
    expect(isCredentialRejection("gemini-aistudio 400: API_KEY_INVALID")).toBe(true);
  });

  it("NEVER demotes a good key for being rate-limited or for a vendor outage", () => {
    // The failure that matters: a client gets briefly popular, Google 429s,
    // and their key is marked failed — silently migrating their costs onto
    // the firm's bill until someone notices.
    expect(isCredentialRejection("gemini-aistudio 429: RESOURCE_EXHAUSTED")).toBe(false);
    expect(isCredentialRejection("gemini-aistudio 503: overloaded")).toBe(false);
    expect(isCredentialRejection("anthropic-api 529: overloaded_error")).toBe(false);
    expect(isCredentialRejection("gemini-aistudio 500: internal")).toBe(false);
  });
});

/* ── the resolver ─────────────────────────────────────────────────────────── */

describe("makeByokResolver", () => {
  it("resolves nothing for unattributed work", async () => {
    const r = await resolverWith({
      rows: { "Nestle:gemini-aistudio": {} }, keys: { "projects/p/secrets/s/versions/3": "K" },
    })({ tenantId: "t1" });
    expect(r.adapters.size).toBe(0);
  });

  it("builds adapters bound to the client's key", async () => {
    const seen: string[] = [];
    const r = await resolverWith({
      rows: { "Nestle:gemini-aistudio": {} },
      keys: { "projects/p/secrets/s/versions/3": "CLIENT-KEY" },
      fetchImpl: keyRecordingFetch(seen),
    })({ tenantId: "t1", clientName: "Nestle" });

    expect([...r.adapters.keys()].sort()).toEqual(["gemini-aistudio", "gemini-aistudio-2"]);
    await r.adapters.get("gemini-aistudio")!.generate(REQ);
    expect(seen).toEqual(["CLIENT-KEY"]);
    expect(r.backing.get("gemini-aistudio")!.keyHint).toBe("aaaa");
  });

  it("marks a client's attested key as paid tier, or production would refuse it", async () => {
    // blockFreeTier is on in production. An adapter built without paidTier
    // reports freeTier and gets skipped — the client supplies a key that is
    // never used and keeps paying the firm.
    const r = await resolverWith({
      rows: { "Nestle:gemini-aistudio": {} }, keys: { "projects/p/secrets/s/versions/3": "K" },
    })({ tenantId: "t1", clientName: "Nestle" });
    expect(r.adapters.get("gemini-aistudio")!.freeTier).toBe(false);
  });

  it("ignores a key that is not active", async () => {
    for (const status of ["pending", "disabled", "failed"] as const) {
      const r = await resolverWith({
        rows: { "Nestle:gemini-aistudio": { status } },
        keys: { "projects/p/secrets/s/versions/3": "K" },
      })({ tenantId: "t1", clientName: "Nestle" });
      expect(r.adapters.size, status).toBe(0);
    }
  });

  it("reports, and falls back, when the secret cannot be read", async () => {
    const errs: unknown[] = [];
    const r = await resolverWith({
      rows: { "Nestle:gemini-aistudio": {} },
      keys: {},                                   // secret gone
      onResolveError: (i) => errs.push(i),
    })({ tenantId: "t1", clientName: "Nestle" });
    expect(r.adapters.size).toBe(0);
    expect(errs).toHaveLength(1);
  });

  it("never throws when Secret Manager is down", async () => {
    const errs: unknown[] = [];
    const resolve = makeByokResolver({
      secretStore: { projectId: "p" },
      onResolveError: (i) => errs.push(i),
      lookup: async () => keyRow(),
      fetchKey: async () => { throw new Error("secretmanager unreachable"); },
    });
    const r = await resolve({ tenantId: "t1", clientName: "Nestle" });
    expect(r.adapters.size).toBe(0);
    expect(errs.length).toBeGreaterThan(0);
  });

  it("resolves the two providers independently — a client may bring one, not both", async () => {
    const r = await resolverWith({
      rows: { "Nestle:anthropic-api": { secretName: "projects/p/secrets/a/versions/1", keyHint: "bbbb" } },
      keys: { "projects/p/secrets/a/versions/1": "ANTHROPIC-KEY" },
    })({ tenantId: "t1", clientName: "Nestle" });
    expect([...r.adapters.keys()]).toEqual(["anthropic-api"]);
  });
});

/* ── the gateway: who pays, and whose key was used ────────────────────────── */

describe("LlmGateway with BYOK", () => {
  function gatewayFor(opts: {
    resolve?: ReturnType<typeof makeByokResolver>;
    adapters?: ProviderAdapter[];
    events?: MeterEvent[];
    rejected?: any[];
    blockFreeTier?: boolean;
  }) {
    return new LlmGateway({
      adapters: opts.adapters ?? [platform("gemini-vertex"), platform("anthropic-vertex")],
      policy: PROD_POLICY,
      meter: async (e) => { opts.events?.push(e); },
      blockFreeTier: opts.blockFreeTier ?? true,
      byok: opts.resolve,
      onByokRejected: (i) => { opts.rejected?.push(i); },
      transientRetries: 0,
    });
  }

  it("spends the client's key and records who paid", async () => {
    const events: MeterEvent[] = [];
    const seen: string[] = [];
    const gw = gatewayFor({
      events,
      resolve: resolverWith({
        rows: { "Nestle:gemini-aistudio": {} },
        keys: { "projects/p/secrets/s/versions/3": "NESTLE-KEY" },
        fetchImpl: keyRecordingFetch(seen),
      }),
    });
    const res = await gw.generate(
      { tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ);

    expect(res.provider).toBe("gemini-aistudio");
    expect(seen).toEqual(["NESTLE-KEY"]);
    expect(events.at(-1)!.payer).toBe("client_key");
    expect(events.at(-1)!.payerKeyHint).toBe("aaaa");
  });

  it("meters platform work as platform-paid", async () => {
    const events: MeterEvent[] = [];
    const gw = gatewayFor({ events, resolve: resolverWith({}) });
    await gw.generate({ tenantId: "t1", userId: "u1", module: "m", clientName: "Humana" }, REQ);
    expect(events.at(-1)!.payer).toBe("platform");
    expect(events.at(-1)!.payerKeyHint).toBeUndefined();
  });

  /*
   * THE BLEED TEST.
   *
   * Two clients, two keys, two calls interleaved inside one another. An
   * implementation that swaps the key on a shared adapter, or caches an
   * adapter per name, passes every other test in this file and fails this one:
   * whichever call resolved last serves both.
   */
  it("cannot serve one client's call with another client's key, under concurrency", async () => {
    const perCall: Record<string, string[]> = { Nestle: [], Humana: [] };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;

    const fetchImpl = (async (_url: string, init: any) => {
      const key = init.headers["x-goog-api-key"];
      // The FIRST call in flight parks inside the provider call, holding its
      // credential, while the second resolves and runs to completion.
      if (first) { first = false; await gate; }
      (key === "NESTLE-KEY" ? perCall.Nestle : perCall.Humana).push(key);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const resolve = makeByokResolver({
      secretStore: { projectId: "p" },
      fetchImpl,
      lookup: async (_t, clientName, provider) =>
        provider === "gemini-aistudio"
          ? keyRow({ clientName, clientNorm: clientName!.toLowerCase(),
                     secretName: `secret-${clientName}`, keyHint: clientName!.slice(0, 4) })
          : null,
      fetchKey: async (_o, secretName) =>
        secretName === "secret-Nestle" ? "NESTLE-KEY" : "HUMANA-KEY",
    });

    const events: MeterEvent[] = [];
    const gw = gatewayFor({ events, resolve });

    const a = gw.generate({ tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ);
    // Let the first call reach the provider and park there.
    await new Promise((r) => setTimeout(r, 10));
    const b = gw.generate({ tenantId: "t1", userId: "u2", module: "m", clientName: "Humana" }, REQ);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([a, b]);

    expect(perCall.Nestle).toEqual(["NESTLE-KEY"]);
    expect(perCall.Humana).toEqual(["HUMANA-KEY"]);
    const hints = events.filter((e) => e.ok).map((e) => `${e.clientName}:${e.payerKeyHint}`).sort();
    expect(hints).toEqual(["Humana:Huma", "Nestle:Nest"]);
  });

  it("does not leak a client's adapter into the next call", async () => {
    // Sequential version of the same fault: state left on the gateway after a
    // BYOK call must not serve the client who has no key.
    const events: MeterEvent[] = [];
    const seen: string[] = [];
    const resolve = makeByokResolver({
      secretStore: { projectId: "p" },
      fetchImpl: keyRecordingFetch(seen),
      lookup: async (_t, clientName, provider) =>
        clientName === "Nestle" && provider === "gemini-aistudio" ? keyRow() : null,
      fetchKey: async () => "NESTLE-KEY",
    });
    const gw = gatewayFor({ events, resolve });

    await gw.generate({ tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ);
    const second = await gw.generate(
      { tenantId: "t1", userId: "u1", module: "m", clientName: "Humana" }, REQ);

    expect(second.provider).toBe("gemini-vertex");        // the platform adapter
    expect(second.text).toBe("platform:gemini-vertex");
    expect(seen).toEqual(["NESTLE-KEY"]);                 // used once, for Nestle only
    expect(events.at(-1)!.payer).toBe("platform");
  });

  it("uses a client's paid key even where the platform's free-tier key is blocked", async () => {
    const events: MeterEvent[] = [];
    const seen: string[] = [];
    const gw = gatewayFor({
      events,
      blockFreeTier: true,
      adapters: [platform("gemini-aistudio", { freeTier: true }), platform("gemini-vertex")],
      resolve: resolverWith({
        rows: { "Nestle:gemini-aistudio": {} },
        keys: { "projects/p/secrets/s/versions/3": "NESTLE-KEY" },
        fetchImpl: keyRecordingFetch(seen),
      }),
    });
    const res = await gw.generate(
      { tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ);
    expect(res.provider).toBe("gemini-aistudio");
    expect(seen).toEqual(["NESTLE-KEY"]);
  });

  it("falls back to the platform when the client's key is refused, and reports it once", async () => {
    const events: MeterEvent[] = [];
    const rejected: any[] = [];
    const refusing = (async () => new Response(
      JSON.stringify({ error: { status: "PERMISSION_DENIED" } }), { status: 403 })) as unknown as typeof fetch;

    const gw = gatewayFor({
      events, rejected,
      resolve: resolverWith({
        rows: { "Nestle:gemini-aistudio": {} },
        keys: { "projects/p/secrets/s/versions/3": "DEAD-KEY" },
        fetchImpl: refusing,
      }),
    });
    const res = await gw.generate(
      { tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ);

    // The interview does not stop because a client's key lapsed.
    expect(res.provider).toBe("gemini-vertex");
    expect(res.text).toBe("platform:gemini-vertex");
    // Reported once, naming the client and the provider, so the Owner's screen
    // can stop saying "active".
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ clientName: "Nestle", provider: "gemini-aistudio" });
    // And the sibling adapter on the SAME key was not tried again.
    const attempted = events.map((e) => e.provider);
    expect(attempted.filter((p) => p === "gemini-aistudio-2")).toHaveLength(0);
    // The successful row is platform-paid; the failed one is not invoiced anyway.
    expect(events.at(-1)!.payer).toBe("platform");
  });

  it("does NOT demote a client's key over a rate limit", async () => {
    const events: MeterEvent[] = [];
    const rejected: any[] = [];
    const busy = (async () => new Response(
      JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429 })) as unknown as typeof fetch;

    const gw = gatewayFor({
      events, rejected,
      resolve: resolverWith({
        rows: { "Nestle:gemini-aistudio": {} },
        keys: { "projects/p/secrets/s/versions/3": "GOOD-KEY" },
        fetchImpl: busy,
      }),
    });
    const res = await gw.generate(
      { tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ);

    expect(res.provider).toBe("gemini-vertex");   // served, via fallback
    expect(rejected).toHaveLength(0);             // key untouched
  });

  it("serves the call on the platform when the resolver itself throws", async () => {
    const events: MeterEvent[] = [];
    const gw = gatewayFor({
      events,
      resolve: (async () => { throw new Error("resolver exploded"); }) as any,
    });
    const res = await gw.generate(
      { tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ);
    expect(res.provider).toBe("gemini-vertex");
    expect(events.at(-1)!.payer).toBe("platform");
  });

  it("behaves exactly as before when no resolver is configured", async () => {
    const events: MeterEvent[] = [];
    const gw = new LlmGateway({
      adapters: [platform("gemini-vertex")],
      policy: PROD_POLICY,
      meter: async (e) => { events.push(e); },
      blockFreeTier: true,
    });
    const res = await gw.generate(
      { tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ);
    expect(res.provider).toBe("gemini-vertex");
    expect(events.at(-1)!.payer).toBe("platform");
  });

  it("asks the resolver once per call, not once per adapter in the chain", async () => {
    const resolve = vi.fn(async () => ({ adapters: new Map(), backing: new Map() }));
    const gw = gatewayFor({ resolve: resolve as any });
    await gw.generate({ tenantId: "t1", userId: "u1", module: "m", clientName: "Nestle" }, REQ);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

/* ── the live-voice resolver ──────────────────────────────────────────────── */

describe("makeByokLiveResolver", () => {
  function liveResolver(opts: {
    row?: ByokKeyRow | null;
    key?: string | null;
    onResolveError?: (i: { clientName: string; err: unknown }) => void;
    fetchKey?: () => Promise<string | null>;
  }) {
    return makeByokLiveResolver({
      secretStore: { projectId: "p" },
      onResolveError: opts.onResolveError,
      lookup: async () => opts.row ?? null,
      fetchKey: opts.fetchKey ?? (async () => opts.key ?? null),
    });
  }

  it("returns nothing for unattributed work", async () => {
    expect(await liveResolver({ row: keyRow(), key: "K" })("t1", undefined)).toBeNull();
  });

  it("binds a live session to the client's key, marked as a paid account", async () => {
    const b = await liveResolver({ row: keyRow(), key: "CLIENT-LIVE" })("t1", "Nestle");
    expect(b).not.toBeNull();
    // freeTier false is what lets it through the production lockdown in
    // routes/voice.ts — see the attestation note in resolveLive.ts.
    expect(b!.live.freeTier).toBe(false);
    expect(b!.keyHint).toBe("aaaa");
    expect(b!.clientName).toBe("Nestle");
  });

  it("only ever looks at the GOOGLE key — Anthropic cannot serve a voice session", async () => {
    const seen: string[] = [];
    const resolve = makeByokLiveResolver({
      secretStore: { projectId: "p" },
      lookup: async (_t, _c, provider) => { seen.push(provider); return null; },
      fetchKey: async () => null,
    });
    await resolve("t1", "Nestle");
    expect(seen).toEqual(["gemini-aistudio"]);
  });

  it("falls back rather than failing when the key is inactive or unreadable", async () => {
    expect(await liveResolver({ row: keyRow({ status: "failed" }), key: "K" })("t1", "Nestle")).toBeNull();
    const errs: unknown[] = [];
    expect(await liveResolver({ row: keyRow(), key: null, onResolveError: (i) => errs.push(i) })("t1", "Nestle"))
      .toBeNull();
    expect(errs).toHaveLength(1);
  });

  it("never throws when Secret Manager is unreachable", async () => {
    const errs: unknown[] = [];
    const r = await liveResolver({
      row: keyRow(),
      fetchKey: async () => { throw new Error("secretmanager unreachable"); },
      onResolveError: (i) => errs.push(i),
    })("t1", "Nestle");
    expect(r).toBeNull();
    expect(errs).toHaveLength(1);
  });
});
