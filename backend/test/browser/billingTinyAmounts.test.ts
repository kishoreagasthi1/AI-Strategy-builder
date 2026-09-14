/**
 * A real cost must never render as nothing. (v5.34.60)
 *
 * Found while testing BYOK against production: a text call that genuinely ran
 * on a client's own key cost $0.0000099, and every figure on the screen said
 * "$0.0000". The money was recorded correctly and was invisible, which is the
 * same shape as the two billing faults this product has already shipped —
 * $6.62 of phantom holds nobody could see, and a 13x voice undercount.
 *
 * Driven in a real browser because the formatting happens at render time.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { openPage, pageErrors, skipBrowser, type Harness } from "./harness.js";

import { BROWSER_TEST_TIMEOUT_MS, BROWSER_HOOK_TIMEOUT_MS } from "./harness.js";
/* Real browser work does not fit vitest's 5s default — see harness.ts. */
vi.setConfig({ testTimeout: BROWSER_TEST_TIMEOUT_MS, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });

const SKIP = skipBrowser();

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

/** Exactly the shape production returned: a single tiny client-paid call. */
const TINY = {
  clients: [
    { clientNorm: "zzbyoktest", clientName: "ZZ BYOK Test", callCount: 1,
      tokensIn: 8, tokensOut: 3, costEstUsd: 0, clientPaidUsd: 0.0000099,
      lastActivity: "2026-09-13T00:58:09.000Z" },
    { clientNorm: "humana", clientName: "Humana", callCount: 80,
      tokensIn: 100000, tokensOut: 44441, costEstUsd: 0.8033, clientPaidUsd: 0,
      lastActivity: "2026-09-11T10:00:00.000Z" },
  ],
  from: null, to: null,
};

const stub = (req: { url: string }) => {
  if (req.url.startsWith("/api/billing/summary")) return { body: TINY };
  if (req.url.startsWith("/api/byok/keys")) return { body: { keys: [] } };
  return { body: {} };
};

describe.skipIf(SKIP)("v5.34.60 — costs too small to round", () => {
  it("shows a tiny real cost as '<$0.0001', not as zero", async () => {
    h = await openPage({ file: "billing.html", stub });
    await h.page.waitForSelector("#sum-container table tbody tr");

    const row = await h.page.$$eval("#sum-container tbody tr", (trs) =>
      Array.from(trs.find((t) => /ZZ BYOK/.test(t.textContent || ""))!.querySelectorAll("td"))
        .map((td) => td.textContent?.trim()));
    // "On their key" column — the real, non-zero amount.
    expect(row).toContain("<$0.0001");
    expect(row).not.toContain("$0.0000099");   // not raw precision either
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("still prints an exact zero as $0.0000 — there really is nothing there", async () => {
    // The opposite error: "<$0.0001" where nothing was spent would be a lie in
    // the other direction, and every client without a key shows zero.
    h = await openPage({ file: "billing.html", stub });
    await h.page.waitForSelector("#sum-container table tbody tr");
    const row = await h.page.$$eval("#sum-container tbody tr", (trs) =>
      Array.from(trs.find((t) => /Humana/.test(t.textContent || ""))!.querySelectorAll("td"))
        .map((td) => td.textContent?.trim()));
    expect(row).toContain("$0.8033");   // ordinary amounts unchanged
    expect(row.join("|")).not.toContain("<$0.0001");
  });

  it("does not distort ordinary figures", async () => {
    h = await openPage({ file: "billing.html", stub });
    await h.page.waitForSelector("#sum-container table tbody tr");
    const nums = await h.page.$$eval("#sum-container .total-num", (els) =>
      els.map((e) => e.textContent?.trim()));
    expect(nums[0]).toBe("$0.8033");     // recoverable total, four dp as before
  });
});
