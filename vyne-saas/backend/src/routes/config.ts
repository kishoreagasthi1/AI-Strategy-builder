/**
 * Public frontend bootstrap config: which auth mode is live and (in Identity
 * Platform mode) the public Firebase web config. These are public
 * identifiers, not secrets — security lives in verified tokens + RLS.
 */
import type { FastifyInstance } from "fastify";

export interface FrontendConfig {
  devAuth: boolean;
  firebase: { apiKey: string; authDomain: string } | null;
  /** Server-enforced (REQUIRE_MFA=1); exposed so the login flow can walk the
   *  user straight into authenticator enrollment instead of failing later. */
  requireMfa?: boolean;
  /** Server-enforced (REQUIRE_VERIFIED_EMAIL=1). */
  requireVerifiedEmail?: boolean;
}

export async function configRoutes(app: FastifyInstance, cfg: FrontendConfig): Promise<void> {
  const out: FrontendConfig = {
    ...cfg,
    requireMfa: cfg.requireMfa ?? process.env.REQUIRE_MFA === "1",
    requireVerifiedEmail: cfg.requireVerifiedEmail ?? process.env.REQUIRE_VERIFIED_EMAIL === "1",
  };
  app.get("/api/config", async () => out);
}
