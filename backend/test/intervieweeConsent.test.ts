/**
 * v5.34.45 — the interviewee is told what happens to their voice, BEFORE the
 * microphone opens, and has to say so.
 *
 * privacy.html and dpa.html described voice handling accurately and neither was
 * reachable from anything the interviewee saw. The only notice on that path was
 * on the CONSULTANT's setup screen. This pins the gap shut: the disclosure has
 * to be on the interviewee's own welcome overlay, every start button has to be
 * gated behind an affirmative tick, and the acknowledgement has to be recorded.
 *
 * These are static assertions on the shipped HTML, not a rendering test. That
 * is deliberate: the failure this guards against is someone deleting or
 * bypassing the gate, and a static check catches that in the release gate
 * rather than in a deployment nobody re-tested by hand.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FE = (p: string) => readFileSync(join(__dirname, "..", "..", "frontend", p), "utf8");
const page = FE("interview_agent.html");

describe("the interviewee's consent gate", () => {
  it("the disclosure is on the interviewee's welcome screen, not just the consultant's setup", () => {
    expect(page).toContain("function consentBlock()");
    // renderWelcome is the interviewee-facing overlay; the setup screen above it
    // asks for an Anthropic API key and is the consultant's.
    const welcome = page.slice(page.indexOf("function renderWelcome()"));
    expect(welcome).toContain("consentBlock()");
  });

  it("names the third party, because that is what the wiretap claims turn on", () => {
    // "we do not keep a recording" does not answer the interception question:
    // the audio still leaves the browser for a third-party provider.
    expect(page).toMatch(/third-party AI\s*' \+\s*'provider \(Google\)|third-party AI provider \(Google\)/);
  });

  it("says plainly that audio is not kept but the transcript is", () => {
    expect(page).toMatch(/transcribed, not recorded/i);
    expect(page).toMatch(/audio is not kept/i);
    expect(page).toMatch(/transcript is stored/i);
  });

  it("EVERY start button on the welcome screen is gated behind the tick", () => {
    /*
     * Scoped to renderWelcome ONLY. renderPaused() below it also offers a
     * Resume button, and that one is correctly ungated: it unpauses an
     * interview whose consent was already given and recorded. Re-asking there
     * would be noise, not rigour.
     */
    const welcome = page.slice(page.indexOf("function renderWelcome()"),
                               page.indexOf("function renderPaused()"));
    // Any button that begins or resumes an interview must carry the attribute
    // and start disabled. A new start path added without it fails here.
    const starters = welcome.match(/<button[^>]*onclick="[^"]*_vyneIv(Fresh|Resume)[^"]*"/g) || [];
    expect(starters.length).toBeGreaterThanOrEqual(4);
    for (const b of starters) expect(b).toContain("data-needs-consent");
    for (const b of starters) expect(b).toContain("disabled");
  });

  it("starting records WHAT was agreed and WHEN", () => {
    expect(page).toContain("_vyneRecordConsent");
    expect(page).toMatch(/acknowledgedAt/);
    expect(page).toMatch(/CONSENT_VERSION/);
    // the wording shown is stored with it — a consent you cannot evidence
    // afterwards is not much use when it is asked about
    expect(page).toMatch(/text:\s*CONSENT_TEXT/);
  });

  it("links the privacy notice the interviewee could not previously reach", () => {
    const welcome = page.slice(page.indexOf("function consentBlock()"));
    expect(welcome).toContain('href="privacy.html"');
  });

  it("the interview screen keeps saying it while the conversation runs", () => {
    // Anchor on the MARKUP, not the class name — the CSS rule for
    // .progress-bar-wrap appears hundreds of lines earlier in the <style>.
    const header = page.slice(page.indexOf('<div class="interview-header">'),
                              page.indexOf('<div class="progress-bar-wrap">'));
    expect(header.length).toBeGreaterThan(200);
    expect(header).toMatch(/Transcribed, not recorded/);
  });
});
