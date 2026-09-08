#!/usr/bin/env bash
# =============================================================================
# The parts of preflight.sh that COMPUTE something, split out so they can be
# tested (v5.32.70).
#
# WHY THIS FILE EXISTS. preflight.sh has now shipped three bugs, and all three
# had the same shape: the check ran, printed something reassuring, and was
# wrong.
#
#   · check 3 passed on "more than one distinct address" while 79% of traffic
#     resolved to a link-local proxy hop
#   · check 6 passed on "the list is not empty" with the newest backup two days
#     old and automated backups switched off
#   · check 2 queried jsonPayload.message when Fastify's pino writes msg, so it
#     would have reported "no boot line found" on a perfectly healthy service
#
# Everything else in this repo is revert-tested. This script was the one thing
# shipping untested, and it is the script whose entire job is to tell the truth
# about production. So the logic lives here as pure functions over stdin/args —
# no gcloud, no network — and backend/test/preflightChecks.test.ts drives them.
#
# Rule for anything added here: it takes text in, prints a number or a word out,
# and touches nothing.
# =============================================================================

# ── Backup freshness ─────────────────────────────────────────────────────────
# Age in whole hours of an RFC3339 timestamp, or the string "unparseable".
#
# v5.32.70: the first version of this printed "newest is -4h old" against a real
# instance. gcloud emits UTC ("2026-08-14T14:42:46.963+00:00"), and BSD `date -j
# -f` parses in LOCAL time — so on a UTC-5 machine the backup was read as five
# hours in the FUTURE. A negative age then sailed past the `-gt 36` staleness
# test, which means a misparsed timestamp reported as FRESH. Fail-open, in the
# check whose whole purpose is to notice staleness.
#
# Two fixes, and the second matters more than the first: parse as UTC, and treat
# a negative age as a parse failure rather than as good news.

# "2026-08-14T14:42:46.963+00:00" → "2026-08-14T14:42:46".
#
# Split out and tested separately because the BSD branch below feeds it to a
# `-f '%Y-%m-%dT%H:%M:%S'` format that cannot express a fractional part OR an
# offset, and BSD date's tolerance for trailing characters varies by release.
# The three shapes gcloud has been seen to emit — with milliseconds, without,
# and with a bare Z — must all reduce to the same bare stamp. Kishore's machine
# is the macOS one, so this branch is the one that actually runs in anger.
vyne_normalize_stamp() {
  local s="${1%%.*}"   # drop ".963+00:00"
  s="${s%%+*}"         # or a bare "+00:00" when there were no milliseconds
  s="${s%Z}"           # or a trailing Z
  printf '%s' "${s}"
}

vyne_backup_age_hours() {
  local stamp="$1" now_epoch stamp_epoch age bare
  [ -n "${stamp}" ] || { echo "unparseable"; return; }
  now_epoch="$(date '+%s')"
  bare="$(vyne_normalize_stamp "${stamp}")"

  # BSD/macOS first. TZ=UTC applies to this invocation only and is the whole
  # point: without it the stamp is read as local time and a backup taken an hour
  # ago looks like one taken in the future. GNU `date -d` understands the
  # original string, offset and all, so it gets that.
  stamp_epoch="$(TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%S' "${bare}" '+%s' 2>/dev/null \
                 || date -d "${stamp}" '+%s' 2>/dev/null \
                 || echo '')"
  case "${stamp_epoch}" in
    ''|*[!0-9]*) echo "unparseable"; return ;;
  esac

  age=$(( (now_epoch - stamp_epoch) / 3600 ))
  # A backup from the future is a clock or parsing problem, never a fact.
  # Allow one hour of slack for clock skew rather than flagging on -0.
  if [ "${age}" -lt -1 ]; then echo "unparseable"; return; fi
  [ "${age}" -lt 0 ] && age=0
  echo "${age}"
}

# ── Client-address sanity ────────────────────────────────────────────────────
# Addresses that are infrastructure by definition: link-local, RFC1918,
# loopback, IPv6 unique-local. A request logged against one of these did not
# come from a client — it came from a proxy hop we resolved to instead.
VYNE_PRIVATE_RE='(^| )(169\.254\.|10\.|192\.168\.|127\.|172\.(1[6-9]|2[0-9]|3[01])\.|::1$|f[cd][0-9a-f]{2}:)'

# stdin: `uniq -c` output ("  237 169.254.169.126"). Prints the request count
# that resolved to a non-routable address.
vyne_nonroutable_count() {
  awk '{print $1, $2}' | grep -Ei "${VYNE_PRIVATE_RE}" | awk '{s+=$1} END {print s+0}'
}

# stdin: the same. Prints the percentage of requests held by the single
# largest address, or 0 when there is nothing to judge.
vyne_top_share_pct() {
  awk 'NR==1 {top=$1} {s+=$1} END {if (s>0) printf "%d", top*100/s; else print 0}'
}
