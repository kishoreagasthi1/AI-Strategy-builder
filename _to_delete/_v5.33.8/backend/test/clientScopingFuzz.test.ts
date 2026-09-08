/**
 * PROPERTY-BASED FUZZING of auth/clients.ts (v5.32.31).
 *
 * Why this file exists. Every prior review of clients.ts — including three
 * adversarial audit passes — reasoned about hand-picked keys. That is how a
 * file whose job is string parsing over an UNBOUNDED key space keeps shipping
 * leaks: a reviewer can only check the keys they thought of.
 *
 * This generates random multi-client workspaces over the real key families and
 * asserts INVARIANTS rather than expected outputs, so it can catch leaks nobody
 * named. Two properties of the generator are load-bearing and were both got
 * wrong on the first attempt — each mistake made the fuzzer silently useless:
 *
 *   · OPAQUE keys (values that do NOT carry a top-level .client) must be
 *     generated, or every key resolves via the value-fallback branch and the
 *     final deny-by-default branch is never exercised. Without them the fuzzer
 *     passed with the v5.32.25 "unrecognised key → GLOBAL" bug reintroduced.
 *   · SIBLING_PAIRS — genuinely distinct clients agreeing for the first 30
 *     normalised characters — must be generated, or the v5.32.26 prefix
 *     tolerance in normSetHas cannot be detected. Without them the fuzzer
 *     passed with that privilege escalation reintroduced.
 *
 * All four historical bug classes were verified to FAIL this file before it was
 * committed (revert the fix, watch the test go red, restore it):
 *   1. resolveKeyClient final branch → "GLOBAL"        (v5.32.25 leak)
 *   2. normSetHas prefix tolerance                     (v5.32.26 priv-esc)
 *   3. removing the CR-1 code-ownership refusal        (v5.32.29 CR-1)
 *   4. taking notes/synthesis/gantt from the request   (v5.32.26 clobber)
 *
 * If you add a key family to clients.ts, add it to the generator here too.
 * Needs no database.
 */
import { describe, it, expect } from "vitest";
import {
  normClient, legacyNormClient, buildWorkspaceMaps, resolveKeyClient,
  filterWorkspaceState, scopeWorkspaceWrite, purgeClientKeys, renameClientKeys,
} from "../src/auth/clients.js";


// ── deterministic RNG so a failure is reproducible ───────────────────────────
let seed = 0xC0FFEE;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const chance = (p: number) => rnd() < p;

const CLIENTS = ["Acme Ltd", "Beta Corp", "Victor Industries",
  "eng", "client", "unassigned", "none", "UNKNOWN", "X"];

/**
 * Pairs of genuinely distinct clients whose names agree for AT LEAST the first
 * 30 normalised characters — the exact collision the 30→100 widening exists to
 * prevent, and the only shape the v5.32.26 prefix-tolerance bug exploits.
 * A fuzzer without these cannot detect that class of privilege escalation.
 */
const SIBLING_PAIRS: [string, string][] = [
  ["Meridian Capital Partners Group Holdings LLC", "Meridian Capital Partners Group Holdings Asia"],
  ["Mitsubishi Heavy Industries Machine Tool Company", "Mitsubishi Heavy Industries Machinery Systems"],
  ["International Business Consolidated Holdings North", "International Business Consolidated Holdings South"],
];
for (const [a, b] of SIBLING_PAIRS) {
  const la = a.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
  const lb = b.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
  if (la !== lb || la.length !== 30) {
    console.error(`FIXTURE BUG: "${a}" / "${b}" do not share a 30-char norm (${la} vs ${lb})`);
    process.exit(2);
  }
}
/** Codes must be UNIQUE per client — reusing one across two clients makes the
 *  fixture itself inconsistent and produces phantom "leaks" that are artifacts
 *  of the generator, not of the code under test. */
const codeFor = (i: number) => `ENGC-${String(i).padStart(4, "0")}`;
const NORM_SUFFIX = ["vynora_briefing_", "vynora_mandatory_", "vynora_draft_pre_engagement_"];
const CODE_SUFFIX = ["vynora_engagement_", "vynora_synthesis_full_", "vynora_interview_archive_",
  "vynora_roadmap_scores_", "vynora_dim_notes_", "vynora_uc_stages_", "vynora_solution_design_",
  "vynora_design_studio_", "vynora_uc_requirements_", "vynora_refresh_agenda_"];
const SHARED = ["vynora_engagement_index", "vynora_code_index", "vynora_roadmap_index", "vynora_roadmap_state"];

interface World { state: Record<string, string>; clientOf: Record<string, string>; codeOwner: Record<string, string>; }

/** Build a random but internally consistent multi-client workspace. */
function makeWorld(): World {
  const state: Record<string, string> = {};
  const clientOf: Record<string, string> = {};   // key → owning client NAME
  const codeOwner: Record<string, string> = {};  // CODE → owning client NAME
  const engIndex: Record<string, string> = {};
  const codeIndex: Record<string, string> = {};
  const roadmapIndex: Record<string, any> = {};
  const roadmapState: any = { assumptions: {}, dependencies: {}, generated: {}, byEng: {}, notes: "owner-notes", synthesis: "owner-synth", gantt: "owner-gantt", savedAt: 1 };

  const n = 2 + Math.floor(rnd() * 4);
  const chosen: string[] = [];
  // Half of all worlds contain a truncation-colliding sibling pair.
  if (chance(0.5)) chosen.push(...pick(SIBLING_PAIRS));
  for (let i = 0; i < n; i++) { const c = pick(CLIENTS); if (!chosen.includes(c)) chosen.push(c); }

  chosen.forEach((client, i) => {
    const norm = normClient(client);
    if (!norm) return;
    const code = codeFor(i);
    codeOwner[code] = client;
    engIndex[norm] = code;
    codeIndex[code] = `sid${i}`;
    roadmapIndex[code] = { clientName: client };
    roadmapState.assumptions[`eng_${code}`] = { a: client };
    roadmapState.byEng[`client_${norm}`] = { b: client };
    if (chance(0.7)) roadmapState.generated[`eng_${code}`] = { g: client };

    for (const p of NORM_SUFFIX) if (chance(0.6)) { const k = p + norm; state[k] = JSON.stringify({ client }); clientOf[k] = client; }
    for (const p of CODE_SUFFIX) if (chance(0.5)) {
      // families keyed by code, and families keyed by norm — both real shapes
      const k = chance(0.5) ? p + code : p + norm;
      state[k] = JSON.stringify({ client, payload: "secret-" + norm });
      clientOf[k] = client;
    }
    if (chance(0.5)) { const k = `vynora_session_sid${i}`; state[k] = JSON.stringify({ client }); clientOf[k] = client; }
    if (chance(0.4)) { const k = `vynora_engagement_${code}`; state[k] = JSON.stringify({ code, client }); clientOf[k] = client; }
  });

  state.vynora_engagement_index = JSON.stringify(engIndex);
  state.vynora_code_index = JSON.stringify(codeIndex);
  state.vynora_roadmap_index = JSON.stringify(roadmapIndex);
  state.vynora_roadmap_state = JSON.stringify(roadmapState);
  state.vynora_deck_mode = "full";
  state.vynora_api_key = "sk-firm-secret";
  state.vynora_industry_catalog_tech = JSON.stringify({ x: 1 });
  if (chance(0.5)) state.vynora_dm_snapshots = JSON.stringify([{ clientName: chosen[0] }]);
  if (chance(0.5)) state.vynora_last_briefing = JSON.stringify({ client: chosen[0] });

  // OPAQUE keys: client-owned, but the value does NOT self-describe, so the
  // value-fallback branch cannot rescue them and resolution must fall to the
  // final deny branch. This is the shape a NEW key family takes when someone
  // adds one without updating clients.ts — the exact v5.32.25 leak class, and
  // the shape the first version of this fuzzer failed to generate.
  chosen.forEach((client) => {
    const norm = normClient(client);
    if (!norm) return;
    if (chance(0.6)) { const k = `vynora_future_family_${norm}`; state[k] = JSON.stringify({ data: "secret-" + norm }); clientOf[k] = client; }
    if (chance(0.4)) { const k = `vynora_v6_notes_${norm}`; state[k] = "plain-text-not-json-" + norm; clientOf[k] = client; }
    if (chance(0.3)) { const k = `vynora_dm_snapshot_${norm}`; state[k] = JSON.stringify([{ x: norm }]); clientOf[k] = client; }
  });

  return { state, clientOf, codeOwner };
}

const failures: string[] = [];
let cases = 0;
const fail = (inv: string, detail: string) => { if (failures.length < 25) failures.push(`[${inv}] ${detail}`); };


describe("auth/clients.ts — property-based fuzz", () => {
  it("holds every isolation invariant across thousands of generated workspaces", () => {
for (let iter = 0; iter < 4000; iter++) {
  const w = makeWorld();
  const clients = [...new Set(Object.values(w.clientOf).concat(Object.values(w.codeOwner)))];
  if (clients.length < 2) continue;
  const mine = pick(clients);
  const theirs = clients.filter((c) => c !== mine && normClient(c) !== normClient(mine));
  if (!theirs.length) continue;
  cases++;
  const allowed = new Set([normClient(mine), legacyNormClient(mine)].filter(Boolean));
  const maps = buildWorkspaceMaps(w.state);

  // ── INV-1: the read path never hands over a key owned by another client ──
  const view = filterWorkspaceState(w.state, allowed);
  for (const k of Object.keys(view)) {
    const owner = w.clientOf[k];
    if (owner && normClient(owner) !== normClient(mine)) fail("INV-1 read-leak", `key ${k} owned by "${owner}" served to "${mine}"`);
  }
  // index entries must not name another client's norm/code
  const vEng = JSON.parse(view.vynora_engagement_index || "{}");
  for (const [norm, code] of Object.entries(vEng)) {
    if (!allowed.has(norm)) fail("INV-1b index-leak", `engagement_index entry ${norm}→${code} served to "${mine}"`);
  }
  const vRoad = JSON.parse(view.vynora_roadmap_index || "{}");
  for (const [code, meta] of Object.entries<any>(vRoad)) {
    const own = w.codeOwner[code];
    if (own && normClient(own) !== normClient(mine)) fail("INV-1c roadmap-index-leak", `code ${code} of "${own}" served to "${mine}"`);
  }
  // the firm's LLM key is owner-only
  if ("vynora_api_key" in view) fail("INV-1d owner-only", `vynora_api_key served to restricted consultant "${mine}"`);

  // ── INV-2: echoing the filtered view back must not disturb anyone else ──
  const echo = scopeWorkspaceWrite({ ...view }, [], w.state, allowed);
  const after = { ...w.state };
  for (const [k, v] of Object.entries(echo.sets)) after[k] = v;
  for (const k of echo.deletes) delete after[k];
  for (const k of Object.keys(w.state)) {
    const owner = w.clientOf[k];
    if (owner && normClient(owner) !== normClient(mine) && after[k] !== w.state[k])
      fail("INV-2 echo-clobber", `key ${k} of "${owner}" changed by "${mine}" echoing their own view`);
  }
  for (const shared of ["vynora_roadmap_state", "vynora_engagement_index", "vynora_roadmap_index"]) {
    const before = JSON.parse(w.state[shared]), post = JSON.parse(after[shared]);
    if (shared === "vynora_roadmap_state") {
      for (const slot of ["notes", "synthesis", "gantt"]) if (post[slot] !== before[slot])
        fail("INV-2b flat-slot-clobber", `${slot} changed from ${JSON.stringify(before[slot])} to ${JSON.stringify(post[slot])}`);
      for (const fam of ["assumptions", "byEng", "generated"]) {
        for (const ek of Object.keys(before[fam] || {})) {
          const code = ek.startsWith("eng_") ? ek.slice(4) : null;
          const own = code ? w.codeOwner[code] : null;
          if (own && normClient(own) !== normClient(mine) && JSON.stringify(post[fam]?.[ek]) !== JSON.stringify(before[fam][ek]))
            fail("INV-2c roadmap-entry-clobber", `${fam}.${ek} of "${own}" changed by "${mine}"`);
        }
      }
    } else {
      for (const ek of Object.keys(before)) {
        const own = shared === "vynora_engagement_index"
          ? Object.entries(w.codeOwner).find(([c]) => c === before[ek])?.[1]
          : w.codeOwner[ek];
        if (own && normClient(own) !== normClient(mine) && JSON.stringify(post[ek]) !== JSON.stringify(before[ek]))
          fail("INV-2d index-entry-clobber", `${shared}.${ek} of "${own}" changed by "${mine}"`);
      }
    }
  }

  // ── INV-3: a HOSTILE write must not reach another client's data ──────────
  const victim = pick(theirs);
  const victimNorm = normClient(victim);
  const victimCode = Object.entries(w.codeOwner).find(([, c]) => c === victim)?.[0];
  const hostile: Record<string, string> = {};
  // (a) bind my norm to the victim's engagement code — the audit CR-1 shape
  if (victimCode) hostile.vynora_engagement_index = JSON.stringify({ [normClient(mine)]: victimCode });
  // (b) write directly into a victim-owned key
  for (const k of Object.keys(w.clientOf)) if (w.clientOf[k] === victim && chance(0.5)) hostile[k] = JSON.stringify({ pwned: true });
  // (c) claim ownership via the value fallback
  hostile[`vynora_solution_design_${normClient(mine)}`] = JSON.stringify({ client: victim, pwned: true });
  // (d) overwrite the firm-wide LLM key
  hostile.vynora_api_key = "sk-attacker";
  // (e) blank the shared flat slots
  hostile.vynora_roadmap_state = JSON.stringify({ assumptions: {}, dependencies: {}, generated: {}, byEng: {}, notes: "", synthesis: "", gantt: "" });

  const hostileDeletes = Object.keys(w.clientOf).filter((k) => w.clientOf[k] === victim);
  const scoped = scopeWorkspaceWrite(hostile, hostileDeletes, w.state, allowed);

  const after2 = { ...w.state };
  for (const [k, v] of Object.entries(scoped.sets)) after2[k] = v;
  for (const k of scoped.deletes) delete after2[k];

  for (const k of hostileDeletes) if (!(k in after2)) fail("INV-3a hostile-delete", `"${mine}" deleted ${k} owned by "${victim}"`);
  for (const k of Object.keys(w.clientOf))
    if (w.clientOf[k] === victim && after2[k] !== w.state[k]) fail("INV-3b hostile-write", `"${mine}" modified ${k} owned by "${victim}"`);
  if (after2.vynora_api_key !== w.state.vynora_api_key) fail("INV-3c api-key-write", `restricted consultant "${mine}" overwrote vynora_api_key`);
  const rs2 = JSON.parse(after2.vynora_roadmap_state);
  for (const slot of ["notes", "synthesis", "gantt"])
    if (rs2[slot] !== JSON.parse(w.state.vynora_roadmap_state)[slot]) fail("INV-3d flat-slot-erase", `"${mine}" erased roadmap_state.${slot}`);
  // the code-binding attack: after the write, the victim's code must NOT resolve to me
  const maps2 = buildWorkspaceMaps(after2);
  if (victimCode && maps2.codeToNorm.get(victimCode) === normClient(mine))
    fail("INV-3e code-hijack", `"${mine}" bound victim code ${victimCode} to their own norm`);
  // and the follow-on read must still not serve the victim's keys
  const view2 = filterWorkspaceState(after2, allowed);
  for (const k of Object.keys(view2)) {
    const owner = w.clientOf[k];
    if (owner === victim) fail("INV-3f post-write-read-leak", `after hostile write, ${k} of "${victim}" served to "${mine}"`);
  }

  // ── INV-4: purge leaves nothing resolving to the purged client ───────────
  const pn = normClient(victim);
  if (pn) {
    const purge = purgeClientKeys(w.state, pn, [legacyNormClient(victim)]);
    const purged = { ...w.state };
    for (const [k, v] of Object.entries(purge.sets)) purged[k] = v;
    for (const k of purge.deletes) delete purged[k];
    const pmaps = buildWorkspaceMaps(purged);
    for (const k of Object.keys(purged)) {
      if (SHARED.includes(k)) continue;
      const r = resolveKeyClient(k, purged[k], pmaps);
      if (r === pn) fail("INV-4 purge-residue", `key ${k} still resolves to purged client "${victim}"`);
    }
    const pIdx = JSON.parse(purged.vynora_engagement_index || "{}");
    if (pn in pIdx) fail("INV-4b purge-index-residue", `engagement_index still holds "${pn}"`);
  }

  // ── INV-5: rename must not merge two clients or strand the old norm ──────
  if (chance(0.3)) {
    const newName = "Renamed " + mine;
    const rn = renameClientKeys(w.state, normClient(mine), newName);
    if (rn) {
      const renamed = { ...w.state };
      for (const [k, v] of Object.entries(rn.sets)) renamed[k] = v;
      for (const k of rn.deletes) delete renamed[k];
      for (const k of Object.keys(w.clientOf)) {
        const owner = w.clientOf[k];
        if (owner && normClient(owner) !== normClient(mine) && renamed[k] !== w.state[k])
          fail("INV-5 rename-collateral", `rename of "${mine}" changed ${k} owned by "${owner}"`);
      }
      if (rn.deletes.some((d) => rn.sets[d] !== undefined))
        fail("INV-5b rename-race", `a key is both deleted and set in the same rename plan`);
    }
  }
}

    expect(cases).toBeGreaterThan(2000);   // the generator must actually generate
    expect(failures).toEqual([]);
  });
});
