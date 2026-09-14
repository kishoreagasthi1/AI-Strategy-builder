# VYNE Platform — Security Model

_Last updated: v5.3_

## Identity & login

| Control | Where it lives | Status |
|---|---|---|
| Password login | Google Cloud Identity Platform (per-firm tenant pools). Passwords are stored and verified by Google, never by VYNE. | Built — active whenever the API runs with Firebase config (production mode) |
| Dev bypass (`DEV_AUTH=1`) | Local development only; the code refuses to enable it when `NODE_ENV=production`. | Built, hard-gated |
| MFA (authenticator app / TOTP) | Enrollment + challenge UI in the login flow; QR + manual key; codes verified by Identity Platform. | Built (v5.3) — enable TOTP in the GCP console at deploy time |
| MFA enforcement | `REQUIRE_MFA=1` → the API rejects any token whose sign-in lacked a second factor, on **every request**. New users are walked into enrollment automatically. | Built (v5.3) |
| Email verification | `REQUIRE_VERIFIED_EMAIL=1` → API rejects unverified accounts; login flow sends the verification email. | Built (v5.3) |
| Password reset | "Forgot password?" → Identity Platform reset email. | Built (v5.3) |
| Brute-force throttling, password policy | Identity Platform built-ins. | Free at deploy time |
| Session expiry | 12 h absolute cap + 30 min idle timeout in the browser; server tokens (~1 h) expire independently; any 401 cleanly returns to login. | Built (v5.3) |

## Authorization (every rule enforced server-side)

- **Firm isolation** — every table carries `tenant_id` with Postgres FORCE
  Row-Level Security; the app connects as a non-owner role, so even a bug in
  route code cannot cross firms. The tenant comes from the verified token,
  never from client input.
- **Roles** — owner / consultant / interviewee, resolved from the memberships
  table per request.
- **Client separation within a firm** — consultants are deny-by-default and
  see only clients assigned by an owner (`client_assignments`): tracker,
  interviews, briefings, engagements, synthesis and roadmap workspace keys
  are all filtered; hostile writes are dropped; shared indexes are merged
  server-side.
- **Interviewees** — exactly their own interview: private state namespace,
  403 on the shared workspace, and a bootstrap limited to their own client's
  **sanitized** briefing (political-sensitivity flags, field observations,
  and PE context stripped).

## AI & data handling

- No provider API keys in the browser — all LLM/TTS/STT calls run
  server-side through the gateway and are metered per firm.
- Production blocks free-tier endpoints (`blockFreeTier`) so client data
  never reaches train-eligible APIs.

## Remaining for the GCP deployment step

1. Enable Identity Platform + TOTP MFA in the console; set
   `REQUIRE_MFA=1`, `REQUIRE_VERIFIED_EMAIL=1` on the service.
2. HTTPS (automatic on Cloud Run) + secrets in Secret Manager.
3. Cloud Audit Logs / structured request logging.
4. Token refresh UX (today an expired 1 h token returns you to login;
   silent refresh is a polish item).
