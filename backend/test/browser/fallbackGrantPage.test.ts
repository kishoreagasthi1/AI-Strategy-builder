/**
 * The fallback-grant panel, and the refusal a consultant will actually meet.
 * (v5.34.64)
 *
 * Driven in a browser rather than asserted about the API, because both things
 * under test here are things a person reads. The first is an empty state whose
 * ABSENCE is the behaviour — no grants means BYOK clients' work stops — and an
 * empty state that says "none configured" would leave that invisible. The
 * second is a 409 whose useful content is in `detail`; the page printed
 * `error` until this release, which would have read "Could not save:
 * vendor_not_keyed".
 */
import { describe, it, expect, afterEach } from "vitest";
import { openPage, pageErrors, skipBrowser, type Harness } from "./harness.js";

const SKIP = skipBrowser();

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const GRANT = {
  clientName: "Nestlé", reason: "pilot, procurement pending",
  grantedAt: "2026-09-13T02:00:00.000Z",
};

const NOT_KEYED = {
  error: "vendor_not_keyed",
  detail: "ZZ BYOK Test supplies their own Google (Gemini) key, so their work runs on that provider "
    + "and is billed to them. Preferring Anthropic (Claude) would mean running their work on your "
    + "account instead. Ask them for an Anthropic (Claude) key, or grant fallback for this client first.",
};

const stub = (over: { grants?: unknown[]; routingStatus?: number } = {}) =>
  (req: { method: string; url: string; body: any }) => {
    if (req.url.startsWith("/api/byok/fallback-grants/revoke")) return { body: { ok: true } };
    if (req.url.startsWith("/api/byok/fallback-grants")) {
      if (req.method === "POST") return { body: { grant: req.body } };
      return { body: { grants: over.grants ?? [] } };
    }
    if (req.url.startsWith("/api/client-routing")) {
      if (req.method === "POST" && over.routingStatus === 409) {
        return { status: 409, body: NOT_KEYED };
      }
      if (req.method === "POST") return { body: { routing: req.body } };
      return { body: { routing: [] } };
    }
    if (req.url.startsWith("/api/byok/invites")) return { body: { invites: [] } };
    if (req.url.startsWith("/api/byok/keys")) return { body: { keys: [] } };
    if (req.url.startsWith("/api/billing/summary")) return { body: { clients: [], from: null, to: null } };
    return { body: {} };
  };

const openKeys = async (over: any = {}) => {
  const harness = await openPage({ file: "billing.html", stub: stub(over) });
  await harness.page.click("#tab-btn-keys");
  await harness.page.waitForTimeout(400);
  return harness;
};

describe.skipIf(SKIP)("v5.34.64 — the fallback grant panel", () => {
  it("states the default behaviour rather than just 'none configured'", async () => {
    h = await openKeys({ grants: [] });
    const text = await h.page.$eval("#grant-list", (el) => el.textContent || "");
    // The empty state has to carry the consequence, because the empty state IS
    // the behaviour: work stops, and the firm is not billed.
    expect(text).toMatch(/their work stops/i);
    expect(text).toMatch(/nothing is charged to you/i);
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("explains what granting costs, in money, before anyone grants anything", async () => {
    h = await openKeys();
    const text = await h.page.$eval("#pane-keys", (el) => el.textContent || "");
    expect(text).toMatch(/on your key and your bill/i);
    // Live audio is the expensive case and the number belongs on screen.
    expect(text).toMatch(/\$2 for 90 minutes/i);
  });

  it("says on the keys panel that a client's key failing stops their work", async () => {
    h = await openKeys();
    const text = await h.page.$eval("#pane-keys", (el) => el.textContent || "");
    expect(text).toMatch(/runs on their key alone/i);
    expect(text).toMatch(/does not quietly move onto your account/i);
  });

  it("refuses to grant without a client name, and posts nothing", async () => {
    h = await openKeys();
    await h.page.click("#pane-keys button:has-text('Grant fallback')");
    await h.page.waitForTimeout(300);
    expect(await h.page.textContent("#grant-msg")).toMatch(/Enter the client name first/i);
    expect(h.calls.some((c) => c.method === "POST" && c.url.startsWith("/api/byok/fallback-grants")))
      .toBe(false);
  });

  it("posts the client and reason, and confirms the consequence", async () => {
    h = await openKeys();
    await h.page.fill("#grant-client", "Nestlé");
    await h.page.fill("#grant-reason", "pilot, procurement pending");
    await h.page.click("#pane-keys button:has-text('Grant fallback')");
    await h.page.waitForTimeout(500);

    const post = h.calls.find((c) => c.method === "POST" && c.url === "/api/byok/fallback-grants");
    expect(post, "no grant was posted").toBeTruthy();
    expect(post!.body).toMatchObject({ clientName: "Nestlé", reason: "pilot, procurement pending" });
    // Not "Saved." — the confirmation restates what was agreed to.
    expect(await h.page.textContent("#grant-msg")).toMatch(/the cost lands on your bill/i);
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("lists a grant with its reason and offers to withdraw it", async () => {
    h = await openKeys({ grants: [GRANT] });
    await h.page.waitForSelector("#grant-list table tbody tr");
    const row = await h.page.$$eval("#grant-list tbody tr td",
      (tds) => tds.map((td) => td.textContent?.trim()));
    expect(row[0]).toBe("Nestlé");
    expect(row[1]).toBe("pilot, procurement pending");
    expect(row.at(-1)).toBe("withdraw");
  });

  it("withdrawing asks first, and says what will happen instead", async () => {
    h = await openKeys({ grants: [GRANT] });
    await h.page.waitForSelector("#grant-list table tbody tr");
    let asked = "";
    await h.page.evaluate(() => {
      (window as any).__asked = "";
      (window as any).confirm = (m: string) => { (window as any).__asked = m; return true; };
    });
    await h.page.click("#grant-list tbody tr td:last-child a");
    await h.page.waitForTimeout(400);
    asked = await h.page.evaluate(() => (window as any).__asked);

    expect(asked).toMatch(/their work will stop/i);
    const revoke = h.calls.find((c) => c.url.startsWith("/api/byok/fallback-grants/revoke"));
    expect(revoke, "no revoke call was made").toBeTruthy();
    expect(revoke!.body.clientName).toBe("Nestlé");
  });

  it("a client name from the database is escaped, never interpolated", async () => {
    h = await openKeys({
      grants: [{ clientName: "<img src=x onerror=alert(1)>",
                 reason: "<script>alert(2)</script>", grantedAt: null }],
    });
    await h.page.waitForSelector("#grant-list table tbody tr");
    expect(await h.page.$$eval("#grant-list img", (els) => els.length)).toBe(0);
    expect(await h.page.$$eval("#grant-list script", (els) => els.length)).toBe(0);
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("appears for a firm with no keys on file at all", async () => {
    // The v5.34.63 early-return regression, which hid two panels from exactly
    // the firms that had not set a key up yet. A third panel now hangs off the
    // same loader, so the same mistake is available again.
    h = await openKeys({ grants: [GRANT] });
    await h.page.waitForSelector("#grant-list table tbody tr");
    expect(await h.page.$$eval("#grant-list tbody tr", (trs) => trs.length)).toBe(1);
  });
});

describe.skipIf(SKIP)("v5.34.64 — a preference the client cannot pay for", () => {
  it("shows the server's explanation, not the error code", async () => {
    /*
     * The page used to print `d.error`, so this refusal would have read
     * "Could not save: vendor_not_keyed" — a wire value, with neither the
     * consequence nor the remedy.
     */
    h = await openKeys({ routingStatus: 409 });
    await h.page.fill("#route-client", "ZZ BYOK Test");
    await h.page.selectOption("#route-vendor", "anthropic-api");
    await h.page.click("#pane-keys button:has-text('Save preference')");
    await h.page.waitForTimeout(500);

    const msg = await h.page.textContent("#route-msg");
    expect(msg).not.toContain("vendor_not_keyed");
    expect(msg).toMatch(/billed to them/i);
    expect(msg).toMatch(/grant fallback for this client first/i);
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("explains the boundary before anyone hits it", async () => {
    h = await openKeys();
    const text = await h.page.$eval("#pane-keys", (el) => el.textContent || "");
    expect(text).toMatch(/only be pointed at a provider/i);
    expect(text).toMatch(/move their work onto your bill/i);
  });
});
