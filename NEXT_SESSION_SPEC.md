# VYNE — Next Session Build Queue (agreed with Kishore, Aug 2026)

Current state: Phases 0–3.2 complete and user-verified (see README). Three
modules live (Pre-Engagement, Interview Agent, Synthesis), distributed
interviews with pause/resume, tracker with edit/delete, natural voice both
directions.

## 1. Follow-up interviews (MUST-HAVE — build first)

Post-synthesis, consultants need targeted follow-ups with specific
interviewees, run distributed (interviewee's own login).

**Critical design constraint:** follow-up agendas derive from OTHER
interviewees' answers. Nothing may reach a client member that exposes a
colleague's specific statements. Two safeguards:
1. Agenda items are auto-drafted from synthesis phrased function-level
   (conditions, never "X said"), AND
2. A consultant REVIEWS AND APPROVES/edits the agenda in the tracker before
   the interviewee can see the follow-up. No approval → no follow-up visible.

**Build:**
- Migration: `interviews.kind` ('initial'|'follow_up'), `parent_interview_id`,
  `agenda` jsonb (approved items), `agenda_status` ('draft'|'approved').
- Tracker: "Request follow-up" on completed rows → agenda review screen
  (draft from synthesis outputs for that person's role) → approve.
- Interviewee welcome screen: third option "You have a follow-up interview"
  (only when an approved follow-up exists). Runs a short session seeded ONLY
  with the approved agenda + sanitized briefing.
- Tracker shows follow-up rows linked to their parent interview.

## 2. Pre-interview topic preview (build second)

Interviewees can prepare — but show TOPICS, not the literal question list
(the agent adapts; exact questions invite rehearsed answers).

**Build:**
- Welcome screen: "Preview what we'll discuss" → renders from the sanitized
  bootstrap: dimensions scoped to their role (roleCatalog priorityDims),
  2–3 representative issue-tree questions per dimension
  (briefingContext.issueTreeQuestions), plus a "useful to have handy" note.
- Printable/simple layout. No new backend needed — data already in
  /api/interviews/mine/bootstrap.

## 3. Then (existing queue)
- Tracker → Synthesis auto-flow (completed interviews appear in the
  Synthesis Dashboard without manual JSON export/import).
- Phase 4: AI Roadmap Builder migration (largest module, ~10K lines).
- Phase 5: Solution Design Studio. Phase 6: Scorecard + Persona Simulator.
- GCP deployment (deploy/deploy.sh; Identity Platform + Vertex).

## Session-start reminder
Dev run: Postgres.app running → backend `npm run dev` one-liner with
DEV_AUTH=1, GEMINI_API_KEY, GEMINI_MODEL=gemini-3.5-flash-lite,
GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview. Consultant login: dev-owner.

---

## Backlog — voice harness spend is invisible to the product (added 2026-09-13)

`deploy/voice-record.mjs` mints its Live grant **directly from Google** and
never calls our backend — a grep for `vyneLlmBase`, `vyne-api` or any
`/api/...` URL it actually fetches returns zero. The consequence is that a
30-minute recording is real money on the Google bill and writes **no
`usage_events` row at all**, so it appears nowhere on the Cost by Client
dashboard and in no statement.

Measured on the 2026-09-13 runs, priced with our own `llm/types.ts` table
(`gemini-3.1-flash-live-preview`, $1.00 in / $20.00 out per 1M) and the
~25 tokens-per-second-of-speech figure documented there:

| run | interviewer speech | approx cost |
|---|---|---|
| shipped persona (v5.34.74+) | 262s of 1805s | ~$0.13 |
| harness stub persona        | 1047s of 1805s | ~$0.52 |
| Sep 12, 2.5-native-audio    | 567s of 1805s | ~$0.28 |

Cross-checks against the "about $1.80 per hour the model actually talks" note
already in types.ts. Pennies per run, so this is not urgent — it is on the
list because it is the same class of gap as the billing ghosts cleaned up the
same day: money that happened, with nothing in the system saying so.

**Fix:** have the harness mint through `POST /api/voice/live-session` the way
the browser does, so the reservation, the metering and the close all run. It
needs an auth token available to a headless script, which is the only reason
it was not done at the time — see the "What it does NOT prove" header in
voice-record.mjs, which already documents the route being bypassed and why
(a cap refusal must not be mistakable for a voice fault). Any fix has to keep
that property: metering yes, budget refusal still out of the way.

Not blocking. Do it when the harness next needs work.

---

## Backlog — the harness interviewee is a tape, so a long run is mostly fiction (added 2026-09-14)

`deploy/voice-record.mjs` answers with eight fixed sentences. A question-and-
answer cycle takes about fourteen seconds, so the scripted interviewee has said
everything it knows inside **two minutes**. Everything after that was the same
eight answers again, and again, for the rest of the booked time.

v5.34.78 stops the run at the end of the script (`--loop` restores the soak),
which removes the false measurement and the wasted spend. It does not give us
a long run worth having — and we still need one, because the **~10-minute
session handover** cannot be reached in two minutes. Today the only way there
is `--loop`, whose verdict cannot be read for question quality, repetition or
coverage: past answer eight the interviewer is responding to a tape.

**Fix:** generate the interviewee's side, turn by turn, from the actual
question — a small text model behind the existing `speak()`, with a persona
holding the same facts the eight canned answers hold, plus enough substance to
sustain half an hour. The harness already caches TTS per answer; that cache
becomes per-turn instead.

**What it costs to not do:** the handover path, the one thing a long run exists
to exercise, is currently only ever checked offline (stage 2) against a stub.

**Constraint any fix must keep:** the interviewee must not be the same model
instance as the interviewer, and must never see the interviewer's instruction —
otherwise the run measures a model agreeing with itself.

Not blocking. Needed before the next long live run is worth its cost.
