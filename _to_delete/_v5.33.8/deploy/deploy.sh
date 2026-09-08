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

deploy_api() {
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
      --update-env-vars "NODE_ENV=production,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},VERTEX_LOCATION=${CLAUDE_REGION},APP_BASE_URL=${APP_BASE_URL}${EXTRA_ENV}" \
      --allow-unauthenticated \
      --min-instances 0 --max-instances 5 \
      `# v5.32.58: Cloud Run defaults to 80 concurrent requests per instance,` \
      `# which meets a 20-connection pool where each request takes 1-3` \
      `# sequential checkouts. Matching concurrency to the pool is what keeps` \
      `# requests from queueing forever on connect().` \
      --concurrency 20 )
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
  # v5.32.3: firebase deploy has its own project context, separate from
  # `gcloud config set project` above — without an explicit --project (or a
  # committed .firebaserc, which this repo doesn't have), a fresh checkout
  # fails with "No currently active project" even though gcloud is correctly
  # pointed at $PROJECT_ID. Pass it explicitly so this never depends on
  # `firebase use` having been run by hand in this exact directory before.
  ( cd "$(dirname "$0")/../frontend" && firebase deploy --only hosting --project "$PROJECT_ID" )
}

# ── Entrypoint ───────────────────────────────────────────────────────────────
case "${1:-}" in
  apis)      enable_apis ;;
  sql)       create_sql ;;
  sa)        create_service_account ;;
  secrets)   put_secrets ;;
  api)       deploy_api ;;
  migrate)   run_migrations ;;
  frontend)  deploy_frontend ;;
  rotate-db-password) rotate_app_password ;;
  *) echo "usage: $0 {apis|sql|sa|secrets|api|migrate|frontend|rotate-db-password}"; exit 1 ;;
esac
