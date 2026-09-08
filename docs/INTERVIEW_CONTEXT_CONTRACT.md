# What context reaches the interview agent, exactly

_v5.32.86. Every field below was read from the code, not recalled. File and
function references are given so each claim can be checked._

There are **two entirely separate mechanisms**, and they share no code and no
storage. Both are commonly called "a follow-up", which is the source of most of
the confusion.

| | Follow-up interview | Refresh interview (Round 2, 3, …) |
|---|---|---|
| Started from | Interview Tracker → **Request follow-up** | Synthesis → **Close Round**, then the agent's **Refresh Interview** tab |
| Built by | `POST /api/interviews/:id/followup/draft` (backend) | `confirmCloseRound()` in `synthesis.html` (browser) |
| Stored in | `interviews.agenda` (jsonb, one row) | `vynora_refresh_agenda_<CODE>` + `vynora_refresh_context_<CODE>` (workspace) |
| Reaches the agent via | `GET /api/interviews/mine/bootstrap` | the workspace store, read directly |
| Who runs it | the **interviewee**, logged in | the **consultant**, from the Refresh tab |
| Scope | one person, one parent interview | a whole round, per person |
| Synthesis involved? | **No.** It reads the engagement record directly. | Yes — it is the only writer. |

---

## 1. Follow-up interview

### What the draft is built from

`routes/interviews.ts`, the `followup/draft` handler:

1. Resolves the client's engagement code from `vynora_engagement_index`, then
   loads `vynora_engagement_<CODE>`.
2. Takes **`rounds[rounds.length - 1]`** — see the defect note below.
3. Walks that round's interviews, **excluding this interviewee's own** by
   `sourceInterviewId`, falling back to a role match when the id is absent.
4. Groups the remaining findings by dimension, keeping at most **2 texts per
   dimension**, then caps the agenda at **8 dimensions**.
5. Emits one item per dimension:

```json
{ "dimension": "D1",
  "text": "Revisit Data & Data Management — we would like your current view on how this is working in practice, and what has changed since we last spoke.",
  "evidence": ["<colleague's verbatim finding>", "<a second one>"] }
```

`text` is a **fixed neutral probe** from `neutralAgendaProbe(dimension)`. It is
not generated and contains nothing specific to the engagement. When no findings
are available at all, the agenda falls back to a single generic D1 item.

The row is written with `kind='follow_up'`, `agenda_status='draft'`,
`parent_interview_id`, and the parent's `interviewee_user_id`. **It is invisible
to the interviewee until a consultant approves it** — the bootstrap query
filters `AND (kind = 'initial' OR agenda_status = 'approved')`.

### What actually reaches the agent

`GET /api/interviews/mine/bootstrap` returns `{ interview, injected, own }`.

**`interview.agenda`** — passed through `projectAgendaForInterviewee()`, which
keeps `{dimension, text}` and **drops `evidence` entirely**. The colleagues'
verbatim sentences are consultant-only and never leave the server for an
interviewee.

**`injected`** — workspace keys, filtered three times:

- dropped if they match `BLOCKED_PREFIXES` = `vynora_refresh_agenda_`,
  `vynora_refresh_context_`, `vynora_api_key`, `vynora_last_briefing`
- kept only if they match `CONSULTANT_SAFE_PREFIXES` = `vynora_briefing_`,
  `vynora_engagement_`, `vynora_engagement_index`, `vynora_code_index`
- scoped to the interviewee's own client by `filterWorkspaceState`

and then two are rewritten:

- `vynora_briefing_*` → `sanitizeBriefing()`: an allowlist of fields, with
  hypotheses projected down.
- `vynora_engagement_<CODE>` → `sanitizeEngagementForInterviewee(raw, ownRoundNumber)`.
  Per round it keeps `roundId, roundNumber, label, type, date, status,
  scopeDimensions, whatChanged, benchmarks, benchmarkTrends, benchmarkBasis,
  benchmarkConfidence`, and adds `scores` plus `findingsByDimension` (one
  finding text per dimension, no attribution) **only for rounds that are both
  strictly before the interviewee's own round number and not the engagement's
  current round**. The raw `interviews` array is dropped in every case.

**`own`** — the interviewee's own private session namespace.

### What ends up in the prompt

`interview_agent.html` sets `S.followUpAgenda = iv.agenda`, and
`buildSystemPrompt()` emits:

```
THIS IS A FOLLOW-UP INTERVIEW — not a full re-run. The consulting team has
approved the specific topics below, drawn from the wider engagement, for you to
probe with this stakeholder. Do NOT repeat a full initial-interview pass; focus
the conversation on these topics, ask sharp follow-up questions on each, and
re-score only the dimensions they touch:
- [D1] Revisit Data & Data Management — …
- [D6] Revisit Governance & Risk — …
```

plus whatever `loadBriefingContext()` derives from the sanitized engagement.

**So a follow-up prompt carries dimensions and a generic probe per dimension —
nothing a colleague actually said.**

### One defect to check

Step 2 takes `rounds[rounds.length - 1]`: the **last element of the array**, not
the highest round number. Everywhere else in the product that question is
answered by `VyneScoring.sortRounds` / `latestRound`, which exist precisely
because the two differ — `frontend/test/synthesis-e2e.mjs`'s own fixture is
built with the rounds array in `[2, 1]` order and calls it "the F23 case that
became reachable when v5.32.55 let a consultant pin a round number".

On an engagement whose rounds array is out of order, the follow-up agenda is
therefore drafted from the **wrong round's** findings. Not yet confirmed against
a real engagement — the array is usually in order — but the ordering assumption
is one the codebase has already been bitten by once.

---

## 2. Refresh interview — Round 2, Round 3, …

Written by **Close Round** in Synthesis, which is the only writer of these keys.

### `vynora_refresh_agenda_<CODE>`

```
engagementCode, clientName, roundClosed, roundLabel, generatedAt,
trigger, eventDescription,
byRole:   { "COO": { isNewRole, agendaItems: [...] } },
byPerson: { "COO||Cara Diaz": { role, person, label, isNewRole, agendaItems: [...] } }
```

`byPerson` is v5.32.86; `byRole` is kept so agendas already written into
production workspaces still load. The agent prefers `byPerson`.

Four kinds of `agendaItems`, from four sources:

| Source | Item fields | Routed to |
|---|---|---|
| **A. Contradiction** (`detectConflicts`, spread ≥ 1.5) | `type, dimension, gap, question, round1ScoreHigh, round1ScoreLow, counterpartHigh, counterpartLow` | the **two people** on either side |
| **B. Hypothesis** (verdict contradicted / unresolved) | `type, verdict, hypothesis, question, routedTo, routedToRole, routedToPerson, routingBasis, routingScore, routingReason` | the **person** with the lowest score on a linked dimension |
| **C. Blind spot** (`whoShouldAddress`) | `type, topic, question, isNewRole` | **everyone holding** each named role |
| **D. Custom focus** (consultant-added) | `type, dimension, dimensions, consultantDirected, note, question` | everyone holding the chosen role |

Items the consultant has manually resolved are excluded, and a contradiction
whose gap has since narrowed is auto-resolved.

### `vynora_refresh_context_<CODE>` — "Tier-2", deliberately not put in the prompt wholesale

```
engagementCode, generatedAt,
round1Summaries: { "COO||Cara Diaz": { scores, findings (≤5 texts), name, role, label } },
round1ByRole:    { "COO": { … } },                       // compatibility only
synthesisVerdicts: { hypothesisVerdict, blindSpots, strategicImplications }
```

Two things worth knowing about this file:

- **`round1Summaries` is a misnomer after round 1.** It is built from
  `getActiveRoundInterviews()` at close time, so closing round 2 writes
  *round-2* summaries under that name. The data is right; the name is not.
- **`synthesisVerdicts` arrives and is never read.** It is parsed into
  `refreshCtxData` with the rest of the file, and the string
  `synthesisVerdicts` does not appear anywhere in `interview_agent.html` — the
  only field that object is ever consulted for is the persona summary. The
  verdicts, blind spots and strategic implications reach the browser and go
  nowhere. Harmless, and dead payload.

Close Round also writes `vynora_hypothesis_verdicts_<CODE>` for the next round's
Pre-Engagement refresh.

### What ends up in the prompt

`buildRefreshSystemPrompt(role, entry, mandatoryCount, who)`:

```
REFRESH INTERVIEW — Round 2
Client: Acme Industrial
This is a follow-up driven by the previous round's synthesis (resolving
contradictions, open hypotheses, and blind spots).

YOUR PERSONA: COO (Dev Rao)
You participated in Round 1 of this engagement.

YOUR OWN ROUND 1 VIEW (only on the areas being revisited today):
• D5: you assessed this around 4/5
```

then their **own** findings, filtered to today's agenda dimensions, then the
agenda items' `question` text, then a question budget of roughly three questions
per item.

`computeRefreshScope(entry)` restricts everything to the dimensions today's
agenda actually touches — so a round-2 interview does not re-ask the whole
diagnostic.

**Consultant-only, and excluded from the prompt:** `routingReason`, `gap`,
`round1ScoreHigh` / `round1ScoreLow`, `type`, `topic`, `note`,
`consultantDirected`, and the hypothesis wording. The interviewee-facing preview
sheet is stricter still — `generateRefreshIntervieweePreview` maps each item down
to `{question, dimension}` before it goes anywhere near a model.

### Round 3 and beyond

The mechanism is round-agnostic: `roundClosed` is whatever round was closed, and
the prompt says "Round N+1" and "you participated in Round N".

**Only the most recently closed round is carried.** Closing round 2 overwrites
`vynora_refresh_agenda_<CODE>` and `vynora_refresh_context_<CODE>` in place, so a
round-3 interview receives the round-2 picture and no round-1 history. That is
consistent with the design — each refresh follows on from the round before it —
but it means there is no cumulative view across three rounds anywhere in the
prompt, and a pending round-2 agenda is destroyed if round 2 is closed before it
is used.

---

## The short version

- **Follow-up**: dimension list + a fixed neutral probe per dimension. Colleagues'
  sentences are attached as consultant-only `evidence` and stripped before the
  interviewee's browser sees them.
- **Refresh**: the person's **own** prior scores and findings, restricted to the
  dimensions on today's agenda, plus neutral question text per agenda item.
  Everything explaining *why* they were selected stays with the consultant.
- Neither carries another person's attributed material into the prompt. That was
  true between roles from v5.32.29, and true between two people sharing a role
  only from v5.32.86.
