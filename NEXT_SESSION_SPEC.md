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
