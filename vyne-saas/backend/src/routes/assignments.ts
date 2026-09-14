/**
 * Client assignments API (Phase 5) — owners control which clients each
 * consultant can see. Server-enforced everywhere client data is served.
 *
 *   GET    /api/assignments            owner: all rows · consultant: own rows
 *   GET    /api/my-clients             clients the caller may work on
 *   POST   /api/assignments            owner: { email, clientName }
 *   DELETE /api/assignments            owner: { email, clientName }
 *
 * Team management (owners create the consultant logins they then assign):
 *   GET    /api/team                   owner: all owner/consultant members
 *   POST   /api/team                   owner: { email, name?, password? } →
 *                                      consultant login (dev: signs in with
 *                                      the id; IdP: real tenant user)
 *   DELETE /api/team                   owner: { email } — removes a
 *                                      consultant's membership + assignments
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant, withoutTenant } from "../db/pool.js";
import { requireRole } from "../auth/middleware.js";
import { normClient, purgeClientKeys } from "../auth/clients.js";

const Body = z.object({
  email: z.string().min(3).max(200),
  clientName: z.string().min(1).max(200),
});

/** Resolve a tenant member (owner/consultant) by email. */
async function memberByEmail(tenantId: string, email: string):
  Promise<{ id: string; role: string; name: string | null } | undefined> {
  return withoutTenant(async (c) => {
    const r = await c.query<{ id: string; role: string; name: string | null }>(
      `SELECT u.id, m.role, u.name
         FROM users u JOIN memberships m ON m.user_id = u.id
        WHERE m.tenant_id = $1 AND lower(u.email) = lower($2)
          AND m.role IN ('owner','consultant')
        ORDER BY m.created_at DESC LIMIT 1`,
      [tenantId, email]
    );
    return r.rows[0];
  });
}

const TeamBody = z.object({
  email: z.string().min(3).max(200),
  name: z.string().max(200).optional(),
  /** Initial password when running with Identity Platform; ignored in dev. */
  password: z.string().min(10).max(200).optional(),
});

export async function assignmentRoutes(app: FastifyInstance): Promise<void> {
  // ── Team: list owner/consultant members ──────────────────────────────────
  app.get(
    "/api/team",
    { preHandler: requireRole("owner") },
    async (req) => {
      const ctx = req.ctx!;
      const members = await withoutTenant(async (c) => {
        const r = await c.query(
          `SELECT u.id, u.email, u.name, m.role, m.created_at
             FROM users u JOIN memberships m ON m.user_id = u.id
            WHERE m.tenant_id = $1 AND m.role IN ('owner','consultant')
            ORDER BY m.role, u.email`, [ctx.tenantId]);
        return r.rows;
      });
      return { members };
    }
  );

  // ── Team: add a consultant login ─────────────────────────────────────────
  app.post(
    "/api/team",
    { preHandler: requireRole("owner") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = TeamBody.safeParse(req.body);
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      const { email, name, password } = parsed.data;

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
          const u = await pool.createUser({ email, password, displayName: name ?? email });
          idpUid = u.uid;
        } catch (e: unknown) {
          // Re-adding a previously removed consultant: reuse the orphaned IdP
          // login, resetting its password/name to this invite's values.
          const code = (e as { errorInfo?: { code?: string }; code?: string });
          if ((code.errorInfo?.code ?? code.code) === "auth/email-already-exists") {
            const existing = await pool.getUserByEmail(email);
            await pool.updateUser(existing.uid, { password, displayName: name ?? email });
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
             ON CONFLICT (identity_platform_uid)
             DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)
             RETURNING id`,
            [idpUid, email, name ?? null]
          );
          const existing = await c.query<{ role: string }>(
            `SELECT role FROM memberships WHERE user_id = $1 AND tenant_id = $2`,
            [u.rows[0].id, ctx.tenantId]
          );
          if (existing.rows[0] && existing.rows[0].role === "interviewee") {
            await c.query("ROLLBACK");
            return { error: "is_interviewee" as const };
          }
          await c.query(
            `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'consultant')
             ON CONFLICT (user_id, tenant_id) DO NOTHING`,
            [u.rows[0].id, ctx.tenantId]
          );
          await c.query("COMMIT");
          return { id: u.rows[0].id };
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      });
      if ("error" in result) {
        reply.code(409).send({ error: "is_interviewee", detail: "That login belongs to an interviewee. Use a different email for the consultant." });
        return;
      }
      reply.code(201).send({
        ok: true, id: result.id,
        loginHint: devAuth
          ? `Dev mode: they sign in on the landing page with "${email}".`
          : `They sign in with your firm tenant ID + ${email}.`,
      });
    }
  );

  // ── Team: remove a consultant (membership + their assignments) ───────────
  app.delete(
    "/api/team",
    { preHandler: requireRole("owner") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = z.object({ email: z.string().min(3).max(200) }).safeParse(req.body);
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      const member = await memberByEmail(ctx.tenantId, parsed.data.email);
      if (!member) { reply.code(404).send({ error: "no_such_member" }); return; }
      if (member.role === "owner") {
        reply.code(400).send({ error: "cannot_remove_owner", detail: "Owners cannot be removed here." });
        return;
      }
      await withTenant(ctx.tenantId, async (c) => {
        await c.query(`DELETE FROM client_assignments WHERE user_id = $1`, [member.id]);
      });
      const info = await withoutTenant(async (c) => {
        await c.query(
          `DELETE FROM memberships WHERE user_id = $1 AND tenant_id = $2 AND role = 'consultant'`,
          [member.id, ctx.tenantId]);
        const r = await c.query<{ uid: string; idp: string | null }>(
          `SELECT u.identity_platform_uid AS uid, t.idp_tenant_id AS idp
             FROM users u, tenants t WHERE u.id = $1 AND t.id = $2`,
          [member.id, ctx.tenantId]);
        return r.rows[0] ?? null;
      });
      // Remove the IdP login too (v5.22) so re-adding the same email later
      // creates cleanly. Best-effort — membership removal already revoked access.
      const devAuth = process.env.DEV_AUTH === "1" && process.env.NODE_ENV !== "production";
      if (info?.idp && !devAuth) {
        try {
          const { getAuth } = await import("firebase-admin/auth");
          await getAuth().tenantManager().authForTenant(info.idp).deleteUser(info.uid);
        } catch (e) {
          req.log.warn({ err: e }, "IdP consultant cleanup failed (non-fatal)");
        }
      }
      return { ok: true };
    }
  );

  // ── Client deletion: permanently remove ONE client's data everywhere ──────
  // Owner-only. Deletes the client's interviews (rows + their private session
  // namespaces), interviewee logins that only existed for this client, the
  // engagements rows, consultant assignments, and every workspace key that
  // belongs to the client (briefing, engagement, sessions, synthesis, roadmap
  // slices) — shared indexes keep other clients' entries untouched.
  app.delete(
    "/api/clients",
    { preHandler: requireRole("owner") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = z.object({ clientName: z.string().min(1).max(200) }).safeParse(req.body);
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      const clientName = parsed.data.clientName.trim();
      const norm = normClient(clientName);

      const result = await withTenant(ctx.tenantId, async (c) => {
        // 1. Interviews (norm-matched) + their private state namespaces.
        const ivs = await c.query<{ id: string; state_module: string; interviewee_user_id: string | null; client_name: string }>(
          `SELECT id, state_module, interviewee_user_id, client_name FROM interviews`);
        const mine = ivs.rows.filter((r) => normClient(r.client_name) === norm);
        for (const r of mine) {
          await c.query(`DELETE FROM module_state WHERE module = $1`, [r.state_module]);
          await c.query(`DELETE FROM interviews WHERE id = $1`, [r.id]);
        }
        // Which of those interviewees still have OTHER interviews in this firm?
        const userIds = [...new Set(mine.map((r) => r.interviewee_user_id).filter((x): x is string => Boolean(x)))];
        let orphaned: string[] = [];
        if (userIds.length) {
          const still = await c.query<{ interviewee_user_id: string }>(
            `SELECT DISTINCT interviewee_user_id FROM interviews WHERE interviewee_user_id = ANY($1::uuid[])`,
            [userIds]);
          const keep = new Set(still.rows.map((r) => r.interviewee_user_id));
          orphaned = userIds.filter((u) => !keep.has(u));
        }
        // 2. Engagements table rows.
        const engs = await c.query<{ id: string; client_name: string }>(`SELECT id, client_name FROM engagements`);
        let engCount = 0;
        for (const e of engs.rows.filter((r) => normClient(r.client_name) === norm)) {
          await c.query(`DELETE FROM engagements WHERE id = $1`, [e.id]);
          engCount++;
        }
        // 3. Consultant assignments for this client.
        await c.query(`DELETE FROM client_assignments WHERE client_norm = $1`, [norm]);
        // 4. Workspace purge via the shared resolver.
        const ws = await c.query<{ key: string; value: { v: string } }>(
          `SELECT key, value FROM module_state WHERE module = 'workspace'`);
        const state: Record<string, string> = {};
        for (const row of ws.rows) state[row.key] = row.value.v;
        const { sets, deletes } = purgeClientKeys(state, norm);
        for (const [k, v] of Object.entries(sets)) {
          await c.query(
            `UPDATE module_state SET value = $1, updated_by = $2, updated_at = now()
              WHERE module = 'workspace' AND key = $3`,
            [JSON.stringify({ v }), ctx.userId, k]);
        }
        if (deletes.length) {
          await c.query(`DELETE FROM module_state WHERE module = 'workspace' AND key = ANY($1::text[])`, [deletes]);
        }
        return { interviews: mine.length, engagements: engCount, workspaceKeys: deletes.length, orphaned };
      });

      // Interviewee logins that only existed for this client lose their
      // membership (memberships has no RLS — system path) AND their IdP
      // login (v5.22), so the same email can be re-invited cleanly later.
      const devAuth = process.env.DEV_AUTH === "1" && process.env.NODE_ENV !== "production";
      for (const uid of result.orphaned) {
        const info = await withoutTenant(async (c) => {
          await c.query(
            `DELETE FROM memberships WHERE user_id = $1 AND tenant_id = $2 AND role = 'interviewee'`,
            [uid, ctx.tenantId]);
          const r = await c.query<{ uid: string; idp: string | null }>(
            `SELECT u.identity_platform_uid AS uid, t.idp_tenant_id AS idp
               FROM users u, tenants t WHERE u.id = $1 AND t.id = $2`,
            [uid, ctx.tenantId]);
          return r.rows[0] ?? null;
        });
        if (info?.idp && !devAuth) {
          try {
            const { getAuth } = await import("firebase-admin/auth");
            await getAuth().tenantManager().authForTenant(info.idp).deleteUser(info.uid);
          } catch (e) {
            req.log.warn({ err: e }, "IdP interviewee cleanup failed (non-fatal)");
          }
        }
      }

      return {
        ok: true, clientName,
        interviews: result.interviews,
        engagements: result.engagements,
        workspaceKeys: result.workspaceKeys,
        intervieweeLoginsRemoved: result.orphaned.length,
      };
    }
  );

  app.get(
    "/api/assignments",
    { preHandler: requireRole("owner", "consultant") },
    async (req) => {
      const ctx = req.ctx!;
      return withTenant(ctx.tenantId, async (c) => {
        const r = ctx.role === "owner"
          ? await c.query(
              `SELECT a.user_id, a.client_name, a.client_norm, a.created_at,
                      u.email, u.name
                 FROM client_assignments a JOIN users u ON u.id = a.user_id
                ORDER BY u.email, a.client_name`)
          : await c.query(
              `SELECT a.user_id, a.client_name, a.client_norm, a.created_at
                 FROM client_assignments a WHERE a.user_id = $1
                ORDER BY a.client_name`, [ctx.userId]);
        return { assignments: r.rows };
      });
    }
  );

  // Clients the caller can work on. Owners get every client seen anywhere
  // (engagements + interviews + assignments); consultants get exactly their
  // assignments.
  app.get(
    "/api/my-clients",
    { preHandler: requireRole("owner", "consultant") },
    async (req) => {
      const ctx = req.ctx!;
      return withTenant(ctx.tenantId, async (c) => {
        if (ctx.role === "owner") {
          // Engagements included so a client created via the briefing flow
          // (Pre-Engagement) appears in the login picker even before any
          // interview exists or a consultant is assigned.
          const r = await c.query<{ client_name: string }>(
            `SELECT client_name FROM interviews
             UNION SELECT client_name FROM client_assignments
             UNION SELECT client_name FROM engagements
             ORDER BY client_name`);
          return { role: "owner", clients: r.rows.map((x) => x.client_name) };
        }
        const r = await c.query<{ client_name: string }>(
          `SELECT DISTINCT client_name FROM client_assignments
            WHERE user_id = $1 ORDER BY client_name`, [ctx.userId]);
        return { role: ctx.role, clients: r.rows.map((x) => x.client_name) };
      });
    }
  );

  app.post(
    "/api/assignments",
    { preHandler: requireRole("owner") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      const member = await memberByEmail(ctx.tenantId, parsed.data.email);
      if (!member) { reply.code(404).send({ error: "no_such_member", detail: "No owner/consultant with that email in this firm — add them in the Team section first." }); return; }
      const clientName = parsed.data.clientName.trim();
      await withTenant(ctx.tenantId, async (c) => {
        await c.query(
          `INSERT INTO client_assignments (tenant_id, user_id, client_name, client_norm, created_by)
           VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4)
           ON CONFLICT (tenant_id, user_id, client_norm)
           DO UPDATE SET client_name = EXCLUDED.client_name`,
          [member.id, clientName, normClient(clientName), ctx.userId]
        );
      });
      reply.code(201).send({ ok: true, userId: member.id, clientNorm: normClient(clientName) });
    }
  );

  app.delete(
    "/api/assignments",
    { preHandler: requireRole("owner") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = Body.safeParse(req.body);
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      const member = await memberByEmail(ctx.tenantId, parsed.data.email);
      if (!member) { reply.code(404).send({ error: "no_such_member" }); return; }
      const n = await withTenant(ctx.tenantId, async (c) => {
        const r = await c.query(
          `DELETE FROM client_assignments WHERE user_id = $1 AND client_norm = $2`,
          [member.id, normClient(parsed.data.clientName)]
        );
        return r.rowCount ?? 0;
      });
      if (!n) { reply.code(404).send({ error: "not_found" }); return; }
      return { ok: true };
    }
  );
}
