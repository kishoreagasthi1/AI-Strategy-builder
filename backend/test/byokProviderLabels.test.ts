/**
 * What the screen says a client's key pays for must match what it pays for.
 * (v5.34.62)
 *
 * The keys tab offered:
 *
 *     Google AI — voice interviews
 *     Anthropic — decks & synthesis
 *
 * Neither was true. PROD_POLICY puts gemini-vertex FIRST on every chain —
 * synthesis, strategy decks, solution design, the Design Studio artifacts and
 * all ordinary text — with Claude only as the fallback when Gemini fails. So a
 * client's Google key already pays for essentially everything, and an Anthropic
 * key is reached only when Gemini has failed.
 *
 * The wording came from the original design notes ("Gemini for voice, Claude
 * for the deck") and survived a routing change that inverted it. Nothing
 * catches a stale sentence, so this does: the assertions below are derived from
 * the ROUTER, not from a copy of the label.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PROD_POLICY, chainForTask } from "../src/llm/router.js";
import { applyByokToChain } from "../src/llm/byok/resolve.js";
import { ATTESTATION_TEXT } from "../src/routes/byok.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const billing = readFileSync(join(ROOT, "frontend", "billing.html"), "utf8");

/** Everything a client's work actually routes through in production. */
const PAID_TASKS = [
  "synthesis", "strategy_deck", "solution_design",
  "design_brief", "design_governance", "design_artifact",
  "hypotheses",          // not in taskChains → the default chain
];

describe("v5.34.62 — Gemini leads every production chain", () => {
  it("every task the firm bills for tries Gemini before Claude", () => {
    for (const task of PAID_TASKS) {
      const chain = chainForTask(PROD_POLICY, task);
      expect(chain[0], `${task} does not try Gemini first`).toBe("gemini-vertex");
      expect(chain.indexOf("gemini-vertex")).toBeLessThan(chain.indexOf("anthropic-vertex"));
    }
  });

  it("a client with ONLY a Google key gets it used for decks and synthesis too", () => {
    /*
     * The claim the old label denied. A Gemini BYOK key substitutes wherever
     * the chain wanted Gemini — which is first, on every one of these.
     */
    for (const task of PAID_TASKS) {
      const chain = chainForTask(PROD_POLICY, task);
      const out = applyByokToChain(chain, new Set(["gemini-aistudio", "gemini-aistudio-2"]));
      expect(out[0], `${task} would not use the client's Google key`).toBe("gemini-aistudio");
    }
  });

  it("a client with ONLY an Anthropic key is behind Gemini, not in front of it", () => {
    // Which is why the label now says "fallback only" rather than implying
    // decks run on Claude. A client supplying an Anthropic key today should
    // know it will rarely be reached.
    const out = applyByokToChain(chainForTask(PROD_POLICY, "strategy_deck"), new Set(["anthropic-api"]));
    expect(out[0]).toBe("gemini-vertex");
    expect(out.indexOf("anthropic-api")).toBeGreaterThan(out.indexOf("gemini-vertex"));
  });
});

describe("v5.34.62 — the keys screen describes that accurately", () => {
  it("does not tell the Owner a Google key is only for voice", () => {
    const option = billing.match(/<option value="gemini-aistudio">([^<]*)</)?.[1] ?? "";
    expect(option).not.toMatch(/^Google AI — voice interviews$/);
    // It must name the work a Gemini key actually pays for.
    expect(option).toMatch(/synthesis/i);
    expect(option).toMatch(/deck/i);
    expect(option).toMatch(/voice/i);
  });

  it("does not tell the Owner that decks need Anthropic", () => {
    const option = billing.match(/<option value="anthropic-api">([^<]*)</)?.[1] ?? "";
    expect(option).not.toMatch(/decks\s*&(amp;)?\s*synthesis/i);
    expect(option).toMatch(/fallback/i);
  });
});

describe("v5.34.62 — the attestation covers what the key is used for", () => {
  it("no longer describes the key as serving only interview content", () => {
    /*
     * This is the sentence the client's administrator agrees to, stored
     * verbatim as the record of what they were told. Understating the scope of
     * use is the one inaccuracy here that has consequences outside the product.
     */
    const text = ATTESTATION_TEXT["gemini-aistudio"];
    expect(text).not.toMatch(/the interview content/);
    expect(text).toMatch(/documents and presentations/i);
    // And it still says plainly what cannot be checked.
    expect(text).toMatch(/cannot be verified\s+automatically/i);
    expect(text).toMatch(/free tier/i);
  });
});
