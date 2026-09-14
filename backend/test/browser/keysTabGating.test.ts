/**
 * Who may see the Client API keys tab, and what the forms let them type.
 * (v5.34.67)
 *
 * Two fixes, both about a screen telling someone something untrue.
 *
 * 1. A CONSULTANT saw the tab. Every route behind it is owner-only, all three
 *    loaders swallow their 403s, and so the panels rendered their EMPTY states:
 *    "No client is using their own key yet" and "No client has fallback." Those
 *    are not empty states, they are forbidden states — and a consultant could
 *    repeat either to a client while looking at a screen that was never allowed
 *    to show them one.
 *
 * 2. The three client fields were free text, labelled "Client name (exactly as
 *    on the engagement)" — an instruction that exists only because the field
 *    could get it wrong, and regularly did. A key attached to a name nobody had
 *    registered stored fine, showed as active, and was never used.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { openPage, pageErrors, skipBrowser, type Harness } from "./harness.js";

import { BROWSER_TEST_TIMEOUT_MS, BROWSER_HOOK_TIMEOUT_MS } from "./harness.js";
/* Real browser work does not fit vitest's 5s default — see harness.ts. */
vi.setConfig({ testTimeout: BROWSER_TEST_TIMEOUT_MS, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });

const SKIP = skipBrowser();

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const CLIENTS = [
  { clientName: "Acme Industrial", registered: true },
  { clientName: "Nestlé USA", registered: true },
  { clientName: "Meridian Foods", registered: true },
];

const stub = (over: { clients?: unknown[] } = {}) =>
  (req: { method: string; url: string; body: any }) => {
    if (req.url.startsWith("/api/byok/clients")) {
      return { body: { clients: over.clients ?? CLIENTS } };
    }
    if (req.url.startsWith("/api/byok/fallback-grants")) return { body: { grants: [] } };
    if (req.url.startsWith("/api/client-routing")) return { body: { routing: [] } };
    if (req.url.startsWith("/api/byok/invites")) return { body: { invites: [] } };
    if (req.url.startsWith("/api/byok/keys")) return { body: { keys: [] } };
    if (req.url.startsWith("/api/billing/summary")) return { body: { clients: [], from: null, to: null } };
    return { body: {} };
  };

describe.skipIf(SKIP)("v5.34.67 — the keys tab is the Owner's", () => {
  it("a consultant is not shown the tab at all", async () => {
    h = await openPage({
      file: "billing.html", stub: stub(),
      session: { token: "t", role: "consultant", email: "c@firm.com" },
    });
    await h.page.waitForTimeout(400);
    const visible = await h.page.$eval("#tab-btn-keys",
      (el) => getComputedStyle(el as HTMLElement).display !== "none");
    expect(visible, "a consultant can see a tab whose every route 403s").toBe(false);
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("and therefore never reads a forbidden state as an empty one", async () => {
    /*
     * The consequence, asserted separately from the cause. Before this release
     * a consultant clicking through saw "No client is using their own key yet"
     * — a sentence about the firm's clients, produced by a 403.
     */
    h = await openPage({
      file: "billing.html", stub: stub(),
      session: { token: "t", role: "consultant", email: "c@firm.com" },
    });
    await h.page.waitForTimeout(400);
    const pane = await h.page.$eval("#pane-keys",
      (el) => getComputedStyle(el as HTMLElement).display);
    expect(pane).toBe("none");
  });

  it("an owner still sees it", async () => {
    h = await openPage({
      file: "billing.html", stub: stub(),
      session: { token: "t", role: "owner", email: "o@firm.com" },
    });
    await h.page.waitForTimeout(400);
    const visible = await h.page.$eval("#tab-btn-keys",
      (el) => getComputedStyle(el as HTMLElement).display !== "none");
    expect(visible).toBe(true);
  });
});

describe.skipIf(SKIP)("v5.34.67 — the client is picked, not typed", () => {
  const openKeys = async (over: any = {}) => {
    const harness = await openPage({
      file: "billing.html", stub: stub(over),
      session: { token: "t", role: "owner", email: "o@firm.com" },
    });
    await harness.page.click("#tab-btn-keys");
    await harness.page.waitForTimeout(500);
    return harness;
  };

  it("all three client fields are pickers, not text boxes", async () => {
    h = await openKeys();
    for (const id of ["#byok-client", "#grant-client", "#route-client"]) {
      const tag = await h.page.$eval(id, (el) => el.tagName.toLowerCase());
      expect(tag, `${id} is still free text`).toBe("select");
    }
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("lists the firm's actual clients, in all three, in the order the server sent", async () => {
    /*
     * The page deliberately does NOT re-sort. /api/byok/clients orders by
     * client_name in SQL, and a second sort in JavaScript would use a different
     * collation — localeCompare puts "Nestlé USA" somewhere Postgres may not —
     * so the two would disagree for exactly the accented names this product is
     * full of. One authority, and it is the one with the data.
     */
    h = await openKeys();
    for (const id of ["#byok-client", "#grant-client", "#route-client"]) {
      const opts = await h.page.$$eval(`${id} option`,
        (els) => els.map((e) => (e as HTMLOptionElement).value).filter(Boolean));
      expect(opts, id).toEqual(CLIENTS.map((c) => c.clientName));
    }
  });

  it("says what to do when the firm has no clients yet", async () => {
    // An empty dropdown reading "Choose a client…" would be a dead end. The
    // ordering rule is the point, so the empty state has to name the next step.
    h = await openKeys({ clients: [] });
    const first = await h.page.$eval("#byok-client option", (el) => el.textContent || "");
    expect(first).toMatch(/create one in Pre-Engagement/i);
  });

  it("a client name from the database is set as text, never as markup", async () => {
    h = await openKeys({
      clients: [{ clientName: "<img src=x onerror=alert(1)>", registered: true }],
    });
    expect(await h.page.$$eval("#byok-client img", (els) => els.length)).toBe(0);
    const val = await h.page.$$eval("#byok-client option",
      (els) => els.map((e) => (e as HTMLOptionElement).value).filter(Boolean));
    expect(val).toEqual(["<img src=x onerror=alert(1)>"]);
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("still lists a client who has a key but no engagement — and labels them", async () => {
    /*
     * Found in production the minute the pickers shipped. "ZZ BYOK Test" had an
     * active key and a fallback grant and no engagement row: the key kept
     * working (it falls back to the norm) and the client disappeared from every
     * dropdown, so their grant could not be re-issued and their preference
     * could not be set. Tightening what may be ATTACHED had made what already
     * WAS attached unmanageable.
     *
     * They are listed, so the configuration stays reachable — and labelled, so
     * the state reads as something to fix rather than something normal.
     */
    h = await openKeys({
      clients: [
        { clientName: "Acme Industrial", registered: true },
        { clientName: "ZZ BYOK Test", registered: false },
      ],
    });
    const opts = await h.page.$$eval("#grant-client option",
      (els) => els.map((e) => ({ v: (e as HTMLOptionElement).value, t: e.textContent || "" })));
    const zz = opts.find((o) => o.v === "ZZ BYOK Test");
    expect(zz, "a client with a key on file vanished from the picker").toBeTruthy();
    expect(zz!.t).toMatch(/not a registered client/i);
    // The registered one carries no label at all.
    expect(opts.find((o) => o.v === "Acme Industrial")!.t.trim()).toBe("Acme Industrial");
  });

  it("posts the unregistered client's real name, not the label", async () => {
    // The label is decoration. Posting "ZZ BYOK Test  (not a registered client)"
    // would create a second, differently-named client on the server.
    h = await openKeys({
      clients: [{ clientName: "ZZ BYOK Test", registered: false }],
    });
    await h.page.selectOption("#grant-client", "ZZ BYOK Test");
    await h.page.click("#pane-keys button:has-text('Grant fallback')");
    await h.page.waitForTimeout(400);
    const post = h.calls.find((c) => c.method === "POST" && c.url === "/api/byok/fallback-grants");
    expect(post!.body.clientName).toBe("ZZ BYOK Test");
  });

  it("posts the picked client verbatim", async () => {
    h = await openKeys();
    await h.page.selectOption("#grant-client", "Nestlé USA");
    await h.page.click("#pane-keys button:has-text('Grant fallback')");
    await h.page.waitForTimeout(400);
    const post = h.calls.find((c) => c.method === "POST" && c.url === "/api/byok/fallback-grants");
    expect(post, "no grant was posted").toBeTruthy();
    expect(post!.body.clientName).toBe("Nestlé USA");
  });
});
