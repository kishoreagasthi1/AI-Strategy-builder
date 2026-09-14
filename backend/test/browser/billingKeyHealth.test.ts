/**
 * The keys screen, when a key is on file but not working. (v5.34.61)
 *
 * This is the screen that said `active` for several minutes on 2026-09-13
 * while every call for that client was silently billed to the firm. The fix is
 * only real if it appears HERE — in the column someone looks at — so it is
 * driven in a browser rather than asserted about the API.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { openPage, pageErrors, skipBrowser, type Harness } from "./harness.js";

import { BROWSER_TEST_TIMEOUT_MS, BROWSER_HOOK_TIMEOUT_MS } from "./harness.js";
/* Real browser work does not fit vitest's 5s default — see harness.ts. */
vi.setConfig({ testTimeout: BROWSER_TEST_TIMEOUT_MS, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });

const SKIP = skipBrowser();

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const KEY = {
  clientName: "Nestlé", clientNorm: "nestle", provider: "gemini-aistudio", status: "active",
  keyHint: "wxyz", attestedByEmail: "admin@nestle.com", paidTierAttested: true,
  secretName: "projects/p/secrets/s", verifiedAt: null, attestedAt: null, probe: null,
  lastError: null as string | null, lastErrorAt: null as string | null,
};

const INVITE = {
  id: "11111111-2222-3333-4444-555555555555",
  clientName: "Acme Corp", provider: "gemini-aistudio",
  sentToEmail: "it@acme.com",
  expiresAt: "2026-09-16T00:00:00.000Z", createdAt: "2026-09-13T00:00:00.000Z",
};

const stub = (over: { keys?: any[]; invites?: any[] } = {}) =>
  (req: { method: string; url: string; body: any }) => {
    if (req.url.startsWith("/api/byok/invites/revoke")) return { body: { ok: true } };
    if (req.url.startsWith("/api/byok/invites")) return { body: { invites: over.invites ?? [] } };
    if (req.url.startsWith("/api/byok/keys")) return { body: { keys: over.keys ?? [KEY] } };
    if (req.url.startsWith("/api/billing/summary")) return { body: { clients: [], from: null, to: null } };
    return { body: {} };
  };

const openKeys = async (over: any = {}) => {
  const harness = await openPage({ file: "billing.html", stub: stub(over) });
  await harness.page.click("#tab-btn-keys");
  return harness;
};

describe.skipIf(SKIP)("v5.34.61 — a key that is on file but not working", () => {
  it("a healthy key still just says active", async () => {
    h = await openKeys();
    await h.page.waitForSelector("#byok-list tbody tr");
    const status = await h.page.$$eval("#byok-list tbody tr td",
      (tds) => tds[2].textContent?.trim());
    expect(status).toBe("active");
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("says plainly when an active key did NOT work, and why", async () => {
    h = await openKeys({
      keys: [{ ...KEY, lastError: "the key could not be read from Secret Manager — check the service account's permissions",
               lastErrorAt: "2026-09-13T00:45:00.000Z" }],
    });
    await h.page.waitForSelector("#byok-list tbody tr");
    const cell = await h.page.$$eval("#byok-list tbody tr td", (tds) => tds[2].textContent || "");

    expect(cell).toContain("active — but not working");
    expect(cell).toContain("Secret Manager");
    // The consequence, in money terms, is the part that makes someone act.
    expect(cell).toMatch(/running on your keys/i);
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("a client's own text is escaped, not interpolated", async () => {
    // lastError is server-authored, but the row beside it carries a client name
    // straight from the database. The page's innerHTML ratchet exists because
    // this table got that wrong once already.
    h = await openKeys({
      keys: [{ ...KEY, clientName: "<img src=x onerror=alert(1)>",
               lastError: "<script>alert(2)</script>", lastErrorAt: null }],
    });
    await h.page.waitForSelector("#byok-list tbody tr");
    const imgs = await h.page.$$eval("#byok-list img", (els) => els.length);
    const scripts = await h.page.$$eval("#byok-list script", (els) => els.length);
    expect(imgs).toBe(0);
    expect(scripts).toBe(0);
    expect(pageErrors(h.page)).toEqual([]);
  });
});

describe.skipIf(SKIP)("v5.34.61 — setup links awaiting a key", () => {
  it("lists a pending link with who it went to and when it expires", async () => {
    h = await openKeys({ invites: [INVITE] });
    await h.page.waitForSelector("#byok-open-invites table tbody tr");
    const row = await h.page.$$eval("#byok-open-invites tbody tr td",
      (tds) => tds.map((td) => td.textContent?.trim()));
    expect(row[0]).toBe("Acme Corp");
    expect(row[2]).toBe("it@acme.com");
    expect(row[4]).toBe("cancel");
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("never renders anything resembling the link itself", async () => {
    // Only the token's hash is stored. A screen that appeared to show a link
    // would be showing something that cannot work — or worse, something that can.
    h = await openKeys({ invites: [INVITE] });
    await h.page.waitForSelector("#byok-open-invites table tbody tr");
    const text = await h.page.$eval("#byok-open-invites", (el) => el.textContent || "");
    expect(text).not.toContain("byok.html?t=");
    expect(text).toMatch(/never stored and cannot be shown again/i);
  });

  it("still appears for a firm with NO keys on file", async () => {
    /*
     * v5.34.63 regression. loadKeys() returned early when the key list was
     * empty, and both this panel and the model-preference panel hung off the
     * end of that function — so they were invisible to exactly the firms that
     * had not set a key up yet, which is the state every firm starts in.
     *
     * Shipped in v5.34.61 and unnoticed because every browser test until now
     * happened to seed a key, and the production check ran against an account
     * that already had one.
     */
    h = await openKeys({ keys: [], invites: [INVITE] });
    await h.page.waitForSelector("#byok-open-invites table tbody tr");
    const rows = await h.page.$$eval("#byok-open-invites tbody tr", (trs) => trs.length);
    expect(rows).toBe(1);
    // And the empty-state for keys is still what it was.
    expect(await h.page.textContent("#byok-list")).toMatch(/No client is using their own key yet/);
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("shows nothing at all when there are no pending links", async () => {
    h = await openKeys({ invites: [] });
    await h.page.waitForSelector("#byok-list tbody tr");
    const text = await h.page.$eval("#byok-open-invites", (el) => el.textContent?.trim());
    expect(text).toBe("");
  });

  it("cancelling posts the id and refreshes the list", async () => {
    h = await openKeys({ invites: [INVITE] });
    await h.page.waitForSelector("#byok-open-invites table tbody tr");
    // The confirm() guard would block the click in a headless browser.
    await h.page.evaluate(() => { (window as any).confirm = () => true; });
    await h.page.click("#byok-open-invites tbody tr td:last-child a");
    await h.page.waitForTimeout(500);

    const revoke = h.calls.find((c) => c.url.startsWith("/api/byok/invites/revoke"));
    expect(revoke, "no revoke call was made").toBeTruthy();
    expect(revoke!.method).toBe("POST");
    expect(revoke!.body.id).toBe(INVITE.id);
    // And the keys list is reloaded, so the cancelled row disappears.
    expect(h.calls.filter((c) => c.url.startsWith("/api/byok/keys")).length).toBeGreaterThan(1);
    expect(pageErrors(h.page)).toEqual([]);
  });
});
