# VYNE — Briefing for a Third-Party Auditor

_v5.32.74 · prepared by the author of the code_

Read `SECURITY.md` section 7 first. This document is the rest of what you would
otherwise spend two days working out, plus an honest account of where the
previous audit and the author's own review both fell short.

---

## What this system is

A multi-tenant SaaS for an AI Readiness Diagnostic, sold to consulting firms. A
**firm** (tenant) employs **consultants** who run diagnostics for **clients**.
Client staff participate as **interviewees**.

The sensitive asset is not credentials. It is one consulting firm's candid
assessment of their client's business — including political-sensitivity notes and
private-equity context that the client's own staff must never see. Two separation
boundaries matter, and they are enforced very differently:

- **Firm from firm** — Postgres RLS. Strong, database-enforced.
- **Client from client, inside a firm** — application logic in
  `auth/clients.ts`. This is where every authorisation finding to date has been.

---

## Shape of the codebase

**Backend** — Fastify + TypeScript on Cloud Run, Postgres on Cloud SQL.
Roughly 20 route modules, ~680 tests.

**Frontend** — about fifteen statically-hosted HTML pages on Firebase Hosting,
each largely self-contained with inline scripts. `roadmap.html` is ~11,000 lines.
No framework, no build step. ~285 Playwright assertions.

**State model — the part worth understanding before anything else.** The frontend
was originally `localStorage`-based. It now writes through `vyneStore`, a
synchronous facade over a server-side `module_state` table, hydrated with a
blocking XHR at page load and flushed on an 800ms debounce.

This matters because **client separation is enforced by parsing key names.**
`auth/clients.ts` maps each workspace key to a client identity by convention:
`vynora_briefing_<normclient>`, `vynora_synthesis_full_<CODE>`, and so on.
Anything unresolvable is dropped. Owners bypass the filter entirely.

That design has two structural consequences, and both have produced real bugs:

1. **A key family added without updating `clients.ts` is invisible to the filter.**
   It used to default to `GLOBAL` (shared with everyone); it now denies, which
   turns the failure from a leak into silent data loss for restricted
   consultants. Both failure modes have occurred.
2. **A globally-named key holding client-specific content leaks to owners.** The
   filter can only act on names. `vynora_roadmap_state` held one client's
   synthesis in an unattributed slot and any other engagement inherited it — and
   because that value feeds the deck export, one client's analysis could be
   exported inside another client's deck. Fixed in v5.32.74.

---

## Where I would start

Ranked by expected yield, not by severity.

**1. Sweep the state model for more of finding (2).** This is my strongest
recommendation. The instance we found was found by accident — a consultant
noticed a populated tab — not by review. `vynora_dm_snapshots` is a known
candidate: a single key holding records that each carry their own `clientName`.
The systematic question for every `vynora_*` key is: *does its content vary by
client while its name does not?* Start at `frontend/roadmap.html` and
`frontend/synthesis.html`.

**2. Token in `sessionStorage`, with CSP allowing `'unsafe-inline'`.** These
compound. Any XSS yields a full session. Fifteen pages of inline scripts is a
large surface, and the innerHTML sink inventory (`test/innerHtmlSinks.test.ts`)
is a ratchet over 51 known sites — worth checking whether it is complete rather
than merely stable.

**3. `auth/clients.ts` in full.** Four authorisation findings so far: a prefix
wildcard that granted cross-client access, an unrecognised-key default of
`GLOBAL`, an engagement-index binding that let a consultant claim another
client's code, and a key parser that resolved three families to literal strings.
`test/clientScopingFuzz.test.ts` and `test/rlsPenetration.test.ts` are the
existing coverage. The interesting question is which key families are *not*
enumerated there.

**4. Interviewee boundary.** `routes/interviews.ts` sanitizes the briefing and
projects follow-up agendas. Confidentiality here is a product promise: an
interviewee learning what earlier rounds concluded about them changes their
answers. Tests: `intervieweeRoundConfidentiality`, `followupAgendaConfidentiality`.

**5. Prompt injection.** Interviewee-typed text reaches prompts whose output a
consultant reads as findings. Nothing treats it as untrusted. Undefended, and
I have no test for it.

**6. The metering and billing path.** Reserve-then-commit under an advisory lock.
`llm/metering.ts`, `test/metering.test.ts`, `test/liveSessionAdmission.test.ts`.
Concurrency correctness here is money.

---

## What the previous audit covered

Twenty findings: one critical, five high, six medium, nine low. All closed, each
with a test verified by backing the fix out and watching it fail.

**What it missed, both found afterwards by chasing unrelated symptoms:**

- `trustProxy` was the number `2`, which made `req.ip` attacker-controlled and
  defeated the brute-force limit on the platform key that provisions firms. The
  code comment on that setting asserted the attack was impossible; it reasoned
  about a three-entry forwarding chain and never considered a shorter one.
- The cross-client roadmap leak described above.

Neither came from systematic review. Draw the obvious inference about what a
second systematic pass is likely to find.

---

## Author's caveats

I wrote this code, so my review of it has a ceiling. Concretely, within the single
session that produced v5.32.70–74 I:

- shipped three wrong checks in the production preflight script — two that
  reported healthy on a real problem, one that reported a problem on healthy
  infrastructure;
- wrote two test suites that passed with the bug fully restored, because they
  exercised a hard-coded copy of a setting rather than the application's own;
- recommended re-keying an anti-enumeration rate limit in a way that would have
  removed the bound entirely, and caught it only while implementing it.

Every one of those was caught by mechanically reverting the fix and watching the
test fail, or by writing the code out. None was caught by reading carefully. That
is the argument for you.

---

## Conventions that will help you read the code

**Comments carry incident history.** Where a fix exists because something broke,
the comment says what broke, what the symptom was, and what was verified — not
just what the code does. `server.ts`'s `trustProxy` block and
`auth/clients.ts`'s `normSetHas` are representative.

**Tests are prose-documented and adversarial by design.** Each names the failure
it prevents. Several deliberately demonstrate the *old* broken behaviour so that
the reason for the current design stays visible.

**Revert-testing is the house rule.** No fix is considered done until the fix has
been backed out and the test observed failing. If you find a test that passes
with its subject removed, that is a finding in itself and I would like to hear
about it.

---

## Running it locally

```bash
docker compose up -d                 # Postgres on 5433
cd backend && npm install && npm run migrate && npm run dev
npx vitest run
RLS_TEST=1 npx vitest run            # RLS suites need the database
for f in ../frontend/test/*.mjs; do node "$f"; done
```

`DEV_AUTH=1` bypasses Identity Platform locally and is hard-refused when
`NODE_ENV=production`.

---

## What I would consider a good outcome

Not a clean report. A clean report on a system where the author has been wrong
this often in one week would tell us mainly about the depth of the review.

Findings in the state model, in `clients.ts`, or in the prompt path would all be
more useful than a confirmation, and any test you find that passes with its
subject deleted is worth reporting on its own.
