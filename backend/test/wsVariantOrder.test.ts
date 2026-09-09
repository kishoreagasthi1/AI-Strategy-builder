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

  it("tries the known-working variant FIRST (v1beta Constrained access_token)", () => {
    // Extract the array body.
    const m = src.match(/var WS_VARIANTS\s*=\s*\[([\s\S]*?)\];/);
    expect(m).toBeTruthy();
    const body = m![1];
    const firstEntry = body.split("},")[0]; // first object literal
    expect(firstEntry).toContain("v1beta");
    expect(firstEntry).toContain("BidiGenerateContentConstrained");
    expect(firstEntry).toContain("access_token");
  });
});
