/**
 * The model-preference panel, in a real browser. (v5.34.63)
 *
 * The screen has to say what the feature actually does, because the thing it
 * would be easiest to imply is the thing that is not true: a preference does
 * NOT let a client pick any model, and it does NOT change who pays. Both of
 * those confusions cost real time earlier in this release — the keys dropdown
 * described a routing policy the product did not have for five versions.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openPage, pageErrors, skipBrowser, type Harness } from "./harness.js";

const SKIP = skipBrowser();

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const ROUTING = [
  { clientName: "Nestlé", textVendor: "anthropic-api", note: "their CTO asked",
    updatedAt: "2026-09-13T02:00:00.000Z" },
];

const stub = (over: { routing?: unknown[] } = {}) =>
  (req: { method: string; url: string; body: any }) => {
    if (req.url.startsWith("/api/client-routing/clear")) return { body: { ok: true } };
    if (req.url.startsWith("/api/client-routing")) {
      if (req.method === "POST") return { body: { routing: req.body } };
      return { body: { routing: over.routing ?? [] } };
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

describe.skipIf(SKIP)("v5.34.63 — model preference by client", () => {
  it("explains the boundary rather than implying a free choice of model", async () => {
    h = await openKeys();
    const text = await h.page.$eval("#pane-keys", (el) => el.textContent || "");
    // The two claims that must be on screen, because both are counter-intuitive.
    expect(text).toMatch(/reorders the providers you already allow/i);
    expect(text).toMatch(/never changes who pays/i);
    // And why voice is not offered — it is not a policy, it is a capability.
    expect(text).toMatch(/live audio runs on Gemini/i);
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("says plainly when no client has asked for anything", async () => {
    h = await openKeys({ routing: [] });
    const text = await h.page.$eval("#route-list", (el) => el.textContent || "");
    expect(text).toMatch(/follows? your routing policy/i);
  });

  it("lists a stated preference with the vendor named in plain words", async () => {
    h = await openKeys({ routing: ROUTING });
    await h.page.waitForSelector("#route-list table tbody tr");
    const row = await h.page.$$eval("#route-list tbody tr td",
      (tds) => tds.map((td) => td.textContent?.trim()));
    expect(row[0]).toBe("Nestlé");
    // Not the wire value — a consultant should not have to know what
    // "anthropic-api" means.
    expect(row[1]).toBe("Anthropic (Claude)");
    expect(row[2]).toBe("their CTO asked");
    expect(row.at(-1)).toBe("remove");
  });

  it("refuses to save without a client name, and posts nothing", async () => {
    h = await openKeys();
    await h.page.click("#pane-keys button:has-text('Save preference')");
    await h.page.waitForTimeout(300);
    expect(await h.page.textContent("#route-msg")).toMatch(/Enter the client name first/i);
    expect(h.calls.some((c) => c.method === "POST" && c.url.startsWith("/api/client-routing"))).toBe(false);
  });

  it("posts the client and vendor, then confirms what will happen", async () => {
    h = await openKeys();
    await h.page.fill("#route-client", "Nestlé");
    await h.page.selectOption("#route-vendor", "anthropic-api");
    await h.page.click("#pane-keys button:has-text('Save preference')");
    await h.page.waitForTimeout(500);

    const post = h.calls.find((c) => c.method === "POST" && c.url === "/api/client-routing");
    expect(post, "no preference was posted").toBeTruthy();
    expect(post!.body).toMatchObject({ clientName: "Nestlé", textVendor: "anthropic-api" });
    // The confirmation repeats the boundary rather than just saying "saved".
    expect(await h.page.textContent("#route-msg")).toMatch(/your policy already allows it/i);
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("removing a preference asks first and posts the client name", async () => {
    h = await openKeys({ routing: ROUTING });
    await h.page.waitForSelector("#route-list table tbody tr");
    await h.page.evaluate(() => { (window as any).confirm = () => true; });
    await h.page.click("#route-list tbody tr td:last-child a");
    await h.page.waitForTimeout(400);

    const clear = h.calls.find((c) => c.url.startsWith("/api/client-routing/clear"));
    expect(clear, "no clear call was made").toBeTruthy();
    expect(clear!.body.clientName).toBe("Nestlé");
  });

  it("a client name from the database is escaped, never interpolated", async () => {
    h = await openKeys({
      routing: [{ clientName: "<img src=x onerror=alert(1)>", textVendor: "gemini-aistudio",
                  note: "<script>alert(2)</script>", updatedAt: null }],
    });
    await h.page.waitForSelector("#route-list table tbody tr");
    expect(await h.page.$$eval("#route-list img", (els) => els.length)).toBe(0);
    expect(await h.page.$$eval("#route-list script", (els) => els.length)).toBe(0);
    expect(pageErrors(h.page)).toEqual([]);
  });
});
