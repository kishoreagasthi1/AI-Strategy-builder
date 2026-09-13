/**
 * Token verification, abstracted behind an interface so tests can inject a
 * fake and so the auth provider could in principle be swapped.
 *
 * Production implementation: Identity Platform (Firebase Admin SDK).
 * Identity Platform multi-tenancy puts the tenant in `firebase.tenant` inside
 * the ID token — we surface it as idpTenantId and map it to our tenants row.
 *
 * Hardening flags (production):
 *   REQUIRE_MFA=1             → reject tokens whose sign-in did not use a
 *                               second factor. The frontend catches the
 *                               `mfa_required` 403 and walks the user through
 *                               authenticator-app enrollment, then re-auth.
 *   REQUIRE_VERIFIED_EMAIL=1  → reject tokens for unverified email addresses
 *                               (frontend offers to resend the verification).
 * Both checks are enforced SERVER-SIDE on every request — hiding UI is never
 * the security boundary.
 */
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export interface VerifiedIdentity {
  /** Identity Platform user id (uid) */
  uid: string;
  email: string | undefined;
  /** Identity Platform tenant id from the token (firm's user pool), if any */
  idpTenantId: string | undefined;
}

export interface TokenVerifier {
  verify(idToken: string): Promise<VerifiedIdentity>;
}

/** Verification failure with a machine-readable code the middleware maps to
 *  a specific 403 (instead of a generic 401). */
export class AuthPolicyError extends Error {
  constructor(public code: "mfa_required" | "email_unverified") {
    super(code);
    this.name = "AuthPolicyError";
  }
}

/** The shape of the decoded-token fields the policy checks look at. */
export interface SecurityClaims {
  email_verified?: boolean;
  firebase?: { sign_in_second_factor?: string; second_factor_identifier?: string };
}

export interface SecurityPolicy {
  requireMfa: boolean;
  requireVerifiedEmail: boolean;
}

export function policyFromEnv(): SecurityPolicy {
  return {
    requireMfa: process.env.REQUIRE_MFA === "1",
    requireVerifiedEmail: process.env.REQUIRE_VERIFIED_EMAIL === "1",
  };
}

/** Pure, unit-testable policy check. Throws AuthPolicyError on violation. */
export function checkSecurityClaims(decoded: SecurityClaims, policy: SecurityPolicy): void {
  if (policy.requireVerifiedEmail && decoded.email_verified !== true) {
    throw new AuthPolicyError("email_unverified");
  }
  if (policy.requireMfa && !decoded.firebase?.sign_in_second_factor) {
    throw new AuthPolicyError("mfa_required");
  }
}

export class IdentityPlatformVerifier implements TokenVerifier {
  private policy: SecurityPolicy;

  constructor(policy?: SecurityPolicy) {
    this.policy = policy ?? policyFromEnv();
    if (getApps().length === 0) {
      // On Cloud Run this picks up the service account automatically (ADC).
      initializeApp({ credential: applicationDefault() });
    }
  }

  async verify(idToken: string): Promise<VerifiedIdentity> {
    const decoded = await getAuth().verifyIdToken(idToken);
    checkSecurityClaims(decoded as unknown as SecurityClaims, this.policy);
    return {
      uid: decoded.uid,
      email: decoded.email,
      idpTenantId: (decoded.firebase as { tenant?: string } | undefined)?.tenant,
    };
  }
}
