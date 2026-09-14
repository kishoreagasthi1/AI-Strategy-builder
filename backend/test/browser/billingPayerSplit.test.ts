/**
 * The invoice screen, in a real browser. (v5.34.59)
 *
 * The backend already refuses to put client-paid work into totalCostUsd. What
 * this checks is the thing a person actually reads: that the dashboard and the
 * statement do not present an amount as owed when it is not, and that the CSV —
 * the file that gets attached to an invoice — says on each row who paid.
 *
 * A string search over billing.html cannot answer any of that: the split is
 * computed at render time from the API response.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { openPage, pageErrors, skipBrowser, type Harness } from "./harness.js";

import { BROWSER_TEST_TIMEOUT_MS, BROWSER_HOOK_TIMEOUT_MS } from "./harness.js";
/* Real browser work does not fit vitest's 5s default — see harness.ts. */
vi.setConfig({ testTimeout: BROWSER_TEST_TIMEOUT_MS, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });

const SKIP = skipBrowser();

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

/** Nestlé brought their own Google key; Humana did not. */
const MIXED_SUMMARY = {
  clients: [
    { clientNorm: "nestle", clientName: "Nestlé", callCount: 42,
      tokensIn: 500_000, tokensOut: 250_000, costEstUsd: 0.4,
      clientPaidUsd: 12.5, lastActivity: "2026-09-12T10:00:00.000Z" },
    { clientNorm: "humana", clientName: "Humana", callCount: 10,
      tokensIn: 10_000, tokensOut: 5_000, costEstUsd: 0.75,
      clientPaidUsd: 0, lastActivity: "2026-09-11T10:00:00.000Z" },
  ],
  from: null, to: null,
};

/** What a firm with no BYOK clients at all sees — the overwhelmingly common case. */
const PLAIN_SUMMARY = {
  clients: [
    { clientNorm: "humana", clientName: "Humana", callCount: 10,
      tokensIn: 10_000, tokensOut: 5_000, costEstUsd: 0.75,
      clientPaidUsd: 0, lastActivity: "2026-09-11T10:00:00.000Z" },
  ],
  from: null, to: null,
};

const STATEMENT = {
  client: "Nestlé", from: null, to: null,
  lineItems: [
    { createdAt: "2026-09-12T10:00:00.000Z", module: "synthesis", task: "synthesis",
      provider: "anthropic-vertex", model: "claude-sonnet-5",
      tokensIn: 1000, tokensOut: 500, costEstUsd: 0.4 },
    { createdAt: "2026-09-12T11:00:00.000Z", module: "interview_agent", task: "live_session",
      provider: "gemini-live", model: "gemini-3.1-flash-live-preview",
      tokensIn: 40000, tokensOut: 90000, costEstUsd: 12.5, clientPaid: true },
  ],
  callCount: 2, totalTokensIn: 41000, totalTokensOut: 90500,
  totalCostUsd: 0.4, clientPaidUsd: 12.5,
};

const stub = (summary: any, statement: any = STATEMENT) =>
  (req: { method: string; url: string; body: any }) => {
    if (req.url.startsWith("/api/billing/summary")) return { body: summary };
    if (req.url.startsWith("/api/billing/statement")) return { body: statement };
    if (req.url.startsWith("/api/byok/keys")) return { body: { keys: [] } };
    return { body: {} };
  };

describe.skipIf(SKIP)("v5.34.59 — billing.html keeps client-paid work off the invoice", () => {
  it("the dashboard shows recoverable cost and client-paid cost as SEPARATE numbers", async () => {
    h = await openPage({ file: "billing.html", stub: stub(MIXED_SUMMARY) });
    await h.page.waitForSelector("#sum-container table tbody tr");

    const labels = await h.page.$$eval("#sum-container .total-label", (els) =>
      els.map((e) => e.textContent?.trim()));
    expect(labels).toContain("Recoverable AI cost");
    expect(labels).toContain("On clients' own keys");

    const nums = await h.page.$$eval("#sum-container .total-num", (els) =>
      els.map((e) => e.textContent?.trim()));
    // $1.15 recoverable (0.40 + 0.75), $12.50 already paid by the client.
    expect(nums[0]).toContain("1.15");
    expect(nums[1]).toContain("12.5");
    // The $12.50 must NOT be inside the recoverable figure.
    expect(nums[0]).not.toContain("13.65");
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("a firm with no BYOK clients sees no extra column at all", async () => {
    // A permanently-$0.00 column on every firm's dashboard is noise, and noise
    // is how a real number stops being noticed.
    h = await openPage({ file: "billing.html", stub: stub(PLAIN_SUMMARY) });
    await h.page.waitForSelector("#sum-container table tbody tr");

    const headers = await h.page.$$eval("#sum-container thead th", (els) =>
      els.map((e) => e.textContent?.trim()));
    expect(headers).not.toContain("On their key");
    const labels = await h.page.$$eval("#sum-container .total-label", (els) =>
      els.map((e) => e.textContent?.trim()));
    expect(labels).not.toContain("On clients' own keys");
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("“Total due” is the firm-paid amount, never the sum of the cost column", async () => {
    h = await openPage({ file: "billing.html", stub: stub(MIXED_SUMMARY) });
    await h.page.click("#tab-btn-statement");
    await h.page.fill("#stmt-client", "Nestlé");
    await h.page.click("#stmt-btn");
    await h.page.waitForSelector("#stmt-result table tbody tr");

    const stats = await h.page.$$eval("#stmt-result .total-stat", (els) =>
      els.map((e) => ({
        num: e.querySelector(".total-num")?.textContent?.trim(),
        label: e.querySelector(".total-label")?.textContent?.trim(),
      })));
    const due = stats.find((s) => s.label === "Total due")!;
    expect(due.num).toContain("0.4");
    expect(due.num).not.toContain("12.5");
    expect(stats.find((s) => s.label === "Already paid on their key")!.num).toContain("12.5");
    expect(pageErrors(h.page)).toEqual([]);
  });

  it("every line says who paid for it, so the cost column cannot be misread", async () => {
    h = await openPage({ file: "billing.html", stub: stub(MIXED_SUMMARY) });
    await h.page.click("#tab-btn-statement");
    await h.page.fill("#stmt-client", "Nestlé");
    await h.page.click("#stmt-btn");
    await h.page.waitForSelector("#stmt-result table tbody tr");

    const rows = await h.page.$$eval("#stmt-result tbody tr", (trs) =>
      trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim())));
    expect(rows).toHaveLength(2);
    expect(rows[0].at(-1)).toBe("Invoiced");
    expect(rows[1].at(-1)).toBe("Their own key");
    // The client-paid line is still LISTED — a statement that omitted half an
    // engagement would be a quiet lie of a different kind.
    expect(rows[1].some((c) => c?.includes("12.5"))).toBe(true);
  });

  it("the CSV carries the payer on every row and separates the two totals", async () => {
    h = await openPage({ file: "billing.html", stub: stub(MIXED_SUMMARY) });
    await h.page.click("#tab-btn-statement");
    await h.page.fill("#stmt-client", "Nestlé");
    await h.page.click("#stmt-btn");
    await h.page.waitForSelector("#stmt-result table tbody tr");

    // Build the CSV through the page's own code path rather than re-deriving
    // it here — the file that reaches an invoice is the thing under test.
    const csv = await h.page.evaluate(() => {
      const d = (window as any).lastStatement;
      const lines: string[] = [];
      const orig = (window as any).Blob;
      let captured = "";
      (window as any).Blob = function (parts: any[]) { captured = parts.join(""); return new orig(parts); };
      const a = document.createElement("a");
      const click = a.click;
      // Suppress the download; we only want the bytes.
      HTMLAnchorElement.prototype.click = function () { /* no-op */ };
      (window as any).downloadStatementCsv();
      HTMLAnchorElement.prototype.click = click;
      (window as any).Blob = orig;
      void d; void lines;
      return captured;
    });

    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("Paid By");
    expect(lines[1]).toContain("Invoiced");
    expect(lines[2]).toContain("Client's own key");
    expect(csv).toContain("TOTAL DUE");
    expect(csv).toContain("ALREADY PAID ON CLIENT'S OWN KEY");
    // The due line must carry the firm-paid figure, not the combined one.
    const dueLine = lines.find((l) => l.includes("TOTAL DUE"))!;
    expect(dueLine).toContain("0.400000");
    expect(dueLine).not.toContain("12.500000");
  });

  it("an API response from before this release still renders", async () => {
    // A cached page against an older backend must not throw on a missing
    // clientPaidUsd — it should simply show the old, single total.
    const old = {
      clients: [{ clientNorm: "humana", clientName: "Humana", callCount: 3,
                  tokensIn: 10, tokensOut: 10, costEstUsd: 0.5, lastActivity: null }],
      from: null, to: null,
    };
    h = await openPage({ file: "billing.html", stub: stub(old) });
    await h.page.waitForSelector("#sum-container table tbody tr");
    const nums = await h.page.$$eval("#sum-container .total-num", (els) =>
      els.map((e) => e.textContent?.trim()));
    expect(nums[0]).toContain("0.5");
    expect(pageErrors(h.page)).toEqual([]);
  });
});
