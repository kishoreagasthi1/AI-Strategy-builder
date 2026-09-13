/**
 * Cloud Error Reporting (v5.32.70) — src/monitoring/errorReporting.ts and the
 * captureError fan-out in src/monitoring/errors.ts.
 *
 * WHAT MAKES THIS WORTH TESTING. This integration is a magic string. Error
 * Reporting ingests a Cloud Logging entry only if it carries exactly
 * `type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent`,
 * and grouping is only useful if `message` carries a stack trace. Every way of
 * getting those subtly wrong fails the same way the bug this replaces failed:
 * silently, with the app apparently fine and nobody being told anything.
 *
 * A test that asserted "reportError does not throw" would pass with the @type
 * key misspelled, with the stack omitted, with the payload written across two
 * lines, and with the whole thing disabled. So these assert the bytes that
 * reach stdout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initErrorReporting, reportError, buildReportedErrorEvent,
  isErrorReportingActive, _resetForTests,
} from "../src/monitoring/errorReporting.js";

const TYPE = "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent";

/** Capture what actually goes to stdout — the real integration surface. */
function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("Cloud Error Reporting — off unless enabled", () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  it("is inert outside production, so a test run never files a real issue", () => {
    initErrorReporting({ service: "vyne-api", version: "5.32.70", enabled: false });
    expect(isErrorReportingActive()).toBe(false);
    const out = captureStdout();
    reportError(new Error("boom"));
    out.restore();
    expect(out.lines).toHaveLength(0);
  });

  it("never throws, whatever it is handed", () => {
    initErrorReporting({ service: "vyne-api", version: "5.32.70", enabled: true });
    const out = captureStdout();
    expect(() => reportError(new Error("boom"))).not.toThrow();
    expect(() => reportError("a string")).not.toThrow();
    expect(() => reportError(null)).not.toThrow();
    expect(() => reportError(undefined)).not.toThrow();
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(() => reportError(new Error("boom"), circular)).not.toThrow();
    out.restore();
  });
});

describe("Cloud Error Reporting — the payload Google actually needs", () => {
  beforeEach(() => {
    _resetForTests();
    initErrorReporting({ service: "vyne-api", version: "5.32.70", enabled: true });
  });
  afterEach(() => _resetForTests());

  it("carries the exact @type marker — the whole integration is this string", () => {
    const e = buildReportedErrorEvent(new Error("boom"));
    expect(e["@type"]).toBe(TYPE);
    expect(e.severity).toBe("ERROR");
  });

  it("puts the STACK TRACE in message, not just the text", () => {
    // Without the stack, Error Reporting files every occurrence as a separate
    // issue and the console becomes a flat list rather than a count.
    const err = new Error("database is on fire");
    const e = buildReportedErrorEvent(err);
    expect(String(e.message)).toContain("database is on fire");
    expect(String(e.message)).toContain("errorReporting.test");
    expect(String(e.message).split("\n").length).toBeGreaterThan(1);
  });

  it("names the service and release, so a regression is dateable", () => {
    const e = buildReportedErrorEvent(new Error("boom"));
    expect(e.serviceContext).toEqual({ service: "vyne-api", version: "5.32.70" });
  });

  it("degrades sanely for a non-Error — a string, a null, an object", () => {
    expect(String(buildReportedErrorEvent("plain string").message)).toBe("plain string");
    expect(String(buildReportedErrorEvent({ code: 42 }).message)).toContain("42");
    expect(() => buildReportedErrorEvent(null)).not.toThrow();
  });

  it("scrubs query strings out of context, exactly like the Sentry path", () => {
    // A consulting product's URLs name the CUSTOMER'S customers. Logs are read
    // by more people than a monitoring console is, so staying inside GCP does
    // not make a client name in an error payload safe.
    const e = buildReportedErrorEvent(new Error("boom"), {
      url: "/api/solution-design?client=Acme%20Manufacturing",
      referer: "https://app/roadmap?code=ACME01",
      tenantId: "t-1",
    });
    const ctx = e.context as Record<string, unknown>;
    expect(ctx.url).toBe("/api/solution-design");
    expect(ctx.referer).toBe("https://app/roadmap");
    expect(ctx.tenantId).toBe("t-1");
    expect(JSON.stringify(e)).not.toContain("Acme");
    expect(JSON.stringify(e)).not.toContain("ACME01");
  });

  /* ── The message and stack, scrubbed (v5.33.3, audit HIGH) ──────────────
   *
   * redactFreeText() shipped attached to Sentry's beforeSend and to nothing
   * else, while this file's own header claimed "the same scrubbing as the
   * Sentry path applies". The two sinks are NOT symmetric: initErrorReporting
   * is unconditional in production, Sentry needs SENTRY_DSN, and this project's
   * v5.32.69 preflight found that DSN UNSET. So the only live sink in
   * production was the unscrubbed one, and the doc comment was the entire
   * defence.
   *
   * REVERT TEST: change `message: redactFreeText(message)` back to `message`
   * in buildReportedErrorEvent and the three cases below fail.
   */
  it("redacts an email address out of the message", () => {
    const e = buildReportedErrorEvent(new Error("no membership for kishore.agasthi@gmail.com"));
    expect(String(e.message)).toContain("[email]");
    expect(String(e.message)).not.toContain("kishore.agasthi@gmail.com");
  });

  it("redacts a query string carried in a STACK FRAME, not just in the text", () => {
    // The realistic shape: the identity is several lines BELOW the message, in
    // a frame. Scrubbing only the first line would pass a naive test and leak
    // in production. The two forms that actually occur are an outbound
    // https:// URL (undici/fetch frames) and one of our own /api/ paths.
    const err = new Error("request failed");
    err.stack = [
      "Error: request failed",
      "    at fetch (https://app.vyne.example/roadmap?client=Acme%20Manufacturing:11:2)",
      "    at route (/api/solution-design?code=ACME01&email=a@b.com:4:9)",
    ].join("\n");
    const e = buildReportedErrorEvent(err);
    expect(String(e.message)).not.toContain("Acme");
    expect(String(e.message)).not.toContain("ACME01");
    expect(String(e.message)).not.toContain("a@b.com");
    // ...while the frames themselves survive, or the trace stops being usable
    // and Error Reporting stops grouping on it.
    expect(String(e.message)).toContain("https://app.vyne.example/roadmap");
    expect(String(e.message)).toContain("/api/solution-design");
    expect(String(e.message)).toContain("at fetch");
  });

  it("states the scrubber's boundary rather than implying it has none", () => {
    /* redactFreeText strips a query string only from an https:// URL or one of
     * our /api/ paths — see its definition in sentry.ts. A query string on some
     * OTHER absolute path is not touched:
     *
     *     "/app/roadmap?client=Acme"   →   unchanged
     *
     * That is a deliberate boundary, not an oversight: broadening the pattern
     * to any `/path?…` makes an ordinary sentence containing a question mark
     * ("check /docs for help? yes") redact its own tail, and a scrubber that
     * eats error text is how people turn scrubbing off. Both shapes that carry
     * identity in practice — outbound fetch URLs and our own routes — are
     * covered by the case above.
     *
     * Written down because the alternative is somebody rediscovering it as a
     * finding, and because an email inside such a path IS still removed, which
     * makes the gap narrower than it first looks. */
    const e = buildReportedErrorEvent(new Error("navigating to /app/roadmap?client=Acme&u=a@b.com"));
    expect(String(e.message)).toContain("[email]");     // the email still goes
    expect(String(e.message)).toContain("Acme");        // the query string does not
  });

  it("redacts a Postgres parameter dump, which quotes the bound values", () => {
    const e = buildReportedErrorEvent(
      new Error(`insert failed - parameters: ['Acme Manufacturing', 'ENG-ACME-0001']`)
    );
    expect(String(e.message)).toContain("parameters: [redacted]");
    expect(String(e.message)).not.toContain("Acme Manufacturing");
  });

  it("scrubs a context value whose KEY does not look url-ish", () => {
    // The other half of the gap: only keys matching /url|uri|referer/ were
    // touched, so `{ detail: "... a@b.com" }` went through untouched.
    const e = buildReportedErrorEvent(new Error("boom"), {
      detail: "client_not_assigned for owner@firm.com",
      tenantId: "t-1",
    });
    const ctx = e.context as Record<string, unknown>;
    expect(ctx.detail).toBe("client_not_assigned for [email]");
    expect(ctx.tenantId).toBe("t-1");
  });

  it("still reports enough to act on — this is redaction, not deletion", () => {
    // A scrubbed-to-nothing error is an error nobody can fix, and would be the
    // obvious wrong way to make the assertions above pass.
    const e = buildReportedErrorEvent(new Error("database is on fire"));
    expect(String(e.message)).toContain("database is on fire");
    expect(String(e.message)).toContain("errorReporting.test");
  });

  it("writes ONE line, so Cloud Logging parses it as one structured entry", () => {
    // A multi-line write is ingested as several unrelated text entries and the
    // @type marker is lost with them — the failure is total and silent.
    const out = captureStdout();
    reportError(new Error("multi\nline\nmessage"));
    out.restore();
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].endsWith("\n")).toBe(true);
    expect(out.lines[0].trimEnd()).not.toContain("\n");
    const parsed = JSON.parse(out.lines[0]);
    expect(parsed["@type"]).toBe(TYPE);
  });
});

/**
 * The SINK PARITY guard (v5.33.3).
 *
 * The audit finding was not "errorReporting.ts forgot a call". It was that
 * captureError() fans out to two sinks, a scrub was added to one of them, and
 * nothing anywhere could tell. The instance is fixed above; this is the class.
 *
 * Deliberately a source-level assertion. A behavioural test would have to
 * enumerate every shape redactFreeText removes and assert it on both paths —
 * which is a test that passes while the NEXT redaction rule is added to one
 * sink only, i.e. the same failure again. What has to be true is simpler:
 * both sinks run the same scrubber.
 */
describe("both error sinks run the same scrub (v5.33.3, audit HIGH)", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "monitoring");

  it("errorReporting.ts puts the message through redactFreeText", () => {
    const src = readFileSync(join(SRC, "errorReporting.ts"), "utf8");
    expect(src).toContain("redactFreeText");
    // Specifically on `message`, which IS the stack trace — not merely imported
    // and used on something incidental.
    expect(src).toMatch(/message:\s*redactFreeText\(message\)/);
  });

  it("sentry.ts still puts the message and the frames through it", () => {
    const src = readFileSync(join(SRC, "sentry.ts"), "utf8");
    expect(src).toMatch(/event\.message\s*=\s*redactFreeText\(event\.message\)/);
    expect(src).toMatch(/ex\.value\s*=\s*redactFreeText\(ex\.value\)/);
  });

  it("the fan-out reaches exactly the two sinks this file has checked", () => {
    /* monitoring/errors.ts is the single entry point — every route, the error
     * handler and the process-level handlers call captureError() and nothing
     * else. A THIRD sink added there would inherit no scrubbing and nothing
     * would say so, which is the shape of the finding this block exists for.
     *
     * (Written against errors.ts. The first draft of this test read sentry.ts,
     * whose own captureError only talks to Sentry — a guard pointed at the
     * wrong file, which is its own small instance of the same lesson.) */
    const src = readFileSync(join(SRC, "errors.ts"), "utf8");
    const fn = src.slice(src.indexOf("export function captureError"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    const sinks = [...body.matchAll(/\b(captureToSentry|reportToCloud)\s*\(/g)].map((m) => m[1]);
    expect(
      [...new Set(sinks)].sort(),
      "captureError fans out to a sink this file does not know about — " +
      "check that it scrubs, then account for it here"
    ).toEqual(["captureToSentry", "reportToCloud"]);
  });
});

describe("captureError fans out to every sink (v5.32.70)", () => {
  beforeEach(() => { vi.resetModules(); _resetForTests(); });
  afterEach(() => { vi.resetModules(); _resetForTests(); });

  it("reports to Cloud Error Reporting with NO Sentry DSN configured", async () => {
    // The v5.32.69 production state exactly: SENTRY_DSN unset. captureError
    // was a total no-op, so a lost billing row told nobody. That must not be
    // reachable again.
    const { initErrorReporting: init } = await import("../src/monitoring/errorReporting.js");
    const { captureError } = await import("../src/monitoring/errors.js");
    init({ service: "vyne-api", version: "5.32.70", enabled: true });

    const out = captureStdout();
    captureError(new Error("metering write FAILED"), { where: "safeMeter", tenantId: "t-9" });
    out.restore();

    expect(out.lines).toHaveLength(1);
    const parsed = JSON.parse(out.lines[0]);
    expect(parsed["@type"]).toBe(TYPE);
    expect(String(parsed.message)).toContain("metering write FAILED");
    expect((parsed.context as Record<string, unknown>).tenantId).toBe("t-9");
  });

  it("one sink failing does not cost us the other", async () => {
    const { initErrorReporting: init } = await import("../src/monitoring/errorReporting.js");
    const { captureError } = await import("../src/monitoring/errors.js");
    init({ service: "vyne-api", version: "5.32.70", enabled: true });

    // Sentry inactive and stdout throwing: captureError still must not throw.
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw new Error("stdout is gone");
    });
    expect(() => captureError(new Error("boom"))).not.toThrow();
    spy.mockRestore();
  });
});
