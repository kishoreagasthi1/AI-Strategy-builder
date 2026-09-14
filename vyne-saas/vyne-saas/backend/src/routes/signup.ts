/**
 * Firm provisioning (Option B: each customer firm becomes a tenant).
 *
 * NOT public self-serve — despite the historical "signup" naming, the
 * product decision (v5.24) is that provisioning happens ONLY through the
 * Vynora operator console (frontend/admin.html), gated by the same
 * SIGNUP_ACCESS_KEY every other operator endpoint requires. This route used
 * to fail OPEN (skip the check entirely) whenever SIGNUP_ACCESS_KEY wasn't
 * set — inconsistent with routes/firms.ts's requireOperator(), which fails
 * CLOSED, and a real risk: forgetting to set the env var in production
 * would have silently reopened unauthenticated tenant creation to the
 * internet. V225-audit HIGH fix: reuse requireOperator() so this endpoint
 * shares the same fail-closed gate as the rest of the operator surface.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { provisionFirm } from "../tenant/provisioning.js";
import { requireOperator } from "./firms.js";

const SignupBody = z.object({
  firmName: z.string().min(2).max(120),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(10).max(200),
  ownerName: z.string().max(120).optional(),
});

export async function signupRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/signup", async (req, reply) => {
    if (!requireOperator(req, reply)) return;
    const parsed = SignupBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_input", detail: parsed.error.flatten() });
      return;
    }
    try {
      const result = await provisionFirm(parsed.data);
      reply.code(201).send({
        tenantId: result.tenantId,
        idpTenantId: result.idpTenantId,
        slug: result.slug,
        loginPath: `/?firm=${result.slug}`,
        message: "Firm provisioned. Share the loginPath link — it selects the firm automatically.",
      });
    } catch (err) {
      req.log.error({ err }, "provisioning failed");
      reply.code(500).send({ error: "provisioning_failed" });
    }
  });
}
