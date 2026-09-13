/**
 * v5.32.5 postmortem: the Synthesis Dashboard's Interview Tracker panel
 * double-listed every configured role — once "Done" (matched against a
 * synthetic interview's stored role, the roleCatalog DISPLAY label, e.g.
 * "COO / VP Operations") and once "Pending" (matched against the
 * roleCatalog roster using the SHORT value, e.g. "COO") — because the two
 * interview-creation paths (routes/synthetic.ts vs interviews.html's Create
 * Invite form) store a role under different fields of the same roleCatalog
 * entry, and the dashboard compared those strings directly with no
 * normalization.
 *
 * That bug shipped with zero automated test coverage — it was only caught
 * because a human clicked through the UI and noticed duplicate rows. The
 * fix (frontend/roleCanon.js) pulls the canonicalization logic out of the
 * page-rendering function it used to live inside, into a plain, DOM-free
 * module that both the browser and this test load identically. This test
 * exists so that class of bug can't silently regress again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

// frontend/roleCanon.js is a plain CommonJS/UMD-style module (no bundler in
// this repo — see vyne-client.js/vyne-rail.js for the same pattern), so it
// can be loaded directly with require() from a .ts test via createRequire.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildRoleMaps, roleKey, roleLabel } = require(
  path.join(repoRoot, "frontend/roleCanon.js")
);

const ROLE_CATALOG = [
  { value: "COO", display: "COO / VP Operations" },
  { value: "CTO", display: "CTO / Technology Leadership" },
  { value: "VP_Sales", display: "VP Sales / Revenue" },
  { value: "General_Counsel", display: "General Counsel / Legal" },
];

describe("roleCanon — role identity across the short value and display label", () => {
  it("resolves both the short value and the display label to the same canonical key", () => {
    const maps = buildRoleMaps(ROLE_CATALOG);
    expect(roleKey("COO", maps)).toBe("COO");
    expect(roleKey("COO / VP Operations", maps)).toBe("COO");
    expect(roleKey("VP_Sales", maps)).toBe("VP_Sales");
    expect(roleKey("VP Sales / Revenue", maps)).toBe("VP_Sales");
  });

  it("regression: a synthetic interview's role and a real invite's role for the same configured role never diverge into two rows", () => {
    const maps = buildRoleMaps(ROLE_CATALOG);
    // Simulates routes/synthetic.ts's personasFromRoles(): stores the display label.
    const syntheticInterviewRole = "COO / VP Operations";
    // Simulates interviews.html's Create Invite form: stores the short value.
    const realInviteRole = "COO";
    expect(roleKey(syntheticInterviewRole, maps)).toBe(roleKey(realInviteRole, maps));
  });

  it("always renders the friendly display label for a canonical key, regardless of which form produced it", () => {
    const maps = buildRoleMaps(ROLE_CATALOG);
    const keyFromDisplay = roleKey("COO / VP Operations", maps);
    const keyFromValue = roleKey("COO", maps);
    expect(roleLabel(keyFromDisplay, maps)).toBe("COO / VP Operations");
    expect(roleLabel(keyFromValue, maps)).toBe("COO / VP Operations");
  });

  it("passes through an unrecognized/custom role string unchanged (no roleCatalog entry to canonicalize against)", () => {
    const maps = buildRoleMaps(ROLE_CATALOG);
    expect(roleKey("Head of Something Custom", maps)).toBe("Head of Something Custom");
    expect(roleLabel("Head of Something Custom", maps)).toBe("Head of Something Custom");
  });

  it("handles an empty/missing roleCatalog without throwing", () => {
    const maps = buildRoleMaps(undefined);
    expect(roleKey("COO", maps)).toBe("COO");
    expect(roleLabel("COO", maps)).toBe("COO");
  });

  it("trims whitespace before comparing, so incidental formatting differences don't reintroduce the split", () => {
    const maps = buildRoleMaps(ROLE_CATALOG);
    expect(roleKey("  COO / VP Operations  ", maps)).toBe("COO");
  });
});

describe("frontend wiring: synthesis.html actually loads and uses roleCanon.js", () => {
  it("includes the roleCanon.js script tag", () => {
    const html = readFileSync(path.join(repoRoot, "frontend/synthesis.html"), "utf8");
    expect(html).toContain('<script src="roleCanon.js"></script>');
  });

  it("the interview-tracker panel calls window.VyneRoleCanon rather than re-implementing canonicalization inline", () => {
    const html = readFileSync(path.join(repoRoot, "frontend/synthesis.html"), "utf8");
    expect(html).toContain("window.VyneRoleCanon.buildRoleMaps(");
    expect(html).toContain("window.VyneRoleCanon.roleKey(");
    expect(html).toContain("window.VyneRoleCanon.roleLabel(");
  });
});
