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
import {
  allowedClientNorms, clientAllowed, filterWorkspaceState, scopeWorkspaceWrite,
  stampServerNames, enforceServerNames,
  migrateLegacyNormKeys,
} from "../auth/clients.js";
import type { PoolClient } from "pg";
import type { FastifyBaseLogger } from "fastify";

const MODULE_RE = /^[a-z0-9_-]{1,64}$/;

/*
 * v5.32.58. The key-count and key-length caps were added to
 * /api/interviews/mine/state (audit M-7) and never mirrored here — despite
 * server.ts naming /api/module-state as a cause of pool exhaustion.
 *
 * With a 32 MB body limit and no key cap, one request can carry thousands of
 * keys, and the handler loops a separate INSERT per key inside a single
 * transaction holding one of ten pool connections. Ten such requests stall
 * every database-backed route on the instance — including the auth membership
 * lookup, so the whole firm sees 500s.
 *
 * A workspace is a few dozen keys in practice. 400 is generous and still
 * bounds the loop.
 */
const PutBody = z
  .object({
    sets: z.record(z.string().max(2_000_000)).default({}),
    deletes: z.array(z.string().max(512)).max(400).default([]),
  })
  .extend({
    /**
     * Per-key optimistic-concurrency tokens (v5.32.58), {key: version}.
     *
     * Optional and per-key rather than per-request: a client sends versions for
     * the keys it READ, and a key it is creating for the first time has none.
     * A key with no expected version is written unconditionally, which is what
     * every pre-upgrade client does — so an open tab keeps working through the
     * deploy and gains the protection on its next reload.
     */
    expectedVersions: z.record(z.number().int().nonnegative()).optional(),
  })
  .refine((b) => Object.keys(b.sets).length <= 400, { message: "too_many_keys" })
  .refine((b) => Object.keys(b.sets).every((k) => k.length <= 512), { message: "key_too_long" });

/** Versions of the keys just read, so the caller can write conditionally. */
const lastReadVersions = new WeakMap<PoolClient, Record<string, number>>();

async function readState(c: PoolClient, module: string): Promise<Record<string, string>> {
  const res = await c.query<{ key: string; value: { v: string }; version: string }>(
    `SELECT key, value, version FROM module_state WHERE module = $1`, [module]);
  const out: Record<string, string> = {};
  const vers: Record<string, number> = {};
  for (const row of res.rows) vers[row.key] = Number(row.version);
  lastReadVersions.set(c, vers);
  for (const row of res.rows) out[row.key] = row.value.v;
  return out;
}

/**
 * Lazily migrate a shared namespace off the old 30-character client norm onto
 * the 100-character one, in place. Applied in the app rather than as a SQL
 * migration because recovering the full client name behind a truncated norm
 * means reading the JSON VALUES, not just the key text.
 *
 * v5.32.29 SECURITY (audit H-2). As shipped in v5.32.26 this ran on EVERY
 * non-interviewee GET, over the unfiltered state, with the rename table
 * derived from values a restricted consultant can write — and it issued
 * `UPDATE client_assignments` for users the caller cannot see, from inside a
 * read handler. Verified: one authorised PUT plus one GET moved another
 * client's briefing and design portfolio onto a norm of the attacker's
 * choosing and dragged that client's consultants' assignments with it.
 *
 * Three changes, all of them narrowing:
 *   · OWNERS ONLY. A restricted consultant can no longer trigger it at all.
 *   · Renames may only target a client name the SERVER already knows for this
 *     tenant (client_assignments + engagements) — see migrateLegacyNormKeys.
 *   · No `client_assignments` write. Migration 011 owns those columns, and
 *     allowedClientNorms() covers the gap until it runs.
 *
 * Still idempotent: once no legacy-shaped key is left, it writes nothing.
 */
/**
 * code → client_name for this tenant, from the engagements TABLE.
 *
 * The one source of code ownership that a consultant cannot write. Everything
 * else the scoping layer consults (vynora_engagement_index, the
 * vynora_engagement_<CODE> records) lives in module_state, which is exactly the
 * store being authorised — hence the CR-1 guard in scopeWorkspaceWrite. With
 * migration 025 the code is a column, so ownership can simply be looked up.
 */
async function trustedCodeNames(c: PoolClient): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const r = await c.query<{ code: string; client_name: string }>(
      `SELECT code, client_name FROM engagements
        WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          AND code IS NOT NULL`
    );
    for (const row of r.rows) out.set(row.code.toUpperCase(), row.client_name);
  } catch {
    /* Migration 025 not applied yet: no `code` column. Fall back to the
     * pre-v5.32.96 behaviour (ownership from workspace JSON, guarded by CR-1)
     * rather than failing the request — this must not make the API unbootable
     * against an older database. */
  }
  return out;
}

async function migrateNorms(
  c: PoolClient, module: string, state: Record<string, string>,
  userId: string, log: FastifyBaseLogger
): Promise<{ state: Record<string, string>; applied: boolean }> {
  const kn = await c.query<{ client_name: string }>(
    `SELECT client_name FROM client_assignments
      UNION SELECT client_name FROM engagements`
  );
  const plan = migrateLegacyNormKeys(state, kn.rows.map((r) => r.client_name));
  if (plan.ambiguous.length) {
    log.warn({ module, ambiguous: plan.ambiguous },
      "client-norm widening: legacy norm maps to multiple client names — left as-is");
  }
  if (!plan.pairs.length) return { state, applied: false };

  const next = { ...state };
  for (const [key, v] of Object.entries(plan.sets)) {
    await c.query(
      `INSERT INTO module_state (tenant_id, module, key, value, updated_by)
       VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4)
       ON CONFLICT (tenant_id, module, key)
       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [module, key, JSON.stringify({ v }), userId]
    );
    next[key] = v;
  }
  if (plan.deletes.length) {
    await c.query(`DELETE FROM module_state WHERE module = $1 AND key = ANY($2::text[])`,
      [module, plan.deletes]);
    for (const key of plan.deletes) delete next[key];
  }
  log.info({ module, renamed: plan.deletes.length, clients: plan.pairs.map((p) => p.to) },
    "client-norm widening applied");
  return { state: next, applied: true };
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
    const out = await withTenant(ctx.tenantId, async (c) => {
      if (module.startsWith("iv_")) {
        if (!(await ivModuleAllowed(c, module, allowed))) return null;
        const st = await readState(c, module);
        return { state: st, versions: lastReadVersions.get(c) ?? {} };
      }
      // Owners only (audit H-2). allowed === null IS the owner check.
      const raw = allowed === null
        ? (await migrateNorms(c, module, await readState(c, module), ctx.userId, req.log)).state
        : await readState(c, module);
      const versions = lastReadVersions.get(c) ?? {};
      // v5.32.96: code → client_name straight from `engagements`, so a code's
      // owner is settled by a table the caller cannot write. See
      // buildWorkspaceMaps(). Owners short-circuit before this, so the extra
      // query only runs for restricted consultants.
      const trustedCodes = await trustedCodeNames(c);
      /*
       * v5.32.96 — serve the CURRENT name, whatever the stored copy says.
       *
       * vynora_engagement_<CODE>.client is a duplicate of
       * engagements.client_name, and a duplicate is a thing that can be stale.
       * Stamping it on the way out means a page cannot render a name the firm
       * has already changed, no matter what is sitting in module_state — and
       * no matter which tab last wrote it.
       */
      const state = stampServerNames(filterWorkspaceState(raw, allowed, trustedCodes), trustedCodes);
      // Only hand back versions for keys the caller can actually see, so the
      // response never hints at the existence of another client's keys.
      const visible: Record<string, number> = {};
      for (const k of Object.keys(state)) if (k in versions) visible[k] = versions[k];
      return { state, versions: visible };
    });
    if (out === null) { reply.code(404).send({ error: "not_found" }); return; }
    /* v5.32.58: `versions` is what makes a conditional write possible. Older
     * clients ignore the extra field; newer ones echo it back as
     * expectedVersions and are protected from silently overwriting a
     * colleague. */
    return { module, state: out.state, versions: out.versions };
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
      } else {
        /*
         * v5.32.96 — the client's NAME is not the browser's to write.
         *
         * This runs for EVERY role, before and independently of scoping.
         * That placement is the fix: every other guard in this file lives
         * inside scopeWorkspaceWrite(), which short-circuits on
         * `allowed === null` — so a firm OWNER's writes have never passed
         * through any of them. The reverting rename was an owner's own tab
         * pushing a pre-rename copy of vynora_engagement_<CODE> back, and
         * nothing in the request path was looking.
         *
         * Making the write carry expectedVersions (v5.32.95) was not enough on
         * its own either: onVersionConflict() answers a 409 by adopting the
         * server's version and retrying OUR value on top, so a refusal only delays
         * the revert by one round trip. Ignoring the name outright is the only
         * version of this that cannot be raced.
         */
        const trustedCodes = await trustedCodeNames(c);
        const enforced = enforceServerNames(sets, trustedCodes);
        sets = enforced.sets;
        if (enforced.corrected.length) {
          req.log.info({ keys: enforced.corrected, module },
            "workspace write carried a stale client name; server copy applied");
        }
        if (allowed !== null) {
          const current = await readState(c, module);
          ({ sets, deletes } = scopeWorkspaceWrite(sets, deletes, current, allowed, trustedCodes));
        }
      }
      /*
       * v5.32.58 — conditional write. See migration 018 for why this matters:
       * without it, two consultants with the same page open silently destroy
       * each other's work and both see a green "Saved".
       *
       * The DO UPDATE now carries a WHERE, so a stale write updates zero rows
       * instead of clobbering. Losers are collected and returned with the
       * CURRENT value, which is what lets the client re-apply its edit on top
       * of what it missed rather than asking a person to remember what they
       * had typed.
       */
      const expected = parsed.data.expectedVersions ?? {};
      const conflicts: Array<{ key: string; version: number; value: string }> = [];
      const versions: Record<string, number> = {};
      for (const [key, v] of Object.entries(sets)) {
        const hasExpectation = Object.prototype.hasOwnProperty.call(expected, key);
        const r = await c.query<{ version: string }>(
          `INSERT INTO module_state (tenant_id, module, key, value, updated_by, version)
           VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, 1)
           ON CONFLICT (tenant_id, module, key)
           DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by,
                         updated_at = now(), version = module_state.version + 1
             WHERE $5::bigint IS NULL OR module_state.version = $5::bigint
           RETURNING version`,
          [module, key, JSON.stringify({ v }), ctx.userId,
           hasExpectation ? expected[key] : null]
        );
        if (r.rows[0]) {
          versions[key] = Number(r.rows[0].version);
        } else {
          // Zero rows updated means the version moved under us. Hand back what
          // is actually stored so the caller can merge rather than guess.
          const cur = await c.query<{ version: string; value: { v: string } }>(
            `SELECT version, value FROM module_state WHERE module = $1 AND key = $2`,
            [module, key]
          );
          conflicts.push({
            key,
            version: Number(cur.rows[0]?.version ?? 0),
            value: cur.rows[0]?.value?.v ?? "",
          });
        }
      }
      if (deletes.length) {
        await c.query(`DELETE FROM module_state WHERE module = $1 AND key = ANY($2::text[])`, [
          module,
          deletes,
        ]);
      }
      return { set: Object.keys(sets).length - conflicts.length, deleted: deletes.length,
               versions, conflicts };
    });
    if (result === null) { reply.code(403).send({ error: "client_not_assigned" }); return; }
    if (result.conflicts.length) {
      /*
       * 409 with the CURRENT value, not a bare rejection. The client needs
       * what it missed in order to re-apply its own edit on top; telling it
       * only "you lost" would leave a consultant retyping from memory.
       *
       * Keys that did NOT conflict were still written — a partial success is
       * reported honestly rather than rolled back, because rolling back would
       * discard good work to punish a collision on an unrelated key.
       */
      reply.code(409).send({
        error: "version_conflict",
        conflicts: result.conflicts,
        versions: result.versions,
        set: result.set,
        deleted: result.deleted,
      });
      return;
    }
    return { ok: true, ...result };
  });
}
