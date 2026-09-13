/**
 * v5.34.56 — the firm's "Client API keys" tab, driven in a real browser.
 *
 * This is the page whose markup was inserted inside a <script> block earlier
 * today. Every static assertion still passed. A browser would have rendered the
 * rest of the file's JavaScript as visible text.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openPage, pageErrors, skipBrowser, type Harness } from "./harness.js";

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

const stub = (over: any = {}) => (req: { method: string; url: string; body: any }) => {
  if (req.url.startsWith("/api/byok/keys/disable")) return over.disable ?? { body: { ok: true } };
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

  it("a key that is not active says plainly that the firm is paying", async () => {
    h = await openKeys();
    await h.page.waitForSelector("#byok-list table tbody tr");
    const second = await h.page.$$eval("#byok-list tbody tr", (trs) =>
      trs[1].querySelectorAll("td")[2].textContent);
    expect(second).toMatch(/failed — running on your key/);
  });

  it("only an active key offers a way to turn it off", async () => {
    h = await openKeys();
    await h.page.waitForSelector("#byok-list table tbody tr");
    const links = await h.page.$$eval("#byok-list tbody tr", (trs) =>
      trs.map((tr) => !!tr.querySelector("a")));
    expect(links).toEqual([true, false]);
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

    await h.page.fill("#byok-client", "Nestlé");
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
