/**
 * The scoring budget has to cover the model's THINKING, not just its answer.
 * (v5.34.102)
 *
 * ── Measured, against production, 2026-09-14 ────────────────────────────────
 *
 * The same prompt, sent twice through /api/llm/generate as task
 * interview_score, differing only in maxTokens:
 *
 *   maxTokens 900  -> provider gemini-vertex, model gemini-3.6-flash,
 *                     tokensOut  35, finishReason "length", 60 chars of text,
 *                     cut at:  {"scores":{"D1":2,"D2":0,"D3":
 *   maxTokens 4000 -> same provider and model,
 *                     tokensOut 159, finishReason "stop", parses cleanly,
 *                     scores D1=2 D6=1 — correct for the transcript
 *
 * Thirty-five visible output tokens against a 900 budget, and the model still
 * reported "length". gemini-3.6-flash is a thinking model: maxOutputTokens
 * covers the reasoning as well as the reply, so ~865 tokens went on thinking
 * and the JSON was guillotined mid-value.
 *
 * ── where this was found, and where it was NOT ─────────────────────────────
 *
 * By calling /api/llm/generate directly from a signed-in browser against
 * production. NOT by the voice harness, which cannot score at all: before
 * v5.34.100 it answered that endpoint with a 404, and the page counted the
 * 404s as failed scoring passes. So the harness's "scoring passes: 0
 * succeeded, 3 failed" on 2026-09-14 was a RIG fault, and this truncation is
 * a separate, real one that happened to produce the same-looking number.
 *
 * Worth stating plainly because the harness's own v5.34.100 note calls this
 * "this harness's oldest recurring trap" — a rig fault presenting as a
 * product failure — and it caught us again. The measurement above is the
 * evidence for this fix; the harness verdict is not.
 *
 * Worth keeping in mind for anyone reading this later: in PROD_POLICY every
 * task starts on gemini-vertex (router.ts:44), so a `model: 'claude-...'` in a
 * frontend body does not mean the call reaches Claude. It does not.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const liveInterview = readFileSync(join(root, "frontend", "vyne-live-interview.js"), "utf8");

describe("v5.34.102 — the interview_score budget", () => {
  /*
   * v5.34.103: the thinking room now comes from buildGeminiBody, so this
   * number means what every other call site means — how long an ANSWER. What
   * is pinned here is that it covers the answer with margin (the measured
   * response was ~160 tokens, and a rich finding can be much longer), and that
   * the hard-won reason is still legible at the line. The reserve itself is
   * tested in geminiThinkingReserve.test.ts.
   */
  it("covers the answer with margin", () => {
    const call = /task: 'interview_score'[\s\S]*?messages: \[/.exec(liveInterview);
    expect(call, "the interview_score call moved — update this test").toBeTruthy();
    const m = /maxTokens:\s*(\d+)/.exec(call![0]);
    expect(m, "the scoring call no longer sets maxTokens at all").toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(900);
  });

  it("and the reason it matters is recorded where the number is", () => {
    /*
     * Without the note, this reads as an arbitrary constant and the next
     * person to see a truncated score has to rediscover the whole thing from
     * a paid production run.
     */
    const call = /task: 'interview_score'[\s\S]*?maxTokens:/.exec(liveInterview);
    expect(call![0]).toMatch(/thinking/i);
  });
});

describe("v5.34.102 — why a truncated score cannot be salvaged", () => {
  /*
   * The tolerant parser is not the problem and must not be 'fixed' into
   * accepting these. A scorecard built from half a response is worse than a
   * failed pass, because a failed pass is counted, badged, and eventually
   * stops the interview — while a salvaged half is silently shown to a
   * consultant as an assessment.
   *
   * vyne-client.js is a browser IIFE, so the parser is lifted out by source
   * rather than imported.
   */
  const clientSrc = readFileSync(join(root, "frontend", "vyne-client.js"), "utf8");

  function loadParser() {
    const detailed = /function vyneParseJsonDetailed\(text\) \{[\s\S]*?\n  \}/.exec(clientSrc);
    const repair = /\/\*\* Drop an incomplete tail[\s\S]*?function repairTruncated\(body\) \{[\s\S]*?\n  \}/.exec(clientSrc);
    expect(detailed, "vyneParseJsonDetailed moved").toBeTruthy();
    expect(repair, "repairTruncated moved").toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(
      `${detailed![0]}\n${repair![0]}\nreturn vyneParseJsonDetailed;`,
    )() as (t: string) => { value: unknown; truncated: boolean; reason: string };
  }

  it("reports the exact production response as cut off, not as unparseable", () => {
    // Verbatim from the failing call, fence and all.
    const truncated = '```json\n{\n  "scores": {\n    "D1": 2,\n    "D2": 0,\n    "D3":';
    const out = loadParser()(truncated);
    expect(out.value, "a half-read scorecard was handed back as if it were whole").toBeNull();
    expect(out.truncated).toBe(true);
    expect(out.reason).toMatch(/cut off/i);
  });

  it("still parses the full response the raised budget produces", () => {
    const whole = '```json\n{"scores":{"D1":2,"D2":0,"D3":0,"D4":0,"D5":0,"D6":1,"D7":0},' +
      '"coverage":{"D1":0.6,"D6":0.4}}\n```';
    const out = loadParser()(whole);
    expect(out.truncated).toBe(false);
    expect((out.value as { scores: Record<string, number> }).scores.D1).toBe(2);
    expect((out.value as { scores: Record<string, number> }).scores.D6).toBe(1);
  });
});

describe("v5.34.103 — the browser floor, and the one caller that escapes it", () => {
  /*
   * vyne-client.js floors every budget routed through vyneLLM at 8192 (16384
   * for synthesis). That floor is why a module asking for 400 tokens has never
   * truncated, and it is the reason the "eleven exposed call sites" reading of
   * this bug was wrong: those numbers are inert.
   *
   * The scoring pass is the only code in the product that calls
   * /api/llm/generate directly, so it is the only budget that reaches the
   * provider as written. That is a fine thing to do — it wants a specific
   * task, no Anthropic reshaping and no compact-retry — but it means the
   * protection has to be reasoned about at that call site rather than
   * inherited.
   *
   * These two tests exist so the NEXT raw caller is a deliberate act. Someone
   * adding one will be told here what they are opting out of.
   */
  const frontendDir = join(root, "frontend");

  function rawCallers(): { file: string; budget: number | null }[] {
    const files = readdirSync(frontendDir).filter((f) => /\.(html|js)$/.test(f));
    const found: { file: string; budget: number | null }[] = [];
    for (const f of files) {
      const src = readFileSync(join(frontendDir, f), "utf8");
      /*
       * A generous window: the scoring call carries a long explanatory comment
       * between the fetch and its maxTokens, and a tight window silently reads
       * the budget as absent — which is a false alarm, the most expensive kind
       * of test failure.
       */
      const re = /fetch\(\s*['"][^'"]*\/api\/llm\/generate['"][\s\S]{0,4000}?maxTokens:[\s\S]{0,40}?\n/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const b = /maxTokens:\s*(\d+)/.exec(m[0]);
        found.push({ file: f, budget: b ? Number(b[1]) : null });
      }
    }
    return found;
  }

  it("there is still exactly one raw caller, and it is the scoring pass", () => {
    const callers = rawCallers();
    expect(
      callers.map((c) => c.file),
      "a new raw /api/llm/generate caller appeared. It does NOT get vyne-client.js's " +
        "8192 floor, so its maxTokens reaches the provider as written and must be " +
        "large enough to cover the model's thinking as well as its answer — see the " +
        "measurement at the top of this file. Route it through vyneLLM, or give it a " +
        "budget with the same margin, then add it here.",
    ).toEqual(["vyne-live-interview.js"]);
  });

  it("and every raw caller states a budget that survives the thinking", () => {
    for (const c of rawCallers()) {
      expect(c.budget, `${c.file} calls /api/llm/generate raw with no maxTokens`).not.toBeNull();
      expect(c.budget!, `${c.file} asks for ${c.budget} unfloored`).toBeGreaterThanOrEqual(900);
    }
  });
});
