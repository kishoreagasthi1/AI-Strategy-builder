/**
 * v5.34.14 — the realtime WebSocket variant order.
 *
 * vyne-live.js tries a list of connection variants until one reaches
 * setupComplete. The combination that actually connects in production
 * (verified live) is v1beta / BidiGenerateContentConstrained / access_token.
 * It was originally LAST in the list, so every interview opened five doomed
 * sockets first (~8-11s of dead air that read as "no sound"). This test pins
 * the working variant to FIRST so a future edit can't silently regress the
 * startup latency back to ~11 seconds.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("realtime WS variant order", () => {
  const src = readFileSync(join(__dirname, "../../frontend/vyne-live.js"), "utf8");

  it("defines a WS_VARIANTS array", () => {
    expect(src).toMatch(/var WS_VARIANTS\s*=\s*\[/);
  });

  it("keeps the Constrained/access_token variants at the head of the list (both API versions)", () => {
    // v5.34.26: the effective order comes from variantOrder() (v1alpha first
    // by default, v1beta with the v1beta flag) — see liveTurnOwnership.test.ts.
    // What this still pins is that the constrained access_token variants lead
    // the static list, so the sweep never starts with a doomed key= socket.
    const m = src.match(/var WS_VARIANTS\s*=\s*\[([\s\S]*?)\];/);
    expect(m).toBeTruthy();
    const entries = m![1].split("},").filter((e) => e.trim().length);
    expect(entries[0]).toContain("BidiGenerateContentConstrained");
    expect(entries[0]).toContain("access_token");
    expect(entries[1]).toContain("BidiGenerateContentConstrained");
    expect(entries[1]).toContain("access_token");
    expect(entries[0] + entries[1]).toContain("v1beta");
    expect(entries[0] + entries[1]).toContain("v1alpha");
  });
});
