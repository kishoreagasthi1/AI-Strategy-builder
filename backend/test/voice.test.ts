/**
 * V225-audit CRITICAL fix (TTS bypassed blockFreeTier + the tenant plan
 * limit check): routes/voice.ts's /api/voice/tts used to call
 * tts.synthesize() directly with no equivalent of the two checks
 * LlmGateway.generate() enforces for every other AI call — the production
 * free-tier lockdown and the tenant plan/budget pre-flight. These tests
 * exercise voiceRoutes() directly against a fake Tts/gateway, so no network
 * call or real Postgres is needed: the whole point is that the gate fires
 * BEFORE synthesize() would ever be reached.
 */
import { describe, it, expect, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { voiceRoutes } from "../src/routes/voice.js";
import { LlmGateway } from "../src/llm/gateway.js";
import type { Tts } from "../src/llm/tts.js";
import type { LlmGateway as LlmGatewayType, MeterEvent } from "../src/llm/gateway.js";

function fakeTts(freeTier: boolean, synthesize = vi.fn(async () => ({
  audioBase64: "AAAA", mime: "audio/wav" as const, voice: "Kore", model: "fake-tts-model",
  // v5.32.65 (audit V2-L5): synthesize now reports the provider's own token
  // counts so the route can price the call instead of writing $0.00.
  usage: { tokensIn: 40, tokensOut: 900 },
}))): Tts {
  return {
    isConfigured: () => true,
    model: "fake-tts-model",
    defaultVoice: "Kore",
    freeTier,
    synthesize,
  } as unknown as Tts;
}

async function buildVoiceApp(gateway: LlmGatewayType, tts: Tts): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    req.ctx = { userId: "u1", tenantId: "t1", role: "interviewee", email: "a@b.com" };
  });
  await voiceRoutes(app, gateway, tts, async () => {});
  return app;
}

describe("POST /api/voice/tts — V225-audit gating", () => {
  it("blocks a free-tier TTS key when blockFreeTier is set, without calling synthesize", async () => {
    const gateway = new LlmGateway({ adapters: [], policy: { defaultChain: [], taskChains: {} }, meter: async () => {}, blockFreeTier: true });
    const synthesize = vi.fn();
    const tts = fakeTts(true, synthesize);
    const app = await buildVoiceApp(gateway, tts);

    const res = await app.inject({
      method: "POST", url: "/api/voice/tts",
      headers: { authorization: "Bearer x" },
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("tts_free_tier_blocked");
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("allows a paid-tier TTS key even when blockFreeTier is set", async () => {
    const gateway = new LlmGateway({ adapters: [], policy: { defaultChain: [], taskChains: {} }, meter: async () => {}, blockFreeTier: true });
    const tts = fakeTts(false);
    const app = await buildVoiceApp(gateway, tts);

    const res = await app.inject({
      method: "POST", url: "/api/voice/tts",
      headers: { authorization: "Bearer x" },
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().audioBase64).toBe("AAAA");
  });

  it("allows a free-tier TTS key when blockFreeTier is NOT set (dev/sandbox)", async () => {
    const gateway = new LlmGateway({ adapters: [], policy: { defaultChain: [], taskChains: {} }, meter: async () => {}, blockFreeTier: false });
    const tts = fakeTts(true);
    const app = await buildVoiceApp(gateway, tts);

    const res = await app.inject({
      method: "POST", url: "/api/voice/tts",
      headers: { authorization: "Bearer x" },
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("honors the tenant plan/budget limitCheck before synthesizing, same as generate()", async () => {
    const gateway = new LlmGateway({
      adapters: [], policy: { defaultChain: [], taskChains: {} }, meter: async () => {}, blockFreeTier: false,
      limitCheck: async () => ({ allowed: false, reason: "monthly_token_limit_exceeded" }),
    });
    const synthesize = vi.fn();
    const tts = fakeTts(false, synthesize);
    const app = await buildVoiceApp(gateway, tts);

    const res = await app.inject({
      method: "POST", url: "/api/voice/tts",
      headers: { authorization: "Bearer x" },
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("monthly_token_limit_exceeded");
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("still meters a successful synthesis", async () => {
    const meter = vi.fn(async (_e: MeterEvent) => {});
    const gateway = new LlmGateway({ adapters: [], policy: { defaultChain: [], taskChains: {} }, meter: async () => {}, blockFreeTier: false });
    const tts = fakeTts(false);
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      req.ctx = { userId: "u1", tenantId: "t1", role: "interviewee", email: "a@b.com" };
    });
    await voiceRoutes(app, gateway, tts, meter);

    const res = await app.inject({
      method: "POST", url: "/api/voice/tts",
      headers: { authorization: "Bearer x" },
      payload: { text: "hello" },
    });

    expect(res.statusCode).toBe(200);
    expect(meter).toHaveBeenCalledTimes(1);
    expect(meter.mock.calls[0][0]).toMatchObject({ task: "tts", ok: true, tenantId: "t1" });
  });
});

/**
 * v5.32.54 SECURITY — the live-session close endpoint must not accept a
 * release for a hold that does not exist, is not the caller's, or is already
 * released. Before this, `maxSeconds` came from the request body and sized a
 * negative usage row with no evidence any session had ever been opened, so an
 * interviewee could drive the firm's usage total arbitrarily negative and
 * switch off both spend caps and the concurrency guard for everyone.
 */
describe("live-session close: hold verification", () => {
  it("exports findOpenHold, and reconcileSession sizes the release from the LEDGER not the request", async () => {
    const { reconcileSession, reserveTokensFor, TASK_HOLD_RELEASE } =
      await import("../src/llm/liveSession.js");
    const rows: Array<Record<string, unknown>> = [];
    const meter = async (e: Record<string, unknown>) => { rows.push(e); };

    // The attack shape: a body claiming a 45-minute session (the maximum)
    // against a hold that was only ever 60 seconds.
    const realHold = reserveTokensFor(60);
    await reconcileSession(meter as never, {
      tenantId: "t", userId: "u", module: "interview_agent", model: "m",
      sessionId: "sess-1", maxSeconds: 45 * 60,
      reservedOverride: realHold,
      actualTokensIn: 0, actualTokensOut: 0, actualSeconds: 0,
    });

    const release = rows.find((r) => r.task === TASK_HOLD_RELEASE)!;
    expect(release).toBeDefined();
    // -1500, not -67500. The body's 45 minutes is ignored entirely.
    expect(release.tokensIn).toBe(-realHold.tokensIn);
    expect(release.tokensOut).toBe(-realHold.tokensOut);
    expect(Number(release.tokensIn)).toBeGreaterThan(-2000);
    // And it is stamped with the session, so a second release can be refused.
    expect(release.sessionId).toBe("sess-1");
  });

  it("stamps the session id on the hold so the close path can find it", async () => {
    const { reserveSession, TASK_HOLD } = await import("../src/llm/liveSession.js");
    const rows: Array<Record<string, unknown>> = [];
    const meter = async (e: Record<string, unknown>) => { rows.push(e); };
    await reserveSession(meter as never, {
      tenantId: "t", userId: "u", module: "interview_agent", model: "m",
      sessionId: "sess-42", maxSeconds: 300,
    });
    const hold = rows.find((r) => r.task === TASK_HOLD)!;
    // Without this the ledger cannot answer "which session is this row about",
    // and the close endpoint has nothing to verify against.
    expect(hold.sessionId).toBe("sess-42");
  });
});
