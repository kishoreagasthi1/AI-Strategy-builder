/**
 * Public firm signup (Option B: each customer firm becomes a tenant).
 * Unauthenticated by design — it CREATES the account. Basic input validation
 * via zod; abuse controls (captcha / invite codes / rate limits) are a
 * pre-launch hardening item tracked in the plan.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { provisionFirm } from "../tenant/provisioning.js";

const SignupBody = z.object({
  firmName: z.string().min(2).max(120),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(10).max(200),
  ownerName: z.string().max(120).optional(),
});

export async function signupRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/signup", async (req, reply) => {
    // Production lockdown (v5.21): when SIGNUP_ACCESS_KEY is set, firm
    // provisioning requires the matching x-signup-key header. Public
    // self-serve signup returns when a vetted onboarding flow exists
    // (captcha / payment / invite codes).
    const gate = process.env.SIGNUP_ACCESS_KEY;
    if (gate && req.headers["x-signup-key"] !== gate) {
      reply.code(403).send({ error: "signup_closed", detail: "Firm provisioning is invite-only." });
      return;
    }
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
