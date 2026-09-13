/**
 * v5.34.18 — the DEFAULT live model must be one the Live socket accepts.
 *
 * The old default, "gemini-live-2.5-flash-preview", passed every check we make:
 * it minted a token, the grant looked healthy, the browser opened a socket. It
 * was then rejected by Google on every endpoint variant —
 *
 *   1007 — token-based requests cannot use project-scoped features such as
 *          tuned models
 *
 * — because a name that does not resolve as a public model falls through to a
 * project-scoped lookup, which an ephemeral token cannot perform. The client
 * fell back to text + TTS, so the interview still ran, in a robotic voice, with
 * nothing logged as an error.
 *
 * The correct value existed only as a hand-set Cloud Run env var, documented in
 * HANDOFF_2026-09-08.md as something a fresh deploy does not restore. These
 * tests are what makes it repo state rather than tribal knowledge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  makeLiveSession, DEFAULT_LIVE_MODEL, LIVE_CAPABLE_MODELS,
} from "../src/llm/liveSession.js";
import { estimateCost } from "../src/llm/types.js";

const bare = (m: string) => (m.startsWith("models/") ? m.slice(7) : m);

describe("default live model (v5.34.18)", () => {
  it("defaults to a model the account exposes for bidiGenerateContent", () => {
    expect(LIVE_CAPABLE_MODELS).toContain(bare(DEFAULT_LIVE_MODEL));
  });

  it("is NOT the stale half-cascade preview that fails with close 1007", () => {
    expect(bare(DEFAULT_LIVE_MODEL)).not.toBe("gemini-live-2.5-flash-preview");
    expect(LIVE_CAPABLE_MODELS).not.toContain("gemini-live-2.5-flash-preview");
  });

  it("uses the default when GEMINI_LIVE_MODEL is unset — the local/fresh-deploy case", () => {
    const prev = process.env.GEMINI_LIVE_MODEL;
    delete process.env.GEMINI_LIVE_MODEL;
    try {
      expect(makeLiveSession({ apiKey: "k" }).model).toBe(DEFAULT_LIVE_MODEL);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_LIVE_MODEL;
      else process.env.GEMINI_LIVE_MODEL = prev;
    }
  });

  it("still lets the env var pin a newer model", () => {
    const prev = process.env.GEMINI_LIVE_MODEL;
    process.env.GEMINI_LIVE_MODEL = "models/gemini-3.1-flash-live-preview";
    try {
      expect(makeLiveSession({ apiKey: "k" }).model).toBe("models/gemini-3.1-flash-live-preview");
    } finally {
      if (prev === undefined) delete process.env.GEMINI_LIVE_MODEL;
      else process.env.GEMINI_LIVE_MODEL = prev;
    }
  });

  /** Metering is keyed on the bare id; a default that prices $0 undercounts. */
  it("is priced, in whichever prefix form it is written", () => {
    expect(estimateCost(DEFAULT_LIVE_MODEL, 1_000_000, 1_000_000)).toBeGreaterThan(0);
    expect(estimateCost(DEFAULT_LIVE_MODEL, 1_000, 2_000))
      .toBe(estimateCost(bare(DEFAULT_LIVE_MODEL), 1_000, 2_000));
  });

  it("every known-good model is priced", () => {
    for (const m of LIVE_CAPABLE_MODELS) {
      expect(estimateCost(m, 1_000_000, 1_000_000), `${m} unpriced`).toBeGreaterThan(0);
    }
  });
});

describe("unknown live model is announced at boot, not at the first interview", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it("warns for a model the Live socket will refuse", () => {
    makeLiveSession({ apiKey: "k", model: "gemini-live-2.5-flash-preview" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/not a known bidiGenerateContent model/);
  });

  it("stays quiet for a known-good model, in either prefix form", () => {
    makeLiveSession({ apiKey: "k", model: DEFAULT_LIVE_MODEL });
    makeLiveSession({ apiKey: "k", model: "gemini-2.5-flash-native-audio-latest" });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("paid-tier flag is read under the name the deploy script sets", () => {
  const keys = ["GEMINI_PAID", "GEMINI_PAID_TIER"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {}; for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
    }
  });

  /**
   * deploy.sh forwarded GEMINI_PAID_TIER; config.ts read GEMINI_PAID. An
   * operator following the deploy path set a variable nothing consumed, so a
   * billed key read as free tier — and free tier is hard-blocked in production,
   * which answers 503 live_free_tier_blocked and drops the interview to TTS.
   */
  it("accepts either spelling", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().geminiPaidTier).toBe(false);
    process.env.GEMINI_PAID_TIER = "1";
    expect(loadConfig().geminiPaidTier).toBe(true);
    delete process.env.GEMINI_PAID_TIER;
    process.env.GEMINI_PAID = "1";
    expect(loadConfig().geminiPaidTier).toBe(true);
  });
});
