/**
 * V225-audit H1 fix — regression guard.
 *
 * The real fix lives in frontend/synthesis.html and frontend/interview_agent.html:
 * every place that renders interviewee-supplied or AI-synthesized text via
 * innerHTML/template-literal-into-innerHTML now passes it through an esc()
 * helper first (HTML-escape via textContent round-trip) before any markup
 * assembly. There's no frontend test runner in this repo (these are static
 * HTML+JS pages, not a bundled app), so this is a static source-text check
 * from the backend's vitest suite: it fails loudly if one of the known
 * fixed sinks is ever edited back to interpolating the raw field without
 * esc(). It is a guard against regression, not a substitute for escaping
 * new sinks introduced later — new model/interviewee-text render sites must
 * apply esc() themselves.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dirname, "..", "..", "frontend");

function read(name: string): string {
  return readFileSync(join(FRONTEND, name), "utf8");
}

describe("frontend XSS guards (V225-audit H1)", () => {
  it("synthesis.html defines a global esc() helper", () => {
    const src = read("synthesis.html");
    // v5.32.29 (audit H-3/M-2): the textContent/innerHTML idiom escapes only
    // & < > — HTML text-node serialization never touches quotes — and this
    // value reaches attributes and inline handlers throughout the file.
    // Replaced project-wide with an explicit five-character escaper.
    expect(src).toContain("function esc(s){");
    expect(src).toContain("&quot;");
    expect(src).toContain("&#39;");
  });

  it("synthesis.html escapes interviewee/finding text at every known render site", () => {
    const src = read("synthesis.html");
    // Confirmed findings (corroborated evidence tile). v5.32.59 renamed the
    // loop variable when the tile moved to claim-level clustering (F13); what
    // matters is that BOTH the role badge and the finding body are escaped,
    // since both are interviewee-supplied and land in the consultant's DOM.
    expect(src).toContain('<div class="finding-badge confirmed">\'+esc(r.role)+\'</div><div>\'+esc(r.text)+\'</div>');
    // AI-synthesized blind spots / hypotheses (Recommended Focus tile)
    expect(src).toContain("esc(h.hypothesis)");
    expect(src).toContain("esc(b.topic)");
    expect(src).toContain("esc(b.whyItMatters)");
    // Suggested-roles notes (blind-spot whoShouldAddress)
    expect(src).toContain("esc(n.who)");
    expect(src).toContain("esc(n.reason)");
  });

  it("interview_agent.html escapes agent/interviewee messages and findings", () => {
    const src = read("interview_agent.html");
    // v5.32.29 (audit H-3/M-2): the textContent/innerHTML idiom escapes only
    // & < > — HTML text-node serialization never touches quotes — and this
    // value reaches attributes and inline handlers throughout the file.
    // Replaced project-wide with an explicit five-character escaper.
    expect(src).toContain("function esc(s){");
    expect(src).toContain("&quot;");
    expect(src).toContain("&#39;");
    // fmt() must escape before layering <strong>/<br> markup on top
    expect(src).toMatch(/function fmt\(t\)\{return esc\(t\)/);
    // addFinding()
    expect(src).toContain("esc(f.dimension");
    expect(src).toContain("esc(f.text)");
  });
});
