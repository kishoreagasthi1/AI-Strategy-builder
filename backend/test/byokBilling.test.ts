/**
 * The invoice must not charge a client for what they already paid. (v5.34.59)
 *
 * BYOK slice 2 lets a client's own credential pay Google or Anthropic directly.
 * usage_events still records the call — the firm needs the volume, and the
 * spend caps read those rows — so the ONLY thing standing between "recorded"
 * and "invoiced" is the payer split in routes/billing.ts. If that split is
 * wrong, the firm sends a bill for money it never spent, to a client who can
 * see their own provider statement. That is a worse failure than any outage in
 * this codebase, because it is silent and it goes out under the firm's name.
 */
import { describe, it, expect } from "vitest";
import {
  buildBillingSummary, buildBillingStatement, type UsageEventLite,
} from "../src/routes/billing.js";

function ev(over: Partial<UsageEventLite> = {}): UsageEventLite {
  return {
    clientName: "Nestle", clientNorm: "nestle", module: "interview_agent",
    task: "hypotheses", provider: "gemini-vertex", model: "gemini-3.6-flash",
    tokensIn: 1000, tokensOut: 500, costEstUsd: 0.01, ok: true,
    createdAt: "2026-09-12T10:00:00.000Z", ...over,
  };
}

describe("billing split by payer", () => {
  it("keeps client-paid cost out of the recoverable total", () => {
    const [row] = buildBillingSummary([
      ev({ costEstUsd: 0.01, payer: "platform" }),
      ev({ costEstUsd: 2.00, payer: "client_key" }),
    ]);
    expect(row.costEstUsd).toBe(0.01);      // what the firm may invoice
    expect(row.clientPaidUsd).toBe(2.00);   // what the client already paid
  });

  it("still counts the tokens, because the work happened", () => {
    // A firm whose clients all bring keys must not become invisible to its own
    // plan cap and its own dashboard.
    const [row] = buildBillingSummary([
      ev({ payer: "client_key" }), ev({ payer: "client_key" }),
    ]);
    expect(row.callCount).toBe(2);
    expect(row.tokensIn + row.tokensOut).toBe(3000);
    expect(row.costEstUsd).toBe(0);
  });

  it("treats a row with no payer as the firm's own — every row written before this release", () => {
    const [row] = buildBillingSummary([ev({ payer: undefined }), ev({ payer: null })]);
    expect(row.costEstUsd).toBe(0.02);
    expect(row.clientPaidUsd).toBe(0);
  });

  it("never lets an unknown payer value silently escape both totals", () => {
    // A NULL or a typo must land in the RECOVERABLE bucket, not vanish: money
    // that disappears from both columns is money nobody ever reconciles.
    const [row] = buildBillingSummary([ev({ payer: "something-else" as any, costEstUsd: 0.05 })]);
    expect(row.costEstUsd).toBe(0.05);
    expect(row.clientPaidUsd).toBe(0);
  });

  it("statement: total due excludes client-paid lines but still lists them", () => {
    const s = buildBillingStatement([
      ev({ costEstUsd: 0.25, payer: "platform", createdAt: "2026-09-12T10:00:00.000Z" }),
      ev({ costEstUsd: 1.75, payer: "client_key", createdAt: "2026-09-12T11:00:00.000Z" }),
    ]);
    expect(s.totalCostUsd).toBe(0.25);
    expect(s.clientPaidUsd).toBe(1.75);
    // The line is present — a statement that omitted half an engagement would
    // be a quiet lie of a different kind.
    expect(s.lineItems).toHaveLength(2);
    expect(s.lineItems[1].clientPaid).toBe(true);
    expect(s.lineItems[0].clientPaid).toBeUndefined();
  });

  it("statement totals are zero-due when everything ran on the client's key", () => {
    const s = buildBillingStatement([
      ev({ costEstUsd: 2.00, payer: "client_key" }),
      ev({ costEstUsd: 1.00, payer: "client_key" }),
    ]);
    expect(s.totalCostUsd).toBe(0);
    expect(s.clientPaidUsd).toBe(3);
    expect(s.callCount).toBe(2);
  });

  it("live-voice hold/release pairs still net to zero within one payer", () => {
    // The reservation ledger writes a positive hold and a negative release. If
    // the two carried different payers the hold would sit on the invoice with
    // nothing to cancel it — see migration 032 and sweepStaleHolds.
    const s = buildBillingStatement([
      ev({ task: "live_session_hold", costEstUsd: 2.5, payer: "client_key" }),
      ev({ task: "live_session_hold_release", costEstUsd: -2.5, payer: "client_key" }),
      ev({ task: "live_session", costEstUsd: 0.42, payer: "client_key" }),
    ]);
    expect(s.totalCostUsd).toBe(0);
    expect(s.clientPaidUsd).toBe(0.42);
  });

  it("a mixed client — voice on their key, decks on ours — bills only the decks", () => {
    // The realistic shape: "Gemini for the voice interviews, Claude for the
    // strategy deck" with only the Google key supplied.
    const [row] = buildBillingSummary([
      ev({ task: "live_session", provider: "gemini-live", costEstUsd: 2.00, payer: "client_key" }),
      ev({ task: "strategy_deck", provider: "anthropic-vertex", costEstUsd: 0.40, payer: "platform" }),
    ]);
    expect(row.costEstUsd).toBe(0.40);
    expect(row.clientPaidUsd).toBe(2.00);
  });
});
