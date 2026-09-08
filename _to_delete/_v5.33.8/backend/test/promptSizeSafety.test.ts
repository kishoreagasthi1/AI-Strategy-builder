/**
 * v5.32.23 — the systemic fix for the failure that hit the Design Studio's
 * build/buy/partner generator three times in a row: a model response cut off
 * mid-JSON, surfacing as an unhelpful parse error.
 *
 * An audit of every LLM call site in the app found the local fix had been
 * papering over four app-wide defects:
 *
 *   1. Nine call sites tested `stop_reason === 'max_tokens'` to detect
 *      truncation. No adapter ever captured a finish reason and GenerateResult
 *      had no field for one, so every check compared against undefined. All of
 *      them were dead, and `brief.truncated` was permanently false.
 *
 *   2. Four near-duplicate JSON parsers existed in four files, two sharing a
 *      name with different capabilities — and roadmap.html CALLED one that was
 *      defined only in interview_agent.html. Every AI dependency generation
 *      there threw a swallowed ReferenceError and then told the consultant
 *      "No hard prerequisites identified — this can proceed on its own". A
 *      wrong answer presented confidently, after paying for the call.
 *
 *   3. Ten further sites used a bare JSON.parse. Two failed silently: static
 *      benchmarks were shown as though AI-refreshed, and an empty catch in the
 *      interview agent discarded a turn's scores AND findings while the
 *      interview carried on looking normal.
 *
 *   4. Seven prompts embedded unbounded collections. The worst is
 *      buildNarrativePrompt, which is O(gaps x initiatives) because each shared
 *      gap also enumerates every initiative it blocks — and it got worse in
 *      v5.32.16 when a .slice(0,12) cap was removed on purpose, for the good
 *      reason that silently dropping the 13th of 40 gaps is invisible loss.
 *
 * The resolution keeps that principle: nothing is capped away. Overflow is
 * summarised into the prompt by a real model call, and the UI says so.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FE = (p: string) => readFileSync(join(__dirname, "..", "..", "frontend", p), "utf8");
const BE = (p: string) => readFileSync(join(__dirname, "..", "src", p), "utf8");

const CLIENT = FE("vyne-client.js");
const ROADMAP = FE("roadmap.html");
const SYNTH = FE("synthesis.html");
const AGENT = FE("interview_agent.html");
const PRE = FE("pre_engagement.html");
const STUDIO = FE("solution_design.html");

describe("truncation is actually detectable now (v5.32.23)", () => {
  it("GenerateResult carries a normalised finishReason", () => {
    const t = BE("llm/types.ts");
    expect(t).toContain("finishReason?: string;");
    expect(t).toContain("export function normalizeFinishReason(");
    // Both providers' vocabularies map onto ours.
    expect(t).toContain('if (v === "max_tokens" || v === "length" || v === "max_token") return "length";');
  });

  it("both adapters capture it instead of dropping it", () => {
    expect(BE("llm/adapters/anthropicVertex.ts")).toContain("finishReason: normalizeFinishReason(data.stop_reason),");
    const shared = BE("llm/adapters/geminiShared.ts");
    expect(shared).toContain("finishReason: normalizeFinishReason(data.candidates?.[0]?.finishReason),");
    expect(BE("llm/adapters/geminiVertex.ts")).toContain("const { text, tokensIn, tokensOut, finishReason } = parseGeminiResponse(");
    expect(BE("llm/adapters/geminiAiStudio.ts")).toContain("const { text, tokensIn, tokensOut, finishReason } = parseGeminiResponse(");
  });

  it("the route relays it and the bridge maps it back to stop_reason", () => {
    expect(BE("routes/llm.ts")).toContain("finishReason: result.finishReason,");
    // This is what revives the nine dead checks without editing those modules.
    expect(CLIENT).toContain('var stopReason = data.finishReason === "length" ? "max_tokens"');
    expect(CLIENT).toContain("stop_reason: stopReason,");
  });

  it("the effective token budget is reported, since the floor overrides call sites", () => {
    expect(CLIENT).toContain("var effectiveMaxTokens = Math.max(payload.max_tokens || 0, floor);");
    expect(CLIENT).toContain("maxTokens: effectiveMaxTokens,");
  });
});

describe("one tolerant JSON parser, shared (v5.32.23)", () => {
  it("lives in the bridge, with a detailed and a drop-in form", () => {
    expect(CLIENT).toContain("function vyneParseJsonDetailed(text) {");
    expect(CLIENT).toContain("window.vyneParseJson = vyneParseJson;");
    // Back-compat aliases are what make roadmap.html's previously-undefined
    // previewSafeParse resolve at all.
    expect(CLIENT).toContain("window.previewSafeParse = vyneParseJson;");
  });

  it("the four local copies now delegate rather than diverge", () => {
    expect(ROADMAP).toContain("return (typeof vyneParseJson === 'function') ? vyneParseJson(text) : null;");
    expect(AGENT).toContain("return (typeof vyneParseJson === 'function') ? vyneParseJson(txt) : null;");
    expect(STUDIO).toContain("return (typeof vyneParseJson === 'function') ? vyneParseJson(text) : null;");
    expect(ROADMAP).toContain("function parseJsonRobust(text){");
    expect(ROADMAP).toContain("vyneParseJsonDetailed(text)");
  });

  it("no bare JSON.parse is left on any model response", () => {
    expect(SYNTH).not.toContain("_parsed=JSON.parse(_clean);");
    expect(ROADMAP).not.toContain("    var parsed=JSON.parse(txt);");
    expect(PRE).not.toContain("    var parsed = JSON.parse(text);");
    expect(PRE).not.toContain("      var newHyps=JSON.parse(text);");
    expect(PRE).not.toContain("    var intel=JSON.parse(text);");
    expect(AGENT).not.toContain("scoreData=JSON.parse(scoreMatch[1].trim());");
  });

  it("the two silent failures now report", () => {
    // Benchmarks: was console.warn then a static fallback presented as if fresh.
    expect(PRE).toContain("if(!parsed) throw new Error('the benchmark response was not usable');");
    // Interview scoring: was `try{...}catch(e){}` — an empty catch.
    expect(AGENT).toContain("that turn contributed no scores or findings");
    expect(AGENT).not.toContain("}catch(e){}\n  const displayText");
  });

  it("synthesis no longer dumps raw model JSON into the results box on failure", () => {
    expect(SYNTH).toContain("if(!_pr.ok) throw new Error(_pr.reason || 'response was not usable');");
  });
});

describe("prompts are fitted, not capped — nothing is dropped (v5.32.23)", () => {
  it("vyneFit summarises overflow with a real call rather than truncating", () => {
    expect(CLIENT).toContain("function vyneFit(items, renderFn, opts) {");
    expect(CLIENT).toContain('"fit_summary"');
    // No call at all when it already fits — the common case must stay free.
    expect(CLIENT).toContain("if (whole.length <= budget) {");
    expect(CLIENT).toContain("summarised: 0, summary: \"\", note: \"\", fitted: false,");
  });

  it("a failed summariser warns the downstream model instead of hiding the gap", () => {
    expect(CLIENT).toContain('note = "WARNING: " + overflow.length + " further " + label');
    expect(CLIENT).toContain("Treat the list above as incomplete and say so in your output.");
  });

  it("the two O(n^2)-ish roadmap blocks are fitted, ranked most-blocking first", () => {
    expect(ROADMAP).toContain("async function buildNarrativePrompt(ctx){");
    expect(ROADMAP).toContain("var _initFit = await vyneFit(ctx.initiatives, renderInit, {");
    expect(ROADMAP).toContain("var _gapFit = await vyneFit(ctx.sharedGaps, function(g){");
    expect(ROADMAP).toContain("var prompt = await buildNarrativePrompt(ctx);");
  });

  it("the synthesis interview block is fitted, since rounds accumulate forever", () => {
    expect(SYNTH).toContain("const _ivFit = await vyneFit(iv, function(i){");
    expect(SYNTH).toContain("label: 'completed interviews',");
  });

  it("compression is surfaced in the UI at both call sites", () => {
    expect(CLIENT).toContain("function vyneFitNotice(fits, hostId) {");
    expect(CLIENT).toContain("<b>Condensed to fit:</b>");
    expect(ROADMAP).toContain("vyneFitNotice([");
    expect(SYNTH).toContain("vyneFitNotice([{label:'completed interviews', fit:_ivFit}], 'synthesis-fit-notice');");
  });
});

describe("every generator gets one compact retry, not just the one that broke (v5.32.23)", () => {
  it("the retry lives in the bridge and fires only on a real truncation signal", () => {
    expect(CLIENT).toContain("var COMPACT_SUFFIX =");
    expect(CLIENT).toContain("function vyneLlmOnce(payload, taskName) {");
    expect(CLIENT).toContain("if (!res.truncated) return res;");
    // Asking again identically would mostly reproduce a length failure.
    expect(CLIENT).toContain("Return the SAME structure, but noticeably shorter");
  });

  it("the original prompt is preserved — the instruction is appended, not substituted", () => {
    expect(CLIENT).toContain("var retryPayload = JSON.parse(JSON.stringify(payload));");
    expect(CLIENT).toContain("msgs[i].content += COMPACT_SUFFIX;");
  });
});
