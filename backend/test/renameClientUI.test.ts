/**
 * v5.32.7 — "Rename Client" control in Pre-Engagement.
 *
 * The backend half of this fix (PATCH /api/clients/rename, renameClientKeys)
 * is covered by clients.test.ts, including the security-critical invariant
 * that a consultant's access survives a rename. This guards the frontend
 * half: that pre_engagement.html actually exposes a way to trigger it,
 * rather than the fix existing only as an API nobody can reach — same
 * "wiring, not just logic" pattern as roleCanon.test.ts /
 * roadmapUseCaseAdd.test.ts.
 *
 * Static source-text check — no frontend test runner in this repo.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dirname, "..", "..", "frontend");

function readPreEngagement(): string {
  return readFileSync(join(FRONTEND, "pre_engagement.html"), "utf8");
}

/*
 * Strip comments before any assertion about the ORDER of two calls.
 *
 * Written after this file's own new test failed on a comment that named the
 * function it was describing. A positional check that counts prose is wrong in
 * both directions: it false-alarms on an explanatory note, and — the half that
 * would actually matter — it would go on passing if the real call were
 * commented out and only the mention remained.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("pre_engagement.html — Rename Client (v5.32.7)", () => {
  it("renders a Rename Client button wired to renameClientPrompt()", () => {
    const src = readPreEngagement();
    expect(src).toContain('id="btn-rename-client"');
    expect(src).toContain('onclick="renameClientPrompt()"');
  });

  it("renameClientPrompt() calls the real rename endpoint with old + new names", () => {
    const src = readPreEngagement();
    const fn = src.match(/async function renameClientPrompt\(\)\{([\s\S]*?)\n\}/);
    expect(fn, "expected to find renameClientPrompt()").toBeTruthy();
    const body = fn![1];
    expect(body).toContain("vyneAuth.api('/api/clients/rename'");
    expect(body).toContain("method:'PATCH'");
    expect(body).toContain("clientName:oldName");
    expect(body).toContain("newClientName:newName");
  });

  it("handles the 409 name-collision and 403 owner-only responses distinctly, not a generic error", () => {
    const src = readPreEngagement();
    const fn = src.match(/async function renameClientPrompt\(\)\{([\s\S]*?)\n\}/);
    const body = fn![1];
    expect(body).toMatch(/e\.status\s*===\s*409/);
    expect(body).toMatch(/e\.status\s*===\s*403/);
  });

  it("a successful rename refreshes this page's own view under the corrected name", () => {
    const src = readPreEngagement();
    const fn = src.match(/async function renameClientPrompt\(\)\{([\s\S]*?)\n\}/);
    const body = fn![1];
    expect(body).toContain("detectRoundMode(newName)");
  });

  /*
   * v5.32.91 — the rename reverted on screen and did not reach the tracker.
   *
   * Reported from production: renaming Meridian Foods → Meridian Foods New
   * renamed the interview rows, but the briefing screen snapped back to the
   * old name, the save pill went red, and renaming BACK left the tracker
   * unchanged.
   *
   * One cause. PATCH /api/clients/rename rewrites the workspace keys
   * server-side, in a transaction, behind vyneStore's back. The browser cache
   * still held vynora_engagement_index keyed by the OLD norm, so
   * detectRoundMode(newName) looked up a name that cache had never heard of,
   * found nothing, and reset existingEngagement to null — the revert. The
   * stale `versions` map then 409'd the next flush — the red pill. And the
   * stale cache stayed locally authoritative, so later writes pushed the OLD
   * keys back — which is why the second rename never landed downstream.
   *
   * The ORDER is the fix, so the order is what is asserted: re-read, then
   * look up. Re-reading afterwards would leave the same wrong lookup in place.
   */
  it("re-reads the store after a rename, BEFORE looking the client up again", () => {
    const src = codeOnly(readPreEngagement());
    const fn = src.match(/async function renameClientPrompt\(\)\{([\s\S]*?)\n\}/);
    expect(fn, "expected to find renameClientPrompt()").toBeTruthy();
    const body = fn![1];

    /* v5.32.92: the SESSION is repointed first. vyneStore.rehydrate() alone
     * shipped in .91 and fixed nothing a consultant could see, because
     * autoRestoreFromStore() asks vyneAuth.activeClient() before it asks the
     * store anything. Session → store → lookup; each step is what makes the
     * next ask about the right client. frontend/test/rename-client-e2e.mjs is
     * the test that can actually observe this; these are the cheap guards. */
    /* v5.32.93b: matched as a CALL, not as one exact argument list. A second
     * argument was added (the owned norms, so the session follows only when it
     * was already on this client) and this assertion failed on the
     * punctuation, while the ORDER it exists to protect was untouched. A test
     * that fails for a reason it does not name is the same class of problem as
     * one that passes for a reason that does not hold. */
    const setActive = /vyneAuth\.setActiveClient\(\s*newName\b/;
    const rehydrateCall = /vyneStore\.rehydrate\(/;
    expect(body).toMatch(setActive);
    expect(body).toMatch(rehydrateCall);
    expect(body.search(setActive)).toBeLessThan(body.search(rehydrateCall));
    /* v5.32.95 — rehydrate() is now told which keys the SERVER just rewrote, so
     * this page's own queued writes for them are discarded instead of flushed.
     * Asserted, because flushing them is what undid the rename. */
    expect(body).toMatch(/vyneStore\.rehydrate\(\s*\{\s*drop:/);
    const rehydrateAt = body.search(rehydrateCall);
    const detectAt = body.indexOf("detectRoundMode(newName)");
    expect(rehydrateAt).toBeGreaterThan(-1);
    expect(detectAt).toBeGreaterThan(-1);
    expect(rehydrateAt).toBeLessThan(detectAt);
  });

  it("a failed re-read stops the page rather than editing on a stale cache", () => {
    // If the re-read fails the page cannot tell the renamed client from an
    // unknown one, and any further edit writes pre-rename keys over a
    // post-rename server. Saying "reload" is the only safe move; carrying on
    // is how the original bug corrupted state.
    const src = codeOnly(readPreEngagement());
    const fn = src.match(/async function renameClientPrompt\(\)\{([\s\S]*?)\n\}/);
    const body = fn![1];
    expect(body).toMatch(/RELOAD this page|Reload required/);
    // detectRoundMode must be inside the success branch, not run regardless.
    expect(body).toMatch(/if\s*\(\s*reread\s*\)\s*\{[\s\S]*detectRoundMode\(newName\)/);
  });

  it("vyneStore.rehydrate flushes pending writes before it discards the cache — except the ones the server just rewrote", () => {
    /*
     * The original rationale here said: "The pending writes were made against
     * the PRE-rename key names and are the consultant's own work. Dropping them
     * to make the re-read simple would be a worse bug than the one being
     * fixed."
     *
     * That belief WAS the bug (v5.32.95). Those writes are not the
     * consultant's work in any useful sense — they are a copy of the record as
     * it was BEFORE the rename, re-queued by detectRoundMode() on every load.
     * Flushing them is not a save, it is a revert, and flushNow() sent them
     * without expectedVersions, so the server could not refuse. The engagement
     * record ended up one name behind the index, the briefing key, the
     * interviews and the engagements row — the split four sessions spent
     * hunting, re-created by the rename itself, every single time.
     *
     * So: still flush by default (that part was always right), but a caller
     * who knows the server has just rewritten a set of keys can say so, and
     * those queued writes are dropped. Everything else still flushes.
     */
    const client = codeOnly(readFileSync(join(FRONTEND, "vyne-client.js"), "utf8"));
    const fn = client.match(/rehydrate: function \([^)]*\) \{([\s\S]*?)\n    \},/);
    expect(fn, "expected to find vyneStore.rehydrate()").toBeTruthy();
    const body = fn![1];
    expect(body).toContain("flushNow()");
    expect(body.indexOf("flushNow()")).toBeLessThan(body.indexOf("fetchStateSync"));
    // The drop happens BEFORE the flush, or it drops nothing.
    expect(body).toMatch(/drop\(k\)/);
    expect(body.search(/drop\(k\)/)).toBeLessThan(body.indexOf("flushNow()"));
    // A failed re-read must NOT blank the cache — that would present a real
    // firm as an empty one, the v5.32.25 data-loss shape.
    expect(body).toMatch(/if \(fresh === null\) return false/);
    const nullGuardAt = body.indexOf("fresh === null");
    const assignAt = body.indexOf("cache = fresh");
    expect(nullGuardAt).toBeLessThan(assignAt);
  });

  /*
   * v5.32.95. EVERY write path must carry expectedVersions.
   *
   * flushNow() — the pagehide/beforeunload path — omitted it, in both its sync
   * XHR attempt and its keepalive fetch fallback. That made closing a tab a
   * FORCE WRITE the server had no way to refuse, so a second tab holding a
   * pre-rename copy of the engagement record silently undid a rename made in
   * the first one just by being closed.
   *
   * Asserted structurally rather than per-call-site, because the failure mode
   * is someone adding a THIRD write path later and omitting it again. The
   * browser test that observes this (frontend/test/rename-cycle-e2e.mjs, part
   * F) had to close the tab inside the 800ms debounce to catch it — easy to
   * get subtly wrong, and it passed against the bug until it was.
   */
  it("every PUT of workspace state carries expectedVersions — no force writes", () => {
    const client = codeOnly(readFileSync(join(FRONTEND, "vyne-client.js"), "utf8"));
    /*
     * v5.33.1: matched on the PAYLOAD OBJECT, not on the `body:` keyword.
     *
     * The previous regex anchored on `body:` / `xhr.send(`, so hoisting a
     * payload into a variable — which flush() now does, to measure its size
     * before deciding whether keepalive is safe — made the write invisible to
     * this test rather than failing it. A guard that stops seeing the thing it
     * guards is worse than no guard: it goes green precisely when the code
     * moves. Match every place a {sets, deletes} payload is BUILT, wherever it
     * is then sent from.
     */
    const bodies = client.match(/JSON\.stringify\(\{[^}]*?sets:\s*sets[^}]*?deletes:\s*deletes[^}]*?\}/g) || [];
    expect(bodies.length, "expected to find the state-write payloads").toBeGreaterThanOrEqual(3);
    for (const b of bodies) {
      expect(b, "a workspace write with no expectedVersions is a force write: " + b.slice(0, 120))
        .toContain("expectedVersions");
    }
  });

  it("the button's visibility is synced everywhere the engagement code display updates", () => {
    const src = readPreEngagement();
    // Every site that sets #eng-code-display's textContent must also call
    // syncRenameButtonVisibility() (or, in detectRoundMode's early-exit
    // branches, explicitly hide it) — otherwise the button can be left
    // showing for the wrong client, or hidden for a real one.
    const displaySites = [...src.matchAll(/eng-code-display'\)(?:\.textContent| ,)/g)];
    expect(displaySites.length).toBeGreaterThan(0);
    expect(src).toContain("function syncRenameButtonVisibility()");
    const syncCallCount = (src.match(/syncRenameButtonVisibility\(\)/g) || []).length;
    // Defined once, plus called from renameClientPrompt's finally + at least
    // the 4 known display-update sites.
    expect(syncCallCount).toBeGreaterThanOrEqual(5);
  });

  it("v5.32.11: the engagement code display lives next to Client Company Name, not down in the export bar", () => {
    // The export bar only becomes visible after a briefing/round is actually
    // generated (style="display:none" until then) — that's what made the
    // Rename button unreachable in the first place (v5.32.9). The engagement
    // id had the same problem: it's the identifying context for the rename
    // action, so it now sits in the same always-visible wrapper as the
    // button, directly under the name field, instead of in the gated bar.
    const src = readPreEngagement();
    const engDisplayIdx = src.indexOf('id="eng-code-display"');
    const exportBarIdx = src.indexOf('class="export-bar"');
    const clientNameIdx = src.indexOf('id="client-name"');
    expect(engDisplayIdx).toBeGreaterThan(-1);
    expect(exportBarIdx).toBeGreaterThan(-1);
    expect(clientNameIdx).toBeGreaterThan(-1);
    expect(engDisplayIdx).toBeGreaterThan(clientNameIdx);
    expect(engDisplayIdx).toBeLessThan(exportBarIdx);
    // Only one copy — same duplicate-id trap as the button had before.
    expect((src.match(/id="eng-code-display"/g) || []).length).toBe(1);
  });
});

describe("rename moves BILLING history too (v5.33.3, audit MEDIUM)", () => {
  /**
   * usage_events.client_norm is frozen at write time and is what
   * GET /api/billing/summary authorizes historical rows on. The rename moved
   * engagements, interviews, workspace state and assignments and left this
   * table alone, so:
   *
   *   · the renamed client loses its own spend history, and
   *   · reusing the old name later — a first-class flow since v5.33.1 — hands
   *     the NEXT client's consultant the previous client's spend and model mix.
   *
   * auth/clients.ts's own migration note lists usage_events among the
   * client_norm-carrying tables. The note was right; the code never followed it.
   *
   * REVERT TEST: delete the `UPDATE usage_events` block from the rename
   * transaction in routes/assignments.ts and both cases below fail.
   */
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes", "assignments.ts"),
    "utf8"
  );

  it("the rename transaction re-keys usage_events.client_norm", () => {
    expect(SRC).toContain("UPDATE usage_events SET client_norm = $1 WHERE client_norm = ANY($2::text[])");
  });

  it("it moves EVERY norm the engagement was found under, not just assigned ones", () => {
    /* assignmentNorms alone would miss a client with no consultant assigned —
     * which still accrues usage — and would miss the legacy 30-char norms that
     * report.ownedNorms carries. */
    const block = SRC.slice(SRC.indexOf("let usageRekeyed"), SRC.indexOf("UPDATE usage_events"));
    expect(block).toContain("plan.report.ownedNorms");
    expect(block).toContain("plan.assignmentNorms");
    expect(block).toContain("n !== plan.newNorm");
  });

  it("it runs INSIDE the same transaction as the rest of the rename", () => {
    // A rename that half-moves billing is worse than one that fails, because
    // nothing surfaces it. The UPDATE must sit before the transaction's return.
    const txEnd = SRC.indexOf("conflict: null,");
    expect(SRC.indexOf("UPDATE usage_events")).toBeLessThan(txEnd);
  });
});
