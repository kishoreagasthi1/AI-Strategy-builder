/**
 * Auth hardening policy checks (pure unit tests — always run).
 *
 * REQUIRE_MFA / REQUIRE_VERIFIED_EMAIL are enforced in the token verifier —
 * on EVERY request, not just at login — so a token minted without a second
 * factor can never reach client data when the policy is on.
 */
import { describe, it, expect } from "vitest";
import { checkSecurityClaims, AuthPolicyError, policyFromEnv } from "../src/auth/verify.js";

const OFF = { requireMfa: false, requireVerifiedEmail: false };
const MFA = { requireMfa: true, requireVerifiedEmail: false };
const VERIFIED = { requireMfa: false, requireVerifiedEmail: true };
const BOTH = { requireMfa: true, requireVerifiedEmail: true };

describe("auth security policy", () => {
  it("policy off: any valid token passes", () => {
    expect(() => checkSecurityClaims({}, OFF)).not.toThrow();
    expect(() => checkSecurityClaims({ email_verified: false }, OFF)).not.toThrow();
  });

  it("REQUIRE_MFA rejects tokens signed in without a second factor", () => {
    expect(() => checkSecurityClaims({ email_verified: true }, MFA))
      .toThrowError(AuthPolicyError);
    try { checkSecurityClaims({}, MFA); } catch (e) {
      expect((e as AuthPolicyError).code).toBe("mfa_required");
    }
  });

  it("REQUIRE_MFA passes tokens that used a second factor", () => {
    expect(() => checkSecurityClaims(
      { email_verified: true, firebase: { sign_in_second_factor: "totp" } }, MFA)).not.toThrow();
    expect(() => checkSecurityClaims(
      { firebase: { sign_in_second_factor: "phone" } }, MFA)).not.toThrow();
  });

  it("REQUIRE_VERIFIED_EMAIL rejects unverified addresses", () => {
    try { checkSecurityClaims({ email_verified: false }, VERIFIED); throw new Error("should have thrown"); }
    catch (e) { expect((e as AuthPolicyError).code).toBe("email_unverified"); }
    expect(() => checkSecurityClaims({ email_verified: true }, VERIFIED)).not.toThrow();
  });

  it("both flags: verified email is checked first, then MFA", () => {
    try { checkSecurityClaims({ email_verified: false }, BOTH); throw new Error("should have thrown"); }
    catch (e) { expect((e as AuthPolicyError).code).toBe("email_unverified"); }
    try { checkSecurityClaims({ email_verified: true }, BOTH); throw new Error("should have thrown"); }
    catch (e) { expect((e as AuthPolicyError).code).toBe("mfa_required"); }
    expect(() => checkSecurityClaims(
      { email_verified: true, firebase: { sign_in_second_factor: "totp" } }, BOTH)).not.toThrow();
  });

  it("policyFromEnv reads the flags", () => {
    const prevM = process.env.REQUIRE_MFA, prevV = process.env.REQUIRE_VERIFIED_EMAIL;
    process.env.REQUIRE_MFA = "1"; delete process.env.REQUIRE_VERIFIED_EMAIL;
    expect(policyFromEnv()).toEqual({ requireMfa: true, requireVerifiedEmail: false });
    process.env.REQUIRE_MFA = prevM ?? ""; process.env.REQUIRE_VERIFIED_EMAIL = prevV ?? "";
    if (!prevM) delete process.env.REQUIRE_MFA;
    if (!prevV) delete process.env.REQUIRE_VERIFIED_EMAIL;
  });
});
