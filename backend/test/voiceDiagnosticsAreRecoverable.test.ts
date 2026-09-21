/**
 * The live-voice trace can be handed over without a browser console.
 * (v5.34.116)
 *
 * Every transport question this project has had was settled from that trace and
 * nothing else: the 186-second dead period, the handover that clipped an
 * answer, the machine that slept. Until now the only way to get it was
 * `copy(vyneLiveLogDump())` typed into DevTools, so it survived only if someone
 * thought to run it before closing the tab. On the 2026-09-15 interview nobody
 * did — the tab closed, and a fault reported at minute nine had to be reasoned
 * about from the transcript rather than read from the log.
 *
 * Asserted statically, against the page source. The handler is a few lines of
 * DOM work whose only interesting properties are WHERE it lives and WHAT it is
 * allowed to contain.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const PAGE = readFileSync(join(root, "frontend", "interview_agent.html"), "utf8");
const LIVE = readFileSync(join(root, "frontend", "vyne-live.js"), "utf8");

describe("v5.34.116 — the trace is one click away", () => {
  it("offers a diagnostics download", () => {
    expect(PAGE).toMatch(/onclick="downloadVoiceDiagnostics\(\)"/);
    expect(PAGE).toMatch(/function downloadVoiceDiagnostics\(\)/);
  });

  it("sits inside the side panel, which interviewee sessions hide", () => {
    /*
     * The trace carries both sides of the conversation and is the consultant's
     * diagnostic. interview_agent.html hides `.side-panel` outright for an
     * interviewee, so placing the button there is the whole access control —
     * and it has to STAY there.
     */
    const panelAt = PAGE.indexOf('<div class="side-panel">');
    const buttonAt = PAGE.indexOf('onclick="downloadVoiceDiagnostics()"');
    expect(panelAt, "the side panel moved — update this test").toBeGreaterThan(-1);
    expect(buttonAt).toBeGreaterThan(panelAt);
    // And the interviewee cut is still the thing that hides it.
    expect(PAGE).toMatch(/querySelector\('\.side-panel'\)/);
  });

  it("falls back to the previous page instance's copy", () => {
    // What a mid-interview reload or sign-out leaves behind — the case the
    // across-navigation mirror in vyne-live.js exists for.
    const fn = /function downloadVoiceDiagnostics\(\)[\s\S]*?\n\}/.exec(PAGE)![0];
    expect(fn).toMatch(/vyneLiveLogDump\b/);
    expect(fn).toMatch(/vyneLiveLogDumpPrev\b/);
  });

  it("says which build and which session produced it", () => {
    // A trace with no version is a trace nobody can place against a fix.
    const fn = /function downloadVoiceDiagnostics\(\)[\s\S]*?\n\}/.exec(PAGE)![0];
    expect(fn).toMatch(/VYNE_VERSION/);
    expect(fn).toMatch(/sessionCode/);
  });

  it("the trace it saves does not carry the firm's briefing", () => {
    /*
     * The one thing that would make this file unsafe to pass around. The mint
     * body contains the engagement briefing; the trace line for a mint must
     * keep logging only what the grant returned, never what was sent.
     */
    const minted = /vlog\('grant minted',[\s\S]{0,400}?\}\);/.exec(LIVE);
    expect(minted, "the 'grant minted' trace line moved — update this test").toBeTruthy();
    expect(minted![0], "the briefing is now being written into the trace")
      .not.toMatch(/\bcontext\b/);
  });

  it("the console route still exists for a live tab", () => {
    // The button needs the page's export panel; mid-interview there is still
    // only the console, and that is the fuller capture.
    expect(LIVE).toMatch(/window\.vyneLiveLogDump = function/);
    expect(LIVE).toMatch(/window\.vyneLiveMark = function/);
  });
});
