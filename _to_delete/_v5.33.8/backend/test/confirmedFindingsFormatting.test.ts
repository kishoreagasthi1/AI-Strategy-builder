/**
 * v5.32.13 — Synthesis → Confirmed Findings, expanded dimension rows.
 *
 * The role badge ("COO / VP Operations", "CDO / VP Data & Analytics" — full
 * titles, not short codes like GAP's) and the finding text shared
 * .finding-item's flex ROW layout with the badge forced white-space:nowrap.
 * A long, unwrapping badge squeezed the actual finding text into a narrow
 * remaining column — the "formatting is not good" the user reported.
 * Confirmed Findings now stacks badge-over-text; Contradictions/Gaps (short
 * badges) intentionally keep the original row layout, so this checks the
 * fix is scoped to .confirmed only, not applied blanket to .finding-item.
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

describe("synthesis.html — Confirmed Findings formatting (v5.32.13)", () => {
  it("stacks the role badge above the finding text for confirmed findings", () => {
    const src = readSynthesis();
    expect(src).toMatch(/\.finding-item\.confirmed\s*\{[^}]*flex-direction:\s*column/);
  });

  it("stretches the finding text to full width so it isn't squeezed beside the badge", () => {
    const src = readSynthesis();
    expect(src).toContain(".finding-item.confirmed > div:last-child{align-self:stretch}");
  });

  it("leaves the gap/contradicted row layout untouched — only .confirmed gets the stacked fix", () => {
    const src = readSynthesis();
    // .finding-item.gap's own rule (the background/border one) must not also
    // carry flex-direction:column — it should still be a plain nowrap row,
    // which is fine for GAP's short badge.
    const gapRule = src.match(/\.finding-item\.gap\s*\{([^}]*)\}/);
    expect(gapRule, "expected to find .finding-item.gap's rule").toBeTruthy();
    expect(gapRule![1]).not.toMatch(/flex-direction/);
  });

  it("the confirmed-findings item is still built as badge div + text div (markup the CSS selector relies on)", () => {
    const src = readSynthesis();
    // v5.32.59: the same markup, built by findingTile() from a claim cluster
    // rather than from a per-role finding (F13). The CSS selector this test
    // protects — .finding-item.confirmed > badge div + text div — is unchanged.
    expect(src).toContain(
      "fi.innerHTML='<div class=\"finding-badge confirmed\">'+esc(r.role)+'</div><div>'+esc(r.text)+'</div>';"
    );
  });
});
