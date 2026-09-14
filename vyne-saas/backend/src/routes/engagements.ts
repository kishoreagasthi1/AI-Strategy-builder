/**
 * Engagements CRUD — the first tenant-scoped resource, and the vehicle for
 * proving RLS isolation end-to-end in Phase 0 acceptance tests.
 * Note: handlers never filter by tenant_id themselves — withTenant() +
 * RLS policies do it. That's the pattern every module will follow.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { allowedClientNorms, clientAllowed, normClient } from "../auth/clients.js";

const CreateBody = z.object({
  clientName: z.string().min(1).max(200),
  industry: z.string().max(100).optional(),
});

export async function engagementRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/engagements", async (req) => {
    const ctx = req.ctx!;
    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    return withTenant(ctx.tenantId, async (c) => {
      const res = await c.query<{ client_name: string }>(
        `SELECT id, client_name, industry, status, created_at, updated_at
           FROM engagements ORDER BY created_at DESC`
      );
      const rows = allowed === null
        ? res.rows
        : res.rows.filter((r) => allowed.has(normClient(r.client_name)));
      return { engagements: rows };
    });
  });

  app.post("/api/engagements", async (req, reply) => {
    const ctx = req.ctx!;
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_input", detail: parsed.error.flatten() });
      return;
    }
    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    if (!clientAllowed(allowed, parsed.data.clientName)) {
      reply.code(403).send({ error: "client_not_assigned" });
      return;
    }
    // Idempotent per client (case/punctuation-insensitive): the briefing flow
    // registers the client on every generate — re-registering must update the
    // industry, not stack duplicate rows.
    const norm = normClient(parsed.data.clientName);
    const { row, created } = await withTenant(ctx.tenantId, async (c) => {
      const existing = await c.query<{ id: string; client_name: string }>(
        `SELECT id, client_name FROM engagements`
      );
      const match = existing.rows.find((r) => normClient(r.client_name) === norm);
      if (match) {
        const res = await c.query(
          `UPDATE engagements
              SET industry = COALESCE($2, industry), updated_at = now()
            WHERE id = $1
            RETURNING id, client_name, industry, status, created_at`,
          [match.id, parsed.data.industry ?? null]
        );
        return { row: res.rows[0], created: false };
      }
      const res = await c.query(
        `INSERT INTO engagements (tenant_id, client_name, industry, created_by)
         VALUES (current_setting('app.tenant_id', true)::uuid, $1, $2, $3)
         RETURNING id, client_name, industry, status, created_at`,
        [parsed.data.clientName, parsed.data.industry ?? null, ctx.userId]
      );
      return { row: res.rows[0], created: true };
    });
    reply.code(created ? 201 : 200).send(row);
  });

  app.get("/api/engagements/:id", async (req, reply) => {
    const ctx = req.ctx!;
    const { id } = req.params as { id: string };
    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    const row = await withTenant(ctx.tenantId, async (c) => {
      const res = await c.query<{ client_name: string }>(
        `SELECT id, client_name, industry, status, created_at, updated_at
           FROM engagements WHERE id = $1`,
        [id]
      );
      if (res.rows[0] && !clientAllowed(allowed, res.rows[0].client_name)) return undefined;
      return res.rows[0];
    });
    if (!row) {
      // Another tenant's engagement id lands here too — RLS returns no row,
      // indistinguishable from "doesn't exist". Exactly what we want.
      reply.code(404).send({ error: "not_found" });
      return;
    }
    return row;
  });
}
