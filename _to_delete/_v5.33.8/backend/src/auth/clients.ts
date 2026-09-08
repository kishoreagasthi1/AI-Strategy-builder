/**
 * Client-level access control (Phase 5).
 *
 * Tenants isolate FIRMS (RLS). This module isolates CLIENTS within a firm:
 *   owner       → unrestricted (allowed === null)
 *   consultant  → only clients assigned via client_assignments. No
 *                 assignment → sees nothing. Deny by default.
 *   interviewee → handled separately (own interview + own client only).
 *
 * Clients are matched by normClient(name): lower, strip non-alphanumerics,
 * first 100 chars (was 30 before v5.32.26) — the same convention every module
 * uses. See normClient() below for the widening and its migration story.
 *
 * Workspace-state filtering: the shared 'workspace' namespace holds keys for
 * many clients. resolveKeyClient() maps a key (+value) to a client norm using
 * the key-family conventions; filterWorkspaceState() then drops anything that
 * belongs to a client outside the allowed set. ANY key that cannot be
 * positively resolved to an allowed client is DROPPED — deny by default,
 * including keys this file doesn't recognize at all. The ONLY things that
 * pass through unfiltered are keys on the explicit GLOBAL_KEYS/GLOBAL_PREFIXES
 * allowlist below (hand-reviewed, no client identity by construction) and the
 * handful of shared index keys that get entry-wise filtering of their own.
 * An unrecognized key is NOT assumed global — see resolveKeyClient()'s final
 * branch for why that used to be the opposite, and was a critical bug.
 */
/*
 * v5.32.93 — the ONE database import in this file is now loaded lazily, inside
 * the one function that uses it (allowedClientNorms, already async).
 *
 * Reason, and it is a testing reason rather than a runtime one: with no
 * top-level imports, this module can be imported directly by a plain
 * `node frontend/test/*.mjs` script (Node >= 22.18 strips the types natively),
 * so a browser end-to-end test can drive the real page against the REAL
 * rename algorithm instead of a hand-written imitation of it. Four rounds of
 * this bug survived because every check that looked at the rename looked at a
 * copy of it: static source assertions, and a fake server that reimplemented
 * the parts it was asked to prove. frontend/test/rename-cycle-e2e.mjs imports
 * renameClientKeys() from THIS file, so it cannot pass for a reason that does
 * not hold in production.
 *
 * Pulling ../db/pool.js at module load would drag in `pg` and the config/env
 * it reads, which is what made that impossible before. Nothing else here
 * touches the database.
 */
type WithTenant = <T>(tenantId: string, fn: (c: {
  query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
}) => Promise<T>) => Promise<T>;

/**
 * v5.32.26 — the client-identity truncation was raised from 30 to 100
 * alphanumeric characters. At 30, two distinct client names sharing a
 * 30-character alphanumeric prefix collapsed onto ONE identity: one
 * assignment grant covered both, one set of workspace keys held both
 * clients' work, and neither the UI nor the API had any way to tell them
 * apart. That is realistic for firms carrying several subsidiaries of the
 * same conglomerate ("Mitsubishi Heavy Industries Thermal Systems Ltd" and
 * "Mitsubishi Heavy Industries Thermal Power Systems Ltd" agree for the first
 * 32 alphanumeric characters).
 *
 * The truncation exists at all so a key stays a bounded, index-friendly
 * string; 100 keeps that property while making a real-world collision
 * require two names identical for 100 alphanumeric characters.
 *
 * MIGRATION. Keys already in Postgres were derived with the 30-char rule, so
 * widening naively would orphan every long-named client's data. Three things
 * carry the change:
 *   1. db/migrations/011_client_norm_widen.sql recomputes the two flat
 *      client_norm COLUMNS (client_assignments, usage_events) from the
 *      client_name that sits beside them in the same row.
 *   2. migrateLegacyNormKeys() below rewrites stored workspace KEYS from the
 *      legacy norm to the widened one; routes/moduleState.ts runs it on read,
 *      so it is applied lazily, per tenant, and is a no-op once done.
 *   3. allowedClientNorms() expands each assignment row into the exact norms
 *      that row can mean, computed from its own client_name, so authorization
 *      keeps working for any row or key either migration has not reached yet.
 *      (v5.32.26 did this with a prefix wildcard instead; that was a
 *      privilege-escalation bug and was removed in v5.32.29 — see normSetHas.)
 */
export const NORM_MAX = 100;

/** The pre-v5.32.26 truncation. Retained ONLY for reading legacy data. */
export const LEGACY_NORM_MAX = 30;

export function normClient(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, NORM_MAX);
}

/** The norm a pre-v5.32.26 build would have derived for this name. */
export function legacyNormClient(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, LEGACY_NORM_MAX);
}

/**
 * v5.32.29 SECURITY (audit H-1) — this used to be normMatches(), a prefix
 * tolerance that treated any norm of EXACTLY 30 characters as matching every
 * longer norm it prefixes. I shipped it in v5.32.26 and documented it as
 * length-pinned and safe. It was not, and the doc comment was wrong: the
 * function cannot tell a TRUNCATED 30-character norm from a NATURALLY
 * 30-character one, because they are the same string.
 *
 * Verified before removal: a consultant assigned only to
 * "Meridian Capital Partners Grou-p Ho" (norm exactly 30, never truncated)
 * passed clientAllowed() for "Meridian Capital Partners Group Holdings LLC",
 * in both directions — and clientAllowed() is the single gate for every
 * client-scoped route in the app.
 *
 * The compatibility problem it was solving is real but does not need a
 * wildcard, because client_assignments stores `client_name` in the same row
 * as `client_norm`. allowedClientNorms() now expands each row into the exact
 * strings that row can legitimately mean — the stored norm, the widened norm,
 * and the legacy norm, all derived from that row's own name. Three exact
 * matches instead of an open-ended prefix rule.
 *
 * Membership is therefore plain set membership. Keep it that way.
 */
export function normSetHas(allowed: Set<string>, norm: string): boolean {
  if (!norm || norm === "UNKNOWN") return false;
  return allowed.has(norm);
}

/** null → unrestricted (owner). Otherwise the set of allowed client norms. */
export async function allowedClientNorms(
  tenantId: string,
  userId: string,
  role: string
): Promise<Set<string> | null> {
  if (role === "owner") return null;
  const { withTenant } = (await import("../db/pool.js")) as { withTenant: WithTenant };
  return withTenant(tenantId, async (c) => {
    const r = await c.query<{ client_norm: string; client_name: string }>(
      `SELECT client_norm, client_name FROM client_assignments WHERE user_id = $1`,
      [userId]
    );
    // v5.32.29 (audit H-1): expand each row into the exact norms it can mean,
    // derived from that row's OWN client_name — the stored value (whatever
    // truncation was in force when it was written), the current 100-char rule,
    // and the legacy 30-char rule for data migration 011 has not reached yet.
    // This is what replaced the prefix wildcard: same compatibility, no reach
    // into any other client's identity.
    const out = new Set<string>();
    for (const row of r.rows) {
      if (row.client_norm) out.add(row.client_norm);
      if (row.client_name) {
        out.add(normClient(row.client_name));
        out.add(legacyNormClient(row.client_name));
      }
    }
    out.delete("");
    return out;
  });
}

export function clientAllowed(allowed: Set<string> | null, clientName: string): boolean {
  if (allowed === null) return true;
  return normSetHas(allowed, normClient(clientName));
}

/* ── Workspace key → client resolution ────────────────────────────────────── */

/**
 * Keys with NO client identity, ever — reviewed and enumerated by hand from
 * every vyneStore.getItem/setItem call site in frontend/*.html (v5.25 audit
 * fix). This is a POSITIVE list of confirmed-safe keys, not a place to guess:
 * a key that isn't here falls through to resolveKeyClient()'s final branch,
 * which now denies (see the fix note there) rather than assumes safety.
 *   vynora_api_key   — a single LLM-key string preference, firm-wide.
 *   vynora_deck_mode — a single 'internal'|'client' UI preference.
 * Deliberately NOT here: vynora_dm_snapshots. Its value is an array of
 * records that each carry their own `clientName` (synthesis.html
 * saveSnapshotMeta) — a single opaque key mixing multiple clients' data,
 * the same shape as the bug this fix closes. It now denies for a restricted
 * consultant (the snapshot pill/list is unavailable) rather than leak; an
 * entry-wise filter (like vynora_engagement_index gets) is the ideal
 * follow-up if that UI is needed for restricted consultants.
 */
const GLOBAL_KEYS = new Set(["vynora_deck_mode"]);

/**
 * v5.32.29 (audit M-6). vynora_api_key was on the GLOBAL_KEYS allowlist, so a
 * consultant with ZERO client assignments could read — and overwrite — the
 * firm's stored LLM key through /api/module-state/workspace. It has no client
 * identity, which is why it was there, but "no client identity" is not the
 * same as "safe for everyone": routes/interviews.ts already lists it in
 * BLOCKED_PREFIXES for interviewees, so its sensitivity was recognised.
 *
 * Keys here resolve to OWNER — a value no assignment set can ever contain, so
 * a restricted caller can neither read nor write them, while owners (who
 * short-circuit on allowed === null before any of this runs) are unaffected.
 */
const OWNER_ONLY_KEYS = new Set(["vynora_api_key"]);

/**
 * Key PREFIXES with no client identity — same bar as GLOBAL_KEYS, just
 * parameterized. vynora_industry_catalog_<norm-of-INDUSTRY> is keyed by
 * INDUSTRY, not client, and is explicitly firm-wide/reused-across-clients by
 * design (see roadmap.html's customCatalogKey comment).
 */
const GLOBAL_PREFIXES = ["vynora_industry_catalog_"];

/** Key families suffixed by the NORMALIZED client name. */
const NORM_SUFFIX = ["vynora_briefing_", "vynora_mandatory_", "vynora_draft_pre_engagement_"];

/** Key families suffixed by an engagement CODE (or "<code>_extra"). */
const CODE_SUFFIX = [
  "vynora_engagement_",
  "vynora_hypothesis_verdicts_",
  "vynora_hypothesis_overrides_",
  "vynora_refresh_agenda_",
  "vynora_refresh_context_",
  "vynora_refresh_resolved_",
  "vynora_custom_focus_",
  "vynora_dim_notes_",
  "vynora_synthesis_full_",
  "vynora_synthesis_recommendations_",
  "vynora_roadmap_scores_",
  "vynora_roadmap_snapsig_",
  "vynora_interview_archive_",
  "vynora_sim_archive_",
  "vynora_uc_overrides_",
  "vynora_uc_req_overrides_",
  "vynora_uc_requirements_",
  "vynora_uc_stages_",
  "vynora_uc_dismissed_gaps_",
  // Solution Design Studio (v5.30) — suffixed by NORMALIZED CLIENT (same as
  // vynora_uc_overrides_/vynora_uc_stages_ above), not an engagement code;
  // resolveKeyClient()'s CODE_SUFFIX branch already accepts either shape
  // ("Some families suffix by norm client instead of code — accept that
  // too", below) so no other change is needed for this to scope correctly.
  /*
   * v5.33.0 DATA LOSS — five roadmap families that were never registered here.
   *
   * vynora_dim_gaps_, vynora_gap_credits_, vynora_gap_plans_,
   * vynora_measured_base_ and vynora_maturity_targets_ are written by
   * roadmap.html (saveDimGaps/saveGapCredits/saveGapPlans/saveMeasuredBase/
   * saveMaturityTargets) suffixed by getEngKey(), exactly like
   * vynora_dim_notes_ and vynora_uc_requirements_ beside them.
   *
   * Those two are in this list. These five never were. So resolveKeyClient()
   * fell through to its deny-by-default branch and returned UNKNOWN, which
   * means filterWorkspaceState() dropped them on READ and scopeWorkspaceWrite()
   * dropped them on WRITE — while the PUT still returned {ok:true} and the page
   * painted "Saved". Every restricted consultant lost their gap analysis,
   * gap credits, remediation plans, measured baseline and maturity targets on
   * every reload, silently.
   *
   * This is the identical shape to the v5.32.25 data loss documented in
   * resolveKeyClient() below — same cause, same symptom, five more families
   * that the fix did not reach because nobody enumerated the writers.
   * ENG_KEY_FAMILIES further down lists all five, but that constant feeds only
   * the (dormant) norm→code migration, never the scoping layer.
   */
  "vynora_dim_gaps_",
  "vynora_gap_credits_",
  "vynora_gap_plans_",
  "vynora_measured_base_",
  "vynora_maturity_targets_",
  "vynora_solution_design_",
  // Solution Design Studio portfolios (v5.32.18) — one blob per client holding
  // that client's use-case portfolio, intakes, patterns and briefs. Norm-client
  // suffixed like vynora_solution_design_ above. Without this line
  // resolveKeyClient() returns UNKNOWN and the server silently drops every read
  // AND write for a restricted consultant, which presents as "my work vanished".
  "vynora_design_studio_",
  /*
   * v5.33.3 (audit MEDIUM) — engagement MEMORY, added in v5.32.88 and never
   * registered here.
   *
   * vynora_memory_<CODE> is code-addressed exactly like vynora_synthesis_full_
   * two dozen lines up. Without this line resolveKeyClient() skipped the
   * server-authoritative codeToNorm() resolution that every sibling gets and
   * fell through to normClient(value.client) — a field in the REQUEST BODY, so
   * the writer decides which client their own write belongs to.
   *
   * A consultant restricted to client A who knows client B's engagement code
   * could PUT vynora_memory_ENG-B with {"client":"Client A", …} and have it
   * accepted. The owner's next follow-up on ENG-B then loads that blob straight
   * into the interview persona PROMPT (interview_agent.html). Cross-client
   * integrity and prompt injection rather than exfiltration — the identical PUT
   * against vynora_synthesis_full_ENG-B is correctly refused — but memory was
   * the one code-addressed artifact that walked around the CR-1/H4
   * code-ownership hardening, because that hardening only runs for families
   * listed here.
   *
   * Same root cause as the five roadmap families above and the v5.32.25 data
   * loss below: a new key family shipped without anyone enumerating the
   * writers. ENG_KEY_FAMILIES lists them and feeds only the dormant migration.
   * codeSuffixCoverage.test.ts (v5.33.3) now fails when a vynora_*_<CODE>
   * family appears in the frontend and not in this list.
   */
  "vynora_memory_",
  /*
   * v5.33.4 — the roadmap partition, split out of the firm-wide
   * `vynora_roadmap_state` blob into one key per engagement.
   *
   * Suffixed by roadmap.html's getEngKey(), so the 'eng_<CODE>' / 'client_<norm>'
   * parsing above handles it exactly as it does the eight sibling roadmap
   * families. The BARE `vynora_roadmap_state` is unaffected — it is matched by
   * the exact-equality GLOBAL branch at the top of resolveKeyClient, long before
   * this loop, and keeps its entry-wise filtering for as long as any tenant
   * still has one.
   */
  "vynora_roadmap_state_",
];

interface WorkspaceMaps {
  /** engagement code (upper) → client norm */
  codeToNorm: Map<string, string>;
  /** session id → client norm (from vynora_session_* values) */
  sessionToNorm: Map<string, string>;
  /**
   * Codes whose owner came from the `engagements` table rather than from
   * workspace JSON. These cannot be rebound by anything the tenant writes.
   */
  trustedCodes: Set<string>;
}

/** Build code→client and session→client maps from the raw state itself. */
export function buildWorkspaceMaps(
  state: Record<string, string>,
  /**
   * v5.32.96 — code → client_name straight from the `engagements` TABLE.
   *
   * Every other source of this mapping lives in module_state, which the tenant
   * writes. That is why scopeWorkspaceWrite() carries the CR-1 code-ownership
   * guard: without it a restricted consultant could PUT a
   * vynora_engagement_index entry rebinding another client's CODE to their own
   * norm, and every code-keyed key would resolve to them. The guard works, but
   * it is a mitigation for trusting caller-supplied data.
   *
   * Rows from `engagements` are not caller-supplied. Where this map has an
   * entry it WINS, and no workspace value can override it. Codes it does not
   * know still fall back to the JSON exactly as before, so a tenant mid-way
   * through migration 025 is unaffected.
   */
  trustedCodeNames?: Map<string, string> | null
): WorkspaceMaps {
  const codeToNorm = new Map<string, string>();
  const sessionToNorm = new Map<string, string>();
  const trusted = new Set<string>();

  if (trustedCodeNames) {
    for (const [code, name] of trustedCodeNames) {
      if (!code || typeof name !== "string") continue;
      const up = code.toUpperCase();
      codeToNorm.set(up, normClient(name));
      trusted.add(up);
    }
  }

  // Engagement index: { normClient: CODE }
  try {
    const idx = JSON.parse(state["vynora_engagement_index"] ?? "{}") as Record<string, string>;
    for (const [norm, code] of Object.entries(idx)) {
      if (typeof code !== "string") continue;
      const up = code.toUpperCase();
      if (trusted.has(up)) continue;   // the database already said who owns this
      codeToNorm.set(up, norm);
    }
  } catch { /* ignore */ }

  // Engagement payloads carry .client — authoritative even without the index.
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith("vynora_engagement_") && k !== "vynora_engagement_index") {
      try {
        const eng = JSON.parse(v) as { client?: string };
        const up = k.slice("vynora_engagement_".length).toUpperCase();
        if (eng?.client && !trusted.has(up)) codeToNorm.set(up, normClient(eng.client));
      } catch { /* ignore */ }
    }
    if (k.startsWith("vynora_session_")) {
      try {
        const s = JSON.parse(v) as { client?: string };
        if (s?.client) sessionToNorm.set(k.slice("vynora_session_".length), normClient(s.client));
      } catch { /* ignore */ }
    }
  }
  return { codeToNorm, sessionToNorm, trustedCodes: trusted };
}

/**
 * Resolve which client a workspace key belongs to.
 * Returns: a norm string | "GLOBAL" (no client identity) | "UNKNOWN"
 * (client-scoped family but unresolvable — treated as deny).
 */
export function resolveKeyClient(
  key: string,
  value: string | undefined,
  maps: WorkspaceMaps
): string {
  if (OWNER_ONLY_KEYS.has(key)) return "OWNER";
  if (key === "vynora_engagement_index" || key === "vynora_code_index" ||
      key === "vynora_roadmap_index" || key === "vynora_roadmap_state") return "GLOBAL"; // filtered entry-wise
  if (GLOBAL_KEYS.has(key)) return "GLOBAL";
  if (GLOBAL_PREFIXES.some((p) => key.startsWith(p))) return "GLOBAL";
  if (key === "vynora_last_briefing") {
    try {
      const v = JSON.parse(value ?? "{}") as { normKey?: string; client?: string };
      return v.normKey ?? (v.client ? normClient(v.client) : "UNKNOWN");
    } catch { return "UNKNOWN"; }
  }
  for (const p of NORM_SUFFIX) {
    if (!key.startsWith(p)) continue;
    const seg = key.slice(p.length).split("_")[0];
    if (!seg) return "UNKNOWN";
    /*
     * v5.32.96 — these families are migrating from <norm> to <CODE> suffixes,
     * so BOTH shapes have to resolve for as long as any tenant holds either.
     *
     * A segment that is a known engagement code resolves through codeToNorm;
     * anything else is read as the norm it has always been. The order matters:
     * checking the code map FIRST means a code is never mistaken for a client
     * whose normalized name happens to look like one.
     */
    const asCode = maps.codeToNorm.get(seg.toUpperCase());
    return asCode ?? seg;
  }
  if (key.startsWith("vynora_session_")) {
    return maps.sessionToNorm.get(key.slice("vynora_session_".length)) ?? "UNKNOWN";
  }
  for (const p of CODE_SUFFIX) {
    if (key.startsWith(p)) {
      let suffix = key.slice(p.length);
      // v5.32.25 DATA LOSS. Three roadmap families suffix by roadmap.html's
      // getEngKey(), which returns 'eng_<CODE>' | 'client_<norm>' |
      // 'unassigned' — NOT a bare code:
      //     vynora_uc_requirements_  vynora_uc_dismissed_gaps_  vynora_dim_notes_
      // The old parser took suffix.split("_")[0] and therefore resolved those
      // to the literal strings "eng" / "client" / "unassigned". None is a
      // client norm, so filterWorkspaceState dropped them on READ and
      // scopeWorkspaceWrite dropped them on WRITE — while the PUT still
      // returned {ok:true} and the browser painted "Saved". Every restricted
      // consultant lost their dimension notes, use-case requirements and
      // dismissed gaps on every reload, permanently and silently.
      //
      // It also opened a narrow leak in the other direction: a firm with a
      // client whose normClient() happened to be "eng" or "client" was granted
      // read AND write access to every other client's copies of those keys.
      if (suffix.startsWith("eng_")) {
        suffix = suffix.slice(4);
      } else if (suffix.startsWith("client_")) {
        // Already a normalised client name — that IS the identity.
        return suffix.slice(7).split("_")[0] || "UNKNOWN";
      }
      // Genuinely unowned partitions: getEngKey()'s 'unassigned' fallback and
      // normClient('') -> 'none'. Deny rather than inventing an owner. The
      // frontends are separately fixed not to write these in the first place.
      if (!suffix || suffix === "unassigned" || suffix === "none") return "UNKNOWN";
      const code = suffix.split("_")[0].toUpperCase();
      const norm = maps.codeToNorm.get(code);
      if (norm) return norm;
      // Some families suffix by norm client instead of code — accept that too.
      return suffix.split("_")[0] || "UNKNOWN";
    }
  }
  // Value-level identity as a last resort (e.g. briefing packs).
  if (value && value.length < 500_000) {
    try {
      const v = JSON.parse(value) as { client?: unknown; clientName?: unknown };
      const c = (typeof v?.client === "string" && v.client) || (typeof v?.clientName === "string" && v.clientName);
      if (c) return normClient(c);
    } catch { /* not JSON */ }
  }
  // V225-audit CRITICAL fix: this used to `return "GLOBAL"` here — i.e. ANY
  // key this function doesn't recognize, and whose value has no top-level
  // .client/.clientName, was treated as having no client identity and passed
  // straight through filterWorkspaceState/scopeWorkspaceWrite to every
  // consultant regardless of client_assignments. That inverted the documented
  // contract ("unresolvable → dropped, deny by default") for the entire
  // unbounded space of not-yet-enumerated keys — including any new vynora_*
  // key family added later without updating this file. GLOBAL is now reached
  // ONLY via the explicit, hand-reviewed GLOBAL_KEYS/GLOBAL_PREFIXES allowlist
  // above (or the four entry-wise-filtered index keys, or a resolved client
  // norm). Everything else — recognized-but-unresolvable AND genuinely
  // unrecognized — denies the same way.
  return "UNKNOWN";
}

/** Filter a full workspace state map down to the allowed clients. */
export function filterWorkspaceState(
  state: Record<string, string>,
  allowed: Set<string> | null,
  /** v5.32.96 — code → client_name from the engagements TABLE; see buildWorkspaceMaps. */
  trustedCodeNames?: Map<string, string> | null
): Record<string, string> {
  if (allowed === null) return state;
  const maps = buildWorkspaceMaps(state, trustedCodeNames);
  const allowedCodes = new Set<string>();
  for (const [code, norm] of maps.codeToNorm) if (normSetHas(allowed, norm)) allowedCodes.add(code);

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(state)) {
    if (k === "vynora_engagement_index") {
      try {
        const idx = JSON.parse(v) as Record<string, string>;
        const f: Record<string, string> = {};
        for (const [norm, code] of Object.entries(idx)) if (normSetHas(allowed, norm)) f[norm] = code;
        out[k] = JSON.stringify(f);
      } catch { /* drop malformed */ }
      continue;
    }
    if (k === "vynora_code_index") {
      try {
        const idx = JSON.parse(v) as Record<string, string>;
        const f: Record<string, string> = {};
        for (const [code, sid] of Object.entries(idx)) {
          const norm = maps.codeToNorm.get(code.toUpperCase()) ?? maps.sessionToNorm.get(sid);
          if (norm && normSetHas(allowed, norm)) f[code] = sid;
        }
        out[k] = JSON.stringify(f);
      } catch { /* drop malformed */ }
      continue;
    }
    if (k === "vynora_roadmap_index") {
      // { CODE: {clientName,...} } — keep entries for allowed clients only.
      try {
        const idx = JSON.parse(v) as Record<string, { clientName?: string }>;
        const f: Record<string, unknown> = {};
        for (const [code, meta] of Object.entries(idx)) {
          const norm = maps.codeToNorm.get(code.toUpperCase())
            ?? (meta?.clientName ? normClient(meta.clientName) : "UNKNOWN");
          if (normSetHas(allowed, norm)) f[code] = meta;
        }
        out[k] = JSON.stringify(f);
      } catch { /* drop malformed */ }
      continue;
    }
    if (k === "vynora_roadmap_state") {
      out[k] = JSON.stringify(filterRoadmapState(v, allowed, allowedCodes));
      continue;
    }
    const who = resolveKeyClient(k, v, maps);
    if (who === "GLOBAL") { out[k] = v; continue; }
    if (who !== "UNKNOWN" && normSetHas(allowed, who)) { out[k] = v; continue; }
    // UNKNOWN or another client's data → dropped (deny by default).
  }
  return out;
}

/** Engagement-key check for roadmap_state sub-maps: 'eng_<CODE>' | 'client_<norm>'. */
function engKeyAllowed(engKey: string, allowed: Set<string>, allowedCodes: Set<string>): boolean {
  if (engKey.startsWith("eng_")) return allowedCodes.has(engKey.slice(4).toUpperCase());
  if (engKey.startsWith("client_")) return normSetHas(allowed, engKey.slice(7));
  return false; // 'unassigned' / legacy keys: unattributable → deny
}

/**
 * vynora_roadmap_state mixes clients: assumptions/dependencies/generated and
 * (since v5.7) byEng are keyed by engagement ('eng_<CODE>' / 'client_<norm>')
 * and are filtered per client. The LEGACY flat notes/synthesis/gantt slots
 * belong to the last active engagement with no client key — those stay
 * dropped for restricted consultants (their per-client copies live in byEng).
 */
function filterRoadmapState(
  raw: string,
  allowed: Set<string>,
  allowedCodes: Set<string>
): Record<string, unknown> {
  let st: Record<string, Record<string, unknown>> = {};
  try { st = JSON.parse(raw); } catch { return {}; }
  const out: Record<string, unknown> = {};
  for (const fam of ["assumptions", "dependencies", "generated", "byEng"]) {
    const src = (st[fam] ?? {}) as Record<string, unknown>;
    const f: Record<string, unknown> = {};
    for (const [engKey, v] of Object.entries(src)) {
      if (engKeyAllowed(engKey, allowed, allowedCodes)) f[engKey] = v;
    }
    out[fam] = f;
  }
  if (st["savedAt"]) out["savedAt"] = st["savedAt"];
  return out;
}

/**
 * Compute the workspace changes that PURGE one client entirely: every key
 * that resolves to the client is deleted, and the shared index keys have the
 * client's entries removed (other clients' entries untouched). Pure function
 * — the route applies the result inside the tenant transaction.
 */
export function purgeClientKeys(
  state: Record<string, string>,
  norm: string,
  /**
   * v5.32.29 (audit M-4). Matching was exact on a single norm, so a client
   * whose data straddles the v5.32.26 widening — some keys at the 100-char
   * norm, some still at the legacy 30-char one — had the legacy copies left
   * on disk by an endpoint whose whole promise is "permanently remove ONE
   * client's data everywhere". Verified: purge returned only the widened keys
   * and left vynora_briefing_<legacy30> and vynora_solution_design_<legacy30>
   * behind. Callers pass every norm the client can be known by.
   */
  alsoNorms: string[] = []
): { sets: Record<string, string>; deletes: string[] } {
  const maps = buildWorkspaceMaps(state);
  const norms = new Set<string>([norm, ...alsoNorms].filter(Boolean));
  const owned = (n: string | null | undefined): boolean => !!n && norms.has(n);
  const codes = new Set<string>();
  for (const [code, n] of maps.codeToNorm) if (owned(n)) codes.add(code);
  const sets: Record<string, string> = {};
  const deletes: string[] = [];

  for (const [k, v] of Object.entries(state)) {
    if (k === "vynora_engagement_index") {
      try {
        const idx = JSON.parse(v) as Record<string, string>;
        if (idx[norm] !== undefined) { delete idx[norm]; sets[k] = JSON.stringify(idx); }
      } catch { /* leave malformed */ }
      continue;
    }
    if (k === "vynora_code_index") {
      try {
        const idx = JSON.parse(v) as Record<string, string>;
        let changed = false;
        for (const c of Object.keys(idx)) {
          const n2 = maps.codeToNorm.get(c.toUpperCase()) ?? maps.sessionToNorm.get(idx[c]);
          if (owned(n2)) { delete idx[c]; changed = true; }
        }
        if (changed) sets[k] = JSON.stringify(idx);
      } catch { /* leave malformed */ }
      continue;
    }
    if (k === "vynora_roadmap_index") {
      try {
        const idx = JSON.parse(v) as Record<string, { clientName?: string }>;
        let changed = false;
        for (const c of Object.keys(idx)) {
          const n2 = maps.codeToNorm.get(c.toUpperCase())
            ?? (idx[c]?.clientName ? normClient(idx[c].clientName as string) : null);
          if (owned(n2)) { delete idx[c]; changed = true; }
        }
        if (changed) sets[k] = JSON.stringify(idx);
      } catch { /* leave malformed */ }
      continue;
    }
    if (k === "vynora_roadmap_state") {
      try {
        const st = JSON.parse(v) as Record<string, Record<string, unknown>>;
        let changed = false;
        const isClients = (ek: string): boolean =>
          (ek.startsWith("eng_") && codes.has(ek.slice(4).toUpperCase())) || ek === "client_" + norm;
        for (const fam of ["assumptions", "dependencies", "generated", "byEng"]) {
          const m = (st[fam] ?? {}) as Record<string, unknown>;
          for (const ek of Object.keys(m)) if (isClients(ek)) { delete m[ek]; changed = true; }
        }
        if (changed) sets[k] = JSON.stringify(st);
      } catch { /* leave malformed */ }
      continue;
    }
    if (owned(resolveKeyClient(k, v, maps))) deletes.push(k);
  }
  return { sets, deletes };
}

/**
 * Compute the workspace changes to RENAME a client, in place, across every
 * key family that embeds its identity — the same hand-maintained list this
 * file already uses for filtering (GLOBAL_KEYS/PREFIXES, NORM_SUFFIX,
 * CODE_SUFFIX) and for purgeClientKeys() above. A rename touches two
 * different kinds of keys:
 *   - key IS the identity (NORM_SUFFIX families, and the norm-keyed members
 *     hiding inside CODE_SUFFIX, like vynora_solution_design_) → the KEY
 *     itself must change.
 *   - key references a stable engagement CODE, and the client's name lives
 *     INSIDE the value (vynora_engagement_<code> etc.) → the key is
 *     untouched; only the embedded .client/.clientName field changes.
 * Plus the handful of structured index/shared keys that need entry-wise
 * edits (vynora_engagement_index, vynora_roadmap_index, vynora_roadmap_state,
 * vynora_last_briefing, vynora_dm_snapshots).
 *
 * Returns null on a NAME COLLISION — the new name's norm already belongs to
 * a different, existing client's key in this workspace — so the caller can
 * refuse the rename outright rather than silently splicing two clients'
 * data together onto one norm (see the V225-audit MEDIUM note on
 * normClient()'s 30-char truncation, above: two names can share a norm).
 */
export function renameClientKeys(
  state: Record<string, string>,
  oldNorm: string,
  newName: string
): { sets: Record<string, string>; deletes: string[] } | null {
  const newNorm = normClient(newName);
  if (!newNorm || !oldNorm) return null;

  /*
   * v5.32.93 — this is now a thin adapter over renameOwnedKeys(), the same
   * core planClientRename() uses. It kept its own copy of the rewrite loop
   * until now, and that copy is where the silent no-op lived:
   *
   *     if (typeof v.client === "string" && normClient(v.client) === oldNorm)
   *
   * a record one hop out of step was skipped, no error raised, nothing counted
   * — and the next rename was then computed from the stale value it left
   * behind. There is no second copy of that loop to drift any more.
   *
   * What stays legacy here is the COLLISION policy: with no table rows to
   * consult, this entry point cannot tell an orphan workspace key from a live
   * client, so it keeps refusing on either. planClientRename() has the rows
   * and can tell the difference, which is what lets a rename back to a
   * previously-used name succeed.
   */
  let code: string | null = null;
  try {
    const idx = JSON.parse(state["vynora_engagement_index"] ?? "{}") as Record<string, string>;
    if (idx[oldNorm]) code = String(idx[oldNorm]);
  } catch { /* malformed index — treat as no engagement */ }

  const norms = ownedNormsFor(state, code, []);
  norms.add(oldNorm);

  const maps = buildWorkspaceMaps(state);
  if (!norms.has(newNorm)) {
    const codeUp = code ? code.toUpperCase() : null;
    for (const [c, norm] of maps.codeToNorm) {
      if (norm === newNorm && c.toUpperCase() !== codeUp) return null;
    }
    for (const p of NORM_SUFFIX) {
      const clash = Object.keys(state).some(
        (k) => k.startsWith(p) && k.slice(p.length).split("_")[0] === newNorm
      );
      if (clash) return null;
    }
    for (const p of CODE_SUFFIX) {
      const clash = Object.keys(state).some((k) => {
        if (!k.startsWith(p)) return false;
        const seg = k.slice(p.length).split("_")[0];
        return !maps.codeToNorm.has(seg.toUpperCase()) && seg === newNorm;
      });
      if (clash) return null;
    }
    try {
      const idx = JSON.parse(state["vynora_engagement_index"] ?? "{}") as Record<string, string>;
      if (Object.prototype.hasOwnProperty.call(idx, newNorm)) return null;
    } catch { /* malformed index */ }
  }

  const rn = renameOwnedKeys(state, { norms, code, newName, preferredNorm: oldNorm });
  return { sets: rn.sets, deletes: rn.deletes };
}

/**
 * Enforce client scope on a workspace WRITE from a restricted consultant.
 * Returns the sets/deletes they may apply, with the two shared index keys
 * MERGED against current server state so a filtered browser copy can never
 * clobber (or read back) other clients' entries.
 */
export function scopeWorkspaceWrite(
  sets: Record<string, string>,
  deletes: string[],
  current: Record<string, string>,
  allowed: Set<string> | null,
  /** v5.32.96 — code → client_name from the engagements TABLE; see buildWorkspaceMaps. */
  trustedCodeNames?: Map<string, string> | null
): { sets: Record<string, string>; deletes: string[] } {
  if (allowed === null) return { sets, deletes };
  const maps = buildWorkspaceMaps(current, trustedCodeNames);
  // Incoming values may introduce new engagements/sessions for allowed
  // clients — extend the maps with them before resolving.
  const incoming = buildWorkspaceMaps(sets);
  for (const [c, n] of incoming.codeToNorm) if (!maps.codeToNorm.has(c)) maps.codeToNorm.set(c, n);
  for (const [s, n] of incoming.sessionToNorm) if (!maps.sessionToNorm.has(s)) maps.sessionToNorm.set(s, n);

  const allowedCodes = new Set<string>();
  for (const [code, norm] of maps.codeToNorm) if (normSetHas(allowed, norm)) allowedCodes.add(code);

  const okSets: Record<string, string> = {};
  for (const [k, v] of Object.entries(sets)) {
    if (k === "vynora_roadmap_index") {
      // Merge: server entries for other clients + incoming entries for allowed.
      let serverIdx: Record<string, { clientName?: string }> = {};
      let clientIdx: Record<string, { clientName?: string }> = {};
      try { serverIdx = JSON.parse(current[k] ?? "{}"); } catch { /* fresh */ }
      try { clientIdx = JSON.parse(v); } catch { continue; }
      const normOf = (code: string, meta: { clientName?: string }): string =>
        maps.codeToNorm.get(code.toUpperCase()) ?? (meta?.clientName ? normClient(meta.clientName) : "UNKNOWN");
      const merged: Record<string, unknown> = {};
      for (const [ik, iv] of Object.entries(serverIdx)) if (!normSetHas(allowed, normOf(ik, iv))) merged[ik] = iv;
      for (const [ik, iv] of Object.entries(clientIdx)) {
        // v5.32.29 (audit CR-1, same family): both loops key on the CODE, so
        // an incoming entry for a code owned by an unseen client used to
        // overwrite the preserved server entry. Anything already preserved
        // above belongs to someone else — leave it alone.
        if (Object.prototype.hasOwnProperty.call(merged, ik)) continue;
        if (normSetHas(allowed, normOf(ik, iv))) merged[ik] = iv;
      }
      okSets[k] = JSON.stringify(merged);
      continue;
    }
    if (k === "vynora_roadmap_state") {
      // Keyed sub-maps merge (server's other-client entries survive).
      //
      // v5.32.26 WRITE-ONLY CLOBBER. The legacy flat notes/synthesis/gantt
      // slots used to be taken from the incoming body — notes merged
      // additively, synthesis and gantt overwritten wholesale. But
      // filterRoadmapState() deliberately DROPS all three on read for a
      // restricted consultant (they are unattributable to any client; the
      // per-client copies live in byEng). So a restricted consultant's browser
      // never holds them, and any value arriving in these three slots from a
      // restricted caller is either empty — which silently erased the owner's
      // firm-wide synthesis and Gantt on the next autosave — or hand-crafted,
      // which let them plant content into a shared slot they cannot read back.
      // Both directions are closed by simply never accepting them here: the
      // server's own values survive untouched via the {...server} spread
      // below. Owners are unaffected — they return early at allowed === null
      // and never reach this function.
      let server: Record<string, Record<string, unknown>> = {};
      let incoming2: Record<string, Record<string, unknown>> = {};
      try { server = JSON.parse(current[k] ?? "{}"); } catch { /* fresh */ }
      try { incoming2 = JSON.parse(v); } catch { continue; }
      const merged: Record<string, unknown> = { ...server };
      for (const fam of ["assumptions", "dependencies", "generated", "byEng"]) {
        const s = (server[fam] ?? {}) as Record<string, unknown>;
        const inc = (incoming2[fam] ?? {}) as Record<string, unknown>;
        const f: Record<string, unknown> = {};
        for (const [ek, ev] of Object.entries(s)) if (!engKeyAllowed(ek, allowed, allowedCodes)) f[ek] = ev;
        for (const [ek, ev] of Object.entries(inc)) if (engKeyAllowed(ek, allowed, allowedCodes)) f[ek] = ev;
        merged[fam] = f;
      }
      // notes / synthesis / gantt: server value only — see the note above.
      if (incoming2["savedAt"]) merged["savedAt"] = incoming2["savedAt"];
      okSets[k] = JSON.stringify(merged);
      continue;
    }
    if (k === "vynora_engagement_index" || k === "vynora_code_index") {
      // Merge: keep server entries for OTHER clients, take client's entries
      // only for allowed clients.
      //
      // v5.32.29 SECURITY (audit CR-1). vynora_engagement_index maps
      // {clientNorm: ENGAGEMENT_CODE}. This authorised the write by asking
      // "is this NORM mine?" and never asked "is this CODE mine?" — but
      // downstream the CODE is the authorisation token: buildWorkspaceMaps()
      // turns the index into codeToNorm[CODE] = norm, and resolveKeyClient()'s
      // CODE_SUFFIX branch then hands every vynora_*_<CODE> key to whoever
      // codeToNorm names.
      //
      // Verified: a consultant assigned only to `acmeltd` sent
      //   {"sets":{"vynora_engagement_index":"{\"acmeltd\":\"VICT-0001\"}"}}
      // and on the next GET received vynora_synthesis_full_VICT-0001 and
      // vynora_interview_archive_VICT-0001 — another client's synthesis and
      // verbatim transcripts — while that client's own consultant was locked
      // out in the same request. okDeletes then accepted deleting them.
      //
      // A code's owner is now resolved from the SERVER's state and an incoming
      // binding is refused when that owner is outside `allowed`. Codes with no
      // server-side owner (a genuinely new engagement) stay writable.
      let serverIdx: Record<string, string> = {};
      let clientIdx: Record<string, string> = {};
      try { serverIdx = JSON.parse(current[k] ?? "{}"); } catch { /* fresh */ }
      try { clientIdx = JSON.parse(v) as Record<string, string>; } catch { continue; }

      /* Who owns a code — resolved from things the CALLER cannot assert.
       *
       * v5.32.64 (audit V2-H4, and deeper than reported). This used to seed
       * codeOwner from `maps.codeToNorm`, and `maps` has the INCOMING payload
       * merged into it a few lines above. buildWorkspaceMaps derives
       * codeToNorm from the engagement index itself — so the caller's own
       * index entry became the "owner", and the guard below was checking the
       * caller's assertion against itself. Any code they named was theirs by
       * the act of naming it. The reported symptom (an unowned code falling
       * through `owner &&`) was one visible edge of that.
       *
       * Ownership now comes from, in order of authority:
       *   1. the SERVER's index          — what was already agreed
       *   2. the SERVER's records        — vynora_engagement_<CODE>.client,
       *                                    which overrides the index because a
       *                                    record asserts its own client
       *   3. an INCOMING record, but only for a code the server has never seen
       *
       * Rule 3 is what keeps engagement creation working: a new engagement
       * arrives as an index entry plus its record in the same write, and the
       * record establishes the owner. It is restricted to unknown codes so a
       * fabricated record cannot re-assign a code the server already knows —
       * which is the same takeover by another route. */
      const codeOwner = new Map<string, string>();
      if (k === "vynora_engagement_index") {
        for (const [n, code] of Object.entries(serverIdx)) {
          if (typeof code === "string") codeOwner.set(code.toUpperCase(), n);
        }
      }
      /*
       * v5.32.96 — rule 0, above all three below: the engagements TABLE.
       *
       * Rules 1-3 all read module_state, which is the store this very function
       * is deciding whether to let the caller write. That is why this guard is
       * as intricate as it is. A code with a row in `engagements` has an owner
       * no workspace write can dispute, so it is set LAST here (overriding the
       * server index) and the record readers below skip it entirely.
       */
      const dbOwned = new Set<string>();
      if (trustedCodeNames) {
        for (const [code, name] of trustedCodeNames) {
          const up = String(code).toUpperCase();
          codeOwner.set(up, normClient(name));
          dbOwned.add(up);
        }
      }
      const readRecords = (store: Record<string, string>, onlyNewCodes: boolean) => {
        for (const [sk, sv] of Object.entries(store)) {
          if (!sk.startsWith("vynora_engagement_") || sk === "vynora_engagement_index") continue;
          const code = sk.slice("vynora_engagement_".length).toUpperCase();
          if (dbOwned.has(code)) continue;   // the database already said whose it is
          if (onlyNewCodes && codeOwner.has(code)) continue;
          try {
            const eng = JSON.parse(sv) as { client?: string };
            if (eng?.client) codeOwner.set(code, normClient(eng.client));
          } catch { /* malformed record asserts nothing */ }
        }
      };
      readRecords(current, false);
      readRecords(sets, true);

      const merged: Record<string, string> = {};
      for (const [ik, iv] of Object.entries(serverIdx)) {
        const norm = k === "vynora_engagement_index"
          ? ik
          : (maps.codeToNorm.get(ik.toUpperCase()) ?? maps.sessionToNorm.get(iv) ?? "UNKNOWN");
        if (!normSetHas(allowed, norm)) merged[ik] = iv; // preserved, invisible to this user
      }
      for (const [ik, iv] of Object.entries(clientIdx)) {
        const norm = k === "vynora_engagement_index"
          ? ik
          : (maps.codeToNorm.get(ik.toUpperCase()) ?? maps.sessionToNorm.get(iv) ?? "UNKNOWN");
        if (!normSetHas(allowed, norm)) continue;
        if (k === "vynora_engagement_index" && typeof iv === "string") {
          const owner = codeOwner.get(iv.toUpperCase());
          /* Binding a code that already belongs to a client this caller cannot
           * see is the takeover above. Refuse it and keep the server's entry.
           *
           * v5.32.64 (audit V2-H4). This was `if (owner && !normSetHas(...))`,
           * so a code with NO resolvable owner fell straight through to being
           * accepted. An authorisation guard that stops checking when it cannot
           * identify the subject is failing open: the caller could pre-claim
           * any code — an orphan whose record was deleted, or one they invented
           * — and whatever later appeared under it would resolve to their
           * client.
           *
           * Deny-by-default instead. Creating a genuine new engagement is
           * unaffected because the record is written in the same request and
           * its own `client` field establishes ownership — see the incoming
           * codeToNorm merge above, and the test that pins it. A code arriving
           * with nothing to justify it is refused. */
          if (!owner || !normSetHas(allowed, owner)) {
            /* Refuse the binding and KEEP the server's existing entry.
             *
             * The comment above has always said that; the code just did
             * `continue`, which drops the key from `merged` entirely — so a
             * refused write also UNBOUND the caller's own client from its real
             * engagement. Harmless to other tenants, but it turns a rejected
             * write into data loss for the person who made it, and the loss is
             * silent. */
            const existing = serverIdx[ik];
            if (typeof existing === "string") merged[ik] = existing;
            continue;
          }
        }
        merged[ik] = iv;
      }
      okSets[k] = JSON.stringify(merged);
      continue;
    }
    const who = resolveKeyClient(k, v, maps);
    if (who === "GLOBAL" || (who !== "UNKNOWN" && normSetHas(allowed, who))) okSets[k] = v;
  }
  const okDeletes = deletes.filter((k) => {
    if (k === "vynora_engagement_index" || k === "vynora_code_index" ||
        k === "vynora_roadmap_index" || k === "vynora_roadmap_state") return false;
    const who = resolveKeyClient(k, current[k], maps);
    return who === "GLOBAL" || (who !== "UNKNOWN" && normSetHas(allowed, who));
  });
  return { sets: okSets, deletes: okDeletes };
}

/* ── v5.32.26: legacy 30-char norm → 100-char norm key migration ──────────── */

export interface LegacyNormMigration {
  /** Keys to write (renamed copies, plus patched index/shared keys). */
  sets: Record<string, string>;
  /** Old keys to remove once their renamed copy is written. */
  deletes: string[];
  /** legacy norm → widened norm, for the caller to apply to SQL columns. */
  pairs: Array<{ from: string; to: string; clientName: string }>;
  /** Legacy norms that resolve to more than one full name — left untouched. */
  ambiguous: string[];
}

/**
 * Rewrite every workspace key whose client segment was derived with the old
 * 30-character truncation so it uses the widened norm instead.
 *
 * This is a PURE function over the raw state map — routes/moduleState.ts
 * applies the result inside the tenant transaction, so it runs lazily on the
 * first read after deploy and is a no-op on every read after that (once no
 * legacy-shaped key remains, nothing matches).
 *
 * The legacy norm is a truncation, so it cannot be inverted on its own. The
 * full client name is recovered from the VALUES, which have always carried it
 * verbatim: engagement payloads (.client), session records (.client), the
 * roadmap index (.clientName), the snapshot list, and the last-briefing
 * pointer. A legacy norm that maps to two DIFFERENT full names is exactly the
 * 30-char collision this release exists to prevent; it is reported in
 * `ambiguous` and deliberately left alone, because splitting data that has
 * already been merged under one identity is a judgement call about whose
 * record is whose — not something to guess at inside a read handler.
 */
export function migrateLegacyNormKeys(
  state: Record<string, string>,
  knownClientNames: string[]
): LegacyNormMigration {
  const out: LegacyNormMigration = { sets: {}, deletes: [], pairs: [], ambiguous: [] };

  // v5.32.29 SECURITY (audit H-2). The rename table used to be derived from
  // whatever client names appeared in the VALUES — and a restricted consultant
  // can write values. Verified: an attacker owning only `acmeltd` wrote one key
  // they fully owned whose value read
  //   {"client":"Meridian Capital Partners Group Hostile Takeover Unit"}
  // and the next GET moved another client's briefing and design portfolio onto
  // a norm of the attacker's choosing, orphaning it from the real client.
  //
  // A rename is now only possible toward a name the SERVER already knows for
  // this tenant — from client_assignments and engagements, tables no consultant
  // can write arbitrary rows into. An invented name matches nothing and the
  // migration ignores it.
  /* 1. Candidates come from the SERVER's own list of client names — not from
   *    the values, which is what made this steerable. A name only matters here
   *    if its legacy norm differs from its widened one; anything shorter than
   *    the old 30-character truncation produces the same string under both
   *    rules and has nothing to migrate. */
  const byLegacy = new Map<string, Set<string>>();
  for (const name of knownClientNames) {
    if (typeof name !== "string") continue;
    const full = normClient(name);
    const legacy = legacyNormClient(name);
    if (!full || full === legacy) continue;
    let set = byLegacy.get(legacy);
    if (!set) { set = new Set(); byLegacy.set(legacy, set); }
    set.add(name);
  }
  // The value scan that used to build this map is GONE, not disabled: it read
  // client names out of workspace VALUES, and a restricted consultant can write
  // values. That was audit H-2 — one authorised PUT plus one GET relocated
  // another client's briefing and design portfolio onto a norm of the
  // attacker's choosing. Nothing downstream needs it now that the candidate
  // list comes from the server.

  const rename = new Map<string, string>(); // legacy → widened
  const candidates: LegacyNormMigration["pairs"] = [];
  for (const [legacy, names] of byLegacy) {
    const distinct = new Set([...names].map((n) => normClient(n)));
    if (distinct.size !== 1) { out.ambiguous.push(legacy); continue; }
    const clientName = [...names][0];
    const to = normClient(clientName);
    rename.set(legacy, to);
    candidates.push({ from: legacy, to, clientName });
  }
  if (!rename.size) return out;

  // A client whose name is long enough to have been truncated is a CANDIDATE;
  // it only becomes a reported pair if this state actually still holds
  // something under its legacy norm. That distinction is what makes the whole
  // function idempotent — the full client name stays in the values forever,
  // so candidates never go away, but once the keys have moved there is
  // nothing left to act on and the caller correctly does nothing.
  const used = new Set<string>();

  /* 2. Rewrite the keys that embed the norm. */
  const maps = buildWorkspaceMaps(state);
  const claim = (oldKey: string, newKey: string, legacy: string, value: string): void => {
    // Never overwrite an already-widened key: if both shapes exist the newer
    // one is authoritative and the legacy copy is stale by construction.
    if (newKey === oldKey || state[newKey] !== undefined) return;
    out.sets[newKey] = value;
    out.deletes.push(oldKey);
    used.add(legacy);
  };

  for (const [k, v] of Object.entries(state)) {
    if (k === "vynora_engagement_index") {
      try {
        const idx = JSON.parse(v) as Record<string, string>;
        let changed = false;
        for (const [norm, code] of Object.entries(idx)) {
          const to = rename.get(norm);
          if (to && idx[to] === undefined) { delete idx[norm]; idx[to] = code; changed = true; used.add(norm); }
        }
        if (changed) out.sets[k] = JSON.stringify(idx);
      } catch { /* malformed */ }
      continue;
    }
    if (k === "vynora_roadmap_state") {
      try {
        const st = JSON.parse(v) as Record<string, Record<string, unknown>>;
        let changed = false;
        for (const fam of ["assumptions", "dependencies", "generated", "byEng"]) {
          const m = (st[fam] ?? {}) as Record<string, unknown>;
          for (const ek of Object.keys(m)) {
            if (!ek.startsWith("client_")) continue;
            const to = rename.get(ek.slice(7));
            const nk = to ? "client_" + to : null;
            if (nk && m[nk] === undefined) { m[nk] = m[ek]; delete m[ek]; changed = true; used.add(ek.slice(7)); }
          }
        }
        if (changed) out.sets[k] = JSON.stringify(st);
      } catch { /* malformed */ }
      continue;
    }
    if (k === "vynora_last_briefing") {
      try {
        const lb = JSON.parse(v) as { normKey?: string; client?: string };
        const was = lb.normKey ?? "";
        const to = was ? rename.get(was) : undefined;
        if (to) { lb.normKey = to; out.sets[k] = JSON.stringify(lb); used.add(was); }
      } catch { /* malformed */ }
      continue;
    }

    let handled = false;
    for (const p of NORM_SUFFIX) {
      if (!k.startsWith(p)) continue;
      const rest = k.slice(p.length);
      const seg = rest.split("_")[0];
      const to = rename.get(seg);
      if (to) claim(k, p + to + rest.slice(seg.length), seg, v);
      handled = true;
      break;
    }
    if (handled) continue;

    for (const p of CODE_SUFFIX) {
      if (!k.startsWith(p)) continue;
      const rest = k.slice(p.length);
      // Three families in this list are suffixed with roadmap.html's
      // getEngKey(), which yields 'client_<norm>' — the norm is the SECOND
      // segment there, not the first (see resolveKeyClient's matching branch).
      if (rest.startsWith("client_")) {
        const inner = rest.slice(7);
        const seg2 = inner.split("_")[0];
        const to2 = rename.get(seg2);
        if (to2) claim(k, p + "client_" + to2 + inner.slice(seg2.length), seg2, v);
        handled = true;
        break;
      }
      const seg = rest.split("_")[0];
      // Code-suffixed members keep their key — the code is stable and the
      // client name lives inside the value. Only the norm-suffixed members
      // hiding in this list (solution_design, design_studio, uc_stages, …)
      // move.
      if (!maps.codeToNorm.has(seg.toUpperCase())) {
        const to = rename.get(seg);
        if (to) claim(k, p + to + rest.slice(seg.length), seg, v);
      }
      handled = true;
      break;
    }
  }

  out.pairs = candidates.filter((p) => used.has(p.from));
  return out;
}

/* ══ Code-anchored client rename (v5.32.93) ════════════════════════════════
 *
 * renameClientKeys() above takes the client's OLD NAME as its starting point.
 * That is the bug, not an implementation detail of it.
 *
 * The old name reaches the server from the browser, which reads it out of its
 * own cached copy of the engagement record. So the moment ANY one of the
 * places that record's name is stored falls out of step with the others, the
 * browser starts sending a name that matches nothing, the rename moves
 * nothing, and — because the response counted only what it changed — it still
 * reports success. One missed field permanently breaks every later rename of
 * that client. That is exactly what production showed: renaming to "Meridian
 * Foods Test" worked, renaming to "Meridian Foods Test 1" did nothing, and the
 * rename prompt still offered "Meridian Foods New", two names behind.
 *
 * The engagement CODE (ENG-GSC6-Y7ME) is the one identifier that is never
 * renamed. Anchoring on it removes the whole bug class:
 *
 *   1. The SERVER decides what this engagement is currently called, by looking
 *      at its own state. No cached page value can misdirect a rename.
 *   2. Every norm the engagement is found under — the index entries pointing
 *      at the code, the name inside the record, the caller's idea of it — is
 *      collected into ONE owned set, and all of them move together. Debris
 *      from a half-finished earlier rename is swept by the next one instead of
 *      accumulating.
 *   3. The name inside the code-keyed record is written UNCONDITIONALLY. The
 *      "only if it already agrees" guard was the silent failure.
 *   4. An index entry that points at THIS code is never a collision. It is
 *      leftover identity belonging to the engagement being renamed, and
 *      refusing over it is what made "rename back to a name I used before"
 *      impossible.
 *   5. The plan reports what it did NOT touch (`report.residue`), computed by
 *      re-scanning the post-rename state rather than by counting successes.
 */

/**
 * The fields a client's name is KNOWN to live in. Everything else is matched
 * by value (see setName), because this list going out of date is itself one of
 * the ways a rename silently half-works.
 */
const NAME_FIELDS = ["client", "clientName"] as const;

export interface ClientRenameReport {
  code: string | null;
  newNorm: string;
  /** Every norm this engagement was found under before the rename. */
  ownedNorms: string[];
  /** Index entries dropped because they pointed at this code under a stale norm. */
  duplicateIndexNormsRemoved: string[];
  /** Keys whose embedded name was corrected despite not having matched — the split this fix closes. */
  keysRepaired: string[];
  /** Orphan keys at the destination norm that this rename overwrote. */
  debrisOverwritten: string[];
  /**
   * POST-CONDITION. Anything still naming an old identity once the plan is
   * applied, found by re-scanning — not by counting what went right. Empty is
   * the only acceptable value; a non-empty residue is a rename that reported
   * success while leaving a split behind, which is the failure that survived
   * four rounds of fixes.
   */
  residue: string[];
}

export interface ClientRenamePlan {
  /** Set when the rename must be refused; the string is the reason for the caller to surface. */
  conflict?: string;
  newName: string;
  newNorm: string;
  code: string | null;
  sets: Record<string, string>;
  deletes: string[];
  /** ids of engagements rows to rename. */
  engagementIds: string[];
  /** ids of interviews rows to rename. */
  interviewIds: string[];
  /** client_norm values in client_assignments that belong to this engagement. */
  assignmentNorms: string[];
  report: ClientRenameReport;
}

/**
 * Which ENGAGEMENT is this rename about? A code is believed only if this
 * workspace can corroborate it (a record, or an index entry pointing at it);
 * an unrecognized code returns null rather than quietly falling back to a name
 * lookup, because a rename aimed at the wrong client is worse than a refused
 * one.
 */
export function resolveEngagementCode(
  state: Record<string, string>,
  target: { code?: string | null; clientName?: string | null }
): string | null {
  const wanted = String(target.code ?? "").trim().toUpperCase();
  if (wanted) {
    const keyWanted = ("vynora_engagement_" + wanted).toUpperCase();
    for (const k of Object.keys(state)) {
      if (k.toUpperCase() === keyWanted) return k.slice("vynora_engagement_".length);
    }
    try {
      const idx = JSON.parse(state["vynora_engagement_index"] ?? "{}") as Record<string, string>;
      for (const c of Object.values(idx)) {
        if (String(c).toUpperCase() === wanted) return String(c);
      }
    } catch { /* malformed index — fall through to "unknown" */ }
    return null;
  }
  const n = normClient(String(target.clientName ?? ""));
  if (!n) return null;
  try {
    const idx = JSON.parse(state["vynora_engagement_index"] ?? "{}") as Record<string, string>;
    if (idx[n]) return String(idx[n]);
  } catch { /* malformed index */ }
  return null;
}

/**
 * Every norm that currently identifies this engagement ANYWHERE — the index
 * entries pointing at the code (however many have accumulated), the name
 * inside the engagement record, and whatever names the caller supplies
 * (including their legacy 30-char norms, audit M-4). These all move together;
 * that is what stops one stale copy from surviving a rename and poisoning the
 * next one.
 */
export function ownedNormsFor(
  state: Record<string, string>,
  code: string | null,
  seedNames: Array<string | null | undefined> = []
): Set<string> {
  const out = new Set<string>();
  const addName = (name: unknown) => {
    if (typeof name !== "string" || !name) return;
    const a = normClient(name);
    if (a) out.add(a);
    const b = legacyNormClient(name);
    if (b) out.add(b);
  };
  for (const n of seedNames) addName(n);
  if (code) {
    const up = code.toUpperCase();
    try {
      const idx = JSON.parse(state["vynora_engagement_index"] ?? "{}") as Record<string, string>;
      for (const [n, c] of Object.entries(idx)) {
        if (n && String(c).toUpperCase() === up) out.add(n);
      }
    } catch { /* malformed index */ }
    for (const k of Object.keys(state)) {
      if (k.toUpperCase() !== ("vynora_engagement_" + up).toUpperCase()) continue;
      try {
        const v = JSON.parse(state[k]) as { client?: unknown };
        addName(v.client);
      } catch { /* malformed record */ }
    }
  }
  out.delete("");
  return out;
}

/** The families whose KEY carries the client norm, wherever they are listed. */
function normKeyedFamilies(): string[] {
  return [...NORM_SUFFIX, ...CODE_SUFFIX];
}

/**
 * Split a key into (family prefix, first segment, remainder), or null if it
 * belongs to no client-suffixed family.
 */
function splitFamilyKey(k: string): { prefix: string; seg: string; rest: string } | null {
  for (const p of normKeyedFamilies()) {
    if (!k.startsWith(p)) continue;
    const rest = k.slice(p.length);
    const seg = rest.split("_")[0];
    return { prefix: p, seg, rest: rest.slice(seg.length) };
  }
  return null;
}

interface OwnedRenameResult {
  sets: Record<string, string>;
  deletes: string[];
  keysRepaired: string[];
  debrisOverwritten: string[];
  duplicateIndexNormsRemoved: string[];
}

/**
 * The rename itself, over an already-resolved set of owned norms.
 *
 * `preferredNorm` decides which copy wins when two owned norms hold the same
 * family (the duplicate-index case: one norm is the live client, the other is
 * debris from a rename that half-finished). It should be the norm of the
 * CANONICAL name — the engagements row — so the copy the consultant has been
 * working in is the one that survives.
 */
function renameOwnedKeys(
  state: Record<string, string>,
  opts: { norms: Set<string>; code: string | null; newName: string; preferredNorm: string }
): OwnedRenameResult {
  const { norms, code, newName, preferredNorm } = opts;
  const newNorm = normClient(newName);
  const codeUp = code ? code.toUpperCase() : null;
  const maps = buildWorkspaceMaps(state);

  const sets: Record<string, string> = {};
  const deletes: string[] = [];
  const keysRepaired: string[] = [];
  const debrisOverwritten: string[] = [];
  const duplicateIndexNormsRemoved: string[] = [];

  /**
   * Write the client's name into a value's own name fields — UNCONDITIONALLY
   * for a record we have already established belongs to this engagement. The
   * conditional this replaces ("only if it already agrees") is the silent
   * no-op at the centre of the bug: a record one hop out of step was skipped,
   * no error was raised, and nothing counted it.
   */
  const setName = (raw: string, why: string | null): string | null => {
    try {
      const v = JSON.parse(raw) as Record<string, unknown>;
      let changed = false;
      let repaired = false;
      /*
       * `client` and `clientName` are rewritten UNCONDITIONALLY on a record we
       * have already established belongs to this engagement — the conditional
       * this replaced was the silent no-op at the centre of the bug.
       */
      for (const field of NAME_FIELDS) {
        if (typeof v[field] !== "string") continue;
        const before = v[field] as string;
        if (before === newName) continue;
        if (!norms.has(normClient(before))) repaired = true;
        v[field] = newName;
        changed = true;
      }
      /*
       * v5.32.93b — and then EVERY other top-level string that is currently
       * this client's name, whatever the field is called.
       *
       * The hand-maintained two-field list was itself a check narrower than it
       * appeared. pre_engagement.html's draft autosave keys its blob by FORM
       * FIELD ID, so the client's name lives there under 'client-name' — not
       * `client`, not `clientName`. The rename moved that key to the new norm
       * and left the name inside it reading the OLD one, restoreDraft() put it
       * straight back into the field, and report.residue said everything was
       * fine because the scanner knew the same two field names the rewriter
       * did. Two narrow checks agreeing is not corroboration.
       *
       * Matching on the VALUE instead of the field name means a blob added
       * later cannot go stale by being spelled differently. Scoped to top-level
       * strings whose whole value normalizes to an identity this engagement
       * currently holds, inside a record already proven to be this client's —
       * which is what a rename means.
       */
      for (const [field, val] of Object.entries(v)) {
        if (NAME_FIELDS.includes(field as (typeof NAME_FIELDS)[number])) continue;
        if (typeof val !== "string" || !val) continue;
        if (val === newName) continue;
        if (!norms.has(normClient(val))) continue;
        v[field] = newName;
        changed = true;
      }
      if (!changed) return null;
      if (repaired && why) keysRepaired.push(why);
      return JSON.stringify(v);
    } catch {
      return null; // malformed value — left exactly as found
    }
  };

  /* ── Key moves ────────────────────────────────────────────────────────────
   * Collect every owned norm-keyed key first, so that when two owned norms
   * both hold e.g. vynora_briefing_ we choose deliberately instead of letting
   * iteration order decide. */
  const moves = new Map<string, Array<{ from: string; seg: string }>>();
  for (const k of Object.keys(state)) {
    const parts = splitFamilyKey(k);
    if (!parts) continue;
    // A CODE_SUFFIX key whose segment is a real engagement code is keyed by
    // CODE, not by name — its key never moves.
    if (maps.codeToNorm.has(parts.seg.toUpperCase())) continue;
    if (!norms.has(parts.seg)) continue;
    const to = parts.prefix + newNorm + parts.rest;
    if (!moves.has(to)) moves.set(to, []);
    moves.get(to)!.push({ from: k, seg: parts.seg });
  }

  for (const [to, sources] of moves) {
    sources.sort((a, b) => {
      const rank = (s: string) => (s === preferredNorm ? 0 : s === newNorm ? 1 : 2);
      return rank(a.seg) - rank(b.seg) || a.seg.localeCompare(b.seg);
    });
    const winner = sources[0];
    // An unowned key already sitting at the destination is debris from an
    // earlier half-finished rename. It is overwritten, and SAID SO — silently
    // clobbering a stranger's key is how data disappears without a trace.
    if (Object.prototype.hasOwnProperty.call(state, to) && to !== winner.from) {
      const there = splitFamilyKey(to);
      if (there && !norms.has(there.seg)) debrisOverwritten.push(to);
    }
    const patched = setName(state[winner.from], winner.from);
    if (to === winner.from) {
      // Same-norm rename (case/punctuation only). Emitting both a delete and a
      // set for one key would race at apply time, so only patch in place.
      if (patched) sets[to] = patched;
    } else {
      sets[to] = patched ?? state[winner.from];
      deletes.push(winner.from);
    }
    for (const loser of sources.slice(1)) {
      if (loser.from === to) continue;
      deletes.push(loser.from);
      debrisOverwritten.push(loser.from);
    }
  }

  /* ── Code-keyed records: the key stays, the embedded name is rewritten ────
   * Either because the segment IS our code (the anchored path), or because
   * this workspace already resolves that code to one of our norms (the path a
   * name-anchored caller takes when the engagement has no index entry). */
  for (const k of Object.keys(state)) {
    const parts = splitFamilyKey(k);
    if (!parts) continue;
    const segCode = parts.seg.toUpperCase();
    const known = maps.codeToNorm.get(segCode);
    const mine = (codeUp && segCode === codeUp) || (known !== undefined && norms.has(known));
    if (!mine) continue;
    const patched = setName(state[k], k);
    if (patched) sets[k] = patched;
  }

  /* ── vynora_engagement_index: exactly ONE norm per code, always ─────────── */
  if (Object.prototype.hasOwnProperty.call(state, "vynora_engagement_index")) {
    try {
      const idx = JSON.parse(state["vynora_engagement_index"]) as Record<string, string>;
      let changed = false;
      const mine: string[] = [];
      for (const [n, c] of Object.entries(idx)) {
        // norms already contains every index norm for this code (ownedNormsFor
        // put them there); the code test is belt-and-braces for a caller that
        // hands us a norm set built some other way, and is NOT what makes the
        // duplicate sweep work. Revert-tested: removing it fails nothing.
        if ((codeUp && String(c).toUpperCase() === codeUp) || norms.has(n)) mine.push(n);
      }
      for (const n of mine) {
        if (n === newNorm) continue;
        delete idx[n];
        changed = true;
      }
      // Everything past the first was a duplicate entry for one code — the
      // shape that made renaming back to an earlier name return 409 forever.
      if (mine.filter((n) => n !== newNorm).length > 1) {
        duplicateIndexNormsRemoved.push(...mine.filter((n) => n !== newNorm).slice(1));
      }
      if (codeUp && mine.length) {
        const codeAsStored = code as string;
        if (idx[newNorm] !== codeAsStored) { idx[newNorm] = codeAsStored; changed = true; }
      }
      if (changed) sets["vynora_engagement_index"] = JSON.stringify(idx);
    } catch { /* malformed index — left as found */ }
  }

  /* ── The remaining structured/shared keys ──────────────────────────────── */
  for (const [k, v] of Object.entries(state)) {
    if (k === "vynora_engagement_index") continue;

    if (k === "vynora_roadmap_index") {
      try {
        const idx = JSON.parse(v) as Record<string, { clientName?: string }>;
        let changed = false;
        for (const [c, meta] of Object.entries(idx)) {
          if (!meta) continue;
          const mine = (codeUp && c.toUpperCase() === codeUp)
            || (typeof meta.clientName === "string" && norms.has(normClient(meta.clientName)));
          if (mine && meta.clientName !== newName) { meta.clientName = newName; changed = true; }
        }
        if (changed) sets[k] = JSON.stringify(idx);
      } catch { /* malformed */ }
      continue;
    }

    if (k === "vynora_roadmap_state") {
      try {
        const st = JSON.parse(v) as Record<string, Record<string, unknown>>;
        let changed = false;
        for (const fam of ["assumptions", "dependencies", "generated", "byEng"]) {
          const m = (st[fam] ?? {}) as Record<string, unknown>;
          const owned = [...norms].filter((n) => n !== newNorm
            && Object.prototype.hasOwnProperty.call(m, "client_" + n));
          owned.sort((a, b) => (a === preferredNorm ? -1 : b === preferredNorm ? 1 : a.localeCompare(b)));
          for (let i = 0; i < owned.length; i++) {
            if (i === 0) m["client_" + newNorm] = m["client_" + owned[i]];
            delete m["client_" + owned[i]];
            changed = true;
          }
        }
        if (changed) sets[k] = JSON.stringify(st);
      } catch { /* malformed */ }
      continue;
    }

    if (k === "vynora_last_briefing") {
      try {
        const lb = JSON.parse(v) as { normKey?: string; client?: string };
        const mine = (lb.normKey && norms.has(lb.normKey))
          || (typeof lb.client === "string" && norms.has(normClient(lb.client)));
        if (mine && (lb.normKey !== newNorm || lb.client !== newName)) {
          lb.client = newName;
          lb.normKey = newNorm;
          sets[k] = JSON.stringify(lb);
        }
      } catch { /* malformed */ }
      continue;
    }

    if (k === "vynora_dm_snapshots") {
      try {
        const arr = JSON.parse(v) as Array<{ clientName?: string }>;
        if (Array.isArray(arr)) {
          let changed = false;
          for (const rec of arr) {
            if (rec && typeof rec.clientName === "string" && norms.has(normClient(rec.clientName))) {
              rec.clientName = newName;
              changed = true;
            }
          }
          if (changed) sets[k] = JSON.stringify(arr);
        }
      } catch { /* malformed */ }
      continue;
    }

    if (splitFamilyKey(k)) continue; // handled above
    // Anything else resolveKeyClient can still place with this client.
    if (norms.has(resolveKeyClient(k, v, maps))) {
      const patched = setName(v, k);
      if (patched) sets[k] = patched;
    }
  }

  return { sets, deletes, keysRepaired, debrisOverwritten, duplicateIndexNormsRemoved };
}

/** Apply a computed sets/deletes to a COPY of a state map. */
function applied(state: Record<string, string>, sets: Record<string, string>, deletes: string[]) {
  const out = { ...state, ...sets };
  for (const k of deletes) if (!Object.prototype.hasOwnProperty.call(sets, k)) delete out[k];
  return out;
}

/**
 * Plan a client rename anchored on the ENGAGEMENT CODE.
 *
 * Pure: it reads the workspace state and the three tables' rows and returns
 * what to change, so routes/assignments.ts (against Postgres) and
 * frontend/test/rename-cycle-e2e.mjs (against an in-memory fake) exercise the
 * SAME algorithm. A rename test that reimplements the rename proves nothing;
 * that is how this bug survived four rounds.
 */
export function planClientRename(input: {
  state: Record<string, string>;
  engagements: Array<{ id: string; client_name: string }>;
  interviews: Array<{ id: string; client_name: string }>;
  assignments: Array<{ user_id: string; client_name: string; client_norm: string }>;
  target: { code?: string | null; clientName?: string | null };
  newName: string;
}): ClientRenamePlan {
  const newName = String(input.newName ?? "").trim();
  const newNorm = normClient(newName);
  const blank = (conflict?: string, code: string | null = null): ClientRenamePlan => ({
    conflict, newName, newNorm, code,
    sets: {}, deletes: [], engagementIds: [], interviewIds: [], assignmentNorms: [],
    report: {
      code, newNorm, ownedNorms: [], duplicateIndexNormsRemoved: [],
      keysRepaired: [], debrisOverwritten: [], residue: [],
    },
  });
  if (!newNorm) return blank("invalid_input");

  const askedForCode = !!String(input.target.code ?? "").trim();
  const code = resolveEngagementCode(input.state, input.target);
  if (askedForCode && !code) {
    // Refusing beats guessing: a code this workspace cannot corroborate means
    // the caller is talking about an engagement that is not here.
    return blank("unknown_engagement");
  }

  /* Seed the owned set from every name we have been given OR can find, then
   * let ownedNormsFor() widen it through the code. */
  let norms = ownedNormsFor(input.state, code, [input.target.clientName]);
  if (!norms.size) return blank("unknown_client", code);

  /* The canonical name is the engagements row's — it is the one the rest of
   * the product reads. Rows matching any owned norm pull their own norms in
   * too, so a row left one hop behind still moves. */
  const engRows = input.engagements.filter((r) => {
    const n = normClient(r.client_name);
    return norms.has(n) || norms.has(legacyNormClient(r.client_name));
  });
  for (const r of engRows) {
    const n = normClient(r.client_name);
    if (n) norms.add(n);
  }
  const preferredNorm = engRows.length ? normClient(engRows[0].client_name) : [...norms][0];

  /* ── Collision ────────────────────────────────────────────────────────────
   * A norm is taken only if something LIVE holds it: an index entry for a
   * different engagement, an engagements row, or interviews. Orphan workspace
   * keys are debris from earlier half-finished renames — sweeping them is this
   * function's job, and refusing over them is precisely what made "rename back
   * to a name I used before" impossible. */
  if (!norms.has(newNorm)) {
    let idxOwner: string | null = null;
    try {
      const idx = JSON.parse(input.state["vynora_engagement_index"] ?? "{}") as Record<string, string>;
      if (idx[newNorm]) idxOwner = String(idx[newNorm]);
    } catch { /* malformed index */ }
    /*
     * An index entry pointing at OUR OWN code cannot reach this branch:
     * ownedNormsFor() has already claimed that norm, so norms.has(newNorm)
     * above is true and the whole collision check is skipped. Written as the
     * plain test it is, rather than as a defensive `idxOwner !== code` that
     * would read like the fix for "renaming back is refused" while never once
     * executing. That fix is ownedNormsFor(); this line is only about OTHER
     * engagements. (Revert-tested: disabling ownedNormsFor()'s code lookup
     * fails eight cases in test/renameClientCycle.test.ts; changing this line
     * fails none.)
     */
    const takenByIndex = !!idxOwner;
    const takenByRow = input.engagements.some((r) => normClient(r.client_name) === newNorm && !engRows.includes(r))
      || input.interviews.some((r) => normClient(r.client_name) === newNorm && !norms.has(normClient(r.client_name)));
    /*
     * ── client_assignments (v5.33.3, audit HIGH) ─────────────────────────────
     *
     * client_assignments.client_norm is THE key authorization runs on —
     * allowedClientNorms() reads this table and nothing else. It was passed
     * into this planner and used for re-keying (assignmentNorms, below) but
     * never consulted in the decision above, so a norm existing ONLY as an
     * assignment read as free:
     *
     *   1. Owner assigns Bob to a not-yet-active client:
     *        POST /api/assignments {email: bob, clientName: "Globex"}
     *      → client_assignments(client_norm="globex"). No engagement, no
     *        interview, no index entry — that endpoint requires none.
     *   2. Owner renames the data-bearing client "Initech" → "Globex".
     *   3. The two tests above find nothing at "globex" and allow it.
     *   4. Every workspace key, engagements row and interview of Initech's is
     *      re-keyed to "globex". Bob's allowed set is exactly {globex}.
     *
     * Bob now holds all of Initech's work-product — synthesis, transcripts,
     * roadmap, scoring — and filterWorkspaceState hands it over on his next
     * request. Owner-initiated, indistinguishable from an ordinary rename, no
     * error raised anywhere. Accidental disclosure, not merely an attack path.
     *
     * This cannot refuse a rename BACK to a name this client used before. The
     * rename transaction MOVES assignment rows (UPDATE when the norm is
     * unchanged, INSERT-then-DELETE otherwise), so an earlier name of ours
     * leaves no row behind; and if one somehow did, ownedNormsFor() would have
     * claimed that norm and this entire block is skipped. The `!norms.has()`
     * guard states that second half explicitly rather than relying on it.
     */
    const takenByAssignment = input.assignments.some(
      (a) => !norms.has(a.client_norm)
        && (a.client_norm === newNorm || normClient(a.client_name) === newNorm)
    );
    if (takenByIndex || takenByRow || takenByAssignment) {
      return blank(
        takenByAssignment && !takenByIndex && !takenByRow
          ? `"${newName}" is already assigned to a consultant in this workspace, ` +
            `even though no engagement has been started under that name. Renaming ` +
            `onto it would hand this client's work to whoever holds that ` +
            `assignment. Remove the assignment first, or choose another name.`
          : `"${newName}" is already in use by a different client in this workspace. ` +
            `Choose another name, or have that client renamed or removed first.`,
        code
      );
    }
  }

  const rn = renameOwnedKeys(input.state, { norms, code, newName, preferredNorm });

  const engagementIds = engRows.map((r) => r.id);
  const interviewIds = input.interviews
    .filter((r) => norms.has(normClient(r.client_name)) || norms.has(legacyNormClient(r.client_name)))
    .map((r) => r.id);
  const assignmentNorms = [...new Set(
    input.assignments.filter((a) => norms.has(a.client_norm) || norms.has(normClient(a.client_name)))
      .map((a) => a.client_norm)
  )];

  /* ── A rename that matches NOTHING is a failure, not a success ────────────
   *
   * The bug, stated as one condition. The old route counted what it changed
   * and never what it missed, so a rename aimed at a name no longer present in
   * this workspace moved nothing, returned ok, and left the caller believing
   * it had worked — after which the next rename was computed from the same
   * wrong base and did nothing either. That is the poison loop.
   *
   * Only reachable when the caller identified the client by NAME alone and
   * that name is not here; a resolved engagement code always has something to
   * rename. Renaming to a name the client already partly holds is not this
   * case — norms contains newNorm then. */
  if (!code && !engagementIds.length && !interviewIds.length
    && !Object.keys(rn.sets).length && !rn.deletes.length && !norms.has(newNorm)) {
    return blank(
      `Nothing in this workspace is currently named "${String(input.target.clientName ?? "").trim()}". ` +
      `Reload the page so it picks up the current name, then rename again.`,
      code
    );
  }

  /* ── The post-condition ───────────────────────────────────────────────────
   * Re-scan the state this plan WOULD produce and list anything still naming
   * an old identity. Counting successes is what hid this bug through four
   * rounds; this counts what is still wrong. */
  const after = applied(input.state, rn.sets, rn.deletes);
  const stale = new Set([...norms].filter((n) => n !== newNorm));
  const residue: string[] = [];
  if (stale.size) {
    const afterMaps = buildWorkspaceMaps(after);
    for (const [k, v] of Object.entries(after)) {
      const parts = splitFamilyKey(k);
      if (parts && stale.has(parts.seg)) { residue.push("key " + k); continue; }
      if (k === "vynora_engagement_index") {
        try {
          const idx = JSON.parse(v) as Record<string, string>;
          for (const [n, c] of Object.entries(idx)) {
            if (stale.has(n) || (code && String(c).toUpperCase() === code.toUpperCase() && n !== newNorm)) {
              residue.push("index entry " + n + " → " + c);
            }
          }
        } catch { residue.push("index unreadable"); }
        continue;
      }
      if (k === "vynora_last_briefing") {
        try {
          const lb = JSON.parse(v) as { normKey?: string; client?: string };
          if ((lb.normKey && stale.has(lb.normKey))
            || (typeof lb.client === "string" && stale.has(normClient(lb.client)))) {
            residue.push("vynora_last_briefing → " + String(lb.client));
          }
        } catch { residue.push("vynora_last_briefing unreadable"); }
        continue;
      }
      if (parts || GLOBAL_KEYS.has(k)) continue;
      if (stale.has(resolveKeyClient(k, v, afterMaps))) residue.push("key " + k);
    }
    /*
     * Embedded names inside every key this rename claimed — the code-keyed
     * records whose key stays put, AND the norm-keyed keys it moved.
     *
     * This scan deliberately does NOT use the same field list the rewriter
     * uses. It looks at every top-level string and asks "is this still one of
     * the names we just renamed away from?" — so a field the rewriter does not
     * know about shows up here as residue rather than being missed by both.
     * The previous version checked `client` and `clientName` only, which is
     * exactly why it reported a clean rename over a draft blob still holding
     * the old name under 'client-name'.
     */
    const claimed = new Set<string>([...Object.keys(rn.sets)]);
    for (const k of Object.keys(after)) {
      const parts = splitFamilyKey(k);
      if (!parts) continue;
      const isOurs = (code && parts.seg.toUpperCase() === code.toUpperCase()) || claimed.has(k);
      if (!isOurs) continue;
      try {
        const val = JSON.parse(after[k]) as Record<string, unknown>;
        for (const [field, v] of Object.entries(val)) {
          if (typeof v !== "string" || !v) continue;
          if (stale.has(normClient(v))) residue.push(k + "." + field + " → " + v);
        }
      } catch { /* malformed value, reported by the key scan above if owned */ }
    }
    for (const r of input.engagements) {
      if (!engagementIds.includes(r.id) && stale.has(normClient(r.client_name))) {
        residue.push("engagements row " + r.id);
      }
    }
    for (const r of input.interviews) {
      if (!interviewIds.includes(r.id) && stale.has(normClient(r.client_name))) {
        residue.push("interviews row " + r.id);
      }
    }
  }

  return {
    newName, newNorm, code,
    sets: rn.sets, deletes: rn.deletes,
    engagementIds, interviewIds, assignmentNorms,
    report: {
      code, newNorm,
      ownedNorms: [...norms],
      duplicateIndexNormsRemoved: rn.duplicateIndexNormsRemoved,
      keysRepaired: rn.keysRepaired,
      debrisOverwritten: rn.debrisOverwritten,
      residue,
    },
  };
}

/* ══ norm-suffixed keys → code-suffixed keys (v5.32.96) ════════════════════
 *
 * The migration that makes the client's name a DISPLAY STRING.
 *
 * Every family below used to be addressed as vynora_<family>_<normClient(name)>.
 * That is why renaming a client was a bulk key migration across a dozen
 * families rather than a field update, and why every bug in the rename saga
 * was debris from one of those migrations — keys stranded under an old norm,
 * duplicate index entries, orphans blocking a rename back to a name used
 * before. Addressed by ENG-XXXX-XXXX instead, a rename touches no keys at all.
 *
 * Applied lazily on read, per tenant, like migrateLegacyNormKeys() above, and
 * ONLY for codes proven by the engagements table (buildWorkspaceMaps'
 * trustedCodes). A key is never moved on the strength of a mapping the tenant
 * could have written — mis-filing a key under the wrong code would be a
 * cross-client leak, not a cosmetic bug.
 */
export const NORM_TO_CODE_FAMILIES = [
  // Declared norm-keyed (NORM_SUFFIX).
  "vynora_briefing_",
  "vynora_mandatory_",
  "vynora_draft_pre_engagement_",
  // Listed in CODE_SUFFIX but ACTUALLY norm-keyed — resolveKeyClient's
  // "some families suffix by norm client instead of code" fallthrough is the
  // only reason these ever worked.
  "vynora_uc_overrides_",
  "vynora_uc_stages_",
  "vynora_roadmap_snapsig_",
  "vynora_solution_design_",
  "vynora_design_studio_",
] as const;

/**
 * Families suffixed by roadmap.html's getEngKey(), which returns
 * 'eng_<CODE>' | 'client_<norm>' | 'unassigned'. The client_<norm> half is the
 * one to move; the eng_<CODE> half is already right.
 */
export const ENG_KEY_FAMILIES = [
  "vynora_uc_requirements_",
  "vynora_uc_dismissed_gaps_",
  "vynora_dim_notes_",
  "vynora_dim_gaps_",
  "vynora_gap_credits_",
  "vynora_gap_plans_",
  "vynora_measured_base_",
  "vynora_maturity_targets_",
] as const;

export interface NormToCodeMigration {
  sets: Record<string, string>;
  deletes: string[];
  /** oldKey → newKey, for the audit trail. */
  moved: Array<[string, string]>;
  /** Norm-shaped keys left alone because their client has no code in the DB. */
  unmigrated: string[];
}

/*
 * NOT YET WIRED INTO THE READ PATH — deliberately, and this is the reason.
 *
 * As of v5.32.97 every page WRITES per-client keys under the engagement code
 * and READS both shapes, and vyneWriteClientKey() deletes the norm-shaped copy
 * as it writes. So the workspace migrates itself, one key at a time, as people
 * work — with no flag day and no window in which a page can look at a key that
 * has moved out from under it.
 *
 * This function is the sweep for what that leaves behind: keys belonging to
 * clients nobody has opened since the upgrade. Before enabling it in
 * routes/moduleState.ts, one family still needs attention —
 * `vynora_solution_design_` is written by routes/solutionDesign.ts, which is
 * still norm-addressed. Moving those keys while the route that owns them looks
 * for the old shape would hide a consultant's solution design from the module
 * that wrote it. Migrate that route first, then turn this on.
 */
export function migrateNormKeysToCode(
  state: Record<string, string>,
  /** code → client_name, from the engagements TABLE. Nothing else is trusted. */
  trustedCodeNames: Map<string, string>
): NormToCodeMigration {
  const out: NormToCodeMigration = { sets: {}, deletes: [], moved: [], unmigrated: [] };
  if (!trustedCodeNames || !trustedCodeNames.size) return out;

  /* norm → code. A norm that two codes both claim is AMBIGUOUS and is left
   * exactly where it is: guessing which engagement a key belongs to is how a
   * client's work ends up in another client's workspace. */
  const normToCode = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [code, name] of trustedCodeNames) {
    for (const n of [normClient(name), legacyNormClient(name)]) {
      if (!n) continue;
      const seen = normToCode.get(n);
      if (seen && seen.toUpperCase() !== code.toUpperCase()) { ambiguous.add(n); continue; }
      normToCode.set(n, code);
    }
  }
  for (const n of ambiguous) normToCode.delete(n);

  const codes = new Set([...trustedCodeNames.keys()].map((c) => c.toUpperCase()));

  const claim = (from: string, to: string) => {
    if (from === to) return;
    /* A key already sitting at the destination is the CODE-shaped one, written
     * by a frontend that has already migrated. It is at least as fresh as the
     * norm-shaped copy, so it wins and the old shape is dropped — otherwise the
     * two would diverge and we would have reinvented the debris this whole
     * change exists to remove. */
    if (!Object.prototype.hasOwnProperty.call(state, to)) {
      out.sets[to] = state[from];
      out.moved.push([from, to]);
    }
    out.deletes.push(from);
  };

  for (const key of Object.keys(state)) {
    // ── plain <norm> → <CODE> families ──────────────────────────────────────
    const fam = NORM_TO_CODE_FAMILIES.find((f) => key.startsWith(f));
    if (fam) {
      const rest = key.slice(fam.length);
      const seg = rest.split("_")[0];
      if (!seg || seg === "none" || seg === "unassigned") continue;
      if (codes.has(seg.toUpperCase())) continue;          // already migrated
      const code = normToCode.get(seg);
      if (!code) { out.unmigrated.push(key); continue; }
      claim(key, fam + code + rest.slice(seg.length));
      continue;
    }

    // ── getEngKey() families: client_<norm> → <CODE> ────────────────────────
    const efam = ENG_KEY_FAMILIES.find((f) => key.startsWith(f));
    if (efam) {
      const rest = key.slice(efam.length);
      if (rest.startsWith("client_")) {
        const seg = rest.slice("client_".length).split("_")[0];
        const code = normToCode.get(seg);
        if (!code) { out.unmigrated.push(key); continue; }
        /* → 'eng_<CODE>', NOT a bare code. That shape is already addressed by
         * the engagement and is what the server's engKeyAllowed() parses;
         * rewriting it would churn every existing partition to no purpose.
         * Only the name-keyed branch moves. */
        claim(key, efam + "eng_" + code + rest.slice("client_".length + seg.length));
      }
      continue;
    }
  }

  /* vynora_roadmap_state's byEng/assumptions/dependencies/generated partitions
   * use the same getEngKey() shapes INSIDE the value. */
  const rsRaw = state["vynora_roadmap_state"];
  if (rsRaw) {
    try {
      const st = JSON.parse(rsRaw) as Record<string, Record<string, unknown>>;
      let changed = false;
      for (const famName of ["assumptions", "dependencies", "generated", "byEng"]) {
        const m = st[famName] as Record<string, unknown> | undefined;
        if (!m || typeof m !== "object") continue;
        for (const sub of Object.keys(m)) {
          if (!sub.startsWith("client_")) continue;   // 'eng_<CODE>' is already right
          const code = normToCode.get(sub.slice("client_".length));
          if (!code) continue;
          const want = "eng_" + code;
          if (m[want] !== undefined) continue;
          m[want] = m[sub];
          delete m[sub];
          changed = true;
        }
      }
      if (changed) out.sets["vynora_roadmap_state"] = JSON.stringify(st);
    } catch { /* malformed — left as found */ }
  }

  /* vynora_last_briefing is a pure NAME pointer: {normKey, client}. Give it the
   * code, so the page that reads it on load knows the identity rather than a
   * string that changes every time someone fixes a typo. */
  const lbRaw = state["vynora_last_briefing"];
  if (lbRaw) {
    try {
      const lb = JSON.parse(lbRaw) as { normKey?: string; client?: string; code?: string };
      const code = (lb.normKey && normToCode.get(lb.normKey))
        ?? (lb.client ? normToCode.get(normClient(lb.client)) : undefined);
      if (code && lb.code !== code) {
        lb.code = code;
        out.sets["vynora_last_briefing"] = JSON.stringify(lb);
      }
    } catch { /* malformed */ }
  }

  return out;
}

/* ══ The name is SERVER-OWNED (v5.32.96) ══════════════════════════════════
 *
 * The last revert path, and the one that survived v5.32.95.
 *
 * `vynora_engagement_<CODE>.client` is a copy of a name whose master record is
 * `engagements.client_name`. Every page in the product writes that copy back:
 * detectRoundMode() re-queues it on every call, and roadmap/synthesis/
 * interview_agent all persist the record too. So any tab holding a pre-rename
 * copy will eventually push the OLD name over a completed rename.
 *
 * v5.32.95 made those writes carry expectedVersions so the server could refuse
 * them. It is not enough, for two reasons:
 *
 *   1. onVersionConflict() answers a 409 by adopting the server's VERSION and
 *      re-queueing OUR value on top of it. The retry then succeeds. That is
 *      correct for two people editing a synthesis; for a stale copy of a
 *      renamed record it means the refusal only delays the revert by one round
 *      trip.
 *   2. scopeWorkspaceWrite() — where every other guard in this file lives —
 *      short-circuits on `allowed === null`. Owners are unrestricted, so a
 *      firm owner's writes were never passing through any of it.
 *
 * Both disappear if the browser simply is not the author of the name. These
 * two functions make the server's copy win on the way in and on the way out,
 * for every role. The browser may send whatever it likes; the name it sends is
 * ignored. That is what "the code is the key and the name is a display string"
 * means in practice.
 */

/** Stamp the current name into engagement records on their way OUT to a page. */
export function stampServerNames(
  state: Record<string, string>,
  trustedCodeNames: Map<string, string> | null | undefined
): Record<string, string> {
  if (!trustedCodeNames || !trustedCodeNames.size) return state;
  let out: Record<string, string> | null = null;
  for (const [k, v] of Object.entries(state)) {
    if (!k.startsWith("vynora_engagement_") || k === "vynora_engagement_index") continue;
    const name = trustedCodeNames.get(k.slice("vynora_engagement_".length).toUpperCase());
    if (!name) continue;
    try {
      const rec = JSON.parse(v) as Record<string, unknown>;
      if (rec === null || typeof rec !== "object" || rec.client === name) continue;
      rec.client = name;
      out = out ?? { ...state };
      out[k] = JSON.stringify(rec);
    } catch { /* malformed record — served as found */ }
  }
  return out ?? state;
}

/**
 * Overwrite the name on engagement records on their way IN from a page, and
 * rebuild any index entry for a code the database knows.
 *
 * Applied to EVERY write, owner included — see above for why role-based
 * scoping was never going to catch this.
 */
export function enforceServerNames(
  sets: Record<string, string>,
  trustedCodeNames: Map<string, string> | null | undefined
): { sets: Record<string, string>; corrected: string[] } {
  const corrected: string[] = [];
  if (!trustedCodeNames || !trustedCodeNames.size) return { sets, corrected };
  const out = { ...sets };

  for (const [k, v] of Object.entries(sets)) {
    if (k.startsWith("vynora_engagement_") && k !== "vynora_engagement_index") {
      const name = trustedCodeNames.get(k.slice("vynora_engagement_".length).toUpperCase());
      if (!name) continue;
      try {
        const rec = JSON.parse(v) as Record<string, unknown>;
        if (rec === null || typeof rec !== "object") continue;
        if (rec.client === name) continue;
        rec.client = name;
        out[k] = JSON.stringify(rec);
        corrected.push(k);
      } catch { /* malformed — left for the normal path to reject */ }
      continue;
    }

    /*
     * vynora_engagement_index is { <norm of name>: <CODE> }, so a stale copy
     * re-introduces the OLD norm as a live entry — the duplicate-index state
     * that made renaming back to an earlier name impossible. Entries for a code
     * the database knows are rewritten to the current norm; entries for codes
     * it does not know are passed through untouched.
     */
    if (k === "vynora_engagement_index") {
      try {
        const idx = JSON.parse(v) as Record<string, string>;
        if (idx === null || typeof idx !== "object") continue;
        const fixed: Record<string, string> = {};
        let changed = false;
        for (const [norm, code] of Object.entries(idx)) {
          if (typeof code !== "string") { fixed[norm] = code; continue; }
          const name = trustedCodeNames.get(code.toUpperCase());
          if (!name) { fixed[norm] = code; continue; }
          const want = normClient(name);
          if (want !== norm) changed = true;
          fixed[want] = code;
        }
        if (changed) {
          out[k] = JSON.stringify(fixed);
          corrected.push(k);
        }
      } catch { /* malformed */ }
    }
  }
  return { sets: out, corrected };
}
