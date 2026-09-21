/**
 * maxTokens means "how long an answer"; maxOutputTokens means "answer plus
 * thinking". The adapter is where those two meet. (v5.34.103)
 *
 * ── Measured, against production, 2026-09-14 ────────────────────────────────
 *
 * task interview_score, gemini-3.6-flash via gemini-vertex, same prompt twice:
 *
 *   maxTokens  900 -> tokensOut  35, finishReason "length"
 *                     text cut at {"scores":{"D1":2,"D2":0,"D3":
 *   maxTokens 4000 -> tokensOut 159, finishReason "stop", parses, D1=2 D6=1
 *
 * Thirty-five visible tokens out of a nine-hundred budget. The reasoning is
 * spent first and it is spent from the same pot, so a caller asking for a
 * short answer was also asking the model to think inside that short budget.
 *
 * Measured from a signed-in browser against production. NOT from the voice
 * harness: that rig stubs /api/llm/generate and reports scoring as NOT
 * EXERCISED, and its earlier "0 succeeded, 3 failed" was its own pre-v5.34.100
 * 404 being counted by the page. Two different faults, one shape of number.
 *
 * Only ONE caller was ever exposed. vyne-client.js floors every budget routed
 * through vyneLLM at 8192 (16384 for synthesis) — v5.32.23, same reasoning —
 * so the 400s and 900s at the module call sites are inert. The scoring pass in
 * vyne-live-interview.js is the single raw /api/llm/generate caller in the
 * product, and it sent its 900 through unfloored.
 *
 * So this is a backstop for the next raw caller, not a sweeping repair. The
 * tests below pin the behaviour either way.
 *
 * NOTE for whoever tunes this next: the reserve is added to the CEILING, so a
 * caller's maxTokens no longer bounds how long an answer can get. If a
 * particular call needs a hard length limit, that limit belongs in its prompt,
 * not in maxTokens.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildGeminiBody, geminiThinkingReserve } from "../src/llm/adapters/geminiShared.js";
import type { GenerateRequest } from "../src/llm/types.js";

const req = (maxTokens?: number): GenerateRequest => ({
  task: "interview_score",
  messages: [{ role: "user", content: "score this" }],
  maxTokens,
});

const cfg = (r: GenerateRequest) =>
  (buildGeminiBody(r).generationConfig as { maxOutputTokens: number });

describe("v5.34.103 — the thinking reserve", () => {
  const saved = process.env.GEMINI_THINKING_RESERVE;
  beforeEach(() => { delete process.env.GEMINI_THINKING_RESERVE; });
  afterEach(() => {
    if (saved === undefined) delete process.env.GEMINI_THINKING_RESERVE;
    else process.env.GEMINI_THINKING_RESERVE = saved;
  });

  it("gives the 900-token scoring call room to think", () => {
    /*
     * The exact failure, as a number. 900 went out as 900 and came back
     * truncated; it must now go out as considerably more.
     */
    expect(cfg(req(900)).maxOutputTokens).toBeGreaterThanOrEqual(4000);
  });

  it("protects the tightest call site in the product", () => {
    // pre_engagement.html generateNewEventHypotheses / summariseFieldIfLong.
    expect(cfg(req(400)).maxOutputTokens).toBeGreaterThanOrEqual(4000);
  });

  it("adds the reserve on top of the answer budget, not instead of it", () => {
    /*
     * A large caller must not be CAPPED to the reserve. synthesis.html asks
     * for 6500 and needs all of it for the answer alone; handing it 4000 would
     * turn a truncation bug into a worse one.
     */
    const big = cfg(req(6500)).maxOutputTokens;
    const small = cfg(req(400)).maxOutputTokens;
    expect(big).toBeGreaterThan(6500);
    expect(big - small).toBe(6100);
  });

  it("still reserves for a caller that sets no budget at all", () => {
    expect(cfg(req(undefined)).maxOutputTokens).toBeGreaterThan(4096);
  });

  it("never exceeds what Gemini will accept", () => {
    /* An out-of-range maxOutputTokens is rejected outright — the reserve must
     * not turn a working large call into a 400 from the provider. */
    expect(cfg(req(64_000)).maxOutputTokens).toBeLessThanOrEqual(64_000);
  });

  it("is overridable, including down to nothing", () => {
    process.env.GEMINI_THINKING_RESERVE = "0";
    expect(cfg(req(900)).maxOutputTokens).toBe(900);
    process.env.GEMINI_THINKING_RESERVE = "9000";
    expect(cfg(req(900)).maxOutputTokens).toBe(9900);
  });

  it("ignores a nonsense override rather than sending NaN to the provider", () => {
    for (const bad of ["lots", "-1", "3.5", " "]) {
      process.env.GEMINI_THINKING_RESERVE = bad;
      const n = cfg(req(900)).maxOutputTokens;
      expect(Number.isInteger(n), `override "${bad}" produced ${n}`).toBe(true);
      expect(n).toBeGreaterThanOrEqual(900);
    }
  });

  it("leaves temperature and the JSON-schema path alone", () => {
    // The reserve must be the only behavioural change in this builder.
    const body = buildGeminiBody({
      task: "interview_score",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 900,
      temperature: 0,
      jsonSchema: { type: "object" },
    });
    const g = body.generationConfig as Record<string, unknown>;
    expect(g.temperature).toBe(0);
    expect(g.responseMimeType).toBe("application/json");
  });

  it("thinking is NOT disabled — the reserve buys room, it does not remove it", () => {
    /*
     * thinkingConfig: { thinkingBudget: 0 } would also stop the truncation,
     * and was rejected deliberately: every hypothesis, sequencing and design
     * call in the product reasons before it answers, and the output quality is
     * the product. If a future change adds it here, that is a decision to
     * make openly, not a side effect of tuning a number.
     */
    const g = buildGeminiBody(req(900)).generationConfig as Record<string, unknown>;
    expect(g.thinkingConfig, "thinking was switched off in the generate path").toBeUndefined();
  });
});

describe("v5.34.103 — geminiThinkingReserve()", () => {
  const saved = process.env.GEMINI_THINKING_RESERVE;
  afterEach(() => {
    if (saved === undefined) delete process.env.GEMINI_THINKING_RESERVE;
    else process.env.GEMINI_THINKING_RESERVE = saved;
  });

  it("defaults above the thinking spend actually observed", () => {
    delete process.env.GEMINI_THINKING_RESERVE;
    // ~865 tokens of thinking on a 218-token prompt for a trivial JSON answer.
    // Harder prompts think harder, so the default carries real margin.
    expect(geminiThinkingReserve()).toBeGreaterThanOrEqual(2000);
  });
});
