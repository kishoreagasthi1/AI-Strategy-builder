/**
 * v5.32.10 — "Assign clients to consultants" and "Delete client" (Interview
 * Tracker → Client access) used to take a free-typed client name. A
 * mistyped or differently-punctuated name normalizes to a different
 * normClient() key than the client the owner meant — an assignment that
 * silently grants access to nobody's real client, or a delete that quietly
 * no-ops instead of removing the intended one. Both fields are now
 * <select>s populated from the same client list /api/my-clients already
 * resolves for owners, so what's pickable is exactly what exists.
 *
 * Static source-text check — no frontend test runner in this repo, same
 * "wiring, not just logic" pattern as renameClientUI.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dirname, "..", "..", "frontend");

function readInterviews(): string {
  return readFileSync(join(FRONTEND, "interviews.html"), "utf8");
}

describe("interviews.html — client picker dropdowns (v5.32.10)", () => {
  it("Assign and Delete client fields are <select>s, not free-text inputs", () => {
    const src = readInterviews();
    expect(src).toContain('<select id="as-client">');
    expect(src).toContain('<select id="del-client">');
    expect(src).not.toMatch(/<input[^>]*id="as-client"/);
    expect(src).not.toMatch(/<input[^>]*id="del-client"/);
  });

  it("each select id appears exactly once (no orphaned duplicate)", () => {
    const src = readInterviews();
    expect((src.match(/id="as-client"/g) || []).length).toBe(1);
    expect((src.match(/id="del-client"/g) || []).length).toBe(1);
  });

  it("both dropdowns are populated from /api/my-clients via a shared helper", () => {
    const src = readInterviews();
    expect(src).toContain("function populateClientSelects(clients)");
    const fn = src.match(/function populateClientSelects\(clients\)\{([\s\S]*?)\n\}/);
    expect(fn, "expected to find populateClientSelects()").toBeTruthy();
    const body = fn![1];
    expect(body).toContain('"as-client"');
    expect(body).toContain('"del-client"');
  });

  it("the owner branch of loadAccess() feeds the real client list into the dropdowns", () => {
    const src = readInterviews();
    expect(src).toMatch(/populateClientSelects\(d\.clients\)/);
  });

  it("creating an invite or deleting a client refreshes the dropdown options", () => {
    const src = readInterviews();
    const createFn = src.match(/async function createInvite\(\)\{([\s\S]*?)\n\}/);
    expect(createFn, "expected to find createInvite()").toBeTruthy();
    expect(createFn![1]).toContain("loadClientOptions()");

    const deleteFn = src.match(/async function deleteClient\(\)\{([\s\S]*?)\n\}/);
    expect(deleteFn, "expected to find deleteClient()").toBeTruthy();
    expect(deleteFn![1]).toContain("loadClientOptions()");
  });
});

describe("interviews.html — Client access panel placement (v5.32.11)", () => {
  it("Client access (Team / Assign / Delete) renders before the per-interviewee invite form", () => {
    // Firm-structure decisions (who's on the team, which clients they can see,
    // whether to delete one) are things an owner reaches for first — not
    // after scrolling past the invite form, which most days nobody touches.
    const src = readInterviews();
    const accessIdx = src.indexOf('id="access-panel"');
    const inviteIdx = src.indexOf("<h2>Invite an interviewee");
    expect(accessIdx).toBeGreaterThan(-1);
    expect(inviteIdx).toBeGreaterThan(-1);
    expect(accessIdx).toBeLessThan(inviteIdx);
  });
});
