/**
 * Engagements CRUD — the first tenant-scoped resource, and the vehicle for
 * proving RLS isolation end-to-end in Phase 0 acceptance tests.
 *
 * Isolation is enforced by withTenant() + RLS policies (SET LOCAL app.tenant_id
 * + FORCE ROW LEVEL SECURITY) — that remains the primary mechanism every
 * module follows. V225-audit H2 fix: every query here also carries its own
 * explicit tenant_id predicate as belt-and-braces defense-in-depth, so a
 * misconfigured connection (see db/pool.ts's assertRlsEnforceable(), which
 * now catches this at boot) doesn't silently turn into cross-tenant reads —
 * these WHERE clauses hold even if RLS itself were somehow inert.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { allowedClientNorms, clientAllowed, normClient } from "../auth/clients.js";

/**
 * ENG-XXXX-XXXX, from an alphabet with no I/O/0/1 so a code read aloud off a
 * screen or copied out of a deck cannot be mistyped. Same shape the UI has
 * always shown; the difference is that the server now owns it.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function mintEngagementCode(): string {
  const seg = () => Array.from({ length: 4 }, () =>
    CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  return `ENG-${seg()}-${seg()}`;
}

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
        `SELECT id, code, client_name, industry, status, created_at, updated_at
           FROM engagements
          WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          ORDER BY created_at DESC`
      );
      const rows = allowed === null
        ? res.rows
        : res.rows.filter((r) => clientAllowed(allowed, r.client_name));
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
      const existing = await c.query<{ id: string; code: string; client_name: string }>(
        `SELECT id, code, client_name FROM engagements
          WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`
      );
      const match = existing.rows.find((r) => normClient(r.client_name) === norm);
      if (match) {
        const res = await c.query(
          `UPDATE engagements
              SET industry = COALESCE($2, industry), updated_at = now()
            WHERE id = $1
              AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
            RETURNING id, code, client_name, industry, status, created_at`,
          [match.id, parsed.data.industry ?? null]
        );
        return { row: res.rows[0], created: false };
      }
      /*
       * v5.32.96 — the CODE is minted HERE, by the server, at the moment the
       * client comes into existence.
       *
       * It used to be minted by the browser (pre_engagement.html's
       * generateEngagementCode(), Math.random) and only when the first
       * interview completed, or when a synthetic set was generated. So a client
       * with a briefing and no interviews had NO code, which is why every
       * per-client key fell back to being suffixed with the client's
       * normalized NAME — and why renaming a client was a bulk key migration
       * instead of a field update. Close that window and the name stops having
       * to be an identity at all.
       *
       * Minting server-side also means the code is not a value the browser
       * asserts. Uniqueness is enforced by idx_engagements_tenant_code
       * (migration 025); the retry loop exists so a collision is a retry rather
       * than a 500 on client creation.
       */
      for (let attempt = 0; attempt < 25; attempt++) {
        const candidate = mintEngagementCode();
        const clash = await c.query(
          `SELECT 1 FROM engagements
            WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND code = $1`,
          [candidate]
        );
        if (clash.rowCount) continue;
        const res = await c.query(
          `INSERT INTO engagements (tenant_id, code, client_name, industry, created_by)
           VALUES (current_setting('app.tenant_id', true)::uuid, $1, $2, $3, $4)
           RETURNING id, code, client_name, industry, status, created_at`,
          [candidate, parsed.data.clientName, parsed.data.industry ?? null, ctx.userId]
        );
        return { row: res.rows[0], created: true };
      }
      throw new Error("could not mint a unique engagement code");
    });
    reply.code(created ? 201 : 200).send(row);
  });

  app.get("/api/engagements/:id", async (req, reply) => {
    const ctx = req.ctx!;
    const { id } = req.params as { id: string };
    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    const row = await withTenant(ctx.tenantId, async (c) => {
      const res = await c.query<{ client_name: string }>(
        `SELECT id, code, client_name, industry, status, created_at, updated_at
           FROM engagements
          WHERE id = $1
            AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
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
