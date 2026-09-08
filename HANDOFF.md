# VYNE — session handoff

_Ends at v5.32.89. Production is on v5.32.86._

## Share these in the new chat

1. **`vyne-saas-v5.32.89.zip`** — the full tree. This is the source of truth.
2. **This file.**

That is all. The zip contains the code, the tests, and the docs.

## Where things stand

| | |
|---|---|
| Deployed | v5.32.86 — reported by the operator; `/api/version` is the authority |
| In the zip, NOT deployed | v5.32.89 |
| GCP project | `vyne-platform-prod`, region `us-central1` |
| Cloud Run service | `vyne-api` · Cloud SQL `vyne-sql` |
| Frontend | Firebase Hosting → `https://vyne-platform-prod.web.app` |
| Deploy folder | `~/vyne-saas-deploy/vyne-saas` |
| Migrations | up to date at **024**, applied with .86 — .87 to .89 add none |

Health: **988 backend tests** (84 files, all RLS suites executed against a real
Postgres), **375 frontend assertions across 16 Playwright files**, **50
full-flow e2e assertions**, `tsc` clean. No known failures.

**.87 to .89 need BOTH deploys** — `./deploy/deploy.sh api` and then
`frontend`. No migration.

`npx tsx backend/test/contextExamples.mts` prints the actual context every
v5.32.88 change produces, from the shipped code paths. Read that before
changing any of it.

`npx tsx backend/test/scoreTrailExample.mts` does the same for v5.32.89: it
drives the real generator and prints the score trail each synthetic transcript
now carries, model path and fallback side by side.

`docs/INTERVIEW_CONTEXT_CONTRACT.md` (new) is the field-by-field trace of what
reaches the interview agent on each path — worth reading before changing either.

---

## What changed, and why each one matters

### 1. The spend caps are switched off for 45 minutes after every midnight

This was handoff item 4 — `meteringAging.test.ts` failing. It was not a flaky
test. It is a live hole in both spend caps, and the previous fix for it made the
number look right without closing it.

Both cap sums and the aging CTE are scoped `created_at >= date_trunc('day'|'month',
now())`. A live session that opens before a boundary and closes after it leaves
its **positive hold in yesterday and its negative release alone in today**. The
CTE sees one row for that session, seconds old, judges it live, and counts minus
a whole grant (135,000 tokens).

v5.32.77 wrapped the total in `GREATEST(..., 0)` and recorded the residual as "a
new month briefly under-counting by one session's hold." That is not what a
clamp does. It floors the **entire window** at zero, so every real token spent in
it disappears with the artifact. Measured against Postgres: 51,000 billable
tokens against a 50,000 daily cap, plus one straddling release, returned
`{allowed: true}`.

Fixed in `excludedSessionsCte` (`llm/metering.ts`) by excluding any session whose
non-billable rows net negative inside the window — a fragment whose opening row
is elsewhere cannot be spare capacity. One line, in the CTE both caps share, and
it needs no task-name classification so the legacy reserve/refund pair is covered
too. The clamp stays as a backstop and should never now be reached.

**Why the test looked like it predated the session:** it fails only between
00:00 and 00:45 **local** time, and passes the other 23 hours. On the Mac that is
05:00–05:45 UTC; in CI, which runs UTC, it was hitting roughly 3% of runs and
being attributed to nothing. Backing out the clamp gave the identical failure
because the clamp was never the mechanism.

Three new tests. Two need no particular time of day (an orphaned release is the
residue a straddle leaves and is reproducible at 3pm). The third reproduces the
real midnight boundary at any wall-clock time by **moving the boundary**: it sets
the connection's TimeZone so `date_trunc('day', now())` — the shipped
expression, unmodified — falls between the hold and the release, and asserts that
placement before asserting the outcome, so the fixture cannot silently miss.

### 2. Regenerating synthetic data for a client has never worked

Found while building the chunked route; it is a defect in the **existing**
`/api/synthetic/engagement`.

Migration 017 grants `vyne_app` only `SELECT, INSERT` on `interview_transcripts`,
with a good reason stated in the migration: *"An audit record that the
application can erase is not much of an audit record."* The generator's
regeneration path runs `DELETE FROM interview_transcripts`, with an equally good
reason: 017 deliberately declines a foreign key, so nothing cascades. Two correct
decisions that had never been executed in the same statement.

The second generation for any client dies with
`permission denied for table interview_transcripts` — a 500, after the interviews
have already been deleted in the same transaction, so it rolls back and the
consultant sees nothing but an error.

It survived because every case in `synthetic.test.ts` used a client name no other
case used: TestCo Industrial, Followup Testco, RoleCo. The delete branch is only
reached when prior rows exist, and prior rows never existed. "Regeneration
replaces the previous synthetic set" was a property asserted in a comment,
reported as held by a green suite, and never once run.

**Migration 024** grants `DELETE` and splits the RLS policy per command so
deletion is permitted **only** for rows carrying the generator's own
`[Synthetic]` marker. Real transcripts stay exactly as undeletable by the
application as 017 intended. There is a test that the app role still cannot
delete a real transcript, and it fails if the `[Synthetic]` predicate is dropped.

### 3. Chunked synthetic generation, and a spec that was wrong

Implemented per `docs/CHUNKED_SYNTHETIC_SPEC.md`, with two departures.

**The spec's central claim was false.** It states that round 2's `seeds` are
"drawn from the PRIOR round's findings", calls that "the existing round
mechanism", and instructs the implementer to preserve rather than invent it.
No such mechanism existed: `seeds` was `seedsFor(personas)` — a pure function of
the persona **list**, computed once and passed identically to both rounds. Only
the `refresh` boolean differed.

That matters beyond the detail. The spec's whole architectural constraint —
*rounds must generate in order* — rested on it. With static seeds there was no
data flow, so the constraint was satisfied by accident and no test could have
distinguished an in-order run from an out-of-order one.

You chose to build the real thing. `seedsFromPriorRound()` composes round N's
seeds from round N−1's actual findings, the contradictions that actually emerged
(rather than the ones we asked for) and the dimensions that actually scored
lowest. `POST /api/synthetic/persona` returns **400 `prior_round_required`** for
round > 1 without one, so the ordering rule is now load-bearing and observable.
`/api/synthetic/engagement` uses the same function, so both paths agree.

**The second departure is security.** The spec has the browser POST `seeds`,
`hypotheses`, `industry` and the persona's bias. The routes instead take
`clientName`, a round and a persona **index**, and re-derive all of it
server-side per call. Everything in that list is prompt content for a billed LLM
call; accepting it from the client turns a server-composed prompt into a
client-composed one for anyone holding a consultant token, and lets a briefing
edited mid-run desync silently. Re-deriving costs one indexed `module_state`
read next to a multi-second model call, and an `expect: {name, role}` field turns
the drift case into a 409.

New routes (all owner/consultant):

- `POST /api/synthetic/personas` — the work-list. No model call, not rate-limited
  with the others. Does **not** return persona bias.
- `POST /api/synthetic/persona` — one persona, one round, one model call.
  502 `{error, category, role, round}` on failure. `category` is one of
  `parse_failed | missing_fields | provider_error | timeout | refused` and never
  carries model output. Rate limit 60/min, deliberately above `/engagement`'s 6.
- `POST /api/synthetic/commit` — writes, via `commitSyntheticEngagement()`, the
  same function `/engagement` calls. Nothing about persistence is reimplemented.
- `/api/synthetic/engagement` still works, unchanged in behaviour apart from the
  round-2 seeding.

`interviews.html` fans out in the browser with a bounded concurrency of 3,
reports progress ("Generating… 7 of 10"), survives per-persona failures, names
the failures with a plain-English reason, and offers a retry that re-runs only
what failed and re-commits the whole set.

### 4. Persona failures now say what they were

Handoff item 2. `generateOne`'s `catch { /* retry */ }` is replaced with
per-attempt logging of the caught error, the safe category, the role, the round,
the attempt number, and which of `scores`/`findings`/`transcript` were present.
Per **attempt**, because the interesting case is two attempts failing
differently. The provider call stays outside the retry's catch on purpose —
pulling it in would double every billed call during an outage and swallow the
`GatewayError.detail` redaction path.

This should make the Nissan failure diagnosable on the next occurrence.

### 5. Backfill route (handoff item 5)

`POST /api/synthetic/backfill-logins`, owner/consultant, repairs pre-v5.32.81
rows in place. Idempotent by construction: the `WHERE` selects only rows still
`NULL`. The LIKE prefix is **escaped** (`iv\_synth\_%`) — `_` is a
single-character wildcard, and there is a test using a real interview whose
`state_module` differs only in its separators.

The prior session's unexplained 500 did not recur; ten tests pass, including the
one that matters — a follow-up draft on a repaired row returns **201**, asserted
after first asserting the 409 it replaces, so the test cannot pass by repairing
something that was never broken.

### 6. The innerHTML ratchet now measures something

Handoff item 6. The extractor was rewritten. It had four classes of phantom:
CSS inside string literals (`"11px;color"`), map-callback source reported whole,
operands truncated at a quote (`"dims.join('"`), and top-level ternaries torn
into fragments by splitting on `+` first (`?:` binds looser than `+`).

Statements are now normalised — string literals collapse to `§`, comments and
regex literals disappear, `${…}` contents are re-emitted as parenthesised code —
and walked in JS precedence order, with callbacks judged on what they **return**.

**93 → 76. Not one line of frontend code changed with that drop.** It is 17
sites the scanner was wrong about, and the baseline comment says so in those
words. The remaining 76 are sites whose value the scanner cannot resolve — now
almost all real indirection (`rows`, `head`, `docDeleteBtnHtml(key)`) rather than
noise. It is a list of unknowns short enough to finish, not a list of
vulnerabilities and not a claim of safety.

### 7. The shadowed-login warning fired on the design working (v5.32.84)

Reported from production immediately after the .83 deploy: every synthetic row
carried a red **"⚠ shadowed by …"** on its login.

"Shadowed" means two interview rows share one login, and since an interviewee is
routed by login with `ORDER BY created_at DESC LIMIT 1`, only the newest is
reachable. The warning is real and worth having — for two DIFFERENT people
sharing one mailbox, both still waiting to be interviewed, where the older row is
a person who will never get in.

It did not fire occasionally. It fired structurally, on three arrangements the
product creates deliberately:

- one login per PERSON across rounds, so round 1 is shadowed by round 2 in every
  multi-round engagement;
- a follow-up reuses its parent's login and is newer by construction, so
  requesting one paints the warning across the interview it follows up ON;
- every synthetic engagement, which does both.

The harm its own comment describes is a row that "sits at 'invited' forever while
the consultant chases a stakeholder who has already been interviewed" — which is
about work outstanding. A COMPLETED interview has no session to open and nobody
to chase, so the warning had no advice to give on one while the red text implied
otherwise. `shadowedBy()` now returns null for a completed row; an invited row
sharing a login is still flagged.

Revert-tested in both directions, which matters more than usual here because the
change SUPPRESSES output: backing the suppression out fails the new check, and
suppressing everything fails the original one. Quietening a warning is only
defensible if the signal is shown to survive.

### 8. One client's synthesis displayed under another client's name (v5.32.85)

Found while answering "why is the Refresh Interview tab empty?", and the more
serious of the two things that question turned up.

**The reachable half.** Three page-load globals in `synthesis.html` hold
synthesis state that is per ENGAGEMENT, and nothing cleared them when the
consultant switched client:

- `lastSynthesisResult` — drives the Unresolved Hypotheses and Blind Spots
  sections, and is what Close Round bakes into the refresh agenda
- `synthesisBoxHydrated` — gates the synthesis box, so once true the box kept
  showing the previous client's summary and never re-read storage
- `_parsedSynthesisForReport` — the fallback the .docx report builds from

Load Acme, then load Newco, and Newco's dashboard shows Acme's synthesis under
Newco's name — on a page whose entire subject is confidential client material.
All three are now cleared in the one place that already existed for "a different
engagement is now loaded", together with the box's own DOM, which otherwise
keeps painting the old text until something overwrites it. Fixed at the writer
rather than at the three readers: a leak fixed at the readers comes back with the
next reader added.

**The gate that hid it, and blocked a module.** The Close Round button is
`display:none` in the markup, is hidden and disabled again on every engagement
load, and was shown by exactly one call to `updateCloseRoundBtn()` — the one
after a LIVE synthesis parses. So the only route to Close Round was to generate a
synthesis in the current page load.

That matters well beyond one button: Close Round is the ONLY writer of
`vynora_refresh_agenda_<CODE>`, and that key is the only thing the interview
agent's Refresh Interview tab reads. So a consultant who reloaded the page — or
opened a synthetic engagement, which ships with a persisted synthesis precisely
so no billed ~90-second call is needed — could not reach the refresh flow at all.
`confirmCloseRound()` already read the stored synthesis itself when the
in-memory copy was missing; the action was built for the persisted copy and only
the control that opens it was not. They agree now.

The two are connected: the hidden button is what kept the stale
`lastSynthesisResult` from being *written* into a second client's refresh agenda
and asked of their executives. The display leak was always reachable.

Six new assertions in `synthesis-e2e.mjs`, using a second client with no stored
synthesis of its own — so any synthesis content on screen provably came from the
first. All three parts revert-tested separately.

### 9. One role, several people (v5.32.86)

A client can have three divisional COOs. The engagement record keeps all three
correctly — that was never the problem — but every layer above it used the role
STRING as an identity. Six consequences, all verified in code:

1. **Conflicts had no names.** `detectConflicts` mapped to `{role, score}`, so a
   disagreement between two COOs rendered as *"the COO scored 4.5 while the COO
   scored 2.1"*.
2. **Two COOs could not corroborate each other.** `finish()` deduped roles by
   string and set `corroborated = roles.length >= 2`, so two people independently
   making the same point collapsed to `["COO"]` — filed as one unsupported
   observation. Two executives agreeing is the strongest evidence an engagement
   produces, and it was being discarded.
3. **A role with N people carries N× weight** in the round score. Undocumented,
   and no decision on record.
4. **The refresh agenda merged them** — `byRole`, one entry per role.
5. **The refresh context kept one of them.** `round1Summaries[role] = {...}` is
   a plain assignment; the second COO silently overwrote the first.
6. **No COO got the follow-up.** `startRefreshInterview` set
   `stakeholderName: role.replace(/_/g,' ')`, so a round-2 interview was
   recorded against an interviewee literally called **"COO"** — matching neither
   round-1 person, sharing no login, incapable of being either one's follow-up.

5 and 6 together were the sharp end: `buildRefreshSystemPrompt` reads
`round1Summaries[role]` into the prompt under **"YOUR OWN ROUND 1 VIEW"**, with a
comment asserting *"no other role's scores/findings ever appear here (no
cross-leakage)"*. True between roles. False between two holders of one — the
second COO was read the first one's private scores and findings as their own.

**Fixed to the rule you set: name the person where the role alone cannot say who
spoke.** `vynePersonKey` / `vyneLabelFor` live in `vyne-client.js`, so one
definition serves both pages rather than a third pair to drift apart.
Attribution reads "CFO" where one person holds it and "COO (Cara Diaz)" where
several do — nothing changes on an ordinary engagement.

- Corroboration dedupes on the attribution label, in both halves of the parity
  pair. Two **unnamed** holders still do not corroborate: with no name there is
  nothing to tell them apart, and minting an identity per row would manufacture
  agreement.
- Contradictions route to the two **people** who disagreed — so a COO who
  agreed with the CEO is no longer pulled into round 2. Hypotheses route to the
  person who actually scored lowest. Blind spots still name a role and fan out
  to everyone holding it, which is correct for them.
- `byPerson` is emitted **alongside** `byRole`, and the agent prefers it. Agendas
  already sitting in production workspaces keep working; a legacy one with an
  ambiguous role gets no "your own round 1 view" rather than a guess.
- Role weighting was left as it is and **written down**: three COOs are three
  observations, and averaging them into one vote would erase the inter-divisional
  disagreement that is often the finding. Pinned by a test.

One existing fixture was pinning the bug: `synthesis-e2e` described D5 as "two
roles on DIFFERENT claims (thematic)" when it actually held two COOs making the
*identical* statement — thematic only because attribution collapsed them. The
fixture now says what it holds, and D7 carries the thematic case properly.

New `frontend/test/refresh-person-e2e.mjs`, 17 assertions, on the picker a
consultant sees and the session state the interview runs on. Every part
revert-tested.

### 10. The follow-up draft read the wrong round (v5.32.87)

`POST /api/interviews/:id/followup/draft` selected its source material with
`rounds[rounds.length - 1]` — the last ARRAY element, not the highest round
number. v5.32.55 let a consultant pin a round number at invite time, so rounds
can be appended out of order; `sortRounds` exists for exactly that reason, and
`synthesis-e2e`'s fixture is deliberately built `[2, 1]` and names it "the F23
case". On such an engagement the follow-up drafted from the OLDER round while
presenting itself as the latest picture.

Plain `latestRound()` is not the answer either: a round is created EMPTY when a
consultant plans it, so the highest-numbered round is frequently one nobody has
been interviewed for — and drafting from it yields no findings, dropping every
follow-up to the generic fallback the moment the next round is planned.

Now selects the highest-numbered round that actually carries a finding. Both
failure modes were silent — the agenda still rendered, just from the wrong
material — which is why the selection is explicit rather than positional. Two
tests, revert-tested.

### 11. Cumulative interview context (v5.32.88)

Four steps, each independently shippable, built on one derived artifact.

**`frontend/vyne-memory.js`** — the engagement's memory, per person and per
dimension, derived from ALL rounds at Close Round and written to
`vynora_memory_<CODE>`. Two rules make it usable:

- **Derived, never authored.** A cache. Delete it and it recomputes; the
  engagement record and the transcripts stay the sources of truth.
- **Every entry carries provenance** — the round and the interview it came
  from. Without that a summary in a prompt is unfalsifiable, which is how a
  sentence nobody said ends up in a board deck.

**Recency is built in, not bolted on.** The newest round a person spoke on a
dimension is kept verbatim; earlier rounds survive only as a score trajectory.
`rankDimensions` orders candidates — today's agenda, then stale, then their own
words, then thin coverage — and caps them, because a prompt containing every
round of every dimension scores worse.

**Step 1 — coverage fed forward.** The refresh prompt now states the round a
score was last measured in, and flags `stale` (measured in an older round than
the person's most recent) and thin coverage. This is the distinction round-2
scoring could not draw: *unchanged because we asked* versus *unchanged because
nobody asked*.

**Step 2 — the follow-up quotes the interviewee back to themselves.**
`probeFor()` replaces a fixed sentence that was identical for every engagement
in the product. It was fixed for a reason — the only specific material available
was colleagues', which can never be shown — and their own last statement can be,
because quoting somebody back to themselves discloses nothing. The draft route
also now accepts `dimensions` and `note`, so a follow-up keeps the direction the
consultant gives it.

**Steps 3 and 4 — the artifact and the projections.** `selfView` (their own
material, quotable), `ambientView` (de-attributed, no role and no name — a role
is frequently identifying on a five-person executive team), `consultantView`
(everything). The privacy rule is now a property of which projection you ask
for, rather than a filter re-implemented at four read sites — which is how one
client's synthesis came to display under another's name (.85) and how two
holders of one role came to share a context entry (.86). `round1Summaries`
remains as a compatibility shim for agendas already in production.

Two defects in my own module, caught by its own tests and worth recording
because they are the same shape as everything else this session: `Number(null)`
is `0`, so "no coverage was recorded" became "coverage measured zero"; and a
person who scored every dimension 0 produced an empty record, which reads as
"they said nothing" rather than "they were never interviewed".

17 unit tests on the module, 6 new browser assertions on the prompt, 3 new
backend assertions on the draft. All revert-tested.

### 12. Three checks that reported more than they verified

You flagged this as the recurring failure mode. Beyond the four above, three
existing checks were quietly narrower than they read:

- **`securityAuditFixes.test.ts`** counted `/config: \{ rateLimit: \{ max: 6/`
  with no boundary — so it matched `max: 60`, and would have matched `max: 6000`.
  A check written to assert a ceiling of six accepted one of sixty without
  comment. Anchored on the trailing comma; the new route's 60/min is asserted as
  a stated fact rather than left to fall through a loose pattern.
- **`schemaInvariants.test.ts`** required both `qual` and `with_check` on every
  RLS policy, which silently also required every policy to be `FOR ALL` — a
  `FOR SELECT` policy has no `WITH CHECK` to give. Made command-aware rather than
  relaxed: `ALL` and `UPDATE` still mandate `WITH CHECK`, and an unrecognised
  command is now itself a failure, since one would otherwise be exempt from
  every check.
- **`RLS_TEST` skipping silently.** New `test/rlsGate.test.ts` fails when `CI` is
  set and `RLS_TEST` is not. Locally `npm test` still runs without a database and
  prints which 25 suites were inert; in CI a green tick can no longer mean zero
  coverage.

Two of my own checks failed this bar during the session and were fixed rather
than kept: an e2e 401 assertion that also accepted the page's own path (true
before the click), and a backfill test whose property was masked by a
within-run cache — replaced with an across-run version that has teeth.

A third is in §13 below.

### 13. Synthetic transcripts carried no evidence at all (v5.32.89)

Reported from real data: every transcript from a synthetic engagement opened
with

> No score trail was kept for this interview — trails are recorded from
> v5.32.66 onward.

Two separate defects, and the message is the more instructive one.

**The data.** Migration 023 added `interview_transcripts.findings` and
`.score_events` so a consultant can answer "why is D6 a 1.5?" by pointing at a
turn. The synthetic generator's insert named
`(tenant_id, interview_id, client_name, interviewee_name, interviewee_role,
round_number, turns, turn_count, mode)` — and stopped. Both evidence columns
went in NULL, on every synthetic row, at every version since 023 shipped. The
generator exists so a consultant can rehearse the parts of the product that
come after interviewing, and the evidence panel is one of those parts, so this
defeated the feature's stated purpose rather than degrading it.

Fixed by asking the model for a `scoreEvents` array alongside the transcript,
normalising it through `synthScoreEvents()` — dimension must be D1–D7, `to`
must be 1–5, the turn anchor is clamped into the transcript, one event per
dimension, capped at 40 — and writing both columns. NULL is still written as
NULL, never `[]`: "no journal" and "a journal with nothing in it" are different
facts and the viewer says so. When the model returns nothing usable, a trail is
derived from the final scores anchored at the last turn; that is a weaker claim
("where it ended up", not "where it moved") and is still better than a panel
reading as though nothing was measured.

**The message.** It asserted a cause it had no way to know. The row carries no
version stamp, so "trails are recorded from v5.32.66 onward" was inference
presented as fact — and it was wrong for the reported data, which was generated
on v5.32.83, seventeen versions after .66. A consultant reading it would
conclude their data was old and regenerate, which would have produced exactly
the same empty panel. It now states what is stored, lists the conditions under
which something is, and lets the reader draw the conclusion:

> No score trail was stored for this interview. A trail is kept for interviews
> completed from v5.32.66 onward, and for synthetic interviews generated from
> v5.32.89 onward. The conversation itself is complete.

**And my own check was narrower than it read.** The new
`synthetic.test.ts` case asserts every synthetic transcript carries a non-NULL
`score_events`, and it passed. But that file's fake adapter returned
`{scores, findings, summary}` with no `scoreEvents` — so the only branch it
ever walked was the *fallback*, the one that manufactures a trail when the
model gave nothing. The path that runs in production had no coverage at all,
while the suite read as though the feature were tested. Caught by asking what
the green tick actually verified, which is the question this whole session has
turned on.

Closed three ways:

- `synthScoreEvents` is exported and tested directly in new
  `test/syntheticScoreTrail.test.ts` — 18 cases covering a well-formed trail,
  a dimension outside D1–D7, a score of 0 or 6, an out-of-range `from`, an
  anchor past the last turn, a missing anchor, duplicates, junk in place of
  the array, the cap, and each fallback condition separately.
- `synthetic.test.ts`'s adapter now returns a trail, with one entry anchored
  at turn 999 so the clamp is exercised through the route.
- That test now asserts the model's *specific* event (D1 3→2 at turn 2) rather
  than non-NULL. Backing the adapter's trail out fails it with
  `expected 2.1 to be 2` — 2.1 being the fallback's value — which is precisely
  the distinction the old assertion could not draw.

The follow-up specimen row is asserted separately, because it carries a
hand-written trail over its own hand-written turns. An assertion that had to
hold for both it and the persona rows could only be weak enough to hold for
neither in particular, so the query joins `interviews.kind` to tell them apart.

---

## Deploy

Every fix was revert-tested: backed out, the test observed failing, restored.

**Use `deploy/deploy.sh`, not a hand-written `gcloud run deploy`.** The script
carries five things a typed-out command drops silently: `--service-account`,
`--add-cloudsql-instances` (without it the API has no Cloud SQL socket),
`--update-secrets DATABASE_URL=vyne-database-url:latest`, `--concurrency 20`
(matched to the 20-connection pool, v5.32.58), and the `_extra_env` passthrough
for Firebase, Stripe, MFA and TTS. A revision missing those comes up and fails
on the first request.

### 1. Extract, and check what you are about to ship

```zsh
export PROJECT_ID=vyne-platform-prod
cd ~/vyne-saas-deploy
unzip -o ~/Downloads/vyne-saas-v5.32.89.zip
cd vyne-saas
grep "VERSION = " backend/src/version.ts
```

Must print `5.32.89`. A deploy from a tree you did not extract into succeeds and
changes nothing.

### 2. Migration — none for this release

**024 was applied when v5.32.86 went out. .87, .88 and .89 add no migration, so
skip to step 3.** The proxy instructions below are kept for the next release
that needs one; running the migrate command now is harmless and prints
`Nothing to apply — up to date.`, but see the warning about which database that
sentence can be describing.

Terminal 1:

```zsh
~/cloud-sql-proxy --port 5433 vyne-platform-prod:us-central1:vyne-sql
```

The binary lives in `$HOME` and is not on `PATH`; a bare `cloud-sql-proxy` is
`command not found`. If `~/cloud-sql-proxy` is missing, see
`docs/OPERATIONS_RUNBOOK.md` § Migrations.

Terminal 2:

```zsh
cd ~/vyne-saas-deploy/vyne-saas/backend
DATABASE_URL="postgres://vyne:<OWNER_PW>@localhost:5433/vyne" npm run migrate
```

On a release that does carry a migration, expect `Applied: <NNN>_<name>.sql`.
**On such a release, "Nothing to apply — up to date." means you are pointed at
the wrong database** — 5432 is the local Postgres, and migrating it succeeds and
reports success in the same words. For THIS release that sentence is the correct
outcome, which is why the safe move is to skip the step rather than run it and
read the output for reassurance.

### 3. Backend

Export whatever optional settings this firm uses first; `--update-env-vars`
merges, so anything you omit keeps its current value, and the script says out
loud when you have exported none.

```zsh
cd ~/vyne-saas-deploy/vyne-saas
export PROJECT_ID=vyne-platform-prod
./deploy/deploy.sh api
```

`--update-*` never `--set-`. A `--set-` once wiped every production env var.

### 4. Frontend

```zsh
cd ~/vyne-saas-deploy/vyne-saas
./deploy/deploy.sh frontend
```

### 5. Confirm the deploy landed

```zsh
curl -s https://vyne-api-<hash>-uc.a.run.app/api/version
./deploy/preflight.sh
```

`/api/version` must report `5.32.89`. It compares the served version against the
frontend's own stamp, so a partial deploy — backend up, hosting not — shows here
rather than as a strange bug later.

> `deploy/deploy.sh migrate` printed **port 5432** until this release. Following
> it migrates the developer's own database and reports success in the same words
> a real migration uses. `preflight.sh` has always defaulted to 5433; the two
> disagreed and the wrong one was the one giving instructions. Fixed in
> v5.32.83, and the port is now a single variable.

---

## Verify after deploying

1. **The chunked generator.** Interview Tracker → generate synthetic data for a
   client. You should see "Generating… n of m" counting up instead of a single
   long wait. Then **generate again for the same client** — that is the path that
   has always 500'd, and it is the one thing here that only production can
   confirm.
2. **Request follow-up** on a row from that run. Agenda overlay = works.
3. **Old engagements.** `POST /api/synthetic/backfill-logins` with `{}` repairs
   every pre-.81 row you can reach, or `{"clientName": "Nissan Motors
   Corporation"}` for one. It is idempotent; run it twice if you are unsure.
4. **The Nissan failure.** If it recurs, the Cloud Run log now carries
   `synthetic persona generation attempt failed` with a category, the role, the
   round, the attempt and which fields were present.
5. **The score trail (v5.32.89).** Open a transcript from the run in step 1. The
   evidence panel should list dimensions against turns, not "No score trail was
   stored".

   **Synthetic engagements generated before .89 will still show no trail after
   this deploy, and that is correct.** The fix is on the write path; the columns
   are NULL in the rows that already exist and nothing can reconstruct where a
   score moved in a conversation that was never scored turn-by-turn. There is no
   backfill for this and inventing one would be manufacturing evidence.
   Regenerate the engagement — which is now a supported operation, per §2.

## Still open

- **Defence in depth for XSS** (old item 7). Token still in `sessionStorage`,
  CSP still allows `script-src 'unsafe-inline'`. Removing `unsafe-inline` costs
  26 inline script blocks **and 435 inline event handlers** — CSP blocks handlers
  regardless of nonce or hash, so a nonce-based CSP is not the cheaper route. The
  httpOnly cookie is the tractable half.
- **Draining the 76.** Each needs its variable followed to where it is built.
  Ordinary work, now on a real signal.
- **Retiring `/api/synthetic/engagement`** once the chunked path has run in
  production for a while. Keeping both is what makes a regression in the new one
  distinguishable from the refactor; that stops being worth the duplication
  eventually.

## Conventions that are load-bearing

Unchanged from the last handoff, and all still true:

- **Deploy** — `export PROJECT_ID` first; `--update-*` never `--set-`; check
  `version.ts` before deploying.
- **Migrations** — port **5433** via cloud-sql-proxy. Last migration is now
  **024**.
- **Deliverables** — `vyne-saas-v<version>.zip`, full tree, extracts to
  `vyne-saas/`, deployed with `unzip -o`.
- **Revert-testing is the rule.** No fix is done until it has been backed out and
  the test observed failing. Applied to every change in this session, including
  the migration (backed out at the database, both regeneration tests went red).
- **Querying production directly is awkward by design.** Tables are FORCE RLS and
  `vyne` lacks BYPASSRLS. Prefer testing through the UI. `psql` is not installed
  on the Mac; use `node -e` with `pg` from `backend/node_modules`, which means
  running from `backend/`.
- **zsh does not treat `#` as a comment** in interactive shells — no inline `#`
  in copy-paste blocks.

One addition, learned the hard way this session:

- **A local test database needs `vyne` to be a SUPERUSER.** Tables are FORCE RLS,
  which applies to the owner, so the suites' "admin" connection cannot seed
  fixtures without it. Six suites fail with
  `new row violates row-level security policy` otherwise, and it looks like six
  application bugs. CI gets this free — the `postgres:16` image makes
  `POSTGRES_USER` a superuser.
