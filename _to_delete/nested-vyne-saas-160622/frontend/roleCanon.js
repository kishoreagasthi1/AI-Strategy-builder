/**
 * roleCanon.js — canonicalizes a Pre-Engagement role string against the
 * client's roleCatalog, regardless of which of the two forms it's actually
 * stored in.
 *
 * v5.32.5 postmortem: interviews.html's "Create Invite" form stores an
 * interview's role as the roleCatalog entry's SHORT value (e.g. "COO");
 * routes/synthetic.ts's synthetic-data generator stores the same role as
 * its DISPLAY label (e.g. "COO / VP Operations") — same role, two
 * different strings, because each call site independently decided which
 * field of the roleCatalog entry to use. synthesis.html's Interview Tracker
 * panel used to compare those strings directly, so every role appeared
 * TWICE: once "Done" under its display label, once "Pending" under its
 * short value, since neither ever matched the other. That bug shipped with
 * zero test coverage — this file exists so the canonicalization logic is a
 * plain, DOM-free function that a real test can exercise directly, instead
 * of dead code buried inside a page-rendering function only a human
 * clicking through the UI could ever catch a regression in.
 *
 * Pure data in, data out — no DOM access, so this loads identically in the
 * browser (as window.VyneRoleCanon) and in a Node test (via module.exports).
 * Load in the browser AFTER the page has its own roleCatalog available;
 * this file itself has no dependencies.
 */
(function (root) {
  "use strict";

  /**
   * Build the value<->display lookup maps for a client's roleCatalog.
   * @param {Array<{value?: string, display?: string}>} roleCatalog
   * @returns {{valueToDisplay: Object, displayToValue: Object}}
   */
  function buildRoleMaps(roleCatalog) {
    var valueToDisplay = {}, displayToValue = {};
    (roleCatalog || []).forEach(function (r) {
      if (!r || !r.value) return;
      var disp = String(r.display || r.value).trim();
      valueToDisplay[r.value] = disp;
      displayToValue[disp] = r.value;
    });
    return { valueToDisplay: valueToDisplay, displayToValue: displayToValue };
  }

  /**
   * Canonicalize any role string (a roleCatalog value, a roleCatalog
   * display label, or an unrecognized/custom string) to the roleCatalog's
   * `value` field. Unrecognized strings pass through unchanged, so custom
   * roles with no roleCatalog entry still behave predictably (compared by
   * raw string equality, same as before this module existed).
   * @param {string} raw
   * @param {{displayToValue: Object}} maps
   * @returns {string}
   */
  function roleKey(raw, maps) {
    raw = String(raw || "").trim();
    if (!raw) return "";
    return (maps && maps.displayToValue && maps.displayToValue[raw]) || raw;
  }

  /**
   * The human-friendly label for a canonical role key — the roleCatalog's
   * display string if known, else the key itself.
   * @param {string} key
   * @param {{valueToDisplay: Object}} maps
   * @returns {string}
   */
  function roleLabel(key, maps) {
    return (maps && maps.valueToDisplay && maps.valueToDisplay[key]) || key;
  }

  var api = { buildRoleMaps: buildRoleMaps, roleKey: roleKey, roleLabel: roleLabel };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api; // Node / vitest
  }
  if (root) {
    root.VyneRoleCanon = api; // browser
  }
})(typeof window !== "undefined" ? window : this);
