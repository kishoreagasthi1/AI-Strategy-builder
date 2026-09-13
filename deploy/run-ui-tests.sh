#!/bin/bash
# Every test this repo has, in one command, in a container. (v5.34.56)
#
#   bash deploy/run-ui-tests.sh              everything: unit + DB + browser
#   bash deploy/run-ui-tests.sh browser      only the browser suite
#   bash deploy/run-ui-tests.sh --native     skip Docker; use local Chromium
#
# WHY THIS EXISTS
#
# Because until today the frontend was tested by a person clicking through it,
# and that person was the customer. Two bugs on 2026-09-12 reached a delivered
# zip: three unescaped innerHTML sinks, and a block of markup inserted inside a
# <script> tag that would have broken billing.html outright. Neither was caught
# by the release gate, because the release gate could not open a page.
set -u

cd "$(dirname "$0")/.." || exit 1
MODE="${1:-all}"

if [ "$MODE" = "--native" ]; then
  echo "== native run (no Docker) — uses whatever Chromium is on PATH/PLAYWRIGHT_BROWSERS_PATH =="
  # v5.34.58: the browser suite needs a devDependency that a checkout from
  # before v5.34.56 does not have. Install it rather than skipping silently —
  # a native run is an explicit request for these tests.
  if [ ! -d backend/node_modules/playwright-core ]; then
    echo ">> installing test dependencies (playwright-core) ..."
    ( cd backend && npm install --no-audit --no-fund ) || {
      echo "!! npm install failed — the browser suite will skip"; }
  fi
  cd backend && exec npx vitest run
fi

if ! docker info >/dev/null 2>&1; then
  echo "!! Docker is not running."
  echo "   Start Docker Desktop, or run the suite natively:"
  echo "     bash deploy/run-ui-tests.sh --native"
  echo "   (native skips the Postgres-backed tier unless you export TEST_DATABASE_URL)"
  exit 2
fi

COMPOSE="docker compose -f deploy/test/docker-compose.yml"
case "$MODE" in
  browser) ARGS="run --rm tests npx vitest run test/browser" ;;
  all)     ARGS="run --rm tests" ;;
  *)       echo "usage: $0 [all|browser|--native]"; exit 1 ;;
esac

echo "== building the test image (first run pulls Playwright, a few minutes) =="
$COMPOSE build tests || { echo "image build failed"; exit 2; }

echo "== running =="
# shellcheck disable=SC2086
$COMPOSE $ARGS
STATUS=$?

$COMPOSE down -v >/dev/null 2>&1
exit $STATUS
