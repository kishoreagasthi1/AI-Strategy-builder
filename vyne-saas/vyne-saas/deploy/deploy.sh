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

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
CLAUDE_REGION="${CLAUDE_REGION:-global}"       # Claude on Vertex's serving location (v5.32.1: was us-east5, now stale)
SQL_INSTANCE="vyne-sql"
SERVICE="vyne-api"
DB_NAME="vyne"
DB_APP_USER="vyne_app"

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
  echo ">> Create the owner + app users now:"
  echo "   gcloud sql users create vyne --instance=$SQL_INSTANCE --password=<OWNER_PW>"
  echo "   (vyne_app is created by migration 001; set its password via SQL:"
  echo "    ALTER ROLE $DB_APP_USER PASSWORD '<APP_PW>';)"
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
  # Secret access
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
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
deploy_api() {
  ( cd "$(dirname "$0")/../backend" &&
    gcloud run deploy "$SERVICE" \
      --source . \
      --region "$REGION" \
      --service-account "vyne-api-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
      --add-cloudsql-instances "${PROJECT_ID}:${REGION}:${SQL_INSTANCE}" \
      --update-secrets "DATABASE_URL=vyne-database-url:latest" \
      --update-env-vars "NODE_ENV=production,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},VERTEX_LOCATION=${CLAUDE_REGION}" \
      --allow-unauthenticated \
      --min-instances 0 --max-instances 5 )
}

# ── 7. Migrations (repeat when migrations change) ────────────────────────────
run_migrations() {
  echo ">> Run migrations as the DB owner from a trusted shell:"
  echo "   (cloud-sql-proxy in one terminal, then)"
  echo "   cd backend && DATABASE_URL=postgres://vyne:<OWNER_PW>@localhost:5432/$DB_NAME npm run migrate"
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
  *) echo "usage: $0 {apis|sql|sa|secrets|api|migrate|frontend}"; exit 1 ;;
esac
