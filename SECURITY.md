# VYNE Platform — Security Model

_Last updated: v5.32.74_

Written to be handed to a third-party auditor or a prospective client's IT
reviewer. It states what is built, what is deliberately not built, and what is
known to be weak. Section 7 is the one to read first if you are auditing: it is
where I would look.

The previous version of this file was stamped v5.3 and was 44 releases behind.
It listed structured request logging as outstanding work long after it shipped
and described none of the fixes below. A stale security document is worse than
none, because it is read as a claim.

---

## 1. Tenancy — how firms are kept apart

Every table carries `tenant_id`, with Postgres row-level security in `ENABLE` +
`FORCE` mode and a `tenant_isolation` policy keyed on
`current_setting('app.tenant_id')`. The application connects as `vyne_app`, a
role with neither `SUPERUSER` nor `BYPASSRLS`, so a bug in route code cannot
cross a firm boundary — the database refuses, rather than the application
remembering to.

The tenant comes from the verified identity token on every request and is never
read from client input. `withTenant()` sets the GUC inside a transaction;
`withoutTenant()` is the explicit, greppable exception for the few genuinely
cross-tenant reads (firm lookup by email, Stripe webhooks).

**The boundary is the `vyne_app` password.** RLS keys off a session variable that
any direct database connection can set for itself, so anyone who can reach the
database with that password can read every firm. `assertRlsEnforceable()`
hard-fails the boot in production if the connection turns out to have
`BYPASSRLS`, so a misconfigured role cannot start quietly. Rotation is
`./deploy/deploy.sh rotate-db-password`; `deploy/preflight.sh` check 1 verifies
the migration default no longer works.

## 2. Identity and session

Password login, MFA (TOTP), email verification and password reset are all Google
Cloud Identity Platform, per-firm tenant pools. VYNE never stores or verifies a
password.

`REQUIRE_MFA=1` rejects any token whose sign-in lacked a second factor, on every
request. `REQUIRE_VERIFIED_EMAIL=1` rejects unverified accounts. `DEV_AUTH=1` is
refused outright when `NODE_ENV=production`.

Browser session: 12-hour absolute cap, 30-minute idle timeout. Server tokens
expire independently (~1h); any 401 returns cleanly to login.

**Known weakness — see section 7.** The bearer token lives in `sessionStorage`.

## 3. Authorization

Three roles resolved per request from the memberships table: `owner`,
`consultant`, `interviewee`.

**Client separation within a firm.** Consultants are deny-by-default and see only
clients assigned to them by an owner. Enforced in `auth/clients.ts`, which maps
every workspace key to a client identity; anything that cannot be positively
resolved to an allowed client is dropped, on read and on write. Shared index keys
get entry-wise merging server-side, so a filtered browser copy can never clobber
another client's entries.

That file has produced more findings than any other part of the system, and its
history deserves an auditor's attention:

- A prefix-matching tolerance treated any 30-character client norm as matching
  every longer norm it prefixed, so a consultant assigned to one client passed
  the gate for another. Replaced with exact set membership.
- An unrecognised key defaulted to `GLOBAL`, so any key family added later
  without updating that file was handed to every consultant regardless of
  assignment. It now denies.
- The engagement index authorised writes by asking "is this client mine?" and
  never "is this code mine?", while downstream the code was the authorisation
  token. A consultant could bind another client's engagement code to themselves
  and read that client's synthesis and verbatim transcripts.
- Three roadmap key families were parsed wrongly and resolved to the literal
  strings `eng` / `client` / `unassigned`, silently discarding restricted
  consultants' work on every reload while the UI reported "Saved".

**Interviewees** get exactly their own interview: a private state namespace, 403
on the shared workspace, and a bootstrap limited to a *sanitized* slice of their
own client's briefing — political-sensitivity flags, field observations and PE
context are stripped server-side. Follow-up round agendas are projected so an
interviewee cannot see what earlier rounds concluded about them.

## 4. Request handling

**Client address resolution.** `trustProxy` is a list of infrastructure address
classes (`loopback`, `linklocal`, `uniquelocal`), not a hop count. It was the
number `2` until v5.32.72, and that was exploitable: proxy-addr truncates
`X-Forwarded-For` at the first untrusted hop and returns the leftmost of what
remains, so a chain shorter than the count returns the caller's own forged entry.
Cloud Run appends the connecting peer, so `X-Forwarded-For: 6.6.6.6` produced
exactly two entries and `req.ip` came back `6.6.6.6`. Rotating the header gave a
fresh identity per request, defeating both IP-keyed limits.
`test/trustProxyForgery.test.ts` performs the forgery rather than describing it.

**Rate limits.** Authenticated scopes key on `ctx.userId`, not on address —
300/min general, 60/min for LLM and voice. Two scopes are necessarily IP-keyed
because their callers are unauthenticated by construction: the operator scope
(20/min, counting only *failed* platform-key attempts, so a legitimate operator
is never throttled) and firm-email lookup (10/min, anti-enumeration).

Behind Firebase Hosting the true client address is not recoverable: Firebase
terminates the visitor's connection and re-originates from Google's own
infrastructure, and the real address appears in neither VYNE's logs nor Cloud
Run's. The raw `X-Forwarded-For` chain is therefore logged beside `req.ip` as
*evidence*; nothing reads it to make a decision.

**Security headers.** CSP with `frame-ancestors 'none'`, `object-src 'none'`,
`base-uri 'self'`, `form-action 'self'`, `img-src 'self' data:` and a
`connect-src` allow-list, plus `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY` and `Referrer-Policy: strict-origin-when-cross-origin`.

**CORS** is an explicit allow-list; the server refuses to boot in production
without `APP_BASE_URL`, because the fallback used to reflect any origin.

**Error responses** never serialize internal error messages — raw Postgres errors
and stack traces are logged server-side only.

**Limits**: 32 MB body, 180s request timeout, 400-key and 512-byte-key caps on
bulk state writes.

## 5. AI and data handling

No provider API keys reach the browser. Every LLM, TTS and STT call runs
server-side through the gateway and is metered per firm. Production blocks
free-tier endpoints so client data never reaches train-eligible APIs.

Spend caps and concurrency limits are enforced in one transaction under one
advisory lock, so two simultaneous sessions cannot both pass a check only one of
them should.

Metering uses reserve-then-commit, and a metering write that fails is reported
rather than swallowed. Before v5.32.65 those were silent, which meant usage could
be spent and never billed with no record anywhere.

**Prompt injection is an open surface.** Interviewee-typed text reaches prompts
whose output a consultant reads as analysis, and nothing currently treats that
text as untrusted. See section 7.

## 6. Monitoring and recovery

Errors go to Google Cloud Error Reporting, always on in production with no
configuration to forget. Sentry is supported additionally when `SENTRY_DSN` is
set. Both are fed through one `captureError()` choke point.

Audit logging records privileged actions. Request logs carry method, URL,
resolved address and the raw forwarding chain.

Cloud SQL automated backups with point-in-time recovery; `BACKUP_RESTORE_RUNBOOK.md`
has the rehearsal procedure. A backup nobody has restored is a hypothesis, not a
capability.

`deploy/preflight.sh` checks the six things a deploy cannot check for itself. Its
own logic is unit-tested (`test/preflightChecks.test.ts`), because it shipped
three bugs in two releases and every one of them printed something reassuring
while being wrong.

## 7. Known weaknesses — where I would look first

Stated plainly. None of these is hypothetical.

**1. The bearer token is in `sessionStorage`.** Any successful XSS reads it and
holds the user's full session. The largest single item; the fix (httpOnly cookie
plus CSRF) is specified and not yet built.

**2. CSP still allows `'unsafe-inline'` for scripts**, which makes item 1
reachable by more paths than it should be, and there is no execution backstop
behind the escaping.

The cost of removing it was understated in the first version of this document,
which said "externalise every inline `<script>` across roughly fifteen pages".
Measured: 26 inline script blocks — and **435 inline event handlers**
(`onclick=`, `onchange=`, …). CSP blocks inline handlers whether or not a nonce
or hash is used, because neither can be applied to an attribute. So a nonce-based
CSP is not a smaller job than externalising the scripts; every one of those 435
handlers has to become an `addEventListener` first, whichever route is taken.
`connect-src`, `form-action` and `img-src` already close the usual exfiltration
routes, so today this is mitigation rather than prevention.

**2b. The innerHTML ratchet has a blind spot.** It inspects the expression
assigned to `.innerHTML`, so when HTML is assembled in one function and assigned
in another it sees a bare identifier and reads as clean. Seventeen assignments
take that shape. Two live sinks rendering raw model output hid behind one of them
in `pre_engagement.html` and were found only by manual review at the audit's
prompting — escaping them did not change the ratchet's count by one.
`test/indirectHtmlSinks.test.ts` now enumerates the class so it cannot grow
silently, but enumeration is a weaker guarantee than the direct ratchet and the
builders still need reading one at a time.

**3. Unattributed global state keys.** A single `vynora_roadmap_state` slot held
client-specific synthesis with no client identity attached, and any engagement
without its own entry inherited it — one client's synthesis could be exported
inside another client's deck. Fixed in v5.32.74. **The class has not been swept.**
`vynora_dm_snapshots` is a known candidate: one key holding records that each
carry their own `clientName`. This is the highest-value area for an independent
pass, precisely because the first instance was found by accident rather than by
review.

**4. Prompt injection via interviewee text.** An interviewee could write
instructions aimed at the model that generates consultant-facing findings. No
detection or fencing exists today.

**5. Client-scoping complexity.** `auth/clients.ts` has produced four separate
authorisation findings. It is correct as far as it is tested, and it is the part
of the system where correct-as-far-as-tested is least reassuring.

**6. The RLS boundary is one password.** Everything in section 1 rests on it, and
there is no second factor on the database path.

## 8. Deployment checklist

1. Identity Platform + TOTP enabled; `REQUIRE_MFA=1`, `REQUIRE_VERIFIED_EMAIL=1`.
2. Secrets in Secret Manager; `APP_BASE_URL` set; `vyne_app` password rotated off
   the migration default.
3. Automated backups and point-in-time recovery on, and a restore rehearsed once.
4. `deploy/preflight.sh` clean.
5. Deploy with `--update-secrets` / `--update-env-vars`, never `--set-`. A
   `--set-` once wiped production environment variables.

## Reporting a vulnerability

Contact the platform owner directly. Please include reproduction steps. The
suites in `backend/test/` are the expected form of a regression proof: every
security fix in this codebase ships with a test that fails when the fix is
reverted.
