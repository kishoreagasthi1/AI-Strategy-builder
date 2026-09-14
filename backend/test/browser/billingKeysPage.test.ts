/**
 * v5.34.56 — the firm's "Client API keys" tab, driven in a real browser.
 *
 * This is the page whose markup was inserted inside a <script> block earlier
 * today. Every static assertion still passed. A browser would have rendered the
 * rest of the file's JavaScript as visible text.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { openPage, pageErrors, skipBrowser, type Harness } from "./harness.js";

import { BROWSER_TEST_TIMEOUT_MS, BROWSER_HOOK_TIMEOUT_MS } from "./harness.js";
/* Real browser work does not fit vitest's 5s default — see harness.ts. */
vi.setConfig({ testTimeout: BROWSER_TEST_TIMEOUT_MS, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });

const SKIP = skipBrowser();

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const KEYS = [
  { clientName: "Nestlé", clientNorm: "nestle", provider: "gemini-aistudio", status: "active",
    keyHint: "wxyz", attestedByEmail: "admin@nestle.com", paidTierAttested: true,
    secretName: "projects/p/secrets/s", verifiedAt: null, attestedAt: null, probe: null },
  { clientName: "Acme Corp", clientNorm: "acmecorp", provider: "anthropic-api", status: "failed",
    keyHint: "1234", attestedByEmail: "it@acme.com", paidTierAttested: true,
    secretName: "projects/p/secrets/t", verifiedAt: null, attestedAt: null, probe: null },
];

/** KEYS[0], for the single-row cases below. */
const KEY = KEYS[0];

const stub = (over: any = {}) => (req: { method: string; url: string; body: any }) => {
    // v5.34.67: the client fields are pickers now, so the stub has to offer the
    // client this test selects. Free text is gone — see keysTabGating.test.ts.
    if (req.url.startsWith("/api/byok/clients")) return { body: { clients: [{ clientName: "Nestlé", registered: true }, { clientName: "Acme Industrial", registered: true }] } };
  if (req.url.startsWith("/api/byok/keys/disable")) return over.disable ?? { body: { ok: true } };
  if (req.url.startsWith("/api/byok/keys/enable")) return over.enable ?? { body: { ok: true } };
  if (req.url.startsWith("/api/byok/keys")) return over.keys ?? { body: { keys: KEYS } };
  if (req.url.startsWith("/api/byok/invites")) {
    return over.invite ?? { body: {
      url: "https://app.example/byok.html?t=TOKEN123", expiresAt: new Date().toISOString(),
      clientName: "Nestlé", provider: "gemini-aistudio",
      attestationText: "I confirm this API key belongs to a billed project.",
    } };
  }
  if (req.url.startsWith("/api/billing/summary")) return { body: { clients: [], from: null, to: null } };
  return { body: {} };
};

const openKeys = async (over: any = {}) => {
  const harness = await openPage({ file: "billing.html", stub: stub(over) });
  await harness.page.click("#tab-btn-keys");
  return harness;
};

describe.skipIf(SKIP)("v5.34.56 — billing.html Client API keys tab", () => {
  it("the page loads with no uncaught JavaScript error", async () => {
    /*
     * The check that would have caught the stranded-markup bug outright: with
     * the pane inside <script>, the rest of the file's code becomes text, so
     * switchTab is never defined and clicking the tab throws.
     */
    h = await openPage({ file: "billing.html", stub: stub() });
    expect(pageErrors(h.page)).toEqual([]);
    expect(await h.page.isVisible("#tab-btn-keys")).toBe(true);
  });

  it("switching to the tab fetches the keys and renders a row per key", async () => {
    h = await openKeys();
    await h.page.waitForSelector("#byok-list table tbody tr");

    const rows = await h.page.$$eval("#byok-list tbody tr", (trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim())));
    expect(rows.length).toBe(2);
    expect(rows[0][0]).toBe("Nestlé");
    expect(rows[0][2]).toBe("active");
    expect(rows[0][3]).toBe("••••wxyz");
    expect(rows[0][4]).toBe("admin@nestle.com");
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("a REFUSED key says the client's work is stopping — not that the firm is paying", async () => {
    /*
     * v5.34.69 corrected this, and the old assertion is why it is worth a note.
     *
     * It read `/failed — running on your key/`, because that is what the screen
     * said about every non-active status. For `disabled` it was true. For
     * `failed` it became FALSE in v5.34.64: a refused key means the client's
     * work STOPS unless a fallback grant covers them. So the one screen built
     * to tell an Owner who is paying was telling them the opposite, and this
     * test was holding it in place.
     */
    h = await openKeys();
    await h.page.waitForSelector("#byok-list table tbody tr");
    const second = await h.page.$$eval("#byok-list tbody tr", (trs) =>
      trs[1].querySelectorAll("td")[2].textContent);
    expect(second).toMatch(/refused — their work is stopping/);
    expect(second).not.toMatch(/running on your key/);
    // And what to do about it, since "stopping" without a remedy is just alarm.
    expect(second).toMatch(/new setup link|grant fallback/i);
  });

  it("a DISABLED key does say the firm is paying, because it is", async () => {
    /*
     * The other half of the distinction. `disabled` is the Owner's own "turn
     * off" — a deliberate move back onto the firm's account — and the label
     * must still say so, or the correction above would just be a new wrong
     * answer applied more widely.
     */
    h = await openKeys({ keys: { body: { keys: [{ ...KEY, status: "disabled", lastError: null }] } } });
    await h.page.waitForSelector("#byok-list table tbody tr");
    const st = await h.page.$$eval("#byok-list tbody tr td",
      (tds) => tds[2].textContent || "");
    expect(st).toMatch(/disabled — running on your key/);
  });

  it("a disabled key can be turned back ON", async () => {
    /*
     * v5.34.69. "turn off" shipped without a "turn on": the only route back was
     * a fresh setup link and the CLIENT's administrator pasting their key
     * again — a round trip to the client to undo a click the firm made on its
     * own screen. Nothing was ever destroyed, so this is the status flip it
     * always should have been.
     */
    h = await openKeys({ keys: { body: { keys: [{ ...KEY, status: "disabled", lastError: null }] } } });
    await h.page.waitForSelector("#byok-list table tbody tr");
    await h.page.evaluate(() => { (window as any).confirm = () => true; });
    await h.page.click("#byok-list tbody tr a");
    await h.page.waitForTimeout(500);

    const call = h.calls.find((c) => c.url === "/api/byok/keys/enable");
    expect(call, "a disabled key offered no way back").toBeTruthy();
    expect(call!.body).toMatchObject({ clientName: KEY.clientName, provider: KEY.provider });
  });

  it("a REFUSED key offers no 'turn on' — it has to be replaced", async () => {
    // Re-enabling a credential the vendor rejected would show "active" for
    // something that fails on the very next call.
    h = await openKeys({ keys: { body: { keys: [{ ...KEY, status: "failed", lastError: "403 PERMISSION_DENIED" }] } } });
    await h.page.waitForSelector("#byok-list table tbody tr");
    const links = await h.page.$$eval("#byok-list tbody tr a",
      (as) => as.map((a) => a.textContent?.trim()));
    expect(links).not.toContain("turn on");
  });

  it("only an active key offers a way to turn it off", async () => {
    h = await openKeys();
    await h.page.waitForSelector("#byok-list table tbody tr");
    const offs = await h.page.$$eval("#byok-list tbody tr", (trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll("a"))
        .some((a) => a.textContent?.trim() === "turn off")));
    expect(offs).toEqual([true, false]);
  });

  it("turning a key off posts the right client and provider", async () => {
    h = await openKeys();
    await h.page.waitForSelector("#byok-list table tbody tr");
    h.page.on("dialog", (d) => d.accept());
    await h.page.click("#byok-list tbody tr:first-child a");
    await h.page.waitForFunction(() =>
      !!(window as any).__seen || true);
    await h.page.waitForTimeout(200);

    const post = h.calls.find((c) => c.url.includes("/disable"));
    expect(post).toBeTruthy();
    expect(post!.body).toEqual({ clientName: "Nestlé", provider: "gemini-aistudio" });
  });

  it("a client name with markup in it is rendered as text, not as HTML", async () => {
    // The stored-XSS shape. innerHtmlSinks.test.ts reasons about the source;
    // this proves the rendered result.
    h = await openKeys({ keys: { body: { keys: [{
      ...KEYS[0], clientName: "<img src=x onerror=alert(1)>Evil Ltd",
    }] } } });
    await h.page.waitForSelector("#byok-list table tbody tr");
    const imgs = await h.page.$$eval("#byok-list img", (n) => n.length);
    expect(imgs).toBe(0);
    const text = await h.page.$$eval("#byok-list tbody tr td", (t) => t[0].textContent);
    expect(text).toContain("<img");
  });

  it("with no keys on file it explains the default rather than showing an empty table", async () => {
    h = await openKeys({ keys: { body: { keys: [] } } });
    await h.page.waitForSelector("#byok-list .hint");
    expect(await h.page.textContent("#byok-list")).toMatch(/runs on your keys and goes on their statement/);
  });

  it("creating a link requires a client name and then shows the URL", async () => {
    h = await openKeys();
    await h.page.click("#pane-keys button");
    await h.page.waitForSelector("#byok-invite");
    expect(await h.page.textContent("#byok-invite")).toMatch(/Enter the client name first/);
    /*
     * The behaviour under test is that no invite is CREATED without a client
     * name. It used to be written as "no request whose URL contains /invites",
     * which stopped being the same statement in v5.34.61: the keys tab now also
     * GETs /api/byok/invites to list links awaiting a key, so the loose match
     * failed on a read that creates nothing.
     *
     * Narrowed to the POST. A weaker assertion would have been the wrong fix —
     * this one now fails if a creation ever slips through, and does not fail
     * because the page learned to read.
     */
    expect(h.calls.some((c) => c.method === "POST" && c.url.startsWith("/api/byok/invites"))).toBe(false);

    await h.page.selectOption("#byok-client", "Nestlé");
    await h.page.click("#pane-keys button");
    await h.page.waitForSelector("#byok-invite input");
    expect(await h.page.inputValue("#byok-invite input")).toBe("https://app.example/byok.html?t=TOKEN123");
    expect(await h.page.textContent("#byok-invite")).toMatch(/works once and expires in 72 hours/);
  });

  it("a failing API is reported, not swallowed into a blank panel", async () => {
    h = await openKeys({ keys: { status: 500, body: { error: "boom" } } });
    await h.page.waitForSelector("#byok-list .hint");
    expect(await h.page.textContent("#byok-list")).toMatch(/Could not load/);
    expect(pageErrors(h.page)).toEqual([]);
  });
});
