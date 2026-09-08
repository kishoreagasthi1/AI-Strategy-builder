#!/usr/bin/env bash
# =============================================================================
# VYNE production preflight — run it, paste the output.
#
# The checks a deploy cannot make for you. Each one is a thing that is
# invisible until someone looks, and each has burned a real system somewhere:
#
#   1. the app role's password — RLS is the tenant boundary and that password
#      is the door to it
#   2. error reporting actually reaching a human
#   3. the client IP the API resolves, which every IP-keyed limit depends on
#   4. requests being refused during ordinary use
#   5. billing rows that were spent and never recorded
#   6. whether a database backup exists AND has ever been restored
#
# Read-only. Nothing here changes anything.
# =============================================================================
set -uo pipefail

# The computing parts live next door so they can be tested — see
# deploy/preflight-lib.sh for why. Resolved relative to THIS script, because it
# is normally run as ../deploy/preflight.sh from backend/.
VYNE_PREFLIGHT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/preflight-lib.sh
. "${VYNE_PREFLIGHT_DIR}/preflight-lib.sh"

PROJECT="${PROJECT_ID:-vyne-platform-prod}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-vyne-api}"
SQL_INSTANCE="${SQL_INSTANCE:-vyne-sql}"
FRESHNESS="${FRESHNESS:-1d}"
PROXY_PORT="${PROXY_PORT:-5433}"

pass(){ echo "   PASS  $*"; }
warn(){ echo "   WARN  $*"; }
fail(){ echo "   FAIL  $*"; }
note(){ echo "         $*"; }

echo "==============================================================="
echo " VYNE production preflight — ${PROJECT} / ${SERVICE}"
echo "==============================================================="

# ── 1. The database role password ───────────────────────────────────────────
echo
echo "1. The vyne_app password (the RLS tenant boundary)"
if nc -z localhost "${PROXY_PORT}" 2>/dev/null; then
  if [ -d node_modules/pg ] || [ -d backend/node_modules/pg ]; then
    DIR="."; [ -d backend/node_modules/pg ] && DIR="backend"
    ( cd "$DIR" && node -e "
      const {Client}=require('pg');
      new Client({connectionString:'postgres://vyne_app:change-me-via-ops@localhost:${PROXY_PORT}/vyne'})
        .connect()
        .then(()=>{ console.log('   FAIL  the migration default password STILL WORKS');
                    console.log('         Anyone who can reach the database can set app.tenant_id themselves.');
                    console.log('         Fix today: ./deploy/deploy.sh rotate-db-password'); process.exit(0); })
        .catch((e)=>{
          // v5.32.77 (external audit). This was .catch(() => PASS) — ANY error
          // read as 'the default password is gone', including a refused
          // connection, a wrong host, or the proxy not being up. The one check
          // guarding the entire tenant boundary reported success when it had
          // not tested anything. Only an AUTH failure proves the password is
          // dead; everything else means the check did not run.
          const m = String((e && e.message) || e);
          if (/password authentication failed|no pg_hba|role .* does not exist/i.test(m)) {
            console.log('   PASS  the default password is gone');
          } else {
            console.log('   WARN  could not test the password — the check did NOT run');
            console.log('         ' + m);
            console.log('         Start a proxy on 5433 and re-run. Do not read this as a pass.');
          }
        });" )
  else
    warn "pg not installed here — run this from the backend/ directory after npm install"
  fi
else
  warn "no cloud-sql-proxy on localhost:${PROXY_PORT} — start one and re-run for this check"
fi

# ── 2. Is anyone told when something breaks? ─────────────────────────────────
echo
echo "2. Error reporting"
#
# v5.32.70: this used to check for SENTRY_DSN and fail without it, which is
# what it did on the v5.32.69 run — correctly, but with no fix that did not
# involve signing up for a third party. captureError() now also writes to
# Google Cloud Error Reporting, which is already in this project, needs no
# configuration and cannot be forgotten. So the question is no longer "is the
# env var set" but "is the running code the version that reports at all".
# The boot line comes from Fastify's logger, which is pino, and pino's message
# key is `msg` — NOT `message`. Check 5 below has always had this right; this
# check shipped with `message` and would have reported WARN "no boot line found"
# on a perfectly healthy v5.32.70, i.e. a preflight check failing in exactly the
# silent, looks-fine way the last two false passes did. (Line ~93 genuinely does
# use `message`: errorReporting.ts writes that field itself, by hand, because
# Error Reporting requires it.)
ERR_START="$(gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND jsonPayload.msg:\"errors \"" \
  --project "${PROJECT}" --freshness "7d" --limit 1 \
  --format='value(jsonPayload.msg)' 2>/dev/null)"
DEPLOYED="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --project "${PROJECT}" \
            --format='value(status.latestReadyRevisionName)' 2>/dev/null)"
ENVS="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --project "${PROJECT}" \
        --format='value(spec.template.spec.containers[0].env)' 2>/dev/null || true)"

if echo "${ERR_START}" | grep -q "errors cloud"; then
  pass "Cloud Error Reporting is active on ${DEPLOYED:-the running revision}"
  note "Console: https://console.cloud.google.com/errors?project=${PROJECT}"
elif [ -n "${ERR_START}" ]; then
  fail "the running revision reports to NOTHING — boot line says: ${ERR_START}"
  note "Deploy v5.32.70 or later."
else
  warn "no boot line found in 7d — redeploy, or check the revision's startup logs"
  note "Look for: 'VYNE API listening on ... errors cloud'"
fi

# Errors it has actually grouped. Not a pass/fail — "none" is the good case and
# cannot be distinguished from "the sink is broken", which is what the boot-line
# check above is for. This is here because it is the thing worth READING.
SEEN="$(gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND jsonPayload.\"@type\":\"*ReportedErrorEvent\"" \
  --project "${PROJECT}" --freshness "${FRESHNESS}" --limit 10 \
  --format='value(jsonPayload.message)' 2>/dev/null | head -3 | cut -c1-100)"
if [ -n "${SEEN}" ]; then
  warn "errors reported in the last ${FRESHNESS}:"
  echo "${SEEN}" | sed 's/^/         /'
fi

if echo "${ENVS}" | grep -q "SENTRY_DSN"; then
  note "SENTRY_DSN is also set — richer grouping, additive to the above."
fi

# ── 3. Client addresses and request forensics ───────────────────────────────
echo
echo "3. Client addresses and request forensics"
#
# v5.32.72: this check has now been wrong twice, in opposite directions.
#
# It first PASSED on "more than one distinct address" while 79% of traffic
# resolved to a link-local hop. It was then rewritten to FAIL on that, with the
# reasoning "those requests share one rate-limit bucket, so one firm's traffic
# can refuse another's". That reasoning was also wrong: server.ts keys every
# authenticated limiter on ctx.userId, not on the address. The scary sentence
# was written from the trustProxy SETTING without reading the keyGenerators.
#
# What is actually true, measured on production:
#   · Firebase Hosting terminates the visitor's connection and re-originates to
#     Cloud Run from Google's own infrastructure, sending no X-Forwarded-For.
#     The real client address is in NO log and no setting recovers it.
#   · Rate limiting is unaffected — authenticated scopes key on userId.
#   · FORENSICS was the real loss, and v5.32.72 addresses it by logging the raw
#     X-Forwarded-For chain beside the resolved address.
#
# So this no longer judges the address distribution at all. It checks the thing
# that can actually regress: whether the chain is being recorded.
IPS="$(gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND jsonPayload.req.remoteAddress:*" \
  --project "${PROJECT}" --freshness "${FRESHNESS}" --limit 300 \
  --format='value(jsonPayload.req.remoteAddress)' 2>/dev/null | sort | uniq -c | sort -rn)"
if [ -z "${IPS}" ]; then
  warn "no request logs in the last ${FRESHNESS} — nothing to judge"
else
  TOTAL="$(echo "${IPS}" | awk '{s+=$1} END {print s}')"
  NONROUTABLE="$(echo "${IPS}" | vyne_nonroutable_count)"
  echo "${IPS}" | head -4 | sed 's/^/         /'
  if [ "${NONROUTABLE}" -gt 0 ]; then
    note "${NONROUTABLE} of ${TOTAL} resolved to an infrastructure address — expected"
    note "behind Firebase Hosting, and harmless: authenticated limits key on userId."
  fi
fi

# The chain itself. This is the check with teeth: the xff field lives in a
# Fastify serializer, and a later logger change would drop it silently.
XFF_SEEN="$(gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND jsonPayload.req.xff:*" \
  --project "${PROJECT}" --freshness "${FRESHNESS}" --limit 1 \
  --format='value(jsonPayload.req.xff)' 2>/dev/null)"
if [ -n "${XFF_SEEN}" ]; then
  pass "the X-Forwarded-For chain is being recorded (e.g. ${XFF_SEEN})"
  note "Evidence only — req.ip is resolved by trusted-address class, never by"
  note "this header. See test/trustProxyForgery.test.ts."
elif [ -z "${IPS}" ]; then
  warn "no traffic to judge"
else
  warn "no X-Forwarded-For recorded in ${FRESHNESS}"
  note "Either every request in the window arrived without one — normal on the"
  note "Firebase Hosting path — or the log serializer lost the field. Confirm by"
  note "hitting the Cloud Run URL directly, which always carries a chain:"
  note "  curl -s \"\$(gcloud run services describe ${SERVICE} --region ${REGION} \\"
  note "        --project ${PROJECT} --format='value(status.url)')/api/version\""
  note "then re-run. Still nothing means the serializer regressed."
fi

# ── 4. Is anything being refused? ────────────────────────────────────────────
echo
echo "4. Rate limiting during ordinary use"
R429="$(gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND httpRequest.status=429" \
  --project "${PROJECT}" --freshness "${FRESHNESS}" --limit 100 \
  --format='value(httpRequest.requestUrl)' 2>/dev/null | sed 's/?.*//' | sort | uniq -c | sort -rn)"
if [ -z "${R429}" ]; then
  pass "no 429s in the last ${FRESHNESS}"
else
  echo "${R429}" | head -6 | sed 's/^/         /'
  warn "someone hit a limit"
  note "/api/llm/* and /api/voice/* at 60/min is the system working as designed."
  note "/api/me or /api/engagements being refused is new since v5.32.65 and worth reporting."
fi

# ── 5. Money spent and not recorded ──────────────────────────────────────────
echo
echo "5. Lost billing rows"
METER="$(gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND jsonPayload.msg:\"metering write FAILED\"" \
  --project "${PROJECT}" --freshness "${FRESHNESS}" --limit 20 \
  --format='value(jsonPayload.tenantId, jsonPayload.task)' 2>/dev/null)"
if [ -z "${METER}" ]; then
  pass "none (before v5.32.65 these were silent, so 'none' now means none)"
else
  echo "${METER}" | sed 's/^/         /'
  fail "usage was spent and not recorded for the above"
fi

# ── 6. Backups, and whether one has ever been restored ───────────────────────
echo
echo "6. Backups"
#
# v5.32.70: this used to pass on "the list is not empty", and on a real
# deployment it passed with the newest backup TWO DAYS OLD and automated
# backups switched off — the two rows it printed were one-off backups taken by
# hand, minutes apart, during a deploy. "A backup exists" and "your current
# data is backed up" are different claims, and only the second one is worth
# anything at 3am. Freshness and the automated-backup SETTING are both checked
# now, because either alone can look fine while the other is the problem.
BK="$(gcloud sql backups list --instance="${SQL_INSTANCE}" --project "${PROJECT}" \
      --limit 3 --format='value(windowStartTime,status)' 2>/dev/null)"
AUTO="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT}" \
        --format='value(settings.backupConfiguration.enabled)' 2>/dev/null)"
if [ -z "${BK}" ]; then
  fail "no backups found at all on ${SQL_INSTANCE}"
  note "Enable them: gcloud sql instances patch ${SQL_INSTANCE} --project ${PROJECT} \\"
  note "               --backup-start-time=03:00"
else
  echo "${BK}" | sed 's/^/         /'
  if [ "${AUTO}" != "True" ] && [ "${AUTO}" != "true" ]; then
    fail "AUTOMATED backups are OFF (settings.backupConfiguration.enabled=${AUTO:-unset})"
    note "Everything listed above was taken by hand. Nothing is protecting the data"
    note "written since. Turn them on — it is one command and needs no downtime:"
    note "  gcloud sql instances patch ${SQL_INSTANCE} --project ${PROJECT} \\"
    note "    --backup-start-time=03:00 --retained-backups-count=14 \\"
    note "    --enable-point-in-time-recovery --retained-transaction-log-days=7"
    note "Point-in-time recovery is the half that matters most: without it the most"
    note "you can undo is back to the last nightly, so a bad migration at 16:00 costs"
    note "a full day of consultant work."
  else
    # Freshness. An automated daily backup older than ~36h means the schedule
    # is configured and not running.
    NEWEST="$(echo "${BK}" | head -1 | awk '{print $1}')"
    AGE_H="$(vyne_backup_age_hours "${NEWEST}")"
    if [ "${AGE_H}" = "unparseable" ]; then
      warn "automated backups are on, but the newest timestamp did not parse"
      note "Read the dates above by eye. (v5.32.70 printed '-4h old' here: gcloud"
      note "emits UTC and BSD date parses local, so a backup read as five hours in"
      note "the future sailed straight past the staleness test.)"
    elif [ "${AGE_H}" -gt 36 ]; then
      fail "the newest backup is ${AGE_H}h old — the schedule is on but not running"
      note "Check for a failed backup run in the instance's operations log."
    else
      pass "automated backups on, newest is ${AGE_H}h old"
    fi
  fi
  note "A backup nobody has restored is a hypothesis, not a capability."
  note "Rehearse it once against a THROWAWAY instance — never the live one:"
  note "  gcloud sql instances clone ${SQL_INSTANCE} vyne-sql-restoretest --project ${PROJECT}"
  note "  ...point a local API at the clone, confirm the data is there, then:"
  note "  gcloud sql instances delete vyne-sql-restoretest --project ${PROJECT}"
  note "See BACKUP_RESTORE_RUNBOOK.md for the full procedure."
fi

echo
echo "==============================================================="
echo " Anything marked FAIL is worth acting on before more firms use this."
echo " WARN usually means a check could not run, not that something is wrong."
echo "==============================================================="
