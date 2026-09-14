/**
 * Every callback the PRODUCT PAGE registers can actually fire. (v5.34.94)
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * harnessHooksReal.test.ts already asserts this class of bug — "a callback
 * registered under a name nothing invokes" — but it reads deploy/voice-record.mjs,
 * the voice TEST HARNESS. frontend/interview_agent.html, the page every real
 * interview actually runs in, registers thirty-five callbacks and was guarded by
 * nothing.
 *
 * So the same defect was sitting in production the whole time. `onNote` is a
 * genuine vyne-live.js callback (emitted at transport negotiation:
 * "trying …", "connected via …"), interview_agent.html registered a handler for
 * it, and vyne-live-interview.js — the layer between them — never forwarded it.
 * The handler could not fire. The comment beside it says it exists "so the setup
 * window never reads as a frozen or silent screen"; that progress messaging had
 * never rendered.
 *
 * This is the third time in this codebase: onAgentText (v5.34.77), the
 * agenda/mandatoryCount/askedCount forwarding (v5.34.84), and now onNote. All
 * three have the same signature — the name exists at BOTH ends, so grepping
 * either end alone looks correct, and only the middle is missing.
 *
 * ── Why it keeps happening ──────────────────────────────────────────────────
 *
 * _sessionOpts() is an ALLOWLIST. vyne-live.js invokes `self.opts.X` for
 * whatever X it likes; _sessionOpts decides which of those names exist on the
 * object it builds. Adding a callback to the page is one edit; making it
 * reachable is two. Nothing failed when only the first was made.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fe = join(__dirname, "..", "..", "frontend");
const page = readFileSync(join(fe, "interview_agent.html"), "utf8");
const mid = readFileSync(join(fe, "vyne-live-interview.js"), "utf8");
const live = readFileSync(join(fe, "vyne-live.js"), "utf8");

/** The options literal interview_agent.html passes to vyneLiveInterview.create. */
function pageOptionNames(): string[] {
  const at = page.indexOf("vyneLiveInterview.create({");
  expect(at, "interview_agent.html no longer calls vyneLiveInterview.create({ — update this test")
    .toBeGreaterThan(-1);
  /*
   * Bounded by the matching close of the create() call rather than a fixed
   * window: the literal is ~350 lines of handlers with nested braces, and a
   * character count would silently truncate the list as handlers are added —
   * turning this test into a partial check that still reads as green.
   */
  let depth = 0, end = -1;
  for (let i = page.indexOf("{", at); i < page.length; i++) {
    const c = page[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  expect(end, "could not find the end of the create({...}) literal").toBeGreaterThan(at);
  const body = page.slice(at, end);
  // Top-level keys only: the handlers' own bodies are indented deeper.
  return [...new Set([...body.matchAll(/^\s{4}(on[A-Z][A-Za-z0-9]*)\s*:/gm)].map((m) => m[1]))];
}

/** Callback names vyne-live.js actually emits, i.e. `self.opts.onX(`. */
function emittedByLive(): Set<string> {
  return new Set([...live.matchAll(/self\.opts\.(on[A-Z][A-Za-z0-9]*)\s*\(/g)].map((m) => m[1]));
}

/** Callback names vyne-live-interview.js reads off ITS caller's options. */
function consumedByMiddle(): Set<string> {
  return new Set([...mid.matchAll(/self\.opts\.(on[A-Z][A-Za-z0-9]*)|this\.opts\.(on[A-Z][A-Za-z0-9]*)/g)]
    .map((m) => m[1] ?? m[2]));
}

describe("v5.34.94 — no callback in the interview page is unreachable", () => {
  const pageOpts = pageOptionNames();

  it("the page's option list parsed, and is the size we expect", () => {
    // A parser that silently matches nothing makes every assertion below vacuous.
    expect(pageOpts.length, `only found ${pageOpts.length} handlers — the parser is broken`)
      .toBeGreaterThan(25);
    expect(pageOpts).toContain("onScore");
    expect(pageOpts).toContain("onEnded");
  });

  it("every handler the page registers is consumed by vyne-live-interview.js", () => {
    /*
     * THE assertion. A handler the middle layer never reads is dead however
     * correct it is, and however clearly the far end emits its name.
     */
    const consumed = consumedByMiddle();
    const dead = pageOpts.filter((o) => !consumed.has(o));
    expect(
      dead,
      "interview_agent.html registers these handlers and vyne-live-interview.js never reads them, " +
      "so they can never fire. Either forward them in _sessionOpts()/the callback block, " +
      "or delete them from the page — a handler that cannot fire is worse than no handler, " +
      "because it reads as implemented.",
    ).toEqual([]);
  });

  it("onNote specifically — the one this test was written for", () => {
    /*
     * Named on its own so a regression says which callback broke rather than
     * only that the set changed, and because it is the one with a live user
     * consequence: no connection progress during setup.
     */
    expect(live, "vyne-live.js no longer emits onNote — this test needs revisiting")
      .toMatch(/self\.opts\.onNote\s*\(/);
    expect(mid, "vyne-live-interview.js does not forward onNote; the page's handler is dead again")
      .toMatch(/onNote:\s*function/);
    expect(page).toMatch(/onNote:\s*function/);
  });

  it("every name vyne-live.js emits is either forwarded or deliberately not", () => {
    /*
     * The other direction: vyne-live.js emits a callback that the middle layer
     * does not pass through, so a page CANNOT subscribe to it even if it wants
     * to. Not always a bug — some are for the diagnostics page, which calls
     * vyneLive.start() directly — so those are listed with the reason rather
     * than fixed. The list is the point: it forces the question to be answered
     * once, out loud, instead of by omission.
     */
    const DIRECT_ONLY = new Set([
      // live-check.html subscribes to these by calling vyneLive.start() itself.
      "onFrame",
      "onClose",
      // Transport fallback notice; the interview page shows its own status text
      // and deliberately does not surface transport internals to an interviewee.
      "onFallback",
    ]);
    const emitted = [...emittedByLive()];
    const forwarded = new Set(
      [...mid.matchAll(/^\s{6}(on[A-Z][A-Za-z0-9]*)\s*:/gm)].map((m) => m[1]),
    );
    const unreachable = emitted.filter((n) => !forwarded.has(n) && !DIRECT_ONLY.has(n));
    expect(
      unreachable,
      "vyne-live.js emits these and vyne-live-interview.js does not forward them, so no page " +
      "using vyneLiveInterview can ever receive them. Forward them, or add them to DIRECT_ONLY " +
      "with the reason.",
    ).toEqual([]);
  });
});

describe("v5.34.94 — the harness and the product page do not drift apart", () => {
  /*
   * deploy/voice-record.mjs exists to exercise the live path before a human
   * does. It can only do that for callbacks it actually registers — and every
   * handler it lacks is a code path the 14-minute run cannot reach, which is
   * how the greeting-false-positive and script-exhaustion bugs got as far as a
   * live run before anyone saw them.
   *
   * Advisory rather than strict: the harness legitimately skips UI-only
   * handlers. What it must not do is skip one silently.
   */
  const harness = readFileSync(join(__dirname, "..", "..", "deploy", "voice-record.mjs"), "utf8");

  it("the harness covers the callbacks that carry interview STATE", () => {
    // Not the cosmetic ones — the ones whose failure loses evidence or scores.
    for (const critical of ["onScore", "onTurns", "onEnded", "onScoreError", "onScoringDead"]) {
      expect(harness, `the voice harness does not register ${critical}, so no harness run can exercise it`)
        .toMatch(new RegExp(`${critical}\\s*:`));
    }
  });
});
