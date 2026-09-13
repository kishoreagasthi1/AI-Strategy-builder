/**
 * vyne-findings.js — the browser half of "what counts as corroborated".
 *
 * v5.32.59 (F13). Counterpart of backend/src/tenant/findings.ts; read that
 * file's header for why. The short version: "confirmed finding" used to mean
 * "two roles mentioned this DIMENSION", so a CFO's complaint about data
 * lineage and a CHRO's complaint about trust in reporting were presented to
 * the client as one corroborated finding with two sources behind it.
 *
 * backend/test/findingsParity.test.ts executes this file and the TypeScript
 * one against the same inputs and fails on any divergence.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.VyneFindings = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  "use strict";

  /* Deliberately short — a long stopword list deletes the words that carry the
   * claim ("no", "not", "own") and makes opposite statements cluster. */
  var STOPWORDS = {};
  ["the","a","an","and","or","but","of","to","in","on","for","with",
   "is","are","was","were","be","been","being","it","its","this",
   "that","these","those","there","their","they","we","our","us",
   "as","at","by","from","has","have","had","do","does","did",
   "will","would","can","could","should","may","might","than","then",
   "so","if","into","about","over","very","much","more","most"
  ].forEach(function (w) { STOPWORDS[w] = true; });

  function contentTokens(text) {
    var words = String(text == null ? "" : text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    var out = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w.length < 3) continue;
      if (STOPWORDS[w] === true) continue;
      var t = (w.length > 3 && w.charAt(w.length - 1) === "s" && w.slice(-2) !== "ss") ? w.slice(0, -1) : w;
      if (out.indexOf(t) === -1) out.push(t);
    }
    return out;
  }

  /* Overlap coefficient, not Jaccard: consultants write findings at wildly
   * different lengths and Jaccard penalises that rather than disagreement. */
  function claimSimilarity(a, b) {
    if (!a.length || !b.length) return 0;
    var setB = {}, i;
    for (i = 0; i < b.length; i++) setB[b[i]] = true;
    var shared = 0;
    for (i = 0; i < a.length; i++) if (setB[a[i]] === true) shared++;
    return shared / Math.min(a.length, b.length);
  }

  var SIMILARITY_THRESHOLD = 0.5;
  /* Without a shared-token floor, two four-word findings sharing only the
   * category noun ("data") score 1.0 and merge. */
  var MIN_SHARED_TOKENS = 2;

  function sameClaim(a, b) {
    if (!a.length || !b.length) return false;
    /* Identical content is identical however few words it is — otherwise
     * MIN_SHARED_TOKENS stops two roles who said the same short sentence from
     * corroborating each other, the one case beyond argument. */
    if (a.length === b.length) {
      var same = true;
      for (var z = 0; z < a.length; z++) if (a[z] !== b[z]) { same = false; break; }
      if (same) return true;
    }
    var setB = {}, i;
    for (i = 0; i < b.length; i++) setB[b[i]] = true;
    var shared = 0;
    for (i = 0; i < a.length; i++) if (setB[a[i]] === true) shared++;
    if (shared < MIN_SHARED_TOKENS) return false;
    return shared / Math.min(a.length, b.length) >= SIMILARITY_THRESHOLD;
  }

  function findingsOf(interviews) {
    var out = [];
    var list = Object.prototype.toString.call(interviews) === "[object Array]" ? interviews : [];
    for (var i = 0; i < list.length; i++) {
      var iv = list[i];
      if (!iv) continue;
      var role = String(iv.role == null ? "" : iv.role).trim();
      var person = String(iv.interviewee == null ? (iv.name == null ? "" : iv.name) : iv.interviewee).trim();
      var fs = Object.prototype.toString.call(iv.findings) === "[object Array]" ? iv.findings : [];
      for (var j = 0; j < fs.length; j++) {
        var f = fs[j];
        if (!f) continue;
        out.push({
          dimension: String(f.dimension == null ? "" : f.dimension).trim(),
          text: String(f.text == null ? "" : f.text).trim(),
          role: role || String(f.role == null ? "" : f.role).trim(),
          // v5.32.86: the person, because one role can be held by several
          // people and every consumer downstream treated the role as identity.
          interviewee: person || String(f.interviewee == null ? "" : f.interviewee).trim()
        });
      }
    }
    return out;
  }

  /**
   * Attribution labels — the role alone, or the role plus the person when the
   * role alone cannot say who spoke. The browser half of findings.ts's
   * attributionLabels(); findingsParity.test.ts fails on any divergence.
   *
   * v5.32.86. `roles` on a cluster is what callers render and count, and it
   * was a list of ROLE strings deduped against each other — so two divisional
   * COOs who independently made the same point collapsed to ["COO"], length 1,
   * and corroborated came out FALSE. An unnamed interview keeps the bare role
   * even when the role is contested: with no name there is nothing to tell two
   * holders apart, and inventing one per row would manufacture agreement.
   */
  function attributionLabels(findings) {
    var list = Object.prototype.toString.call(findings) === "[object Array]" ? findings : [];
    var peopleByRole = {};
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!f) continue;
      var role = String(f.role == null ? "" : f.role).trim();
      var person = String(f.interviewee == null ? "" : f.interviewee).trim();
      if (!role || !person) continue;
      if (!Object.prototype.hasOwnProperty.call(peopleByRole, role)) peopleByRole[role] = [];
      if (peopleByRole[role].indexOf(person) === -1) peopleByRole[role].push(person);
    }
    return function (f) {
      var role = String(f && f.role == null ? "" : f.role).trim();
      var person = String(f && f.interviewee == null ? "" : f.interviewee).trim();
      if (!role) return person;
      if (!person) return role;
      var held = Object.prototype.hasOwnProperty.call(peopleByRole, role) ? peopleByRole[role].length : 0;
      return held > 1 ? role + " (" + person + ")" : role;
    };
  }

  var MAX_TEXTS_PER_CLUSTER = 4;

  function corroborateFindings(findings) {
    var byDim = {}, dimOrder = [];
    var list = Object.prototype.toString.call(findings) === "[object Array]" ? findings : [];
    // Computed over the WHOLE list before clustering: whether a role needs the
    // person's name is a property of the engagement, not of one cluster.
    var labelFor = attributionLabels(list);

    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!f) continue;
      var dim = String(f.dimension == null ? "" : f.dimension).trim();
      var text = String(f.text == null ? "" : f.text).trim();
      var role = String(f.role == null ? "" : f.role).trim();
      // No dimension, no text or no attributable role → cannot corroborate
      // anything, and an empty role must never look like a second source.
      if (!dim || !text || !role) continue;
      var tokens = contentTokens(text);
      if (!tokens.length) continue;

      if (!Object.prototype.hasOwnProperty.call(byDim, dim)) { byDim[dim] = []; dimOrder.push(dim); }
      var clusters = byDim[dim];

      /* BEST match, not first match: first-match makes the output depend on
       * interview completion order, so the list reshuffled between visits. */
      var best = null, bestScore = 0;
      for (var c = 0; c < clusters.length; c++) {
        var s = 0;
        for (var e = 0; e < clusters[c].entries.length; e++) {
          var ent = clusters[c].entries[e];
          if (!sameClaim(tokens, ent.tokens)) continue;
          var v = claimSimilarity(tokens, ent.tokens);
          if (v > s) s = v;
        }
        if (s > bestScore) { bestScore = s; best = clusters[c]; }
      }
      var label = labelFor(f) || role;
      if (best) best.entries.push({ text: text, role: role, label: label, tokens: tokens });
      else clusters.push({ dimension: dim, entries: [{ text: text, role: role, label: label, tokens: tokens }] });
    }

    function finish(cl) {
      var roles = [], texts = [], k;
      // Deduped on the ATTRIBUTION LABEL, so two holders of one role count as
      // two sources and one person's two findings still count as one.
      for (k = 0; k < cl.entries.length; k++) if (roles.indexOf(cl.entries[k].label) === -1) roles.push(cl.entries[k].label);
      var sorted = cl.entries.slice().sort(function (a, b) { return b.text.length - a.text.length; });
      for (k = 0; k < sorted.length; k++) if (texts.indexOf(sorted[k].text) === -1) texts.push(sorted[k].text);
      return {
        dimension: cl.dimension,
        text: texts.length ? texts[0] : "",
        texts: texts.slice(0, MAX_TEXTS_PER_CLUSTER),
        roles: roles,
        corroborated: roles.length >= 2
      };
    }

    var corroborated = [], single = [], thematic = [];
    for (var d = 0; d < dimOrder.length; d++) {
      var dimKey = dimOrder[d];
      var cls = byDim[dimKey].map(finish);
      var conf = cls.filter(function (x) { return x.corroborated; });
      var rest = cls.filter(function (x) { return !x.corroborated; });
      corroborated.push.apply(corroborated, conf);

      /* Only the UN-corroborated remainder counts as thematic — otherwise an
       * already-corroborated claim's roles would be counted twice. */
      var restRoles = [];
      for (var r1 = 0; r1 < rest.length; r1++) {
        for (var r2 = 0; r2 < rest[r1].roles.length; r2++) {
          if (restRoles.indexOf(rest[r1].roles[r2]) === -1) restRoles.push(rest[r1].roles[r2]);
        }
      }
      if (restRoles.length >= 2) thematic.push({ dimension: dimKey, roles: restRoles, clusters: rest });
      else single.push.apply(single, rest);
    }

    corroborated.sort(function (a, b) { return (b.roles.length - a.roles.length) || a.dimension.localeCompare(b.dimension); });
    thematic.sort(function (a, b) { return (b.roles.length - a.roles.length) || a.dimension.localeCompare(b.dimension); });
    single.sort(function (a, b) { return a.dimension.localeCompare(b.dimension); });

    return { corroborated: corroborated, thematic: thematic, single: single };
  }

  return {
    STOPWORDS: STOPWORDS,
    SIMILARITY_THRESHOLD: SIMILARITY_THRESHOLD,
    MIN_SHARED_TOKENS: MIN_SHARED_TOKENS,
    contentTokens: contentTokens,
    claimSimilarity: claimSimilarity,
    findingsOf: findingsOf,
    attributionLabels: attributionLabels,
    corroborateFindings: corroborateFindings
  };
});
