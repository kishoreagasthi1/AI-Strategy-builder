/**
 * The role-weight FUNCTION, not just the table. (v5.34.94)
 *
 * ── What roleWeightParity.test.ts actually guarantees ───────────────────────
 *
 * That the ten-role table in frontend/vyne-client.js is deep-equal to the one
 * in backend/src/tenant/engagementMerge.ts. That is worth having and it is not
 * what the product depends on. What the product depends on is
 * `roleWeight(dim, role)` returning the same number on both sides — and a role
 * arrives as a bare catalog key ("COO") from an invite and as a DISPLAY LABEL
 * ("COO / VP Operations") from synthetic and imported engagements, so the
 * lookup does real work before it ever touches the table.
 *
 * The two lookups are not the same function, and have not been since v5.32.57:
 *
 *   · The server tries the raw string, then every segment of the label, then
 *     `headWord + "_" + lastTailWord` — which exists precisely so
 *     "Operations / Frontline Manager" resolves to Operations_Manager. It
 *     splits on `/ ( — – -`.
 *
 *   · The browser tries the raw string, then VyneRoleCanon.roleKey(r) — called
 *     with ONE argument, so `maps` is undefined and it returns `r` unchanged,
 *     making that branch a guaranteed no-op — then the head segment only. It
 *     splits on `/ ( — -`, with no en dash.
 *
 * So v5.32.57's fix landed on one side. The consequence is the exact defect the
 * whole parity apparatus was built to prevent, one layer down: the Synthesis
 * dashboard computes from the browser's answer and /api/scorecard serves the
 * server's, so the same round reads two different overalls depending on which
 * code path the reader came through.
 *
 * These tests execute BOTH implementations over the real display labels.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { roleWeight as srvRoleWeight, ROLE_WEIGHTS } from "../src/tenant/engagementMerge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const clientSrc = readFileSync(join(root, "frontend", "vyne-client.js"), "utf8");

/**
 * The browser's vyneRoleWeight, lifted out and executed.
 *
 * Deliberately NOT a reimplementation: the function body is taken verbatim from
 * vyne-client.js, so the test cannot drift into agreeing with a copy of itself.
 * roleCanon.js is loaded for real too, because the browser consults it — and
 * whether that branch does anything is part of what is under test.
 */
function loadBrowserRoleWeight(): (dim: string, role?: string) => number {
  const m = /window\.vyneRoleWeight = (function \(dim, role\) \{[\s\S]*?\n  \});/.exec(clientSrc);
  expect(m, "vyneRoleWeight moved or was reformatted — update this test").toBeTruthy();

  const tbl = /var VYNE_ROLE_WEIGHTS = (\{[\s\S]*?\n  \});/.exec(clientSrc);
  expect(tbl, "VYNE_ROLE_WEIGHTS moved — update this test").toBeTruthy();

  const canonSrc = readFileSync(join(root, "frontend", "roleCanon.js"), "utf8");
  const sandbox: any = { module: { exports: {} }, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // eslint-disable-next-line no-new-func
  const make = new Function(
    "sandbox", "canonSrc", "tableSrc", "fnSrc",
    `with (sandbox) {
       (0, eval)(canonSrc);
       var VYNE_ROLE_WEIGHTS = (${"tableSrc"} , eval('(' + tableSrc + ')'));
       return eval('(' + fnSrc + ')');
     }`,
  );
  return make(sandbox, canonSrc, tbl![1], m![1]);
}

const webRoleWeight = loadBrowserRoleWeight();
const DIMS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"] as const;

/** The ten catalog keys, and the display labels the same roles arrive under. */
const CATALOG_KEYS = Object.keys(ROLE_WEIGHTS.D1);
const DISPLAY_LABELS = [
  "CEO / Chief Executive",
  "CFO / Finance Lead",
  "CTO / Chief Technology Officer",
  "CDO / Chief Data Officer",
  "COO / VP Operations",
  "CHRO / People Lead",
  "VP Sales / Revenue",
  "IT Director / CISO",
  "Operations / Frontline Manager",
  "General Counsel / Legal",
  "CEO — Group",   // em dash
  "CEO – Group",   // en dash
  "COO (Divisional)",
];

describe("v5.34.94 — the two roleWeight implementations agree", () => {
  it("the browser function was actually loaded, not stubbed", () => {
    // Guards every assertion below from passing against a function that throws
    // and a catch that returns 0.5 for everything.
    expect(typeof webRoleWeight).toBe("function");
    expect(webRoleWeight("D1", "CDO")).toBe(1.0);
    expect(webRoleWeight("D6", "General_Counsel")).toBe(1.0);
  });

  it("agrees on every bare catalog key, in every dimension", () => {
    for (const d of DIMS) {
      for (const r of CATALOG_KEYS) {
        expect(webRoleWeight(d, r), `${d}/${r}`).toBe(srvRoleWeight(d, r));
      }
    }
  });

  it("agrees on every DISPLAY LABEL, in every dimension", () => {
    /*
     * The one that fails today. Synthetic and imported engagements store
     * display labels, so this is the normal case for them rather than an edge
     * one — and a disagreement here means the dashboard and the persisted score
     * are computed from different weights for the same interview.
     */
    const disagreements: string[] = [];
    for (const d of DIMS) {
      for (const r of DISPLAY_LABELS) {
        const web = webRoleWeight(d, r);
        const srv = srvRoleWeight(d, r);
        if (web !== srv) disagreements.push(`${d} "${r}": browser ${web}, server ${srv}`);
      }
    }
    expect(disagreements.join("\n")).toBe("");
  });

  it("agrees that an unknown role is 0.5 — and does not quietly agree for the wrong reason", () => {
    for (const d of DIMS) {
      expect(webRoleWeight(d, "Chief Vibes Officer")).toBe(0.5);
      expect(srvRoleWeight(d, "Chief Vibes Officer")).toBe(0.5);
    }
    /*
     * 0.5 is both "unknown role" and the value a BROKEN lookup returns, so a
     * test that only checks unknown roles passes on a lookup that has stopped
     * working entirely. These two must NOT be 0.5.
     */
    expect(srvRoleWeight("D5", "Operations / Frontline Manager")).toBe(0.9);
    expect(webRoleWeight("D5", "Operations / Frontline Manager")).toBe(0.9);
  });

  it("agrees on empty, undefined and whitespace roles", () => {
    for (const r of ["", "   ", undefined as never]) {
      expect(webRoleWeight("D3", r)).toBe(srvRoleWeight("D3", r));
    }
    expect(webRoleWeight("D99" as never, "CEO")).toBe(srvRoleWeight("D99" as never, "CEO"));
  });
});

describe("v5.34.94 — the specific divergences, named", () => {
  /*
   * Pinned individually so a regression says WHICH rule was lost rather than
   * only that some label disagrees.
   */
  it("resolves head+tail, so a frontline manager counts on Process & Operations", () => {
    // D5 is the dimension an Operations Manager knows best: 0.9 against a
    // CFO's 0.7. Falling to 0.5 discounts their answer by nearly half.
    expect(srvRoleWeight("D5", "Operations / Frontline Manager")).toBe(0.9);
    expect(webRoleWeight("D5", "Operations / Frontline Manager"))
      .toBe(srvRoleWeight("D5", "Operations / Frontline Manager"));
  });

  it("treats an EN dash as a separator, not part of the name", () => {
    expect(srvRoleWeight("D3", "CEO – Group")).toBe(1.0);
    expect(webRoleWeight("D3", "CEO – Group"))
      .toBe(srvRoleWeight("D3", "CEO – Group"));
  });

  it("does not rely on a roleKey() call that cannot canonicalise anything", () => {
    /*
     * roleCanon.roleKey(raw, maps) returns
     *   (maps && maps.displayToValue && maps.displayToValue[raw]) || raw
     * so called with one argument it is the identity function. vyne-client.js
     * called it with one argument, which made the branch dead and left the
     * crude head-only fallback doing all the work.
     */
    const canonSrc = readFileSync(join(root, "frontend", "roleCanon.js"), "utf8");
    expect(canonSrc, "roleKey's signature changed — re-check the caller")
      .toMatch(/function roleKey\(raw, maps\)/);
    expect(clientSrc, "vyneRoleWeight still calls roleKey with no maps — a guaranteed no-op")
      .not.toMatch(/VyneRoleCanon\.roleKey\(r\)\s*;/);
  });
});
