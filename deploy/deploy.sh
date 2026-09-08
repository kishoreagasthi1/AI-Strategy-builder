#!/usr/bin/env bash
# =============================================================================
# VYNE SaaS — manual deploy runbook (Phase 0)
# One script, ordered steps, run by hand. CI/CD comes in a later phase.
#
# Prereqs: gcloud CLI authenticated; firebase CLI for hosting.
# Fill in the variables below, then run sections top to bottom.
# Sections are idempotent unless marked ONE-TIME.
# =============================================================================
set -euo pipefail

# v5.34.2: `test` is a pure-LOCAL target — it runs the backend suite and needs
# no GCP project, so short-circuit it here, BEFORE the gcloud setup below, so it
# is usable from CI on a checkout with no cloud credentials. The deploy targets
# still run the same suite as a gate via run_tests() (they have gcloud anyway).
if [ "${1:-}" = "test" ]; then
  ( cd "$(dirname "$0")/../backend" && npx vitest run )
  exit $?
fi

# v5.34.3: `itest` is the INTEGRATION gate — the full suite against a real
# Postgres (the ~250 RLS-gated tests a bare `test` skips). Also pure-local and
# CI-friendly; it provisions its own database. Run it before a release.
if [ "${1:-}" = "itest" ]; then
  exec "$(dirname "$0")/it-db.sh"
fi

# v5.32.74: this was `${PROJECT_ID:?set PROJECT_ID}`, which aborts the moment
# you deploy from a shell where you have not exported it — a fresh terminal, a
# reboot, a second tab. It cost two deploy attempts on a release carrying a
# security fix. Fall back to the project gcloud is ALREADY pointed at, which is
# the value the very next line would set anyway, and say out loud which one was
# chosen so an unexpected project is visible rather than silent.
if [ -z "${PROJECT_ID:-}" ]; then
  PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
  if [ -z "${PROJECT_ID}" ] || [ "${PROJECT_ID}" = "(unset)" ]; then
    echo "PROJECT_ID is not set and gcloud has no default project." >&2
    echo "  export PROJECT_ID=vyne-platform-prod" >&2
    exit 1
  fi
  echo ">> PROJECT_ID not exported — using gcloud's current project: ${PROJECT_ID}"
fi
REGION="${REGION:-us-central1}"
CLAUDE_REGION="${CLAUDE_REGION:-global}"       # Claude on Vertex's serving location (v5.32.1: was us-east5, now stale)
SQL_INSTANCE="vyne-sql"
SERVICE="vyne-api"
# v5.34.0 (perf review, item 7): the OPTIONAL second Cloud Run service that
# runs LLM/voice generation, so a burst of multi-second generations can't
# consume the data service's request slots and stall /api/module-state. Same
# container image and code — only the frontend routing (window.VYNE_LLM_BASE)
# and the scaling knobs differ. Deployed on demand with `deploy.sh llm`; until
# an operator sets window.VYNE_LLM_BASE to this service's URL, nothing routes
# to it and it can be left undeployed.
LLM_SERVICE="vyne-llm"
DB_NAME="vyne"
DB_APP_USER="vyne_app"
# v5.32.29 (audit H-4): the API's CORS allow-list. The server refuses to boot in
# production without it, because the fallback used to be "reflect any origin".
# Default to the Firebase Hosting origin this project deploys the frontend to;
# override for a custom domain.
APP_BASE_URL="${APP_BASE_URL:-https://${PROJECT_ID}.web.app}"

gcloud config set project "$PROJECT_ID"

# ── 1. ONE-TIME: enable APIs ─────────────────────────────────────────────────
enable_apis() {
  gcloud services enable \
    run.googleapis.com \
    sqladmin.googleapis.com \
    aiplatform.googleapis.com \
    identitytoolkit.googleapis.com \
    secretmanager.googleapis.com \
    storage.googleapis.com \
    vpcaccess.googleapis.com \
    cloudbuild.googleapis.com
}

# ── 2. ONE-TIME: Cloud SQL Postgres (private IP recommended; start simple) ──
create_sql() {
  gcloud sql instances create "$SQL_INSTANCE" \
    --database-version=POSTGRES_16 \
    --tier=db-g1-small \
    --region="$REGION" \
    --storage-size=10GB
  gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE"
  # v5.32.29 SECURITY (audit H-5). Migration 001 creates vyne_app with the
  # literal password 'change-me-via-ops', and this step used to do nothing but
  # PRINT a reminder to change it. That is not a normal default-credential
  # problem: RLS is the tenant-isolation story, RLS keys off
  # current_setting('app.tenant_id'), and anyone connecting directly as
  # vyne_app sets that themselves — so the password IS the boundary between
  # one firm's interviews and every firm's interviews.
  #
  # It is now generated here, rotated on the role, and written to Secret
  # Manager, so no human ever chooses it and no default survives the install.
  local APP_PW
  APP_PW="$(openssl rand -base64 33 | tr -d '\n/+=' | cut -c1-40)"
  local OWNER_PW
  OWNER_PW="$(openssl rand -base64 33 | tr -d '\n/+=' | cut -c1-40)"
  gcloud sql users create vyne --instance="$SQL_INSTANCE" --password="$OWNER_PW"
  printf '%s' "$OWNER_PW" | gcloud secrets create vyne-db-owner-password --data-file=- 2>/dev/null \
    || printf '%s' "$OWNER_PW" | gcloud secrets versions add vyne-db-owner-password --data-file=-
  printf '%s' "$APP_PW" | gcloud secrets create vyne-db-app-password --data-file=- 2>/dev/null \
    || printf '%s' "$APP_PW" | gcloud secrets versions add vyne-db-app-password --data-file=-
  echo ">> Owner and app passwords generated and stored in Secret Manager"
  echo "   (vyne-db-owner-password, vyne-db-app-password)."
  echo ">> Migration 001 creates $DB_APP_USER with a placeholder. Immediately"
  echo "   after running migrations, rotate it to the generated value:"
  echo "     ALTER ROLE $DB_APP_USER PASSWORD '<vyne-db-app-password>';"
  echo "   then build vyne-database-url from it. rotate_app_password does both."
}

# ── 2b. Rotate the app role's password from Secret Manager ───────────────────
# Idempotent; run it after the first migrate and any time you want to rotate.
rotate_app_password() {
  local APP_PW
  APP_PW="$(gcloud secrets versions access latest --secret=vyne-db-app-password)"
  [ -n "$APP_PW" ] || { echo "!! vyne-db-app-password not found — run ./deploy/deploy.sh sql first"; exit 1; }
  echo ">> Connect as the OWNER (cloud-sql-proxy in another terminal) and run:"
  echo "     ALTER ROLE $DB_APP_USER PASSWORD '$APP_PW';"
  echo ">> Then store the connection string the API actually uses:"
  echo "     printf '%s' \"postgres://$DB_APP_USER:\$APP_PW@/$DB_NAME?host=/cloudsql/${PROJECT_ID}:${REGION}:${SQL_INSTANCE}\" \\"
  echo "       | gcloud secrets versions add vyne-database-url --data-file=-"
  echo ">> Verify the placeholder is gone (this MUST fail):"
  echo "     PGPASSWORD=change-me-via-ops psql -h 127.0.0.1 -U $DB_APP_USER $DB_NAME -c 'select 1'"
}

# ── 3. ONE-TIME: service account for the API (least privilege) ───────────────
create_service_account() {
  gcloud iam service-accounts create vyne-api-sa --display-name="VYNE API"
  local SA="vyne-api-sa@${PROJECT_ID}.iam.gserviceaccount.com"
  # Vertex AI calls (Gemini + Claude in Model Garden)
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA" --role="roles/aiplatform.user"
  # Identity Platform admin (tenant + user provisioning)
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA" --role="roles/firebaseauth.admin"
  # Cloud SQL connection
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA" --role="roles/cloudsql.client"
  # v5.32.29 (audit M-9). This was a PROJECT-level secretAccessor grant —
  # every secret in the project, including ones added later, for a service
  # that consumes exactly one. Bound to the single secret instead, so an SSRF
  # or RCE in the API inherits access to that one string and nothing else.
  gcloud secrets add-iam-policy-binding vyne-database-url \
    --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
}

# ── 4. ONE-TIME: Identity Platform ───────────────────────────────────────────
# Console step (no clean CLI): Identity Platform → enable → Settings →
# "Allow tenants" ON. Email/password provider enabled per tenant at
# provisioning time by the API. Note the API key for the frontend config.

# ── 5. Secrets (repeat when a key rotates) ───────────────────────────────────
put_secrets() {
  echo -n "${DATABASE_URL:?set DATABASE_URL}" | \
    gcloud secrets create vyne-database-url --data-file=- 2>/dev/null || \
    echo -n "$DATABASE_URL" | gcloud secrets versions add vyne-database-url --data-file=-
  # Optional extra providers:
  # echo -n "$OPENAI_API_KEY" | gcloud secrets create vyne-openai-key --data-file=-
}

# ── 6. Deploy the API (repeat every backend release) ─────────────────────────
# IMPORTANT: --update-secrets / --update-env-vars (MERGE) here, never
# --set-secrets / --set-env-vars (REPLACE). The set- variants wipe out any
# secret/env var not explicitly listed on this line — that's a real incident
# that happened in production (FIREBASE_API_KEY, SIGNUP_ACCESS_KEY,
# REQUIRE_MFA, etc. all silently vanished from a live revision). The
# --add-cloudsql-instances flag is idempotent and safe to repeat.
# v5.32.30: the script used to set only four variables, so a firm deployed
# purely from it had no Firebase config (the login bootstrap fails), no
# operator key (firm provisioning is closed), no MFA enforcement and no TTS.
# Anything exported in the invoking shell is now passed through — absent ones
# are simply omitted, so this stays safe to re-run.
_extra_env() {
  local out=""
  for v in FIREBASE_API_KEY FIREBASE_AUTH_DOMAIN SIGNUP_ACCESS_KEY \
           REQUIRE_MFA REQUIRE_VERIFIED_EMAIL SENTRY_DSN \
           STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_ENFORCE_PAYWALL \
           GEMINI_API_KEY GEMINI_PAID_TIER; do
    if [ -n "${!v:-}" ]; then out="${out},${v}=${!v}"; fi
  done
  printf '%s' "$out"
}

# ── Version lockstep (single source of truth = repo-root VERSION file) ───────
# sync_version stamps VERSION into the backend + frontend files before EVERY
# build, so whichever side you deploy always carries the same string — the two
# can no longer drift at the source. verify_versions closes the other half of
# the gap the About page exposed: after a deploy it reads the LIVE backend
# version and checks it equals VERSION, so a half-landed release (api out,
# frontend not — or vice versa) fails loudly at deploy time instead of being
# noticed later on the version page.
sync_version() {
  bash "$(dirname "$0")/sync-version.sh"
}

verify_versions() {
  local V
  V="$(tr -d ' \t\n\r' < "$(dirname "$0")/../VERSION")"
  echo ">> Verifying the live backend at ${APP_BASE_URL} reports v${V} ..."
  local BE
  BE="$(curl -fsS "${APP_BASE_URL}/api/version" 2>/dev/null | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ -z "$BE" ]; then
    echo "!! Could not read ${APP_BASE_URL}/api/version — cannot confirm parity." >&2
    echo "   Check the About page manually once the app is reachable." >&2
    return 1
  fi
  if [ "$BE" = "$V" ]; then
    echo ">> OK — backend v${BE} matches the frontend bundle (v${V}). In lockstep."
  else
    echo "!! VERSION MISMATCH — backend reports v${BE} but this release is v${V}." >&2
    echo "   One side did not land. Re-run the side that is behind:" >&2
    echo "     backend behind  -> ./deploy/deploy.sh api" >&2
    echo "     frontend behind -> ./deploy/deploy.sh frontend" >&2
    return 1
  fi
}

# ── Release gate: the backend test suite ─────────────────────────────────────
# v5.34.2 (perf-review follow-up). Runs `npx vitest run` in backend/ before any
# deploy and ABORTS on failure (set -e). This is where source/test drift fails
# loudly: the frontend STATIC-ASSERTION tests — designStudio, innerHtmlSinks,
# htmlAccumulatorSinks, securityAuditFixes, and the version-parity test — live
# in this suite, NOT in the frontend .mjs e2e set, so nothing else on the deploy
# path was catching them. Five had drifted silently before this gate existed.
#
# Runs at most once per invocation (the guard), so `all` doesn't run it twice.
# Requires backend dev deps installed (npm ci in backend). SKIP_TESTS=1 is a
# deliberate, loud escape hatch for a genuine emergency — a hotfix during an
# incident must not be blocked by an unrelated red test — and nothing else.
_TESTS_RAN=0
run_tests() {
  [ "${_TESTS_RAN}" = "1" ] && return 0
  if [ "${SKIP_TESTS:-0}" = "1" ]; then
    echo ">> SKIP_TESTS=1 — backend test gate BYPASSED. Emergency use only." >&2
    _TESTS_RAN=1
    return 0
  fi
  echo ">> Release gate: running the backend test suite (npx vitest run) ..."
  echo "   This is what catches source/test drift before it ships."
  ( cd "$(dirname "$0")/../backend" && npx vitest run )
  _TESTS_RAN=1
  echo ">> Backend tests passed — proceeding."
}

deploy_api() {
  sync_version
  run_tests
  EXTRA_ENV="$(_extra_env)"
  if [ -z "$EXTRA_ENV" ]; then
    echo ">> NOTE: no optional env vars exported — deploying with the four core"
    echo "   settings only. Firebase login config, the operator key, Stripe and"
    echo "   TTS will be whatever the existing revision already has."
  fi
  ( cd "$(dirname "$0")/../backend" &&
    gcloud run deploy "$SERVICE" \
      --source . \
      --region "$REGION" \
      --service-account "vyne-api-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
      --add-cloudsql-instances "${PROJECT_ID}:${REGION}:${SQL_INSTANCE}" \
      --update-secrets "DATABASE_URL=vyne-database-url:latest" \
      `# v5.33.23 (scalability): cap the per-instance pool so the CROSS-instance` \
      `# total can't exceed the database's connection ceiling. PGPOOL_MAX=8 ×` \
      `# --max-instances 5 = 40 connections, which fits db-g1-small; the old` \
      `# default (20) × 5 = 100 would have the DB refusing connections at ~3-4` \
      `# instances. When the DB tier grows (or a pooler is added), raise both.` \
      --update-env-vars "NODE_ENV=production,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},VERTEX_LOCATION=${CLAUDE_REGION},APP_BASE_URL=${APP_BASE_URL},PGPOOL_MAX=${PGPOOL_MAX_CONF:-8}${EXTRA_ENV}" \
      --allow-unauthenticated \
      `# --min-instances 1: keep one instance warm so the first request after` \
      `# idle doesn't pay a cold start + schema/RLS assertion queries on the` \
      `# user-facing path (small always-on cost, big tail-latency win).` \
      --min-instances 1 --max-instances 5 \
      `# v5.32.58 / v5.33.23: Cloud Run's 80-concurrent default is throttled to` \
      `# match the pool so requests don't queue forever on connect(). Kept EQUAL` \
      `# to PGPOOL_MAX above (8) — pool == concurrency is the invariant that` \
      `# avoids in-instance connection starvation.` \
      --concurrency "${PGPOOL_MAX_CONF:-8}" )
}

# ── 6b. Deploy the OPTIONAL generation service (perf review item 7) ──────────
#
# vyne-llm runs the SAME image as vyne-api. Point the frontend's generation
# calls at it by setting window.VYNE_LLM_BASE to this service's URL (leave it
# unset and every generation call stays on vyne-api — the default). Splitting
# gives long generations their own concurrency/timeout/scaling so they never
# occupy vyne-api's request slots.
#
# DB CONNECTION BUDGET — read before enabling. Each service demands up to
# PGPOOL_MAX × max-instances connections, and BOTH now hit the same
# db-g1-small (max_connections ~25–50). vyne-llm defaults are deliberately
# small (pool 4 × 5 instances = 20). If you enable the split, LOWER vyne-api to
# match — e.g. PGPOOL_MAX_CONF=4 ./deploy/deploy.sh api → 4 × 5 = 20 — so the
# COMBINED total (20 + 20 = 40) still fits, or move to a bigger tier / a
# connection pooler first. The pool == concurrency invariant is kept per
# service.
#
# min-instances 0: generation is bursty and a cold start is negligible next to
# a multi-second generation, so this service scales to zero when idle (no
# always-on cost). Its own long request timeout lets heavy synthesis finish —
# and because clients reach it directly, it is not behind Firebase Hosting's
# hard 60-second proxy limit.
deploy_llm() {
  sync_version
  run_tests
  EXTRA_ENV="$(_extra_env)"
  ( cd "$(dirname "$0")/../backend" &&
    gcloud run deploy "$LLM_SERVICE" \
      --source . \
      --region "$REGION" \
      --service-account "vyne-api-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
      --add-cloudsql-instances "${PROJECT_ID}:${REGION}:${SQL_INSTANCE}" \
      --update-secrets "DATABASE_URL=vyne-database-url:latest" \
      --update-env-vars "NODE_ENV=production,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},VERTEX_LOCATION=${CLAUDE_REGION},APP_BASE_URL=${APP_BASE_URL},PGPOOL_MAX=${LLM_PGPOOL_MAX:-4}${EXTRA_ENV}" \
      --allow-unauthenticated \
      --min-instances "${LLM_MIN_INSTANCES:-0}" --max-instances "${LLM_MAX_INSTANCES:-5}" \
      `# pool == concurrency, same invariant as vyne-api.` \
      --concurrency "${LLM_PGPOOL_MAX:-4}" \
      `# Heavy synthesis can run minutes; give the request room (Cloud Run caps` \
      `# at 3600). Reached directly, so NOT under the 60s Firebase proxy limit.` \
      --timeout "${LLM_TIMEOUT:-900}" )
  echo ">> Deployed ${LLM_SERVICE}. To route generation to it, set the frontend"
  echo "   window.VYNE_LLM_BASE to this service's URL:"
  echo "     gcloud run services describe ${LLM_SERVICE} --region ${REGION} --format='value(status.url)'"
  echo ">> REMEMBER the shared DB budget: lower vyne-api's pool to match, e.g."
  echo "     PGPOOL_MAX_CONF=4 ./deploy/deploy.sh api"
}

# ── 7. Migrations (repeat when migrations change) ────────────────────────────
#
# v5.32.83: this printed port 5432, and 5432 is the LOCAL Postgres on the
# machine this is run from. Following it migrates the developer's own database,
# reports "Applied: …" in the same words a real migration does, and leaves
# production untouched — the exact failure the handoff conventions warn about,
# printed by the runbook meant to prevent it. deploy/preflight.sh has always
# defaulted PROXY_PORT to 5433; these two disagreed and the wrong one was the
# one that gave instructions.
#
# The port is now a variable, so there is one place to be wrong.
PROXY_PORT="${PROXY_PORT:-5433}"
run_migrations() {
  echo ">> Run migrations as the DB owner from a trusted shell."
  echo "   Port ${PROXY_PORT} is the cloud-sql-proxy. Do NOT use 5432 — that is the"
  echo "   local Postgres, and migrating it succeeds, reports success, and"
  echo "   changes nothing in production."
  echo
  echo "   Terminal 1:"
  echo "     ~/cloud-sql-proxy --port ${PROXY_PORT} ${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
  echo "     (the binary lives in \$HOME and is not on PATH — a bare"
  echo "      'cloud-sql-proxy' is 'command not found' on the deploy Mac)"
  echo
  echo "   Terminal 2:"
  echo "     cd backend && DATABASE_URL=postgres://vyne:<OWNER_PW>@localhost:${PROXY_PORT}/$DB_NAME npm run migrate"
  echo
  echo "   Expect it to name the files it applied. \"Nothing to apply — up to"
  echo "   date.\" on a release that ships a migration means you are pointed at"
  echo "   the wrong database."
}

# ── 8. Frontend (repeat every frontend release) ──────────────────────────────
deploy_frontend() {
  sync_version
  run_tests
  # v5.32.3: firebase deploy has its own project context, separate from
  # `gcloud config set project` above — without an explicit --project (or a
  # committed .firebaserc, which this repo doesn't have), a fresh checkout
  # fails with "No currently active project" even though gcloud is correctly
  # pointed at $PROJECT_ID. Pass it explicitly so this never depends on
  # `firebase use` having been run by hand in this exact directory before.
  ( cd "$(dirname "$0")/../frontend" && firebase deploy --only hosting --project "$PROJECT_ID" )
  # Confirm the frontend bundle now matches the live backend (best-effort — a
  # transient network failure here must not mask a successful deploy).
  verify_versions || echo ">> (could not confirm parity automatically — check the About page)"
}

# Deploy BOTH sides together, in lockstep, then verify. This is the normal
# release path: it stamps one version into both, ships api then frontend, and
# fails loudly if the live backend and frontend end up disagreeing.
deploy_all() {
  sync_version
  deploy_api
  deploy_frontend
}

# ── Entrypoint ───────────────────────────────────────────────────────────────
case "${1:-}" in
  apis)      enable_apis ;;
  sql)       create_sql ;;
  sa)        create_service_account ;;
  secrets)   put_secrets ;;
  api)       deploy_api ;;
  llm)       deploy_llm ;;
  migrate)   run_migrations ;;
  frontend)  deploy_frontend ;;
  all)       deploy_all ;;
  test)      : ;;  # handled by the pure-local short-circuit at the top (pre-gcloud)
  itest)     : ;;  # handled by the pure-local short-circuit at the top (pre-gcloud)
  sync-version) sync_version ;;
  verify)    verify_versions ;;
  rotate-db-password) rotate_app_password ;;
  *) echo "usage: $0 {apis|sql|sa|secrets|api|llm|migrate|frontend|all|test|itest|sync-version|verify|rotate-db-password}"; exit 1 ;;
esac
