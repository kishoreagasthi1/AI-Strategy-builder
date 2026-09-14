/**
 * Owner-facing audit log query surface (v5.30).
 *
 *   GET /api/audit-log?limit=&before=&action=
 *
 * Read-only, owner-only (requireRole("owner") — consultants and
 * interviewees never see the firm's audit trail, only the owner who's
 * accountable for the firm's account). Backed by audit_log, RLS-protected
 * as of migration 008 — withTenant() scopes every query to the caller's
 * tenant the same way every other module does, so this route doesn't need
 * (and must not add) its own manual tenant_id filter.
 *
 * Pagination is keyset-based on (created_at, id) rather than OFFSET: the
 * table is append-only and can grow indefinitely, and keyset pagination
 * stays correct even as new rows are written between page fetches (an
 * OFFSET page can skip or repeat rows under concurrent inserts).
 * `before` is an opaque cursor: the `id` of the oldest row already seen.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { requireRole } from "../auth/middleware.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  before: z.coerce.number().int().positive().optional(),
  action: z.string().min(1).max(100).optional(),
});

export interface AuditLogEntry {
  id: number;
  userId: string | null;
  userEmail: string | null;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/audit-log",
    { preHandler: requireRole("owner") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const q = Query.safeParse(req.query);
      if (!q.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      const limit = q.data.limit ?? DEFAULT_LIMIT;

      const entries = await withTenant(ctx.tenantId, async (c) => {
        const r = await c.query<{
          id: string;
          user_id: string | null;
          user_email: string | null;
          action: string;
          detail: Record<string, unknown>;
          created_at: string;
        }>(
          `SELECT a.id, a.user_id, u.email AS user_email, a.action, a.detail, a.created_at
             FROM audit_log a
             LEFT JOIN users u ON u.id = a.user_id
            WHERE ($1::bigint IS NULL OR a.id < $1::bigint)
              AND ($2::text   IS NULL OR a.action = $2::text)
            ORDER BY a.id DESC
            LIMIT $3`,
          [q.data.before ?? null, q.data.action ?? null, limit]
        );
        return r.rows.map((row) => ({
          id: Number(row.id),
          userId: row.user_id,
          userEmail: row.user_email,
          action: row.action,
          detail: row.detail,
          createdAt: row.created_at,
        }));
      });

      const nextBefore = entries.length === limit ? entries[entries.length - 1].id : null;
      return { entries, nextBefore };
    }
  );
}
