/**
 * v5.34.56 — the client-facing key page, driven in a real browser.
 *
 * These are the checks that were being done by hand: does the page load, does
 * the button enable at the right moment, does the key actually get posted, does
 * the success state appear, does the key leave the DOM.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { openPage, pageErrors, skipBrowser, type Harness, type StubHandler } from "./harness.js";

const SKIP = skipBrowser();

/*
 * Taken from the route module rather than retyped (v5.34.62).
 *
 * It was a copy of the wording, and the copy went stale the moment the real
 * text changed — this page renders whatever the API sends, so the test went on
 * passing against a sentence the product no longer uses. Importing it means
 * this test always exercises the words a client is actually shown.
 */
import { ATTESTATION_TEXT } from "../../src/routes/byok.js";

import { BROWSER_TEST_TIMEOUT_MS, BROWSER_HOOK_TIMEOUT_MS } from "./harness.js";
/* Real browser work does not fit vitest's 5s default — see harness.ts. */
vi.setConfig({ testTimeout: BROWSER_TEST_TIMEOUT_MS, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });
const ATTEST = ATTESTATION_TEXT["gemini-aistudio"];

const okInvite = {
  clientName: "Nestlé", provider: "gemini-aistudio",
  attestationText: ATTEST, expiresAt: new Date(Date.now() + 8.64e7).toISOString(),
};

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const open = (stub: StubHandler, query = "?t=" + "a".repeat(43)) =>
  openPage({ file: "byok.html", query, stub, session: null });

describe.skipIf(SKIP)("v5.34.56 — byok.html in a browser", () => {
  it("shows the client name, the vendor and the exact wording being agreed to", async () => {
    h = await open(() => ({ body: okInvite }));
    await h.page.waitForSelector("#form", { state: "visible" });

    expect(await h.page.textContent("#client")).toBe("Nestlé");
    expect(await h.page.textContent("#vendor")).toBe("Google AI");
    expect(await h.page.textContent("#attest-text")).toBe(ATTEST);
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("the submit button stays disabled until key, email AND the tick are all present", async () => {
    // The behaviour a string search cannot see, and the one that matters: a
    // client must not be able to submit without the attestation.
    h = await open(() => ({ body: okInvite }));
    await h.page.waitForSelector("#form", { state: "visible" });
    const disabled = () => h!.page.getAttribute("#go", "disabled");

    expect(await disabled()).not.toBeNull();
    await h.page.fill("#key", "AQ.a-real-looking-key");
    expect(await disabled()).not.toBeNull();
    await h.page.fill("#email", "admin@nestle.com");
    expect(await disabled()).not.toBeNull();   // still — no attestation
    await h.page.check("#attest");
    expect(await disabled()).toBeNull();       // only now

    // And unticking must put it back.
    await h.page.uncheck("#attest");
    expect(await disabled()).not.toBeNull();
  });

  it("a malformed email keeps the button disabled", async () => {
    h = await open(() => ({ body: okInvite }));
    await h.page.waitForSelector("#form", { state: "visible" });
    await h.page.fill("#key", "AQ.a-real-looking-key");
    await h.page.fill("#email", "not-an-email");
    await h.page.check("#attest");
    expect(await h.page.getAttribute("#go", "disabled")).not.toBeNull();
  });

  it("submitting posts the key once, shows success, and clears the field", async () => {
    h = await open((req) =>
      req.method === "POST"
        ? { body: { ok: true, clientName: "Nestlé", provider: "gemini-aistudio" } }
        : { body: okInvite });
    await h.page.waitForSelector("#form", { state: "visible" });
    await h.page.fill("#key", "AQ.super-secret-value-9999");
    await h.page.fill("#email", "admin@nestle.com");
    await h.page.check("#attest");
    await h.page.click("#go");
    await h.page.waitForSelector("#done", { state: "visible" });

    const posts = h.calls.filter((c) => c.method === "POST");
    expect(posts.length).toBe(1);
    expect(posts[0].body.apiKey).toBe("AQ.super-secret-value-9999");
    expect(posts[0].body.attestedByEmail).toBe("admin@nestle.com");
    expect(posts[0].body.paidTierAttested).toBe(true);

    // The key must not survive in the DOM after success.
    expect(await h.page.inputValue("#key")).toBe("");
    expect(await h.page.textContent("#done-client")).toBe("Nestlé");
    expect(await h.page.isVisible("#form")).toBe(false);
  });

  it("a key the server rejects shows the reason and lets them try again", async () => {
    h = await open((req) =>
      req.method === "POST"
        ? { status: 400, body: { error: "key_unusable", detail: "this key cannot start a live voice session" } }
        : { body: okInvite });
    await h.page.waitForSelector("#form", { state: "visible" });
    await h.page.fill("#key", "AQ.no-live-access-here");
    await h.page.fill("#email", "admin@nestle.com");
    await h.page.check("#attest");
    await h.page.click("#go");

    await h.page.waitForSelector("#msg.err", { state: "visible" });
    expect(await h.page.textContent("#msg")).toMatch(/live voice session/);
    // Still usable — not a dead end.
    expect(await h.page.isVisible("#form")).toBe(true);
    expect(await h.page.getAttribute("#go", "disabled")).toBeNull();
  });

  it("an expired or unknown link says so instead of showing a form", async () => {
    h = await open(() => ({ status: 404, body: { error: "invite_not_found_or_expired" } }));
    await h.page.waitForSelector("#dead", { state: "visible" });
    expect(await h.page.isVisible("#form")).toBe(false);
    expect(await h.page.textContent("#dead")).toMatch(/no longer valid/i);
  });

  it("no token at all is treated as a dead link, with no request made", async () => {
    h = await openPage({ file: "byok.html", query: "", stub: () => ({ body: okInvite }), session: null });
    await h.page.waitForSelector("#dead", { state: "visible" });
    expect(h.calls.length).toBe(0);
  });

  it("the Anthropic variant names the right vendor and its own wording", async () => {
    h = await open(() => ({ body: {
      ...okInvite, provider: "anthropic-api",
      attestationText: "I confirm this API key belongs to our organisation's Anthropic account.",
    } }));
    await h.page.waitForSelector("#form", { state: "visible" });
    expect(await h.page.textContent("#vendor")).toBe("Anthropic");
    expect(await h.page.textContent("#keyhint")).toMatch(/console\.anthropic\.com/);
  });

  it("the key input is a password field, so it is not left readable on screen", async () => {
    h = await open(() => ({ body: okInvite }));
    await h.page.waitForSelector("#form", { state: "visible" });
    expect(await h.page.getAttribute("#key", "type")).toBe("password");
  });
});

/* ── the guard itself ─────────────────────────────────────────────────────── */

describe("v5.34.58 — the browser suite must degrade, not explode", () => {
  it("nothing in this directory imports playwright at module load", async () => {
    /*
     * v5.34.55 shipped a top-level `import { chromium } from "playwright-core"`.
     * A top-level import runs at module LOAD, before any describe.skipIf can
     * execute — so on a checkout that had not run `npm install` since the
     * devDependency was added, the suite failed to COLLECT and took deploy.sh
     * down with it. Reported from a real machine, not caught here.
     *
     * The skip guard was written for a missing BROWSER and did not cover a
     * missing PACKAGE, which is the likelier absence by far.
     */
    const { readFileSync, readdirSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));

    for (const f of readdirSync(here).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(here, f), "utf8");
      const valueImports = [...src.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["']playwright[^"']*["']/gm)];
      expect(valueImports.map((m) => m[0]), `${f} imports playwright at module load`).toEqual([]);
    }
  });

  it("reports WHICH prerequisite is missing, so the fix is obvious", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "harness.ts"), "utf8");
    expect(src).toContain("npm install");
    expect(src).toContain("no Chromium on this machine");
  });
});
