# Chunked synthetic generation — implementation spec

_Written at the end of the v5.32.81 session. Everything here is grounded in code
that exists today; file and line references were read, not recalled._

> **IMPLEMENTED IN v5.32.83. One claim in this document was wrong — read this
> before the rest.**
>
> The "Round context — REQUIRED" section below states that `seeds` are "drawn
> from the PRIOR round's findings", calls that "the existing round mechanism",
> and instructs the implementer to preserve it rather than invent it. **No such
> mechanism existed.** `seeds` was `seedsFor(personas)` (`synthetic.ts:83`) — a
> pure function of the persona LIST, computed once at line 506 and passed
> identically to every call in both rounds. The only thing distinguishing a
> refresh round was the `refresh` boolean flipping one paragraph of the prompt.
>
> This matters beyond the detail, because the document's central architectural
> constraint rests on it. "Rounds must generate in order" was presented as a
> requirement derived from the data flow. With static seeds there was no data
> flow, so the constraint was being satisfied by accident, and no test could
> have distinguished an in-order run from an out-of-order one.
>
> v5.32.83 built the mechanism rather than preserving a fiction:
> `seedsFromPriorRound()` composes round N's seeds from round N−1's actual
> findings, contradictions and weakest dimensions, and
> `POST /api/synthetic/persona` returns **400 `prior_round_required`** for
> round > 1 with no prior round. The ordering rule is now load-bearing and
> observable. `/api/synthetic/engagement` was changed to use the same function,
> so both paths produce the same engagement.
>
> The paragraph at the end of that section — "The rule above is what the code
> does today; the spec is to preserve it through the refactor, not to invent
> it" — is the sentence to distrust. It reads as verification and was not.
>
> **One other departure from the API shape below**, made deliberately: the
> chunked routes take `clientName`, a round and a persona INDEX, and re-derive
> `industry`, `hypotheses`, the persona's bias and the seeds server-side on
> every call. Accepting those from the browser, as sketched below, turns a
> server-composed LLM prompt into a client-composed one for anyone holding a
> consultant token — a wider surface bought for nothing — and lets a briefing
> edited mid-run desync silently. See the comment block above the routes in
> `backend/src/routes/synthetic.ts`.

## Why

`POST /api/synthetic/engagement` generates every persona in one request, one LLM
call each, sequentially. Two failures follow from that shape and both are live:

1. **Firebase Hosting cuts the response at 60 seconds.** Not a VYNE setting —
   our `requestTimeout` is 180s and Cloud Run's is higher. The proxy is upstream
   of anything we control. It began failing because v5.32.60 added a 12–16 turn
   transcript per persona and raised `maxTokens` 2000 → 4000, roughly doubling
   output per call. The work outgrew the window; nothing broke.
2. **One persona failing destroys the batch.** `generateOne` retries twice, then
   throws (`routes/synthetic.ts`, "generation failed for ${p.role}"), which
   aborts the whole engagement. Observed in production: Nissan died on
   "VP Sales / Revenue" after every other persona had already generated.

The `catch { /* retry */ }` in that loop swallows the reason, so neither the
response nor the server log says whether it was a parse failure, a missing
field, or a refusal. Fix that first — it is three lines and everything else is
easier to debug afterwards.

## Shape

Move the fan-out to the browser, one request per persona. This is the pattern
`generateIndustryCatalog` in `roadmap.html` already uses — two passes, one call
per function — adopted for exactly this reason.

### Backend

**`POST /api/synthetic/persona`** — generates ONE persona.

```
{ clientName, industry, round, roundLabel, persona: { name, role },
  refresh: boolean, seeds: [...], hypotheses: [...] }
→ 200 { scores, findings, transcript, persona, round }
→ 502 { error: "persona_failed", category, role, round }
```

`category` is a SAFE classifier — `parse_failed` | `missing_fields` |
`provider_error` | `timeout` | `refused`. It must carry no model content: the
v5.32.29 audit finding made these codes stable precisely because a raw
`JSON.parse` message includes a snippet of the model output. A category is not a
snippet.

**`POST /api/synthetic/commit`** — takes the personas the browser collected,
writes the workspace keys and inserts the interview rows. This is the existing
route's second half, unchanged, minus the generation loop. It already:

- creates a login per persona and sets `interviewee_user_id` (v5.32.81 — keep
  this, it is what makes Request follow-up work)
- deletes prior rows matching `client_name` + `interviewee_name LIKE '%[Synthetic]'`

Keep `POST /api/synthetic/engagement` working for now. Removing it in the same
change makes a regression indistinguishable from the refactor.

### Round context — REQUIRED

The round is not a label. It selects what the persona knows and how they talk,
and getting this wrong produces round-2 interviews that read like round 1.

`synthPrompt(p, clientName, industry, refresh, seeds, hypotheses)` already takes
`refresh` and `seeds` — that is the existing round mechanism. The chunked route
must pass them per call, not assume them:

- **Round 1** — `refresh: false`, no seeds. The baseline diagnostic.
- **Round 2+** — `refresh: true`, `seeds` drawn from the PRIOR round's findings
  for that client. This is what makes a later round read as a follow-on rather
  than a repeat.
- `hypotheses` come from the client's Pre-Engagement record and apply to every
  round.

The browser must therefore generate rounds **in order** and feed round N−1's
findings into round N's seeds. Parallelising across personas within a round is
fine; parallelising across rounds is not, and would silently produce a round 2
with nothing to follow on from.

Read the existing `synthPrompt` and the `seeds` construction in the current
route before writing this. The rule above is what the code does today; the spec
is to preserve it through the refactor, not to invent it.

### Frontend

In `interviews.html`, replace the single fetch with a loop:

1. Resolve personas from the client's Pre-Engagement roles (the current route
   already does this — reuse that logic, or expose it as
   `POST /api/synthetic/personas`).
2. For each round in order, for each persona: call `/api/synthetic/persona`.
   Show progress — "3 of 10, round 1" — since the whole point is that a long
   job is now visible instead of silent.
3. **A failed persona does not stop the run.** Collect it, keep going, and
   report at the end: "8 of 10 generated. VP Sales / Revenue and CFO failed
   (response could not be parsed). Retry those two?" Partial results that
   survive beat complete results that time out.
4. Call `/api/synthetic/commit` with what succeeded.

Route 401s through `vyneAuth.handleAuthFailure` — that helper is written and
sitting uncommitted in the working tree from this session, not in any zip.
An expired session currently surfaces as "Generation failed: invalid_token".

## Tests

`test/synthetic.test.ts` is RLS-gated; run it with a database or it silently
skips:

```
RLS_TEST=1 TEST_DATABASE_URL=postgres://vyne:vyne@localhost:5433/vyne \
  RLS_APP_URL=postgres://vyne_app:apppw@localhost:5433/vyne npx vitest run test/synthetic.test.ts
```

Assertions that would have caught the bugs this replaces:

- a persona-level failure returns 502 with a category, and the category is
  **not** the raw error text
- one persona failing leaves the others intact and committable
- round 2 personas receive seeds derived from round 1's findings — assert on the
  prompt or the seeds passed, not merely that a round-2 row exists
- committed rows all carry `interviewee_user_id` (the v5.32.81 property), and a
  follow-up draft on one returns **201**, not 409
- rounds generate in order

Every one of these should be verified by reverting the fix and watching it fail.
Three test suites in this repo have passed with their subject removed; a test
that cannot observe the change it exists to prevent reports the property as held.

## Do first, separately

The three-line logging fix in `generateOne`'s retry loop. Log the caught error
and whether `scores`/`findings` were present, per attempt. Everything above is
easier to build once a failure says what it was, and it makes the Nissan case
diagnosable immediately — possibly before any of this is needed.
