/**
 * v5.32.14/15 — "Run AI Synthesis" result now survives a page reload.
 *
 * runAISynthesis() was already saving the full structured result to
 * vyneStore ('vynora_synthesis_full_'+engagementCode) — genuinely
 * DB-backed, not lost on reload. Downstream tiles (Recommended Focus,
 * Close Round, Word report) already lazily recovered `lastSynthesisResult`
 * from that same key when they needed it. But nothing ever read it back
 * into the main synthesis-box DISPLAY on page load — so every revisit
 * showed the placeholder ("Click Run AI Synthesis...") and the only way to
 * see the result again was to pay for and wait through another ~90s AI
 * call, even though the exact result already existed. Reported live as
 * "why does it have to be generated each time?"
 *
 * v5.32.14's first attempt at this had a real bug the test suite below
 * originally missed: it gated the box-restore on `!lastSynthesisResult`,
 * but renderFocusTile() — called earlier in the SAME renderDashboard() —
 * already silently populates that exact variable as a side effect of
 * building an unrelated tile. By the time the restore code ran, the
 * variable was always already truthy, so the box itself never actually
 * re-rendered — reported live a second time as "I still see no synthesis
 * after the fix." Fixed by gating on a dedicated `synthesisBoxHydrated`
 * flag instead of a variable another function mutates first. The tests
 * below assert the CORRECTED gating and specifically guard against
 * regressing back to checking `lastSynthesisResult`.
 *
 * Static source-text check — no frontend test runner in this repo, same
 * pattern as renameClientUI.test.ts / clientDropdowns.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dirname, "..", "..", "frontend");

function readSynthesis(): string {
  return readFileSync(join(FRONTEND, "synthesis.html"), "utf8");
}

function extractFn(src: string, signature: string): string {
  const re = new RegExp(signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([\\s\\S]*?)\\n\\}", "m");
  const m = src.match(re);
  expect(m, `expected to find ${signature}`).toBeTruthy();
  return m![1];
}

describe("synthesis.html — Confirmed synthesis persists across reload (v5.32.14/15)", () => {
  it("declares a dedicated hydration flag, separate from lastSynthesisResult", () => {
    const src = readSynthesis();
    expect(src).toContain("var synthesisBoxHydrated = false;");
  });

  it("renderDashboard() restores a saved synthesis into the display box, gated on the hydration flag — not on lastSynthesisResult", () => {
    const src = readSynthesis();
    const body = extractFn(src, "function renderDashboard()");
    expect(body).toContain("vynora_synthesis_full_");
    expect(body).toContain("renderStructuredSynthesis(lastSynthesisResult,_synthBox)");
    // The actual bug: gating on `!lastSynthesisResult` here is broken,
    // because renderFocusTile() (called earlier in this same function)
    // already populates that variable itself. Guard against regressing to it.
    expect(body).toMatch(/if\(!synthesisBoxHydrated\s*&&\s*engagement\s*&&\s*engagement\.code\)\{/);
    expect(body).not.toMatch(/if\(!lastSynthesisResult\s*&&\s*engagement\s*&&\s*engagement\.code\)\{/);
    expect(body).toContain("synthesisBoxHydrated=true");
  });

  it("renderFocusTile() runs before the box-restore code, and its own restore doesn't gate the box on the same variable", () => {
    const src = readSynthesis();
    const focusIdx = src.indexOf("renderFocusTile();\n");
    const restoreIdx = src.indexOf("if(!synthesisBoxHydrated && engagement && engagement.code){");
    expect(focusIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(focusIdx).toBeLessThan(restoreIdx);
  });

  it("shows a 'showing a saved synthesis' note with a timestamp so it's clear this wasn't just generated", () => {
    const src = readSynthesis();
    expect(src).toContain('<div id="synthesis-saved-note"');
    const body = extractFn(src, "function renderDashboard()");
    expect(body).toContain("Showing synthesis last generated");
    expect(body).toContain("savedAt");
  });

  it("running a fresh synthesis marks the box hydrated and hides the saved-note (it's live now, not restored)", () => {
    const src = readSynthesis();
    const body = extractFn(src, "async function runAISynthesis()");
    expect(body).toContain("synthesisBoxHydrated=true");
    expect(body).toContain("synthesis-saved-note");
    expect(body).toMatch(/_freshNote\.style\.display\s*=\s*'none'/);
  });
});
