/**
 * Dev-mode token verifier — LOCAL DEVELOPMENT ONLY.
 *
 * Accepts tokens of the form "dev:<uid>:<hmac>" so the full stack (shell
 * login → module hydration → LLM calls → RLS) runs end-to-end on a laptop
 * with zero GCP dependencies. Enabled ONLY when DEV_AUTH=1 AND
 * NODE_ENV !== 'production'; index.ts refuses to construct it otherwise,
 * and the /api/config route tells the frontend which mode is live.
 *
 * V225-audit M2 fix: the token used to be the bare, unsigned "dev:<uid>" —
 * gated ONLY by the DEV_AUTH env flag. That's an env-var typo/leftover away
 * from full account takeover: anyone who could reach a deployment with
 * DEV_AUTH=1 set (a staging environment, a misconfigured Cloud Run revision)
 * could authenticate as ANY uid — including an existing owner's — by just
 * sending "Authorization: Bearer dev:<their-uid>", no secret required. The
 * token is now HMAC-signed with a server-only secret (DEV_AUTH_SECRET,
 * required whenever DEV_AUTH=1 — see index.ts) that never reaches the
 * browser: the frontend asks the server to mint a signed token for a chosen
 * uid (POST /api/dev/mint-token, routes/devAuth.ts, itself only mounted
 * when DEV_AUTH=1) instead of constructing one client-side. An attacker
 * without DEV_AUTH_SECRET can still call that mint endpoint if DEV_AUTH
 * leaks into a reachable deployment — this fix's job is narrower: stop bare
 * env-flag exposure from being silently forgeable long after the fact via a
 * cached/logged/screenshotted token, since every minted token is tied to a
 * specific secret that rotates independently of the flag.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { TokenVerifier, VerifiedIdentity } from "./verify.js";

export class DevVerifier implements TokenVerifier {
  private readonly secret: string;

  constructor(secret: string) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DevVerifier must never be constructed in production");
    }
    if (!secret) {
      throw new Error(
        "DevVerifier requires a non-empty DEV_AUTH_SECRET. Dev auth's only " +
          "protection is this signature — an empty secret would make every " +
          "dev: token forgeable by anyone with network access."
      );
    }
    this.secret = secret;
  }

  private sig(uid: string): string {
    return createHmac("sha256", this.secret).update(uid).digest("hex");
  }

  /** Mint a signed dev token for `uid` — used only by the dev mint-token route. */
  sign(uid: string): string {
    return `dev:${uid}:${this.sig(uid)}`;
  }

  async verify(idToken: string): Promise<VerifiedIdentity> {
    if (!idToken.startsWith("dev:")) {
      throw new Error("not a dev token");
    }
    const rest = idToken.slice(4);
    const sepIdx = rest.lastIndexOf(":");
    if (sepIdx < 1) throw new Error("dev token missing signature");
    const uid = rest.slice(0, sepIdx);
    const providedSig = rest.slice(sepIdx + 1);
    if (!uid || uid.length > 128) throw new Error("bad dev uid");

    const expected = Buffer.from(this.sig(uid), "hex");
    const provided = Buffer.from(providedSig, "hex");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new Error("invalid dev token signature");
    }
    return { uid, email: `${uid}@dev.local`, idpTenantId: undefined };
  }
}
