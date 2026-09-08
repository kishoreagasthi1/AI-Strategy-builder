/**
 * Realtime voice session budgeting (v5.32.32).
 *
 * These tests exist because a live session is the first thing in this product
 * that spends money OUTSIDE the request path. Every other AI call is "check
 * the cap, do one bounded thing, meter it". A live session is granted once and
 * then bills continuously, on a connection this server cannot see — so the
 * only real controls are the bound baked into the grant and the reservation
 * taken before the grant exists.
 *
 * The property that matters most is the last one: a hostile client must not be
 * able to talk its way into MORE budget by lying at reconciliation time.
 */
import { describe, it, expect, vi } from "vitest";
import {
  reserveTokensFor, reserveSession, reconcileSession,
  makeLiveSession, AUDIO_TOKENS_PER_SECOND, MAX_SESSION_SECONDS,
  DEFAULT_SESSION_SECONDS, TASK_HOLD, TASK_HOLD_RELEASE, TASK_ACTUAL, NON_BILLABLE_TASKS,
} from "../src/llm/liveSession.js";
import { PRICE_TABLE, estimateCost } from "../src/llm/types.js";

const base = {
  tenantId: "t1", userId: "u1", module: "interview_agent",
  model: "gemini-live-2.5-flash-preview", sessionId: "s1",
};

describe("live session pricing", () => {
  it("prices every live and current-TTS model — an unlisted one meters at $0.00", () => {
    for (const m of [
      "gemini-live-2.5-flash-preview", "gemini-live-2.5-flash",
      "gemini-2.5-flash-tts", "gemini-2.5-pro-tts",
    ]) {
      expect(PRICE_TABLE[m], `${m} is unpriced — a billed session would invoice as free`).toBeDefined();
      expect(estimateCost(m, 1_000_000, 1_000_000)).toBeGreaterThan(0);
    }
  });

  it("prices audio output far above input, which is what makes duration the cost driver", () => {
    const p = PRICE_TABLE["gemini-live-2.5-flash-preview"];
    expect(p.out).toBeGreaterThan(p.in * 5);
  });

  it("a full-length session costs a sane amount — a guard against an order-of-magnitude typo", () => {
    const { tokensIn, tokensOut } = reserveTokensFor(MAX_SESSION_SECONDS);
    const worstCase = estimateCost(base.model, tokensIn, tokensOut);
    // Worst case charges BOTH directions for the whole session, which no real
    // interview reaches. If this ever leaves the range, someone has moved a
    // decimal point in PRICE_TABLE or in the tokens-per-second constant.
    expect(worstCase).toBeGreaterThan(0.5);
    expect(worstCase).toBeLessThan(10);
  });
});

describe("reservation arithmetic", () => {
  it("reserves both directions for the full session — a reservation must be an upper bound", () => {
    const r = reserveTokensFor(60);
    expect(r.tokensIn).toBe(60 * AUDIO_TOKENS_PER_SECOND);
    expect(r.tokensOut).toBe(60 * AUDIO_TOKENS_PER_SECOND);
  });

  it("commits the worst case up front, so concurrent sessions cannot each see an unspent budget", async () => {
    const meter = vi.fn().mockResolvedValue(undefined);
    await reserveSession(meter, { ...base, maxSeconds: 600 });
    expect(meter).toHaveBeenCalledOnce();
    const row = meter.mock.calls[0][0];
    expect(row.task).toBe(TASK_HOLD);
    expect(row.tokensIn).toBe(600 * AUDIO_TOKENS_PER_SECOND);
    expect(row.tokensOut).toBe(600 * AUDIO_TOKENS_PER_SECOND);
    expect(row.costEstUsd).toBeGreaterThan(0);
  });
});

describe("reconciliation — a hold is not a bill", () => {
  it("releases the ENTIRE hold and records actual usage as a separate row", async () => {
    const meter = vi.fn().mockResolvedValue(undefined);
    await reconcileSession(meter, {
      ...base, maxSeconds: 600,
      actualTokensIn: 1_000, actualTokensOut: 2_000, actualSeconds: 120,
    });
    const full = reserveTokensFor(600);
    const [release, actual] = meter.mock.calls.map((c) => c[0]);

    // v5.32.44: this used to write a PARTIAL refund, leaving the unused portion
    // of a worst-case estimate sitting in usage_events. Billing sums that table,
    // so a twenty-second conversation invoiced the client $1.42.
    expect(release.task).toBe(TASK_HOLD_RELEASE);
    expect(release.tokensIn).toBe(-full.tokensIn);
    expect(release.tokensOut).toBe(-full.tokensOut);

    expect(actual.task).toBe(TASK_ACTUAL);
    expect(actual.tokensIn).toBe(1_000);
    expect(actual.tokensOut).toBe(2_000);
  });

  it("nets to exactly the real usage across hold, release and actual", async () => {
    const meter = vi.fn().mockResolvedValue(undefined);
    await reserveSession(meter, { ...base, maxSeconds: 600 });
    await reconcileSession(meter, {
      ...base, maxSeconds: 600,
      actualTokensIn: 5_000, actualTokensOut: 9_000, actualSeconds: 300,
    });
    const net = meter.mock.calls.reduce(
      (a, [r]) => ({ i: a.i + r.tokensIn, o: a.o + r.tokensOut }), { i: 0, o: 0 });
    expect(net.i).toBe(5_000);
    expect(net.o).toBe(9_000);
  });

  it("marks holds and releases non-billable, and actual usage billable", () => {
    // The invoice is built by summing usage_events. If a hold is billable, the
    // client pays for a pre-authorisation they never consumed.
    expect(NON_BILLABLE_TASKS).toContain(TASK_HOLD);
    expect(NON_BILLABLE_TASKS).toContain(TASK_HOLD_RELEASE);
    expect(NON_BILLABLE_TASKS).not.toContain(TASK_ACTUAL);
  });

  it("releases the hold even when the session reported no usage at all", async () => {
    const meter = vi.fn().mockResolvedValue(undefined);
    await reconcileSession(meter, {
      ...base, maxSeconds: 600, actualTokensIn: 0, actualTokensOut: 0, actualSeconds: 0,
    });
    // A crashed session must not keep its hold — that budget belongs to the firm.
    expect(meter).toHaveBeenCalledTimes(1);
    expect(meter.mock.calls[0][0].task).toBe(TASK_HOLD_RELEASE);
  });

  it("a client over-reporting usage cannot bill beyond the hold", async () => {
    const meter = vi.fn().mockResolvedValue(undefined);
    await reconcileSession(meter, {
      ...base, maxSeconds: 600,
      actualTokensIn: 999_999_999, actualTokensOut: 999_999_999, actualSeconds: 600,
    });
    const full = reserveTokensFor(600);
    const actual = meter.mock.calls.map((c) => c[0]).find((r) => r.task === TASK_ACTUAL);
    expect(actual.tokensIn).toBe(full.tokensIn);
    expect(actual.tokensOut).toBe(full.tokensOut);
  });

  it("a negative report cannot manufacture a credit", async () => {
    const meter = vi.fn().mockResolvedValue(undefined);
    await reconcileSession(meter, {
      ...base, maxSeconds: 600,
      actualTokensIn: -1_000_000, actualTokensOut: -1_000_000, actualSeconds: 0,
    });
    const actual = meter.mock.calls.map((c) => c[0]).find((r) => r.task === TASK_ACTUAL);
    expect(actual).toBeUndefined();   // clamped to zero → no usage row at all
  });
});

describe("the size of the hold", () => {
  it("defaults to well under the maximum session", () => {
    // A 45-minute default holds ~$1.42 the moment a session is granted, which
    // is what a twenty-second test conversation was charged.
    expect(DEFAULT_SESSION_SECONDS).toBeLessThan(MAX_SESSION_SECONDS);
    const d = reserveTokensFor(DEFAULT_SESSION_SECONDS);
    const m = reserveTokensFor(MAX_SESSION_SECONDS);
    expect(d.tokensIn + d.tokensOut).toBeLessThanOrEqual((m.tokensIn + m.tokensOut) / 2);
  });
});

describe("the minted grant", () => {
  it("pins the model and modality into the token, and is single-use and time-bounded", async () => {
    let body: any;
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ name: "eph-token-123" }) } as any;
    });
    const live = makeLiveSession({ apiKey: "k", fetchImpl: fetchImpl as any, paidTier: true });
    const grant = await live.mint("sess-1", 900);

    expect(grant.token).toBe("eph-token-123");
    // Single use: a leaked token cannot be fanned out into many sessions.
    expect(body.uses).toBe(1);
    // Pinned model: a stolen token cannot be redirected at a model we did not
    // price, which would silently invalidate the reservation arithmetic.
    // v5.32.53: the shape is no longer a guess. @google/genai 2.16.0 writes
    // constraints to the wire field `bidiGenerateContentSetup`
    // (liveConnectConstraintsToMldev) and then FLATTENS any {setup:{...}}
    // wrapper away (convertBidiSetupToTokenSetup), so the body carries a bare
    // BidiGenerateContentSetup: model + generationConfig + systemInstruction.
    // The previous `{ model, config: {...} }` had no `config` field on that
    // message at all, which is why every mint fell through to an UNPINNED
    // token and the whole feature ran on its own fallback path.
    const raw = body.bidiGenerateContentSetup;
    expect(raw, "no constraint block sent at all").toBeDefined();
    const c = raw.setup ?? raw;
    expect(c.model).toBe(live.model);
    expect(c.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(c.config, "`config` is not a field of BidiGenerateContentSetup").toBeUndefined();
    // Bounded: a start window AND a hard end.
    expect(new Date(body.newSessionExpireTime).getTime()).toBeLessThan(new Date(body.expireTime).getTime());
    expect(new Date(grant.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(900_000 + 5_000);
  });

  it("falls back to an unpinned token when the API rejects the constraint field", async () => {
    // Verified against the live API: the first candidate came back
    //   400 Unknown name "liveConnectConstraints" at 'auth_token'
    // A hard failure there would take realtime voice down entirely, so mint()
    // degrades to a plain token and reports pinned:false so the caller knows
    // it must send the persona itself.
    const bodies: any[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      call++;
      if (call < 3) {
        return { ok: false, status: 400, text: async () => 'Unknown name "x" at \'auth_token\': Cannot find field.' } as any;
      }
      return { ok: true, json: async () => ({ name: "eph" }) } as any;
    });
    const live = makeLiveSession({ apiKey: "k", fetchImpl: fetchImpl as any });
    const grant = await live.mint("s", 600, "You are an interviewer.");
    expect(grant.token).toBe("eph");
    expect(grant.pinned).toBe(false);
    expect(bodies[bodies.length - 1].uses).toBe(1);       // still single-use
    expect(bodies[bodies.length - 1].expireTime).toBeDefined();  // still bounded
  });

  it("does NOT retry on a real error such as a bad key", async () => {
    // Retrying a 403 would mask the actual problem behind two more doomed
    // attempts and a misleading final error.
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return { ok: false, status: 403, text: async () => "API key not valid" } as any;
    });
    await expect(makeLiveSession({ apiKey: "bad", fetchImpl: fetchImpl as any }).mint("s", 60))
      .rejects.toThrow(/403/);
    expect(calls).toBe(1);
  });

  it("sends the key as a header, not a query parameter", async () => {
    let url = "", init: any;
    const fetchImpl = vi.fn(async (u: any, i: any) => {
      url = String(u); init = i;
      return { ok: true, json: async () => ({ name: "t" }) } as any;
    });
    await makeLiveSession({ apiKey: "AQ.secret", fetchImpl: fetchImpl as any }).mint("s", 60);
    // Same reason as tts.ts and the AI Studio adapter: newer AQ.-prefixed keys
    // 401 on ?key=, and a key in a URL lands in every access log in the path.
    expect(url).not.toContain("AQ.secret");
    expect(init.headers["x-goog-api-key"]).toBe("AQ.secret");
  });

  it("reports free tier so the production lockdown can refuse it", () => {
    expect(makeLiveSession({ apiKey: "k" }).freeTier).toBe(true);
    expect(makeLiveSession({ apiKey: "k", paidTier: true }).freeTier).toBe(false);
  });
});

describe("model id prefix handling (v5.32.41)", () => {
  it("prices a fully-qualified model name", () => {
    // GEMINI_LIVE_MODEL is set to "models/gemini-..." because that is the form
    // the API's own model list returns. Keyed lookup must tolerate it or every
    // live session meters $0.00.
    expect(estimateCost("models/gemini-2.5-flash-native-audio-latest", 1_000_000, 1_000_000))
      .toBeGreaterThan(0);
    expect(estimateCost("models/gemini-2.5-flash-native-audio-latest", 1_000, 2_000))
      .toBe(estimateCost("gemini-2.5-flash-native-audio-latest", 1_000, 2_000));
  });

  it("prices every model this account exposes for bidiGenerateContent", () => {
    // Enumerated from the live account, not guessed.
    for (const m of [
      "gemini-2.5-flash-native-audio-latest",
      "gemini-2.5-flash-native-audio-preview-09-2025",
      "gemini-2.5-flash-native-audio-preview-12-2025",
      "gemini-3.1-flash-live-preview",
    ]) {
      expect(estimateCost(m, 1_000_000, 1_000_000), `${m} unpriced`).toBeGreaterThan(0);
    }
  });
});

describe("concurrency guard is a nuisance guard, not the budget (v5.32.42)", () => {
  it("counts open sessions over a window far shorter than a full session", async () => {
    const { OPEN_SESSION_WINDOW_SECONDS, MAX_CONCURRENT_SESSIONS_PER_USER } =
      await import("../src/routes/voice.js");
    // Using the full 45-minute session length here meant any reservation that
    // failed to refund — a crashed tab, or a close call that 401s because the
    // browser session expired — locked the user out for 45 minutes. Observed in
    // production during testing: the user was blocked from their own product.
    expect(OPEN_SESSION_WINDOW_SECONDS).toBeLessThan(MAX_SESSION_SECONDS);
    expect(MAX_CONCURRENT_SESSIONS_PER_USER).toBeGreaterThanOrEqual(2);
  });
});

describe("voice selection (v5.32.47)", () => {
  it("accepts a voice from the catalog and refuses anything else", async () => {
    const { resolveVoice, VOICES } = await import("../src/llm/liveSession.js");
    expect(resolveVoice("Charon", "Aoede")).toBe("Charon");
    // The voice arrives from the browser and is pinned into the token
    // constraint. An unvalidated string would be forwarded to Google verbatim.
    expect(resolveVoice("../../etc/passwd", "Aoede")).toBe("Aoede");
    expect(resolveVoice("", "Aoede")).toBe("Aoede");
    expect(resolveVoice(undefined, "Aoede")).toBe("Aoede");
    expect(VOICES.some((v) => v.presents === "female")).toBe(true);
    expect(VOICES.some((v) => v.presents === "male")).toBe(true);
  });

  it("mints with the requested voice and reports it back", async () => {
    let body: any;
    const fetchImpl = vi.fn(async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ name: "t" }) } as any;
    });
    const live = makeLiveSession({ apiKey: "k", fetchImpl: fetchImpl as any });
    const grant = await live.mint("s", 300, "persona", "Orus");
    expect(grant.voice).toBe("Orus");
    const raw = body.bidiGenerateContentSetup;
    const c = raw.setup ?? raw;
    // Under generationConfig, exactly as in the browser's setup frame. Google's
    // SDK nests it the same way in both places; this code used to nest it
    // differently in both places, and both were wrong.
    expect(c.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Orus");
    expect(c.speechConfig, "speechConfig must not sit beside generationConfig").toBeUndefined();
  });
});
