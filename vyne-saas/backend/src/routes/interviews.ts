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
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant, withoutTenant } from "../db/pool.js";
import { requireRole } from "../auth/middleware.js";
import { allowedClientNorms, clientAllowed, filterWorkspaceState, normClient } from "../auth/clients.js";

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
export function sanitizeBriefing(raw: string): string {
  try {
    const b = JSON.parse(raw) as Record<string, unknown>;
    delete b.politicalSensitivityFlags;
    delete b.observations;
    delete b.peContext;          // PE thesis / value-creation goals: consultant-side
    delete b.peContextSummary;
    return JSON.stringify(b);
  } catch {
    return raw;
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
                  i.status, i.created_at, i.started_at, i.completed_at, u.email
             FROM interviews i LEFT JOIN users u ON u.id = i.interviewee_user_id
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
          `SELECT state_module, client_name FROM interviews WHERE id = $1`, [id]);
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

  // ── Interviewee: bootstrap (interview + sanitized context + own state) ────
  app.get("/api/interviews/mine/bootstrap", async (req, reply) => {
    const ctx = req.ctx!;
    const data = await withTenant(ctx.tenantId, async (c) => {
      const iv = await c.query(
        `SELECT id, client_name, interviewee_name, interviewee_role, status, state_module
           FROM interviews WHERE interviewee_user_id = $1
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
        injected[k] = k.startsWith("vynora_briefing_") ? sanitizeBriefing(v) : v;
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
    const ok = await withTenant(ctx.tenantId, async (c) => {
      const iv = await c.query<{ id: string; state_module: string; status: string }>(
        `SELECT id, state_module, status FROM interviews
          WHERE interviewee_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [ctx.userId]
      );
      if (!iv.rows[0]) return false;
      const { id, state_module, status } = iv.rows[0];
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
      return true;
    });
    if (!ok) { reply.code(404).send({ error: "no_interview_assigned" }); return; }
    return { ok: true };
  });

  // ── Interviewee: finish ───────────────────────────────────────────────────
  app.post("/api/interviews/mine/complete", async (req, reply) => {
    const ctx = req.ctx!;
    const ok = await withTenant(ctx.tenantId, async (c) => {
      const r = await c.query(
        `UPDATE interviews SET status = 'completed', completed_at = now()
          WHERE interviewee_user_id = $1 AND status <> 'completed'`,
        [ctx.userId]
      );
      return (r.rowCount ?? 0) > 0;
    });
    if (!ok) { reply.code(404).send({ error: "no_open_interview" }); return; }
    return { ok: true };
  });
}
