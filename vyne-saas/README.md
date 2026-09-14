# VYNE SaaS — Phases 0-2 (foundation, index, Pre-Engagement, Interview Agent)

## Phase 2.5 — Distributed interviews (interviewee role)

The Interview Agent is now multi-user:

- **Interviewee role.** Client executives get their own logins (created from
  the Interview Tracker). They see ONE thing: their interview. The launcher,
  workspace store, engagements, and tracker are all closed to them (route
  guards + tests prove it).
- **Sanitized context.** The server hands interviewees a briefing slice with
  consultant-only material stripped — political sensitivity flags, field
  observations, PE/value-creation context — while keeping hypotheses so the
  agent still probes intelligently.
- **Private session namespaces.** Each interview persists to its own
  `iv_<id>` namespace. Interviewee A can never read B's session; consultants
  can read all of them.
- **Interview Tracker** (`interviews.html`): create invites (dev mode: just
  an id; Identity Platform mode: email+password in the firm's tenant), watch
  statuses flip invited → in progress → completed, download any session's
  raw state as JSON.
- **Status automation.** First save flips the interview to in_progress; the
  interviewee's "Finish & Submit" button marks completed (with timestamps).

Phase 2.5 test (dev mode): consultant creates an invite for `ada@client.com`
→ sign out → sign in as `ada@client.com` → only "Your Interview" appears,
prefilled and locked, gold banner on top → answer a question → sign back in
as consultant → tracker shows in progress → Ada finishes → completed.

## Phase 2 — AI Interview Agent

`interview_agent.html` is the migrated Interview Agent (same recipe: 3 LLM
call sites → `vyneLLM`, all storage → `vyneStore`, key UI removed, voice
features untouched — Web Speech API is client-side and unaffected).

**Shared workspace store.** The legacy modules pass work to each other
through shared keys (briefing → interview → synthesis), so from Phase 2 the
store persists under ONE namespace, `workspace`, for all modules. LLM calls
still meter under each module's own name. On first load, hydration
auto-migrates any Phase-1 keys from the old `pre_engagement` namespace —
existing briefings carry forward with no user action.

Phase 2 test: sign in → Pre-Engagement briefing exists → open Interview
Agent → it recognises the client/briefing (engagement dropdown) → run a short
interview turn (mic or typed) → scores render → `usage_events` shows
`interview_agent` rows.

Multi-tenant SaaS platform for the VYNE™ AI Readiness Diagnostic (Option B:
sold to customer firms). This repo is the Phase 0 foundation from the
migration plan: auth, tenancy, the LLM gateway, metering, and the manual
deploy runbook. Phase 1 (index + Pre-Engagement module) builds on this.

## Layout

```
backend/            Fastify + TypeScript API (Cloud Run)
  src/config.ts       env-driven config (secrets via Secret Manager in prod)
  src/db/             Postgres pool with tenant-scoped RLS transactions,
                      migration runner, 001_core.sql (schema + RLS policies)
  src/auth/           Identity Platform JWT verify + auth middleware
  src/tenant/         firm provisioning (IdP tenant + owner user + rows)
  src/llm/            THE GATEWAY: types, routing policy, adapters, metering
  src/routes/         health, signup, engagements, /api/llm/generate
  test/               gateway unit tests + RLS isolation integration test
frontend/           Phase 0 login shell (replaces the API-key landing page)
deploy/deploy.sh    manual runbook: apis | sql | sa | secrets | api | migrate | frontend
docker-compose.yml  local Postgres 16
```

## LLM provider policy (as decided)

| Context | Chain |
|---|---|
| Dev/testing default | **Gemini 2.5 Flash (AI Studio, free)** → Gemini Vertex → Claude Vertex |
| Production default | **Gemini 2.5 Flash (Vertex, paid/no-training)** → Claude Vertex |
| Premium tasks (`synthesis`, `strategy_deck`) | **Claude Sonnet (Vertex)** → Gemini Vertex |
| Other LLMs | OpenAI adapter included; new providers = one adapter file + a chain entry |

Free-tier adapters are **hard-blocked in production** (`blockFreeTier`) because
free-tier limits are per-account not per-tenant, and free-tier prompts may be
used by Google for product improvement — never acceptable for client data.
Every call is metered to `usage_events` (billing attaches to this later).

## Local dev

```bash
docker compose up -d postgres
cd backend && npm install
DATABASE_URL=postgres://vyne:vyne@localhost:5432/vyne npm run migrate
cp .env.example .env       # fill in GEMINI_API_KEY etc.
npm run dev                # http://localhost:8080/api/health
```

## Tests

```bash
cd backend
npm test                   # unit: gateway routing/fallback/free-tier/metering
npm run test:rls           # integration: RLS isolation (needs the compose DB)
```

`test:rls` is **the** Phase 0 acceptance test: it proves at the database that
Tenant A cannot SELECT/UPDATE/DELETE/INSERT across the tenant boundary, and
that a connection with no tenant context sees zero rows.

## Deploy (manual, by design)

`deploy/deploy.sh` documents the ordered steps. One-time: `apis`, `sql`, `sa`,
Identity Platform console setup (enable multi-tenancy), `secrets`. Every
release: `api` (Cloud Run) and/or `frontend` (Firebase Hosting), `migrate`
when migrations change.

## Phase 1 — what changed

**index.html** is now the authenticated app shell: login (Identity Platform
multi-tenant, or dev mode locally), module launcher, sign-out. The API-key
bar is gone for good.

**pre_engagement.html** is the migrated Pre-Engagement module. The rewire was
deliberately surgical (~3,000 lines of working logic untouched):

- Its 7 `fetch(api.anthropic.com)` call sites → `vyneLLM({...})`, a drop-in
  shim in `vyne-client.js` that POSTs to our authenticated
  `/api/llm/generate` gateway and returns an Anthropic-shaped response, so
  surrounding code needed zero changes. Multimodal document-intelligence
  calls (base64 PDFs / diagram images) are supported end-to-end — the
  gateway translates blocks per provider (Gemini `inline_data`, Claude
  native, OpenAI images-only).
- Its ~46 `localStorage` touches → `vyneStore`, a synchronous
  localStorage-compatible facade hydrated from the tenant-scoped
  `/api/module-state` store at page load, with debounced write-back.
  Cross-device persistence and RLS isolation for free; the module's own
  logic unchanged.
- All API-key UI/plumbing removed; a hidden constant satisfies legacy
  `if(!apiKey)` guards. Zero key material, zero direct provider calls, zero
  `dangerous-direct-browser-access` anywhere in the frontend.

**Local end-to-end run (no GCP needed):**

```bash
docker compose up -d postgres
cd backend && npm install
DATABASE_URL=postgres://vyne:vyne@localhost:5432/vyne npm run migrate
DATABASE_URL=postgres://vyne:vyne@localhost:5432/vyne npm run seed:dev
DATABASE_URL=postgres://vyne_app:change-me-via-ops@localhost:5432/vyne \
  DEV_AUTH=1 GEMINI_API_KEY=<your-ai-studio-key> npm run dev
# open http://localhost:8080 → sign in as dev-owner → Pre-Engagement Briefing
```

`DEV_AUTH=1` (blocked in production builds) swaps Identity Platform for a
local verifier and serves the frontend same-origin, so the entire flow —
login → hydration → AI generation on free Gemini Flash → server persistence —
runs on a laptop.

## Phase 1 acceptance checklist

- [x] 21/21 automated tests green (gateway unit, RLS isolation, HTTP API
      integration incl. cross-tenant module-state isolation and metering)
- [x] Zero `api.anthropic.com` / `x-api-key` / `localStorage` references in
      the migrated module (static gate)
- [x] All inline script blocks parse after transformation
- [x] Dev-mode smoke: login → hydrate → write state → re-hydrate → create
      engagement, all via HTTP
- [ ] Manual UX pass in a browser (generate briefing on Gemini, then flip
      `LLM_DEFAULT_CHAIN` to Claude and repeat) — needs your API keys
- [ ] Deploy to GCP per `deploy/deploy.sh` and repeat the pass online

## Phase 0 acceptance checklist

- [ ] `npm test` green (gateway behavior)
- [ ] `npm run test:rls` green (tenant isolation proven at the DB)
- [ ] `/api/signup` provisions a firm; owner can sign in via the shell page
- [ ] Same `generate()` succeeds on Gemini and Claude by config switch only
- [ ] Forced primary failure → fallback provider serves the call
- [ ] Every call writes a `usage_events` row
- [ ] No provider key appears in any frontend file or network response
