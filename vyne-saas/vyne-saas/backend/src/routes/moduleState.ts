/**
 * Module-state API — the server side of the vyneStore shim that replaces
 * localStorage in legacy modules.
 *
 * GET    /api/module-state/:module          → full state map for hydration
 * PUT    /api/module-state/:module          → bulk upsert {sets:{k:v}, deletes:[k]}
 *
 * Values are the module's raw strings, wrapped as {"v": "..."} jsonb.
 * Tenant scoping comes from withTenant() + RLS — never from the client.
 *
 * CLIENT scoping (Phase 5): within a firm, consultants only receive state
 * for clients assigned to them (owners are unrestricted):
 *   - shared namespaces ('workspace', legacy) are key-filtered on read and
 *     write via auth/clients.ts — shared index keys are merged server-side
 *     so a filtered browser copy can never clobber other clients' entries;
 *   - private interview namespaces (iv_*) require the owning interview's
 *     client to be assigned.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { allowedClientNorms, clientAllowed, filterWorkspaceState, scopeWorkspaceWrite } from "../auth/clients.js";
import type { PoolClient } from "pg";

const MODULE_RE = /^[a-z0-9_-]{1,64}$/;

const PutBody = z.object({
  sets: z.record(z.string().max(2_000_000)).default({}),
  deletes: z.array(z.string().max(512)).default([]),
});

async function readState(c: PoolClient, module: string): Promise<Record<string, string>> {
  const res = await c.query<{ key: string; value: { v: string } }>(
    `SELECT key, value FROM module_state WHERE module = $1`, [module]);
  const out: Record<string, string> = {};
  for (const row of res.rows) out[row.key] = row.value.v;
  return out;
}

/** For iv_* namespaces: may this caller touch the owning interview's client? */
async function ivModuleAllowed(
  c: PoolClient, module: string, allowed: Set<string> | null
): Promise<boolean> {
  if (allowed === null) return true;
  const r = await c.query<{ client_name: string }>(
    `SELECT client_name FROM interviews WHERE state_module = $1 LIMIT 1`, [module]);
  if (!r.rows[0]) return false; // orphan namespace: deny for restricted users
  return clientAllowed(allowed, r.rows[0].client_name);
}

export async function moduleStateRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/module-state/:module", async (req, reply) => {
    const ctx = req.ctx!;
    const { module } = req.params as { module: string };
    if (!MODULE_RE.test(module)) {
      reply.code(400).send({ error: "bad_module" });
      return;
    }
    // Interviewees never read the shared workspace (it holds the candid
    // briefing). They use /api/interviews/mine/* exclusively.
    if (ctx.role === "interviewee") {
      reply.code(403).send({ error: "forbidden_for_role" });
      return;
    }
    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    const state = await withTenant(ctx.tenantId, async (c) => {
      if (module.startsWith("iv_")) {
        if (!(await ivModuleAllowed(c, module, allowed))) return null;
        return readState(c, module);
      }
      return filterWorkspaceState(await readState(c, module), allowed);
    });
    if (state === null) { reply.code(404).send({ error: "not_found" }); return; }
    return { module, state };
  });

  app.put("/api/module-state/:module", async (req, reply) => {
    const ctx = req.ctx!;
    const { module } = req.params as { module: string };
    if (!MODULE_RE.test(module)) {
      reply.code(400).send({ error: "bad_module" });
      return;
    }
    if (ctx.role === "interviewee") {
      reply.code(403).send({ error: "forbidden_for_role" });
      return;
    }
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_input" });
      return;
    }
    const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
    const result = await withTenant(ctx.tenantId, async (c) => {
      let { sets, deletes } = parsed.data;
      if (module.startsWith("iv_")) {
        if (!(await ivModuleAllowed(c, module, allowed))) return null;
      } else if (allowed !== null) {
        const current = await readState(c, module);
        ({ sets, deletes } = scopeWorkspaceWrite(sets, deletes, current, allowed));
      }
      for (const [key, v] of Object.entries(sets)) {
        await c.query(
          `INSERT INTO module_state (tenant_id, module, key, value, updated_by)
           VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4)
           ON CONFLICT (tenant_id, module, key)
           DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by,
                         updated_at = now()`,
          [module, key, JSON.stringify({ v }), ctx.userId]
        );
      }
      if (deletes.length) {
        await c.query(`DELETE FROM module_state WHERE module = $1 AND key = ANY($2::text[])`, [
          module,
          deletes,
        ]);
      }
      return { set: Object.keys(sets).length, deleted: deletes.length };
    });
    if (result === null) { reply.code(403).send({ error: "client_not_assigned" }); return; }
    return { ok: true, ...result };
  });
}
