/**
 * v5.32.7 — visible save indicator.
 *
 * vyneStore has always flushed every module page's edits to Postgres
 * automatically (see vyne-client.js's scheduleFlush()/flush()) — but
 * silently, with nothing on screen confirming it happened. That silence is
 * what led a consultant to conclude module data "only goes to a JSON file"
 * (it never did) and go looking for a save button that didn't need to
 * exist. This guards that the status pill actually reflects the real
 * save lifecycle rather than being decorative: pending on every queued
 * edit, saving while the request is in flight, saved on success (with a
 * fade), and a STICKY (non-auto-hiding) error state on failure so a real
 * save failure is never mistaken for "saved" or silently missed.
 *
 * Static source-text check — no frontend test runner in this repo (see
 * frontendXssGuards.test.ts / roleCanon.test.ts for the same pattern).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dirname, "..", "..", "frontend");

function readVyneClient(): string {
  return readFileSync(join(FRONTEND, "vyne-client.js"), "utf8");
}

describe("vyne-client.js — save indicator (v5.32.7)", () => {
  it("defines the four real lifecycle states, not a decorative always-saved pill", () => {
    const src = readVyneClient();
    expect(src).toContain("function setSaveIndicator(state)");
    expect(src).toMatch(/pending:\s*\{[^}]*text:\s*"Unsaved changes"/);
    expect(src).toMatch(/saving:\s*\{[^}]*text:\s*"Saving…"/);
    expect(src).toMatch(/saved:\s*\{[^}]*text:\s*"Saved"/);
    expect(src).toMatch(/error:\s*\{[^}]*text:\s*"Not saved — retrying"/);
  });

  it("scheduleFlush() marks pending the moment an edit is queued", () => {
    const src = readVyneClient();
    const fn = src.match(/function scheduleFlush\(\)\s*\{([\s\S]*?)\n  \}/);
    expect(fn, "expected to find scheduleFlush()").toBeTruthy();
    expect(fn![1]).toContain('setSaveIndicator("pending")');
  });

  it("flush() marks saving before the request and saved/error after it resolves", () => {
    const src = readVyneClient();
    const fn = src.match(/function flush\(\)\s*\{([\s\S]*?)\n  \}\n\n  \/\/ Guaranteed delivery/);
    expect(fn, "expected to find flush()").toBeTruthy();
    const body = fn![1];
    expect(body).toContain('setSaveIndicator("saving")');
    expect(body).toContain('setSaveIndicator("saved")');
    // Both failure paths — a non-ok HTTP status AND a network-level
    // rejection — must surface the error state, not just log to console
    // where nobody but a developer would ever see it.
    const httpErrorBranch = body.match(/if \(!r\.ok\) \{([\s\S]*?)\}/);
    expect(httpErrorBranch![1]).toContain('setSaveIndicator("error")');
    const catchBranch = body.split(".catch(function (e) {")[1] ?? "";
    expect(catchBranch).toContain('setSaveIndicator("error")');
  });

  it("the error state does not auto-hide — only 'saved' schedules a fade-out timer", () => {
    const src = readVyneClient();
    const fn = src.match(/function setSaveIndicator\(state\)\s*\{([\s\S]*?)\n  \}/);
    const body = fn![1];
    // The only conditional hide-timer scheduling in this function must be
    // gated on the 'saved' state specifically.
    expect(body).toMatch(/if \(state === "saved"\) \{\s*saveIndicatorHideTimer = setTimeout/);
  });

  it("the indicator is skipped on the pre-login shell, where vyneStore never runs", () => {
    const src = readVyneClient();
    const fn = src.match(/function ensureSaveIndicator\(\)\s*\{([\s\S]*?)\n  \}/);
    expect(fn![1]).toContain("if (saveIndicatorEl || isShell) return saveIndicatorEl;");
  });
});

describe("unload handling is registered exactly once (v5.32.59, L2)", () => {
  it("pagehide and visibilitychange each have a single listener", () => {
    const src = readFileSync(join(__dirname, "..", "..", "frontend", "vyne-client.js"), "utf8");
    /* Two pagehide handlers meant the synchronous flushNow() drained the queue
     * and bumped every version, then the async flush() re-sent the same
     * payload with the PRE-bump version — a 409 against our own write, on a
     * page that is unloading, answered by re-hydrating and re-queueing work
     * nobody is there to send. */
    const pagehide = src.match(/addEventListener\("pagehide"/g) ?? [];
    const visibility = src.match(/addEventListener\("visibilitychange"/g) ?? [];
    expect(pagehide).toHaveLength(1);
    expect(visibility).toHaveLength(1);
    // The one that survives must be the SYNCHRONOUS drain — an async flush on
    // pagehide is not guaranteed to be sent at all.
    expect(src).toContain('window.addEventListener("pagehide", flushNow);');
  });
});
