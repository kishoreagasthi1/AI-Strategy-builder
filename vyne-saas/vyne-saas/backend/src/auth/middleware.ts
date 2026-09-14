/**
 * Auth middleware: Bearer token → verified identity → membership lookup →
 * request context { userId, tenantId, role }.
 *
 * Every protected route gets its tenant scope from HERE, never from client
 * input. The tenant comes from the verified token + memberships table, so a
 * caller cannot ask for another tenant's data even with a crafted request —
 * and RLS backstops it at the database anyway.
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import type { TokenVerifier } from "./verify.js";
import { AuthPolicyError } from "./verify.js";
import { withoutTenant } from "../db/pool.js";

export interface RequestContext {
  userId: string;
  tenantId: string;
  role: "owner" | "consultant" | "interviewee";
  email: string | undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    ctx?: RequestContext;
  }
}

export function makeAuthHook(verifier: TokenVerifier) {
  return async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      reply.code(401).send({ error: "missing_token" });
      return;
    }
    let identity;
    try {
      identity = await verifier.verify(header.slice("Bearer ".length));
    } catch (e) {
      if (e instanceof AuthPolicyError) {
        // Valid identity, unmet security policy — the frontend routes the
        // user to MFA enrollment / email verification instead of "bad login".
        reply.code(403).send({ error: e.code });
        return;
      }
      reply.code(401).send({ error: "invalid_token" });
      return;
    }

    // Resolve our user + membership (system path, no tenant context yet).
    const row = await withoutTenant(async (c) => {
      const res = await c.query<{
        user_id: string;
        tenant_id: string;
        role: string;
        email: string;
      }>(
        `SELECT u.id AS user_id, m.tenant_id, m.role, u.email
           FROM users u
           JOIN memberships m ON m.user_id = u.id
           JOIN tenants t ON t.id = m.tenant_id
          WHERE u.identity_platform_uid = $1
            AND t.status = 'active'
            AND ($2::text IS NULL OR t.idp_tenant_id = $2)
          ORDER BY m.created_at DESC
          LIMIT 1`,
        [identity.uid, identity.idpTenantId ?? null]
      );
      return res.rows[0];
    });

    if (!row) {
      reply.code(403).send({ error: "no_membership" });
      return;
    }

    req.ctx = {
      userId: row.user_id,
      tenantId: row.tenant_id,
      role: row.role as RequestContext["role"],
      email: identity.email,
    };
  };
}

/** Route guard: require one of the given roles (after authHook has run). */
export function requireRole(...roles: RequestContext["role"][]) {
  return async function roleHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.ctx || !roles.includes(req.ctx.role)) {
      reply.code(403).send({ error: "forbidden" });
    }
  };
}
