#!/usr/bin/env bash
# =============================================================================
# VYNE — version stamper (single source of truth)
#
# The app version lives in ONE place: the repo-root VERSION file. This script
# stamps it into the three files that must always agree, so a release bumps
# VERSION once and never drifts:
#   - backend/src/version.ts   (served over GET /api/version)
#   - frontend/vyne-client.js  (VYNE_VERSION, baked into the static bundle)
#   - frontend/about.html      (FRONTEND_VERSION, the version page)
#
# Run by hand after editing VERSION, or automatically by deploy.sh before every
# api/frontend build. Idempotent. Uses perl -i so it behaves identically on the
# deploy Mac (BSD sed differs) and in CI (GNU sed).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V="$(tr -d ' \t\n\r' < "$ROOT/VERSION")"
[ -n "$V" ] || { echo "!! VERSION file ($ROOT/VERSION) is empty" >&2; exit 1; }
case "$V" in
  *[!0-9.]*) echo "!! VERSION '$V' is not a plain x.y.z string" >&2; exit 1 ;;
esac

perl -0pi -e "s/export const VERSION = \"[^\"]*\";/export const VERSION = \"$V\";/" "$ROOT/backend/src/version.ts"
perl -0pi -e "s/var VYNE_VERSION = \"[^\"]*\";/var VYNE_VERSION = \"$V\";/"          "$ROOT/frontend/vyne-client.js"
perl -0pi -e "s/var FRONTEND_VERSION = \"[^\"]*\";/var FRONTEND_VERSION = \"$V\";/"  "$ROOT/frontend/about.html"

# Verify the stamp actually took in all three (a moved/renamed constant would
# otherwise silently no-op and reintroduce exactly the drift this prevents).
fail=0
grep -q "export const VERSION = \"$V\";"  "$ROOT/backend/src/version.ts"  || { echo "!! backend/src/version.ts not stamped" >&2; fail=1; }
grep -q "var VYNE_VERSION = \"$V\";"       "$ROOT/frontend/vyne-client.js" || { echo "!! frontend/vyne-client.js not stamped" >&2; fail=1; }
grep -q "var FRONTEND_VERSION = \"$V\";"   "$ROOT/frontend/about.html"     || { echo "!! frontend/about.html not stamped" >&2; fail=1; }
[ "$fail" = 0 ] || exit 1

echo ">> version synced to v$V (backend/src/version.ts, frontend/vyne-client.js, frontend/about.html)"
