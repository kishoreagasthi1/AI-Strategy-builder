/**
 * v5.32.20 — Part 10 of the Design Studio brief (Build/Buy/Partner) was the
 * only generator in the module that failed in production, showing the
 * consultant a bare "generation_failed" with nothing else to go on.
 *
 * Two defects, both visible in a real exported session where the other six
 * generators had all succeeded against the same models and the same gateway:
 *
 *   1. This route was the ONLY caller in the codebase passing `jsonSchema` to
 *      the gateway. Gemini maps that onto `responseSchema`, an OpenAPI subset
 *      stricter than plain JSON Schema. The six generators that worked ask for
 *      JSON in the prompt and parse the text. This one now does the same, and
 *      enforces the shape with DocShape afterwards — so the contract is no
 *      looser, it just isn't delegated to a provider-specific feature that the
 *      rest of the app never exercises.
 *   2. The failure was unreportable. The route sent `{error:"generation_failed"}`
 *      with no detail, so neither the consultant nor the logs-less debugger
 *      could tell a truncated response from a capacity blip from a bad schema.
 *
 * These tests cover the parser directly (it is the part that turns a real
 * model response into either a doc or an error) plus the wiring, since the
 * existing route integration test is Postgres-gated and feeds its fake adapter
 * perfectly-formed JSON — which is why neither defect was caught.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJsonLoose } from "../src/routes/solutionDesign.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTE = readFileSync(join(__dirname, "..", "src", "routes", "solutionDesign.ts"), "utf8");

describe("parseJsonLoose — survives what models actually return (v5.32.20)", () => {
  it("plain JSON", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it("fenced JSON, with and without the language tag", () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("JSON wrapped in conversational prose", () => {
    expect(parseJsonLoose('Here is the design document:\n{"a":1}\nLet me know if you need changes.')).toEqual({ a: 1 });
  });

  it("a trailing comma before a closing brace or bracket", () => {
    expect(parseJsonLoose('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
  });

  it("nested braces inside string values do not truncate the span", () => {
    expect(parseJsonLoose('prefix {"a":"has } brace","b":2} suffix')).toEqual({ a: "has } brace", b: 2 });
  });

  it("a truncated response is identified AS truncated, not just unparseable", () => {
    // v5.32.21: these two need different fixes — one is a budget problem, the
    // other is the model not complying — and conflating them sent a round of
    // debugging down the wrong path. An unmatched opening brace is the tell.
    expect(() => parseJsonLoose('{"problemStatement":"the model ran out of tok')).toThrow(
      /cut off before the document was finished/
    );
    expect(() => parseJsonLoose('{"a":{"b":1}')).toThrow(/cut off before the document was finished/);
  });

  it("a response with no JSON at all fails the same way", () => {
    expect(() => parseJsonLoose("I cannot help with that request.")).toThrow(
      /did not return a parseable JSON object/
    );
  });
});

describe("the generate route no longer relies on provider-specific schema mode (v5.32.20)", () => {
  it("passes no jsonSchema to the gateway", () => {
    expect(ROUTE).not.toContain("jsonSchema: DOC_SCHEMA");
    expect(ROUTE).not.toContain("const DOC_SCHEMA = {");
  });

  it("still enforces the document shape, so nothing is loosened", () => {
    expect(ROUTE).toContain("const shaped = DocShape.safeParse(raw);");
    expect(ROUTE).toContain("if (!shaped.success) {");
  });

  it("sizes the budget for the largest output in the studio", () => {
    // Eleven fields, three of them arrays of objects, plus two provenance
    // lists — and thinking tokens come out of the same budget.
    expect(ROUTE).toContain("maxTokens: 8000,");
    expect(ROUTE).not.toContain("maxTokens: 3000,");
    expect(ROUTE).not.toContain("maxTokens: 4000,");
  });

  it("bounds the assumption and evidence lists rather than asking for 'thorough'", () => {
    // An unbounded "list every claim" against a fixed token budget is what
    // truncated the document in the first place.
    expect(ROUTE).not.toContain("Be thorough and specific");
    expect(ROUTE).not.toContain("essentially all specifics");
    expect(ROUTE).toContain("array of 6-10 short strings");
    expect(ROUTE).toContain("array of up to 8 short strings");
  });

  it("retries once with a compact instruction, but only for a shape failure", () => {
    expect(ROUTE).toContain("out = await attempt(true);");
    // A provider failure is the gateway's job — it already exhausted its chain.
    expect(ROUTE).toContain("if (first instanceof GatewayError) throw first;");
    expect(ROUTE).toContain("Completeness of the JSON object matters more than richness of the prose.");
  });

  it("logs a bounded sample of an unparseable response so it stays debuggable", () => {
    expect(ROUTE).toContain('"solution design: unparseable model response"');
    expect(ROUTE).toContain("head: result.text.slice(0, 200),");
  });

  it("sends a client-safe reason instead of a bare error code", () => {
    expect(ROUTE).toContain('reply.code(err instanceof GatewayError ? err.statusCode : 502).send({ error: "generation_failed", detail });');
    // The raw provider text must still never leave the server.
    // v5.32.29 (audit M-5): the detail is still logged and still never sent,
    // but it is redacted first — GatewayError.detail can carry up to 300
    // characters of provider response, which occasionally reflects request
    // content (interview text, client names) back into Cloud Run logs.
    expect(ROUTE).toContain('req.log.error({ detail: redactProviderDetail(err.detail) }, "solution design generation: provider error detail");');
    expect(ROUTE).not.toContain("detail: err.detail })\n        .send");
  });

  it("a capacity blip surfaces as 503, not as a generic failure", () => {
    expect(ROUTE).toContain("err instanceof GatewayError ? err.statusCode : 502");
  });

  it("tolerates a quoted digit for the numeric plan fields without widening the shape", () => {
    expect(ROUTE).toContain("phase: z.coerce.number(), name: z.string(), description: z.string(), durationWeeks: z.coerce.number(),");
  });
});
