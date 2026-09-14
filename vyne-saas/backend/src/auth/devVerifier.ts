/**
 * Dev-mode token verifier — LOCAL DEVELOPMENT ONLY.
 *
 * Accepts tokens of the form "dev:<identity_platform_uid>" so the full stack
 * (shell login → module hydration → LLM calls → RLS) runs end-to-end on a
 * laptop with zero GCP dependencies. Enabled ONLY when DEV_AUTH=1 AND
 * NODE_ENV !== 'production'; index.ts refuses to construct it otherwise,
 * and the /api/config route tells the frontend which mode is live.
 */
import type { TokenVerifier, VerifiedIdentity } from "./verify.js";

export class DevVerifier implements TokenVerifier {
  constructor() {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DevVerifier must never be constructed in production");
    }
  }

  async verify(idToken: string): Promise<VerifiedIdentity> {
    if (!idToken.startsWith("dev:")) {
      throw new Error("not a dev token");
    }
    const uid = idToken.slice(4);
    if (!uid || uid.length > 128) throw new Error("bad dev uid");
    return { uid, email: `${uid}@dev.local`, idpTenantId: undefined };
  }
}
