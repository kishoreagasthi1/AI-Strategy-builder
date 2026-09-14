/**
 * Distributed interviews (Phase 2.5).
 *
 * Consultant/owner:
 *   POST   /api/interviews            create an invite (+ interviewee login)
 *   GET    /api/interviews            tracker: all interviews w/ status
 *   GET    /api/interviews/:id/state  read an interviewee's session state
 *   PATCH  /api/interviews/:id        update status (e.g. reopen)
 *
 * Interviewee:
 *   GET    /api/interviews/mine/bootstrap
 *          their interview + SANITIZED briefing context + own saved state.
 *          Sanitization strips consultant-only material (political
 *          sensitivity flags, field observations) before anything reaches
 *          the interviewee's browser.
 *   PUT    /api/interviews/mine/state   persist own session (auto → in_progress)
 *   POST   /api/interviews/mine/complete
 *
 * Isolation model: interviewees never touch the shared 'workspace'
 * namespace. Each interview has a private module_state namespace
 * (iv_<uuid>); route guards + RLS keep it that way.
 *
 * V225-audit H2 fix: the consultant-facing tracker/state queries below carry
 * their own explicit tenant_id predicate in addition to RLS, as
 * belt-and-braces defense-in-depth — see engagements.ts's doc comment and
 * db/pool.ts's assertRlsEnforceable() for the full rationale.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant, withoutTenant } from "../db/pool.js";
import { requireRole } from "../auth/middleware.js";
import { allowedClientNorms, clientAllowed, filterWorkspaceState, normClient } from "../auth/clients.js";
import { mergeSessionIntoEngagement, pickLatestSession, type EngagementRecord } from "../tenant/engagementMerge.js";

const CreateBody = z.object({
  clientName: z.string().min(1).max(200),
  intervieweeName: z.string().min(1).max(200),
  intervieweeRole: z.string().min(1).max(100),
  /** Login id for the interviewee: email (Identity Platform) or dev uid. */
  email: z.string().min(3).max(200),
  /** Initial password when running with Identity Platform; ignored in dev. */
  password: z.string().min(10).max(200).optional(),
});

/** Strip consultant-only material from a briefing context. */
/**
 * V225-audit MEDIUM fix. This used to be a denylist — delete 4 known-
 * sensitive fields (politicalSensitivityFlags, observations, peContext,
 * peContextSummary), pass everything else through verbatim. Same shape as
 * the bug CRITICAL #2 fixed for engagement records: a denylist means any
 * NEW field added to briefingCtx in frontend/pre_engagement.html leaks to
 * every interviewee by default unless someone remembers to also add it
 * here. Converted to an allowlist of exactly the fields
 * interview_agent.html's briefing consumer (loadBriefingContext() and the
 * system-prompt builder around it) actually reads today — same output as
 * before for all existing data, but a field nobody has reviewed is now
 * excluded by default instead of leaked by default. Deliberately excludes
 * recommendedInterviewOrder (dead/deprecated per pre_engagement.html's own
 * comment), dataRequestOwners, and issueTreeQuestions — none of which
 * interview_agent.html's consumer reads, so dropping them changes nothing
 * observable while shrinking what's exposed.
 */
const BRIEFING_SAFE_FIELDS = [
  "generatedAt", "engagementCode", "client", "industry", "revenue",
  "clientProblem", "clientProblemSummary", "peSponsor", "engagementLead",
  "hypotheses", "industryTrends", "topUseCases", "benchmarkSummary",
  "selectedRoles", "roleCatalog", "priorityRolesPerDim",
  "roundNumber", "roundLabel", "scopeDimensions", "whatChanged", "whatChangedSummary",
  "benchmarks", "benchmarkTrends", "benchmarkDate",
  "documentSummaries", "documentIntelligence", "documentIntelligenceDate", "documentCount",
  // Pre-interview topic preview (v5.26): representative issue-tree questions
  // per dimension, scoped to the interviewee's own role by roleCatalog —
  // these are prep-friendly TOPIC templates the consultant authored, not
  // anyone's answers, so re-adding them to the allowlist (they were
  // deliberately excluded before nothing consumed them) exposes nothing the
  // CRITICAL/MEDIUM fixes above were protecting against.
  "issueTreeQuestions",
];

export function sanitizeBriefing(raw: string): string {
  try {
    const b = JSON.parse(raw) as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const k of BRIEFING_SAFE_FIELDS) if (k in b) safe[k] = b[k];
    return JSON.stringify(safe);
  } catch {
    return raw;
  }
}

/**
 * V225-audit CRITICAL fix. The bootstrap handler used to send
 * `vynora_engagement_<code>` to interviewees VERBATIM — the full consultant
 * engagement record, including every OTHER interviewee's `round.interviews[]`
 * entries (role, full summary, per-dimension findings with attribution),
 * plus consultant-only fields (peContext, clientProblem, peSponsor). Every
 * interviewee at a client could read every other named executive's private
 * interview summary just by hitting GET /api/interviews/mine/bootstrap.
 *
 * The fix is a real allowlist projection, not a delete-list: it keeps
 * exactly what interview_agent.html's own loadBriefingContext() legitimately
 * pulls out of a round for round-over-round continuity — scope/benchmarks
 * for the current round, and (for the PRIOR round) scores plus per-dimension
 * finding TEXT with no interviewee/role attribution — and drops everything
 * else, including the raw `interviews` array itself. See the matching
 * frontend change in interview_agent.html's loadBriefingContext(), which now
 * prefers this precomputed `findingsByDimension` over re-deriving it from a
 * raw `interviews` array that interviewees no longer receive.
 */
export function sanitizeEngagementForInterviewee(raw: string): string {
  try {
    const eng = JSON.parse(raw) as Record<string, unknown>;
    const rounds = Array.isArray(eng.rounds) ? (eng.rounds as Record<string, unknown>[]) : [];
    const safeRounds = rounds.map((r) => {
      const findingsByDimension: Record<string, string> = {};
      const interviews = Array.isArray(r.interviews) ? (r.interviews as Record<string, unknown>[]) : [];
      for (const iv of interviews) {
        const findings = Array.isArray(iv.findings) ? (iv.findings as Record<string, unknown>[]) : [];
        for (const f of findings) {
          const dim = typeof f.dimension === "string" ? f.dimension : null;
          const text = typeof f.text === "string" ? f.text : null;
          if (dim && text && !(dim in findingsByDimension)) findingsByDimension[dim] = text;
        }
      }
      return {
        roundId: r.roundId, roundNumber: r.roundNumber, label: r.label, type: r.type,
        date: r.date, status: r.status, scopeDimensions: r.scopeDimensions,
        whatChanged: r.whatChanged, benchmarks: r.benchmarks, benchmarkTrends: r.benchmarkTrends,
        benchmarkBasis: r.benchmarkBasis, benchmarkConfidence: r.benchmarkConfidence,
        scores: r.scores, findingsByDimension,
      };
    });
    return JSON.stringify({
      code: eng.code, client: eng.client, industry: eng.industry,
      currentRoundId: eng.currentRoundId, rounds: safeRounds,
    });
  } catch {
    return "{}";
  }
}

const CONSULTANT_SAFE_PREFIXES = ["vynora_briefing_", "vynora_engagement_", "vynora_engagement_index", "vynora_code_index"];
const BLOCKED_PREFIXES = ["vynora_refresh_agenda_", "vynora_refresh_context_", "vynora_api_key", "vynora_last_briefing"];

export async function interviewRoutes(app: FastifyInstance): Promise<void> {
  // ── Consultant: create invite ─────────────────────────────────────────────
  app.post(
    "/api/interviews",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_input", detail: parsed.error.flatten() });
        return;
      }
      const { clientName, intervieweeName, intervieweeRole, email, password } = parsed.data;

      // Client scoping: consultants may only invite for clients assigned to them.
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      if (!clientAllowed(allowed, clientName)) {
        reply.code(403).send({ error: "client_not_assigned", detail: `You are not assigned to client "${clientName}". Ask a firm owner to assign you.` });
        return;
      }

      // 1. Interviewee login. Dev mode: a users row keyed by email (signs in
      //    as dev:<email>). Identity Platform mode: a real IdP user in the
      //    firm's tenant pool.
      const devAuth = process.env.DEV_AUTH === "1" && process.env.NODE_ENV !== "production";
      let idpUid = email;
      if (!devAuth) {
        const { getAuth } = await import("firebase-admin/auth");
        const t = await withoutTenant(async (c) => {
          const r = await c.query<{ idp_tenant_id: string | null }>(
            `SELECT idp_tenant_id FROM tenants WHERE id = $1`, [ctx.tenantId]);
          return r.rows[0]?.idp_tenant_id;
        });
        if (!t) { reply.code(500).send({ error: "tenant_missing_idp" }); return; }
        if (!password) { reply.code(400).send({ error: "password_required" }); return; }
        const pool = getAuth().tenantManager().authForTenant(t);
        try {
          const u = await pool.createUser({ email, password, displayName: intervieweeName });
          idpUid = u.uid;
        } catch (e: unknown) {
          // Re-invite after a delete (or a retry): the IdP login may still
          // exist. Reuse it — reset its password/name to this invite's values.
          const code = (e as { errorInfo?: { code?: string }; code?: string });
          if ((code.errorInfo?.code ?? code.code) === "auth/email-already-exists") {
            const existing = await pool.getUserByEmail(email);
            await pool.updateUser(existing.uid, { password, displayName: intervieweeName });
            idpUid = existing.uid;
          } else {
            throw e;
          }
        }
      }

      const result = await withoutTenant(async (c) => {
        await c.query("BEGIN");
        try {
          const u = await c.query<{ id: string }>(
            `INSERT INTO users (identity_platform_uid, email, name) VALUES ($1, $2, $3)
             ON CONFLICT (identity_platform_uid) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [idpUid, email, intervieweeName]
          );
          await c.query(
            `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'interviewee')
             ON CONFLICT (user_id, tenant_id) DO NOTHING`,
            [u.rows[0].id, ctx.tenantId]
          );
          await c.query("COMMIT");
          return u.rows[0].id;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      });

      // 2. Interview row with its private state namespace.
      const row = await withTenant(ctx.tenantId, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO interviews
             (tenant_id, client_name, interviewee_name, interviewee_role,
              interviewee_user_id, state_module, created_by)
           VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                   $1, $2, $3, $4, 'pending', $5)
           RETURNING id`,
          [clientName, intervieweeName, intervieweeRole, result, ctx.userId]
        );
        const id = r.rows[0].id;
        await c.query(`UPDATE interviews SET state_module = $1 WHERE id = $2`, [
          "iv_" + id.replace(/-/g, ""), id,
        ]);
        return r.rows[0];
      });

      // Firm slug → shareable login link that pre-selects the firm (v5.23).
      const slugRow = await withoutTenant(async (c) => {
        const r = await c.query<{ slug: string | null }>(
          `SELECT slug FROM tenants WHERE id = $1`, [ctx.tenantId]);
        return r.rows[0]?.slug ?? null;
      });
      const loginPath = slugRow ? `/?firm=${slugRow}` : null;
      reply.code(201).send({
        id: row.id,
        loginPath,
        loginHint: devAuth
          ? `Dev mode: interviewee signs in as "${email}" on the landing page.`
          : (loginPath
            ? `Send them this login link: ${loginPath} — the firm is pre-selected; they just enter ${email} + password.`
            : `Interviewee signs in with firm tenant + ${email}.`),
      });
    }
  );

  // ── Consultant: tracker ───────────────────────────────────────────────────
  app.get(
    "/api/interviews",
    { preHandler: requireRole("owner", "consultant") },
    async (req) => {
      const ctx = req.ctx!;
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      return withTenant(ctx.tenantId, async (c) => {
        const r = await c.query<{ client_name: string }>(
          `SELECT i.id, i.client_name, i.interviewee_name, i.interviewee_role,
                  i.status, i.created_at, i.started_at, i.completed_at, u.email,
                  i.kind, i.parent_interview_id, i.agenda_status, i.agenda
             FROM interviews i LEFT JOIN users u ON u.id = i.interviewee_user_id
            WHERE i.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
            ORDER BY i.created_at DESC`
        );
        // Client scoping: consultants only see their assigned clients' rows.
        const rows = allowed === null
          ? r.rows
          : r.rows.filter((row) => allowed.has(normClient(row.client_name)));
        return { interviews: rows };
      });
    }
  );

  // ── Consultant: read an interviewee's session state ───────────────────────
  app.get(
    "/api/interviews/:id/state",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { id } = req.params as { id: string };
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      const data = await withTenant(ctx.tenantId, async (c) => {
        const iv = await c.query<{ state_module: string; client_name: string }>(
          `SELECT state_module, client_name FROM interviews
            WHERE id = $1
              AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`, [id]);
        if (!iv.rows[0]) return null;
        if (!clientAllowed(allowed, iv.rows[0].client_name)) return null; // indistinguishable from not-found
        const st = await c.query<{ key: string; value: { v: string } }>(
          `SELECT key, value FROM module_state WHERE module = $1`, [iv.rows[0].state_module]);
        const out: Record<string, string> = {};
        for (const row of st.rows) out[row.key] = row.value.v;
        return out;
      });
      if (data === null) { reply.code(404).send({ error: "not_found" }); return; }
      return { state: data };
    }
  );

  // ── Consultant: edit an interview (details and/or status) ─────────────────
  app.patch(
    "/api/interviews/:id",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { id } = req.params as { id: string };
      const body = z
        .object({
          status: z.enum(["invited", "in_progress", "completed"]).optional(),
          clientName: z.string().min(1).max(200).optional(),
          intervieweeName: z.string().min(1).max(200).optional(),
          intervieweeRole: z.string().min(1).max(100).optional(),
        })
        .safeParse(req.body);
      if (!body.success || Object.keys(body.data).length === 0) {
        reply.code(400).send({ error: "invalid_input" });
        return;
      }
      const d = body.data;
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      // Consultants can neither touch an unassigned client's interview nor
      // move an interview TO a client they aren't assigned to.
      if (d.clientName && !clientAllowed(allowed, d.clientName)) {
        reply.code(403).send({ error: "client_not_assigned" });
        return;
      }
      const n = await withTenant(ctx.tenantId, async (c) => {
        if (allowed !== null) {
          const cur = await c.query<{ client_name: string }>(
            `SELECT client_name FROM interviews WHERE id = $1`, [id]);
          if (!cur.rows[0] || !allowed.has(normClient(cur.rows[0].client_name))) return 0;
        }
        const r = await c.query(
          `UPDATE interviews SET
             status           = COALESCE($1, status),
             client_name      = COALESCE($2, client_name),
             interviewee_name = COALESCE($3, interviewee_name),
             interviewee_role = COALESCE($4, interviewee_role)
           WHERE id = $5`,
          [d.status ?? null, d.clientName ?? null, d.intervieweeName ?? null, d.intervieweeRole ?? null, id]
        );
        return r.rowCount;
      });
      if (!n) { reply.code(404).send({ error: "not_found" }); return; }
      return { ok: true };
    }
  );

  // ── Consultant: delete an interview (row + its private session state; the
  //    interviewee's membership is removed too if this was their only
  //    interview, so their login stops granting access) ──────────────────────
  app.delete(
    "/api/interviews/:id",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { id } = req.params as { id: string };
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      const deleted = await withTenant(ctx.tenantId, async (c) => {
        const iv = await c.query<{ state_module: string; interviewee_user_id: string | null; client_name: string }>(
          `SELECT state_module, interviewee_user_id, client_name FROM interviews WHERE id = $1`, [id]);
        if (!iv.rows[0]) return null;
        if (!clientAllowed(allowed, iv.rows[0].client_name)) return null;
        await c.query(`DELETE FROM module_state WHERE module = $1`, [iv.rows[0].state_module]);
        await c.query(`DELETE FROM interviews WHERE id = $1`, [id]);
        return iv.rows[0].interviewee_user_id;
      });
      if (deleted === null) { reply.code(404).send({ error: "not_found" }); return; }
      if (deleted) {
        // Membership cleanup needs system access (memberships has no RLS).
        const removed = await withoutTenant(async (c) => {
          const r = await c.query(
            `DELETE FROM memberships m
              WHERE m.user_id = $1 AND m.tenant_id = $2 AND m.role = 'interviewee'
                AND NOT EXISTS (SELECT 1 FROM interviews i
                                 WHERE i.interviewee_user_id = $1 AND i.tenant_id = $2)
              RETURNING m.user_id`,
            [deleted, ctx.tenantId]
          );
          if (!r.rows[0]) return null;
          const info = await c.query<{ uid: string; idp: string | null }>(
            `SELECT u.identity_platform_uid AS uid, t.idp_tenant_id AS idp
               FROM users u, tenants t WHERE u.id = $1 AND t.id = $2`,
            [deleted, ctx.tenantId]
          );
          return info.rows[0] ?? null;
        });
        // Their IdP login goes too (v5.22) — otherwise re-inviting the same
        // email later collides with the orphaned account. Best-effort: a
        // failure here must not undo the interview deletion.
        const devAuth = process.env.DEV_AUTH === "1" && process.env.NODE_ENV !== "production";
        if (removed?.idp && !devAuth) {
          try {
            const { getAuth } = await import("firebase-admin/auth");
            await getAuth().tenantManager().authForTenant(removed.idp).deleteUser(removed.uid);
          } catch (e) {
            req.log.warn({ err: e }, "IdP interviewee cleanup failed (non-fatal)");
          }
        }
      }
      return { ok: true };
    }
  );

  // ── Consultant: draft a follow-up agenda for a completed interview ────────
  // (NEXT_SESSION_SPEC.md #1 — must-have.) Agenda items are pulled from the
  // client's OTHER interviewees' findings for the latest engagement round —
  // findings already stored function-level ("observed condition", never
  // attributed to a name — see synthetic.ts's synthPrompt and
  // sanitizeEngagementForInterviewee's doc comment above), so drafting from
  // them carries no more attribution risk than the round-2+ context every
  // interviewee already receives. This interviewee's OWN prior findings are
  // excluded — a follow-up probes what OTHERS said, not a recap of their own
  // answers. The draft is NOT visible to the interviewee until a consultant
  // approves it via PATCH .../followup below (safeguard #2).
  app.post(
    "/api/interviews/:id/followup/draft",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { id } = req.params as { id: string };
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      const result = await withTenant(ctx.tenantId, async (c) => {
        const parent = await c.query<{
          id: string; client_name: string; interviewee_name: string; interviewee_role: string;
          interviewee_user_id: string | null; status: string;
        }>(
          `SELECT id, client_name, interviewee_name, interviewee_role, interviewee_user_id, status
             FROM interviews WHERE id = $1`,
          [id]
        );
        if (!parent.rows[0]) return "not_found" as const;
        const p = parent.rows[0];
        if (!clientAllowed(allowed, p.client_name)) return "not_found" as const;
        if (p.status !== "completed") return "not_completed" as const;
        if (!p.interviewee_user_id) return "no_login" as const;

        const norm = normClient(p.client_name);
        const idxRow = await c.query<{ value: { v: string } }>(
          `SELECT value FROM module_state WHERE module = 'workspace' AND key = 'vynora_engagement_index'`
        );
        let idx: Record<string, string> = {};
        try { idx = JSON.parse(idxRow.rows[0]?.value.v ?? "{}"); } catch { /* none yet */ }
        const code = idx[norm];

        let agenda: { dimension: string; text: string }[] = [];
        if (code) {
          const engRow = await c.query<{ value: { v: string } }>(
            `SELECT value FROM module_state WHERE module = 'workspace' AND key = $1`,
            ["vynora_engagement_" + code]
          );
          if (engRow.rows[0]) {
            try {
              const eng = JSON.parse(engRow.rows[0].value.v) as {
                rounds?: { roundNumber: number; interviews?: { role?: string; findings?: { dimension?: string; text?: string }[] }[] }[];
              };
              const rounds = eng.rounds ?? [];
              const latest = rounds[rounds.length - 1];
              if (latest) {
                const byDim = new Map<string, string[]>();
                for (const iv of latest.interviews ?? []) {
                  if (iv.role === p.interviewee_role) continue; // their own prior answers — skip
                  for (const f of iv.findings ?? []) {
                    if (!f.dimension || !f.text) continue;
                    const arr = byDim.get(f.dimension) ?? [];
                    if (arr.length < 2 && !arr.includes(f.text)) arr.push(f.text);
                    byDim.set(f.dimension, arr);
                  }
                }
                for (const [dimension, texts] of byDim) for (const text of texts) agenda.push({ dimension, text });
                agenda = agenda.slice(0, 8);
              }
            } catch { /* no usable engagement data yet */ }
          }
        }
        if (!agenda.length) {
          agenda = [{
            dimension: "D1",
            text: "Revisit this dimension with updated context from the wider engagement — no specific findings were available to draft from yet.",
          }];
        }

        // Reuse a still-pending (not yet approved) follow-up row if one
        // already exists for this parent, instead of stacking duplicates.
        const existing = await c.query<{ id: string }>(
          `SELECT id FROM interviews WHERE parent_interview_id = $1 AND agenda_status <> 'approved'
            ORDER BY created_at DESC LIMIT 1`,
          [id]
        );
        let followUpId: string;
        if (existing.rows[0]) {
          followUpId = existing.rows[0].id;
          await c.query(`UPDATE interviews SET agenda = $1, agenda_status = 'draft' WHERE id = $2`, [
            JSON.stringify(agenda), followUpId,
          ]);
        } else {
          const ins = await c.query<{ id: string }>(
            `INSERT INTO interviews
               (tenant_id, client_name, interviewee_name, interviewee_role,
                interviewee_user_id, status, state_module, created_by,
                kind, parent_interview_id, agenda, agenda_status)
             VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                     $1, $2, $3, $4, 'invited', 'pending', $5,
                     'follow_up', $6, $7, 'draft')
             RETURNING id`,
            [p.client_name, p.interviewee_name, p.interviewee_role, p.interviewee_user_id,
              ctx.userId, id, JSON.stringify(agenda)]
          );
          followUpId = ins.rows[0].id;
          await c.query(`UPDATE interviews SET state_module = $1 WHERE id = $2`, [
            "iv_" + followUpId.replace(/-/g, ""), followUpId,
          ]);
        }
        return { id: followUpId, agenda };
      });
      if (result === "not_found") { reply.code(404).send({ error: "not_found" }); return; }
      if (result === "not_completed") {
        reply.code(409).send({ error: "parent_not_completed", detail: "The interview must be completed before requesting a follow-up." });
        return;
      }
      if (result === "no_login") {
        reply.code(409).send({ error: "no_login", detail: "This interview has no interviewee login to reuse for a follow-up." });
        return;
      }
      reply.code(201).send(result);
    }
  );

  // ── Consultant: edit and/or approve a follow-up agenda ─────────────────────
  // agenda_status flips to 'approved' ONLY here, on an explicit consultant
  // action — until then, GET /api/interviews/mine/bootstrap keeps returning
  // whatever interview the interviewee already had; this row stays invisible
  // to them (see the bootstrap/state-eligibility filter below).
  app.patch(
    "/api/interviews/:id/followup",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { id } = req.params as { id: string };
      const body = z
        .object({
          agenda: z.array(z.object({
            dimension: z.string().min(1).max(20),
            text: z.string().min(1).max(2000),
          })).min(1).max(20).optional(),
          approve: z.boolean().optional(),
        })
        .safeParse(req.body);
      if (!body.success || (body.data.agenda === undefined && body.data.approve === undefined)) {
        reply.code(400).send({ error: "invalid_input" });
        return;
      }
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      const n = await withTenant(ctx.tenantId, async (c) => {
        const cur = await c.query<{ client_name: string; kind: string }>(
          `SELECT client_name, kind FROM interviews WHERE id = $1`, [id]
        );
        if (!cur.rows[0] || cur.rows[0].kind !== "follow_up") return 0;
        if (!clientAllowed(allowed, cur.rows[0].client_name)) return 0;
        const r = await c.query(
          `UPDATE interviews SET
             agenda        = COALESCE($1, agenda),
             agenda_status = CASE WHEN $2::boolean IS TRUE THEN 'approved' ELSE agenda_status END
           WHERE id = $3`,
          [body.data.agenda ? JSON.stringify(body.data.agenda) : null, body.data.approve ?? null, id]
        );
        return r.rowCount;
      });
      if (!n) { reply.code(404).send({ error: "not_found" }); return; }
      return { ok: true };
    }
  );

  // ── Interviewee: bootstrap (interview + sanitized context + own state) ────
  app.get("/api/interviews/mine/bootstrap", async (req, reply) => {
    const ctx = req.ctx!;
    const data = await withTenant(ctx.tenantId, async (c) => {
      // Eligibility: a follow-up row only becomes visible once a consultant
      // approves its agenda (agenda_status='approved') — see the PATCH
      // .../followup route above. Until then this query keeps returning
      // whatever interview the interviewee already had (typically their
      // completed initial one), so a drafted-but-unapproved follow-up is
      // completely invisible to them.
      const iv = await c.query(
        `SELECT id, client_name, interviewee_name, interviewee_role, status, state_module,
                kind, agenda, parent_interview_id
           FROM interviews
          WHERE interviewee_user_id = $1 AND (kind = 'initial' OR agenda_status = 'approved')
          ORDER BY created_at DESC LIMIT 1`,
        [ctx.userId]
      );
      if (!iv.rows[0]) return null;
      const interview = iv.rows[0];

      // Sanitized slice of the consultant workspace: briefing context minus
      // consultant-only fields, plus engagement round data for continuity.
      // CLIENT-SCOPED: an interviewee only ever receives THEIR client's data
      // — never another customer's briefing, engagements, or sessions.
      const ws = await c.query<{ key: string; value: { v: string } }>(
        `SELECT key, value FROM module_state WHERE module = 'workspace'`
      );
      const raw: Record<string, string> = {};
      for (const row of ws.rows) {
        const k = row.key;
        if (BLOCKED_PREFIXES.some((p) => k.startsWith(p))) continue;
        if (!CONSULTANT_SAFE_PREFIXES.some((p) => k === p || k.startsWith(p))) continue;
        raw[k] = row.value.v;
      }
      const ownClient = new Set([normClient(interview.client_name)]);
      const scoped = filterWorkspaceState(raw, ownClient);
      const injected: Record<string, string> = {};
      for (const [k, v] of Object.entries(scoped)) {
        // V225-audit CRITICAL fix: vynora_engagement_<code> used to be sent
        // verbatim, leaking every other interviewee's attributed findings
        // (see sanitizeEngagementForInterviewee's doc comment above). The
        // index key (vynora_engagement_index) has a different shape
        // ({normClient: CODE}) and must NOT be routed through the sanitizer.
        injected[k] = k.startsWith("vynora_briefing_")
          ? sanitizeBriefing(v)
          : (k.startsWith("vynora_engagement_") && k !== "vynora_engagement_index")
          ? sanitizeEngagementForInterviewee(v)
          : v;
      }

      // The interviewee's own saved session state (their private namespace).
      const st = await c.query<{ key: string; value: { v: string } }>(
        `SELECT key, value FROM module_state WHERE module = $1`, [interview.state_module]);
      const own: Record<string, string> = {};
      for (const row of st.rows) own[row.key] = row.value.v;

      return { interview, injected, own };
    });
    if (!data) { reply.code(404).send({ error: "no_interview_assigned" }); return; }
    return data;
  });

  // ── Interviewee: persist own session state ────────────────────────────────
  app.put("/api/interviews/mine/state", async (req, reply) => {
    const ctx = req.ctx!;
    const body = z
      .object({ sets: z.record(z.string().max(2_000_000)).default({}), deletes: z.array(z.string().max(512)).default([]) })
      .safeParse(req.body);
    if (!body.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    const result = await withTenant(ctx.tenantId, async (c) => {
      const iv = await c.query<{ id: string; state_module: string; status: string }>(
        `SELECT id, state_module, status FROM interviews
          WHERE interviewee_user_id = $1 AND (kind = 'initial' OR agenda_status = 'approved')
          ORDER BY created_at DESC LIMIT 1`,
        [ctx.userId]
      );
      if (!iv.rows[0]) return "not_found" as const;
      const { id, state_module, status } = iv.rows[0];
      // V225-audit LOW fix: this used to write unconditionally regardless
      // of status — an interviewee who already hit POST .../mine/complete
      // could still PUT further state changes afterward, silently mutating
      // session data (answers, findings) the consultant may already be
      // relying on as final. `already_completed` is returned as a distinct
      // sentinel (not the generic `ok: true`) so the frontend can surface
      // it rather than silently pretending the save succeeded.
      if (status === "completed") return "already_completed" as const;
      for (const [key, v] of Object.entries(body.data.sets)) {
        await c.query(
          `INSERT INTO module_state (tenant_id, module, key, value, updated_by)
           VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4)
           ON CONFLICT (tenant_id, module, key)
           DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [state_module, key, JSON.stringify({ v }), ctx.userId]
        );
      }
      if (body.data.deletes.length) {
        await c.query(`DELETE FROM module_state WHERE module = $1 AND key = ANY($2::text[])`, [
          state_module, body.data.deletes,
        ]);
      }
      if (status === "invited") {
        await c.query(`UPDATE interviews SET status = 'in_progress', started_at = now() WHERE id = $1`, [id]);
      }
      return "ok" as const;
    });
    if (result === "not_found") { reply.code(404).send({ error: "no_interview_assigned" }); return; }
    if (result === "already_completed") {
      reply.code(409).send({ error: "interview_already_completed", detail: "This interview is already marked complete; further changes aren't saved." });
      return;
    }
    return { ok: true };
  });

  // ── Interviewee: finish ───────────────────────────────────────────────────
  // Also runs the tracker → Synthesis auto-flow (see tenant/engagementMerge.ts):
  // folds this interviewee's own private session into the firm's shared
  // engagement record in the SAME transaction as marking the interview
  // completed, so it shows up in the Synthesis Dashboard immediately — no
  // manual "Session" JSON download + import. Best-effort: a merge failure is
  // logged but never undoes the completion itself (the interviewee's answers
  // are never lost even if the fold-in has a problem; a consultant can still
  // pull the raw session via GET /api/interviews/:id/state as before).
  app.post("/api/interviews/mine/complete", async (req, reply) => {
    const ctx = req.ctx!;
    const result = await withTenant(ctx.tenantId, async (c) => {
      const upd = await c.query<{
        id: string; state_module: string; kind: string;
        parent_interview_id: string | null; client_name: string;
      }>(
        `UPDATE interviews SET status = 'completed', completed_at = now()
          WHERE id = (
            SELECT id FROM interviews
             WHERE interviewee_user_id = $1 AND status <> 'completed'
             ORDER BY created_at DESC LIMIT 1
          )
         RETURNING id, state_module, kind, parent_interview_id, client_name`,
        [ctx.userId]
      );
      if (!upd.rows[0]) return "not_found" as const;
      const { id, state_module, kind, parent_interview_id, client_name } = upd.rows[0];

      try {
        const st = await c.query<{ key: string; value: { v: string } }>(
          `SELECT key, value FROM module_state WHERE module = $1`, [state_module]
        );
        const raw: Record<string, string> = {};
        for (const row of st.rows) raw[row.key] = row.value.v;
        const session = pickLatestSession(raw);
        if (session) {
          if (!session.client) session.client = client_name;
          const norm = normClient(session.client);

          const idxRow = await c.query<{ value: { v: string } }>(
            `SELECT value FROM module_state WHERE module = 'workspace' AND key = 'vynora_engagement_index'`
          );
          let idx: Record<string, string> = {};
          try { idx = JSON.parse(idxRow.rows[0]?.value.v ?? "{}"); } catch { /* fresh */ }
          let code = idx[norm];

          let eng: EngagementRecord | null = null;
          if (code) {
            const engRow = await c.query<{ value: { v: string } }>(
              `SELECT value FROM module_state WHERE module = 'workspace' AND key = $1`,
              ["vynora_engagement_" + code]
            );
            if (engRow.rows[0]) { try { eng = JSON.parse(engRow.rows[0].value.v); } catch { /* fresh */ } }
          }
          if (!code) {
            code = (client_name.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4) || "ENG") +
              "-" + id.replace(/-/g, "").slice(0, 4).toUpperCase();
            idx[norm] = code;
          }

          const merged = mergeSessionIntoEngagement(eng, code, session, {
            sourceInterviewId: id,
            kind: kind === "follow_up" ? "follow_up" : "initial",
            parentInterviewId: parent_interview_id,
          });

          const upsert = async (key: string, value: string) => {
            await c.query(
              `INSERT INTO module_state (tenant_id, module, key, value, updated_by)
               VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid, 'workspace', $1, $2, $3)
               ON CONFLICT (tenant_id, module, key)
               DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
              [key, JSON.stringify({ v: value }), ctx.userId]
            );
          };
          await upsert("vynora_engagement_index", JSON.stringify(idx));
          await upsert("vynora_engagement_" + code, JSON.stringify(merged));
        }
      } catch (e) {
        req.log.warn({ err: e }, "engagement auto-merge failed (interview still marked completed)");
      }
      return "ok" as const;
    });
    if (result === "not_found") { reply.code(404).send({ error: "no_open_interview" }); return; }
    return { ok: true };
  });
}
