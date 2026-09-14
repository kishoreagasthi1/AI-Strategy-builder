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
 * first 30 chars — the same convention every module uses.
 *
 * Workspace-state filtering: the shared 'workspace' namespace holds keys for
 * many clients. resolveKeyClient() maps a key (+value) to a client norm using
 * the key-family conventions; filterWorkspaceState() then drops anything that
 * belongs to a client outside the allowed set. Keys that belong to another
 * client but cannot be positively resolved are DROPPED (deny by default) —
 * only keys with no client identity at all (global settings, benchmarks)
 * pass through.
 */
import { withTenant } from "../db/pool.js";

export function normClient(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 30);
}

/** null → unrestricted (owner). Otherwise the set of allowed client norms. */
export async function allowedClientNorms(
  tenantId: string,
  userId: string,
  role: string
): Promise<Set<string> | null> {
  if (role === "owner") return null;
  return withTenant(tenantId, async (c) => {
    const r = await c.query<{ client_norm: string }>(
      `SELECT client_norm FROM client_assignments WHERE user_id = $1`,
      [userId]
    );
    return new Set(r.rows.map((x) => x.client_norm));
  });
}

export function clientAllowed(allowed: Set<string> | null, clientName: string): boolean {
  if (allowed === null) return true;
  return allowed.has(normClient(clientName));
}

/* ── Workspace key → client resolution ────────────────────────────────────── */

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
];

interface WorkspaceMaps {
  /** engagement code (upper) → client norm */
  codeToNorm: Map<string, string>;
  /** session id → client norm (from vynora_session_* values) */
  sessionToNorm: Map<string, string>;
}

/** Build code→client and session→client maps from the raw state itself. */
export function buildWorkspaceMaps(state: Record<string, string>): WorkspaceMaps {
  const codeToNorm = new Map<string, string>();
  const sessionToNorm = new Map<string, string>();

  // Engagement index: { normClient: CODE }
  try {
    const idx = JSON.parse(state["vynora_engagement_index"] ?? "{}") as Record<string, string>;
    for (const [norm, code] of Object.entries(idx)) {
      if (typeof code === "string") codeToNorm.set(code.toUpperCase(), norm);
    }
  } catch { /* ignore */ }

  // Engagement payloads carry .client — authoritative even without the index.
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith("vynora_engagement_") && k !== "vynora_engagement_index") {
      try {
        const eng = JSON.parse(v) as { client?: string };
        if (eng?.client) codeToNorm.set(k.slice("vynora_engagement_".length).toUpperCase(), normClient(eng.client));
      } catch { /* ignore */ }
    }
    if (k.startsWith("vynora_session_")) {
      try {
        const s = JSON.parse(v) as { client?: string };
        if (s?.client) sessionToNorm.set(k.slice("vynora_session_".length), normClient(s.client));
      } catch { /* ignore */ }
    }
  }
  return { codeToNorm, sessionToNorm };
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
  if (key === "vynora_engagement_index" || key === "vynora_code_index" ||
      key === "vynora_roadmap_index" || key === "vynora_roadmap_state") return "GLOBAL"; // filtered entry-wise
  if (key === "vynora_last_briefing") {
    try {
      const v = JSON.parse(value ?? "{}") as { normKey?: string; client?: string };
      return v.normKey ?? (v.client ? normClient(v.client) : "UNKNOWN");
    } catch { return "UNKNOWN"; }
  }
  for (const p of NORM_SUFFIX) {
    if (key.startsWith(p)) return key.slice(p.length).split("_")[0] || "UNKNOWN";
  }
  if (key.startsWith("vynora_session_")) {
    return maps.sessionToNorm.get(key.slice("vynora_session_".length)) ?? "UNKNOWN";
  }
  for (const p of CODE_SUFFIX) {
    if (key.startsWith(p)) {
      const suffix = key.slice(p.length);
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
  return "GLOBAL"; // no client identity → shared setting
}

/** Filter a full workspace state map down to the allowed clients. */
export function filterWorkspaceState(
  state: Record<string, string>,
  allowed: Set<string> | null
): Record<string, string> {
  if (allowed === null) return state;
  const maps = buildWorkspaceMaps(state);
  const allowedCodes = new Set<string>();
  for (const [code, norm] of maps.codeToNorm) if (allowed.has(norm)) allowedCodes.add(code);

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(state)) {
    if (k === "vynora_engagement_index") {
      try {
        const idx = JSON.parse(v) as Record<string, string>;
        const f: Record<string, string> = {};
        for (const [norm, code] of Object.entries(idx)) if (allowed.has(norm)) f[norm] = code;
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
          if (norm && allowed.has(norm)) f[code] = sid;
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
          if (allowed.has(norm)) f[code] = meta;
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
    if (who !== "UNKNOWN" && allowed.has(who)) { out[k] = v; continue; }
    // UNKNOWN or another client's data → dropped (deny by default).
  }
  return out;
}

/** Engagement-key check for roadmap_state sub-maps: 'eng_<CODE>' | 'client_<norm>'. */
function engKeyAllowed(engKey: string, allowed: Set<string>, allowedCodes: Set<string>): boolean {
  if (engKey.startsWith("eng_")) return allowedCodes.has(engKey.slice(4).toUpperCase());
  if (engKey.startsWith("client_")) return allowed.has(engKey.slice(7));
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
  norm: string
): { sets: Record<string, string>; deletes: string[] } {
  const maps = buildWorkspaceMaps(state);
  const codes = new Set<string>();
  for (const [code, n] of maps.codeToNorm) if (n === norm) codes.add(code);
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
          if (n2 === norm) { delete idx[c]; changed = true; }
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
          if (n2 === norm) { delete idx[c]; changed = true; }
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
    if (resolveKeyClient(k, v, maps) === norm) deletes.push(k);
  }
  return { sets, deletes };
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
  allowed: Set<string> | null
): { sets: Record<string, string>; deletes: string[] } {
  if (allowed === null) return { sets, deletes };
  const maps = buildWorkspaceMaps(current);
  // Incoming values may introduce new engagements/sessions for allowed
  // clients — extend the maps with them before resolving.
  const incoming = buildWorkspaceMaps(sets);
  for (const [c, n] of incoming.codeToNorm) if (!maps.codeToNorm.has(c)) maps.codeToNorm.set(c, n);
  for (const [s, n] of incoming.sessionToNorm) if (!maps.sessionToNorm.has(s)) maps.sessionToNorm.set(s, n);

  const allowedCodes = new Set<string>();
  for (const [code, norm] of maps.codeToNorm) if (allowed.has(norm)) allowedCodes.add(code);

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
      for (const [ik, iv] of Object.entries(serverIdx)) if (!allowed.has(normOf(ik, iv))) merged[ik] = iv;
      for (const [ik, iv] of Object.entries(clientIdx)) if (allowed.has(normOf(ik, iv))) merged[ik] = iv;
      okSets[k] = JSON.stringify(merged);
      continue;
    }
    if (k === "vynora_roadmap_state") {
      // Keyed sub-maps merge (server's other-client entries survive); notes
      // merge additively; synthesis/gantt take the incoming value (shared
      // last-active slot, last-writer-wins as before).
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
      merged["notes"] = { ...((server["notes"] ?? {}) as object), ...((incoming2["notes"] ?? {}) as object) };
      if ("synthesis" in incoming2) merged["synthesis"] = incoming2["synthesis"];
      if ("gantt" in incoming2) merged["gantt"] = incoming2["gantt"];
      if (incoming2["savedAt"]) merged["savedAt"] = incoming2["savedAt"];
      okSets[k] = JSON.stringify(merged);
      continue;
    }
    if (k === "vynora_engagement_index" || k === "vynora_code_index") {
      // Merge: keep server entries for OTHER clients, take client's entries
      // only for allowed clients.
      let serverIdx: Record<string, string> = {};
      let clientIdx: Record<string, string> = {};
      try { serverIdx = JSON.parse(current[k] ?? "{}"); } catch { /* fresh */ }
      try { clientIdx = JSON.parse(v) as Record<string, string>; } catch { continue; }
      const merged: Record<string, string> = {};
      for (const [ik, iv] of Object.entries(serverIdx)) {
        const norm = k === "vynora_engagement_index"
          ? ik
          : (maps.codeToNorm.get(ik.toUpperCase()) ?? maps.sessionToNorm.get(iv) ?? "UNKNOWN");
        if (!allowed.has(norm)) merged[ik] = iv; // preserved, invisible to this user
      }
      for (const [ik, iv] of Object.entries(clientIdx)) {
        const norm = k === "vynora_engagement_index"
          ? ik
          : (maps.codeToNorm.get(ik.toUpperCase()) ?? maps.sessionToNorm.get(iv) ?? "UNKNOWN");
        if (allowed.has(norm)) merged[ik] = iv;
      }
      okSets[k] = JSON.stringify(merged);
      continue;
    }
    const who = resolveKeyClient(k, v, maps);
    if (who === "GLOBAL" || (who !== "UNKNOWN" && allowed.has(who))) okSets[k] = v;
  }
  const okDeletes = deletes.filter((k) => {
    if (k === "vynora_engagement_index" || k === "vynora_code_index" ||
        k === "vynora_roadmap_index" || k === "vynora_roadmap_state") return false;
    const who = resolveKeyClient(k, current[k], maps);
    return who === "GLOBAL" || (who !== "UNKNOWN" && allowed.has(who));
  });
  return { sets: okSets, deletes: okDeletes };
}
