#!/usr/bin/env bash
# =============================================================================
# Integration DB test harness (v5.34.3)
#
# Runs the FULL backend suite — the ~250 RLS-gated integration tests INCLUDED —
# against a real Postgres. `deploy.sh test` (and a bare `npx vitest run`) skip
# those tests when no database is present, which is exactly how the
# interview-delete auth-cache regression and four schema/uid-drifted tests
# reached a release unseen. This script is the missing gate, runnable by hand.
#
# .github/workflows/ci.yml already runs this same suite on every push against a
# Postgres service — so if this repo is pushed to GitHub, CI is the automated
# backstop and this script is the local equivalent.
#
# Postgres source, in order of preference:
#   1. TEST_DATABASE_URL already exported (CI, or your own Postgres) — used as-is.
#   2. docker compose (docker-compose.yml at the repo root) — brought up here,
#      and torn down at the end unless KEEP_DB=1.
#
# Usage:
#   ./deploy/it-db.sh            # provisions Postgres via docker compose
#   KEEP_DB=1 ./deploy/it-db.sh  # leave the container running afterwards
#   TEST_DATABASE_URL=... RLS_APP_URL=... ./deploy/it-db.sh   # use your own DB
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OWN_DOCKER=0
OWN_PG=""

cleanup() {
  if [ -n "$OWN_PG" ] && [ "${KEEP_DB:-0}" != "1" ]; then
    echo ">> Stopping the throwaway Postgres ..."
    ( PATH=/usr/lib/postgresql/16/bin:$PATH pg_ctl -D "$OWN_PG/data" stop -m immediate >/dev/null 2>&1 ) || true
    rm -rf "$OWN_PG" || true
  fi
  if [ "$OWN_DOCKER" = "1" ] && [ "${KEEP_DB:-0}" != "1" ]; then
    echo ">> Tearing down the ephemeral Postgres ..."
    ( cd "$ROOT" && docker compose down -v >/dev/null 2>&1 || true )
  fi
}
trap cleanup EXIT

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  # `docker info` (not just `docker compose version`) confirms the DAEMON is
  # actually reachable — the CLI can be installed while Docker Desktop is not
  # running, and we want the clean message below rather than a failure at `up`.
  if docker info >/dev/null 2>&1; then
    echo ">> Starting ephemeral Postgres 16 via docker compose ..."
    ( cd "$ROOT" && VYNE_PG_PORT="${VYNE_PG_PORT:-5432}" docker compose up -d postgres )
    OWN_DOCKER=1
    # v5.34.99 — honour VYNE_PG_PORT so a local Postgres holding 5432 is not a
    # dead end. Defaults to 5432, so nothing changes for a machine without one.
    PG_PORT="${VYNE_PG_PORT:-5432}"
    export TEST_DATABASE_URL="postgres://vyne:vyne@localhost:${PG_PORT}/vyne"
    export RLS_APP_URL="${RLS_APP_URL:-postgres://vyne_app:change-me-via-ops@localhost:${PG_PORT}/vyne}"
    echo ">> Waiting for Postgres to accept connections (host port ${PG_PORT}) ..."
    ok=0
    for _ in $(seq 1 30); do
      if ( cd "$ROOT" && docker compose exec -T postgres pg_isready -U vyne ) >/dev/null 2>&1; then ok=1; break; fi
      sleep 1
    done
    [ "$ok" = "1" ] || { echo "!! Postgres did not become ready in time." >&2; exit 1; }
  elif command -v initdb >/dev/null 2>&1 || [ -x /usr/lib/postgresql/16/bin/initdb ]; then
    # v5.34.96 — no Docker, but a local Postgres 16 binary. Bring up a THROWAWAY
    # cluster in a temp directory rather than refusing to run.
    #
    # This is not a convenience: without it the ~400 RLS-gated integration tests
    # are skipped on any machine without a Docker daemon, and a bare `vitest run`
    # reports a confident "all passed" having never touched a route or the
    # database. That is how a regression reaches a release — the suite said yes.
    export PATH="/usr/lib/postgresql/16/bin:$PATH"
    PGTMP="$(mktemp -d /tmp/vyne-itdb-XXXXXX)"
    OWN_PG="$PGTMP"
    echo ">> No Docker daemon — starting a throwaway Postgres 16 in $PGTMP ..."
    # initdb refuses to run as root; use the postgres system account when we are.
    if [ "$(id -u)" = "0" ] && id -u postgres >/dev/null 2>&1; then
      chown postgres:postgres "$PGTMP"
      RUNAS="su postgres -c"
    else
      RUNAS="sh -c"
    fi
    $RUNAS "PATH=$PATH initdb -D $PGTMP/data -U vyne --auth=trust" >/dev/null
    $RUNAS "PATH=$PATH pg_ctl -D $PGTMP/data -o '-p 5432 -c listen_addresses=localhost -c unix_socket_directories=$PGTMP' -l $PGTMP/pg.log start"
    sleep 2
    psql -h localhost -p 5432 -U vyne -d postgres -c "ALTER USER vyne WITH SUPERUSER PASSWORD 'vyne';" >/dev/null
    psql -h localhost -p 5432 -U vyne -d postgres -c "CREATE DATABASE vyne OWNER vyne;" >/dev/null
    export TEST_DATABASE_URL="postgres://vyne:vyne@localhost:5432/vyne"
    export RLS_APP_URL="${RLS_APP_URL:-postgres://vyne_app:change-me-via-ops@localhost:5432/vyne}"
  else
    echo "!! TEST_DATABASE_URL is not set, Docker is not reachable, and no local" >&2
    echo "   Postgres 16 binary was found." >&2
    echo "   Do ONE of:" >&2
    echo "     · start Docker (Desktop), then re-run — provisions Postgres automatically; or" >&2
    echo "     · install postgresql-16; or" >&2
    echo "     · export TEST_DATABASE_URL / RLS_APP_URL pointing at a Postgres 16 you run." >&2
    exit 1
  fi
fi

# The non-owner role the API actually uses (RLS applies to it). Defaults match
# migration 001_core.sql's vyne_app + the CI workflow.
export RLS_APP_URL="${RLS_APP_URL:-postgres://vyne_app:change-me-via-ops@localhost:5432/vyne}"
export RLS_TEST=1

# v5.34.82 — PROVE we are talking to the container BEFORE migrating into it.
#
# The readiness check above runs pg_isready INSIDE the container, so it passes
# whether or not the container actually owns published port 5432. When a local
# Postgres already holds that port — common, and this repo's own runbook says
# 5432 is taken on the deploy Mac — every connection below reaches THAT server
# instead. The migrations then apply to the developer's own database and the
# suite tests it: 77 failures across 18 files on 2026-09-14, nearly all of them
# "new row violates row-level security policy", because `vyne` is a superuser in
# the container and an ordinary owner locally, and FORCE RLS binds an owner.
#
# This connects over TCP exactly as the tests do and refuses to go further if
# the server on the other end is not the one we started.
echo ">> Confirming the database on the other end is the one we started ..."
# --expect-container only when WE started it; a caller-supplied TEST_DATABASE_URL
# is a documented path and is checked for superuser alone.
EXPECT=""
[ "$OWN_DOCKER" = "1" ] && EXPECT="--expect-container"
( cd "$ROOT/backend" && node "$ROOT/deploy/it-db-identify.mjs" "$TEST_DATABASE_URL" $EXPECT ) \
  || { echo "!! Refusing to migrate or test against an unidentified database." >&2; exit 1; }

# Migrations run as the OWNER (they CREATE ROLE vyne_app, tables, RLS, grants);
# the vyne_app role cannot create schema objects. migrate.ts reads DATABASE_URL,
# so point it at the owner just for this step.
echo ">> Applying migrations as the DB owner ..."
( cd "$ROOT/backend" && DATABASE_URL="$TEST_DATABASE_URL" npm run migrate )

# The test run connects as the NON-OWNER vyne_app role, exactly like the API in
# production, so RLS is actually exercised (not bypassed by an owner/superuser).
echo ">> Running the full backend suite (unit + RLS-gated integration) ..."
export DATABASE_URL="$RLS_APP_URL"
set +e
( cd "$ROOT/backend" && npx vitest run )
rc=$?
set -e
if [ "$rc" = "0" ]; then
  echo ">> Integration suite passed."
else
  echo "!! Integration suite FAILED (exit $rc)." >&2
fi
exit $rc
