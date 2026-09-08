/**
 * White-label firm resolution (v5.23) + operator console API (v5.24) +
 * email-based firm lookup (v5.32).
 *
 * GET /api/firm — PUBLIC. Resolves a login context so users never see the
 * raw Identity Platform tenant id:
 *   ?host=vyne.meridianadvisors.com   → the firm whose custom_domain matches
 *   ?firm=meridian-advisors           → by slug, or verbatim IdP tenant id
 * Returns only what the login screen needs: { name, slug, idpTenantId }.
 * These are not secrets — tenant ids are typed by users today — but the
 * endpoint intentionally exposes nothing else about the firm.
 *
 * GET /api/firm/by-email — PUBLIC, rate-limited (see server.ts). The other
 * three resolution paths above all require the visitor to already have
 * *something* — a custom domain, an invite link's ?firm=, or a browser
 * that's logged in before. A brand-new user on the shared platform domain,
 * on a fresh browser, had none of those — the ONLY way in was to already
 * know their raw internal tenant id, which nobody should ever have to type.
 * This closes that gap: given the email they're about to sign in with,
 * look up which active firm(s) that email already has a membership at, and
 * let the login screen resolve + hide the firm field exactly like the other
 * three paths do (frontend/index.html's email blur handler). Same
 * intentionally minimal response shape as GET /api/firm — no membership
 * details, no role, no user id, just enough to fill the field. An email
 * with zero or multiple matches returns an empty/multi list rather than an
 * error — the frontend falls back to manual entry either way, so this
 * endpoint never blocks sign-in, only skips it when it can.
 *
 * PATCH /api/firm — PLATFORM OPERATOR ONLY (x-signup-key, same gate as
 * /api/signup). Binds a slug and/or custom domain to a firm. This is the
 * API half of white-label onboarding; the DNS/Firebase half is documented
 * in WHITE_LABEL_RUNBOOK.md.
 *
 * GET /api/firms — PLATFORM OPERATOR ONLY. Lists every tenant so the
 * operator console (frontend/admin.html) can render a table instead of
 * requiring curl for every lookup.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { withoutTenant } from "../db/pool.js";
import { createHash, timingSafeEqual } from "node:crypto";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;

/**
 * V225-audit MEDIUM fix. frontend/index.html's own SHARED_HOSTS regex
 * already refuses to resolve a firm by hostname when the hostname is one
 * of the platform's own shared hosting domains — but that's a client-side
 * skip, not a server-side rule. Nothing used to stop custom_domain from
 * being SET to one of these values in the first place (an operator typo, a
 * copy-paste mistake, or a future caller of PATCH /api/firm that doesn't
 * know about the frontend's guard). If it were, GET /api/firm?host=...
 * would resolve the platform's own default URL to whichever tenant claimed
 * it — a routing collision that could effectively hijack the platform's
 * shared login page for one customer firm. Kept in sync with
 * frontend/index.html's SHARED_HOSTS by hand (same pattern, same list);
 * WHITE_LABEL_RUNBOOK.md documents the shared-host list as the source of
 * truth for both.
 */
const SHARED_HOSTS = /(\.web\.app|\.firebaseapp\.com|\.run\.app)$|^(localhost|127\.0\.0\.1|\[?::1\]?)$/;

interface FirmRow {
  name: string;
  slug: string | null;
  idp_tenant_id: string | null;
  custom_domain: string | null;
}

/**
 * Shared operator-key gate. Fails CLOSED: if SIGNUP_ACCESS_KEY isn't
 * configured at all, every gated endpoint denies rather than opening up —
 * an ops mistake (forgetting to set the env var) should never silently
 * disable auth. Exported (V225-audit HIGH fix) so every operator-only
 * endpoint in the app — including firm provisioning in routes/signup.ts,
 * which used to implement its own inline version of this check that failed
 * OPEN instead — shares one fail-closed implementation instead of each
 * route re-deriving it and risking divergence.
 */
export function requireOperator(req: FastifyRequest, reply: FastifyReply): boolean {
  const gate = process.env.SIGNUP_ACCESS_KEY;
  const presented = req.headers["x-signup-key"];
  // v5.32.29 (audit Low): `!==` on a secret returns as soon as it finds a
  // differing byte, so response time leaks how much of the key is correct. The
  // signal is small over the internet, but this key provisions firms — it is
  // the highest-value credential in the product — and a constant-time compare
  // costs nothing.
  if (!gate || typeof presented !== "string" || !timingSafeEqualStr(presented, gate)) {
    reply.code(403).send({ error: "forbidden", detail: "Platform operator key required." });
    return false;
  }
  return true;
}

/**
 * Does the presented header match the operator key? Exported (v5.32.59, L1)
 * because server.ts's rate-limit allowList was doing the same check with a
 * plain `===`, and that comparison runs on EVERY request to the operator
 * scope — including the ones requireOperator later rejects. Two gates on one
 * secret, one of them timing-unsafe, is the same leak with an extra step.
 */
export function operatorKeyMatches(presented: unknown): boolean {
  const gate = process.env.SIGNUP_ACCESS_KEY;
  if (!gate || typeof presented !== "string") return false;
  return timingSafeEqualStr(presented, gate);
}

/** Length-independent constant-time string comparison. */
function timingSafeEqualStr(a: string, b: string): boolean {
  // Hashing first makes the compared buffers equal-length, so the comparison
  // itself never short-circuits on a length mismatch either.
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export async function firmRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/firms", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const rows = await withoutTenant(async (c) => {
      const r = await c.query<FirmRow & { id: string; status: string; created_at: string }>(
        `SELECT id, name, slug, idp_tenant_id, custom_domain, status, created_at
           FROM tenants ORDER BY created_at DESC`
      );
      return r.rows;
    });
    return {
      firms: rows.map((r) => ({
        tenantId: r.id,
        name: r.name,
        slug: r.slug,
        idpTenantId: r.idp_tenant_id,
        customDomain: r.custom_domain,
        status: r.status,
        createdAt: r.created_at,
      })),
    };
  });

  app.get("/api/firm", async (req, reply) => {
    const q = req.query as { host?: string; firm?: string };
    const host = (q.host ?? "").trim().toLowerCase();
    const firm = (q.firm ?? "").trim();
    if (!host && !firm) {
      reply.code(400).send({ error: "missing_query", detail: "Pass ?host= or ?firm=." });
      return;
    }
    const row = await withoutTenant(async (c) => {
      if (host) {
        const r = await c.query<FirmRow>(
          `SELECT name, slug, idp_tenant_id, custom_domain FROM tenants
            WHERE custom_domain = $1 AND status = 'active'`, [host]);
        return r.rows[0] ?? null;
      }
      /* v5.32.64 (audit V2-H5). This was an OR across two independently-unique
       * columns with no ORDER BY and no LIMIT, then `rows[0]`.
       *
       * slug and idp_tenant_id are each unique on their own, so nothing stops
       * firm A's slug from equalling firm B's tenant id — and when it does, two
       * rows match and Postgres returns whichever it likes. Resolving "acme"
       * could hand back either firm, and this endpoint is what the login page
       * uses to decide which Identity Platform tenant to authenticate against.
       *
       * Both are operator-set, so this is reachable through operator error
       * rather than by an attacker choosing a colliding value — which is why it
       * is worth making deterministic rather than merely unlikely.
       *
       * The slug is the public, human-facing handle, so it wins; the raw tenant
       * id is the fallback path for firms that have no slug. Ordering by id
       * after that makes even a same-column duplicate resolve the same way on
       * every call instead of drifting with the plan. */
      const r = await c.query<FirmRow>(
        `SELECT name, slug, idp_tenant_id, custom_domain FROM tenants
          WHERE status = 'active' AND (slug = $1 OR idp_tenant_id = $2)
          -- v5.32.77 (external audit, proven in Postgres). Was
          -- ORDER BY (slug = $1) DESC, id. When a row's slug is NULL the
          -- comparison yields NULL, and Postgres sorts NULLs FIRST under DESC —
          -- so a NULL-slug firm matched by idp_tenant_id outranked the firm
          -- whose slug actually matched. Login resolved to the wrong firm
          -- whenever a slug collided with another firm's tenant id.
          -- Deterministic, and deterministically wrong.
          ORDER BY (slug = $1) DESC NULLS LAST, id
          LIMIT 1`,
        [firm.toLowerCase(), firm]);
      return r.rows[0] ?? null;
    });
    if (!row || !row.idp_tenant_id) {
      reply.code(404).send({ error: "firm_not_found" });
      return;
    }
    return { name: row.name, slug: row.slug, idpTenantId: row.idp_tenant_id };
  });

  const PatchBody = z.object({
    idpTenantId: z.string().min(1).max(200),
    slug: z.string().regex(SLUG_RE, "lowercase letters, digits, hyphens; 1-40 chars").optional(),
    customDomain: z.union([z.string().regex(HOST_RE, "must be a bare hostname like vyne.example.com"), z.null()]).optional(),
  });

  app.patch("/api/firm", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_input", detail: parsed.error.flatten() });
      return;
    }
    const { idpTenantId, slug, customDomain } = parsed.data;
    if (slug === undefined && customDomain === undefined) {
      reply.code(400).send({ error: "nothing_to_update", detail: "Pass slug and/or customDomain." });
      return;
    }
    if (customDomain && SHARED_HOSTS.test(customDomain.toLowerCase())) {
      reply.code(400).send({
        error: "shared_host_reserved",
        detail: "That hostname belongs to the platform's own shared hosting — it can't be bound to a firm as a custom domain.",
      });
      return;
    }
    try {
      const row = await withoutTenant(async (c) => {
        const r = await c.query<FirmRow & { id: string }>(
          `UPDATE tenants SET
             slug = COALESCE($2, slug),
             custom_domain = CASE WHEN $4 THEN $3 ELSE custom_domain END
           WHERE idp_tenant_id = $1
           RETURNING id, name, slug, idp_tenant_id, custom_domain`,
          [idpTenantId, slug ?? null, customDomain ?? null, customDomain !== undefined]
        );
        return r.rows[0] ?? null;
      });
      if (!row) { reply.code(404).send({ error: "firm_not_found" }); return; }
      return { ok: true, name: row.name, slug: row.slug, customDomain: row.custom_domain, idpTenantId: row.idp_tenant_id };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/tenants_slug_uq|tenants_custom_domain_uq|duplicate key/.test(msg)) {
        reply.code(409).send({ error: "already_taken", detail: "That slug or domain is bound to another firm." });
        return;
      }
      throw e;
    }
  });
}

const EmailQuery = z.object({ email: z.string().min(3).max(320) });

/**
 * Registered separately from firmRoutes() so server.ts can wrap ONLY this
 * endpoint in its own rate-limit scope — see this file's top doc comment.
 * Unlike GET /api/firm (by slug/host — both intentionally hard to guess,
 * you need a real invite link or custom domain to have one), an email
 * address is exactly the kind of value someone might probe to find out
 * "does this person have an account here." Rate limiting doesn't eliminate
 * that, but it makes bulk enumeration impractical, matching the same
 * reasoning already applied to auth/rate limiting elsewhere in this app.
 */
export async function firmEmailLookupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/firm/by-email", async (req, reply) => {
    const q = EmailQuery.safeParse(req.query);
    // Deliberately not a 400 on a malformed email — see doc comment above:
    // this endpoint never blocks sign-in, it only sometimes helps, so an
    // odd query just resolves to "no match" like any other non-match.
    if (!q.success) { return { firms: [] }; }
    const email = q.data.email.trim().toLowerCase();
    const rows = await withoutTenant(async (c) => {
      const r = await c.query<Pick<FirmRow, "name" | "slug" | "idp_tenant_id">>(
        `SELECT t.name, t.slug, t.idp_tenant_id
           FROM users u
           JOIN memberships m ON m.user_id = u.id
           JOIN tenants t ON t.id = m.tenant_id
          WHERE lower(u.email) = $1 AND t.status = 'active' AND t.idp_tenant_id IS NOT NULL
          ORDER BY t.name`,
        [email]
      );
      return r.rows;
    });
    return {
      firms: rows.map((r) => ({ name: r.name, slug: r.slug, idpTenantId: r.idp_tenant_id })),
    };
  });
}
