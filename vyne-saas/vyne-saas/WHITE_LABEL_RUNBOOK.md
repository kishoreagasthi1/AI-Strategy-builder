# White-Label Runbook — onboarding a paying firm

How a new consulting firm gets its own tenant, a friendly login link, and
(optionally) a fully white-labeled domain like `vyne.meridianadvisors.com`.
All operator actions use your **signup key** (`SIGNUP_ACCESS_KEY`).

## 0. Easiest path: the Operator Console (v5.24)

`$APP/admin.html` is a self-contained page — not linked from the app, not
gated by Identity Platform login, only by your operator key — that does
everything below through a form instead of curl:

- **Provision a new firm**: firm name, owner name/email, a generated or
  typed password → one click → the login link to send the owner, ready to
  copy.
- **Existing firms table**: every tenant, with slug and custom domain
  editable inline (click the value, type, Save), status badges, and a
  "Copy link" button per firm.

Bookmark that URL on your own machine; don't share it — anyone who has it
*and* your operator key can provision firms. The key is checked on every
request server-side (same `SIGNUP_ACCESS_KEY` gate as the curl commands
below). It's held in this browser tab's session storage only — never
localStorage, never sent anywhere but the API — so it clears automatically
when you close the tab; you'll need to re-enter it next time.

Everything past this point is the same thing happening via curl instead —
useful for scripting, or as a reference for exactly what the console does.

Shorthand used below:

    APP=https://vyne-platform-prod.web.app
    KEY=<your signup key>

## 1. Provision the firm (creates the tenant)

    curl -X POST $APP/api/signup \
      -H "content-type: application/json" -H "x-signup-key: $KEY" \
      -d '{"firmName":"Meridian Advisors","ownerEmail":"owner@meridianadvisors.com","ownerPassword":"<initial password, 10+ chars>","ownerName":"Jane Meridian"}'

The response contains everything that matters:

    { "idpTenantId": "Meridian-Advisors-x1y2z",   ← internal id (users never see it)
      "slug": "meridian-advisors",                ← friendly handle
      "loginPath": "/?firm=meridian-advisors" }   ← the link you share

**Send the owner `$APP/?firm=meridian-advisors`.** The login screen shows
"Signing in to Meridian Advisors" — no tenant id anywhere. After one
successful login, that browser remembers the firm and even the link becomes
optional. Every consultant/interviewee invite the firm creates includes the
same link automatically.

## 2. (Optional) change the slug

    curl -X PATCH $APP/api/firm \
      -H "content-type: application/json" -H "x-signup-key: $KEY" \
      -d '{"idpTenantId":"Meridian-Advisors-x1y2z","slug":"meridian"}'

Login link becomes `/?firm=meridian`. Slugs: lowercase letters, digits,
hyphens, unique across the platform (409 if taken).

## 3. (Optional, paid tier) white-label custom domain

Goal: `vyne.meridianadvisors.com` IS their login page — firm auto-selected
by hostname, the concept of a tenant invisible.

**a. Bind the domain to the firm** (instant):

    curl -X PATCH $APP/api/firm \
      -H "content-type: application/json" -H "x-signup-key: $KEY" \
      -d '{"idpTenantId":"Meridian-Advisors-x1y2z","customDomain":"vyne.meridianadvisors.com"}'

**b. Attach the domain to Firebase Hosting** (one-time per domain):
Firebase console → Hosting → *Add custom domain* → enter
`vyne.meridianadvisors.com`. Firebase shows a TXT record (ownership) and an
A/CNAME record — **the firm's IT adds these at their DNS provider**. SSL
certificate provisions automatically once DNS propagates (minutes to ~24h).

**c. Authorize the domain for login** (one-time per domain):
Identity Platform → Settings → Security → *Authorized domains* → add
`vyne.meridianadvisors.com`. (Console path; equivalently PATCH
`admin/v2/.../config?updateMask=authorizedDomains` with the full list.)

**d. Verify:** open `https://vyne.meridianadvisors.com` → "Signing in to
Meridian Advisors", no firm field, login + MFA work.

To unbind a domain: send `"customDomain": null` in the PATCH, and remove it
from Firebase Hosting / authorized domains.

## How resolution works (for debugging)

Login-page order: (1) hostname matched against firms' custom domains —
shared hosts (`*.web.app`, `*.firebaseapp.com`, `*.run.app`, localhost) are
skipped; (2) `?firm=` param, matched against slug then raw tenant id;
(3) this browser's last successful firm (localStorage; "use a different
firm" clears it). Nothing resolved → manual firm-id field, as before.
Suspended firms (status ≠ active) never resolve. Probe directly:

    curl "$APP/api/firm?firm=meridian-advisors"
    curl "$APP/api/firm?host=vyne.meridianadvisors.com"

List every firm (operator-only — same key gate as PATCH; this is what
`admin.html`'s table calls):

    curl "$APP/api/firms" -H "x-signup-key: $KEY"
