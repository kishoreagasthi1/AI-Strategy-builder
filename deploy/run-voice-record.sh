#!/bin/bash
# Record a real interview through the shipped frontend, so it can be judged by
# ear instead of by a live sitting. (v5.34.42)
#
#   bash deploy/run-voice-record.sh            14 minutes — crosses one handover
#   bash deploy/run-voice-record.sh 25          25 minutes — crosses two
#
# It runs the OFFLINE self-check first. That check needs no key and no quota,
# and it is there because this harness has been wrong before: a broken rig and
# a broken product look identical in the output. If the self-check fails, the
# real run is not worth starting.
set -u

MINUTES="${1:-14}"
cd "$HOME/vyne/vyne-saas" || { echo "cannot find ~/vyne/vyne-saas"; exit 1; }

echo "== 1/4  checking the harness itself (offline, no key, no quota) =="
node deploy/voice-record.mjs --offline --minutes 1.3 --offline-goaway 30000 --out voice-selfcheck \
  || { echo; echo "FAILED: the harness is broken before Google is involved. Stop here."; exit 2; }

if ! grep -q "handovers: [1-9]" voice-selfcheck.txt; then
  echo; echo "FAILED: the offline check never exercised a handover. Stop here."; exit 2
fi
echo "harness OK"; echo

# v5.34.47 — the RECOVERY path, which a clean run never executes.
#
# Every line .47 changed runs only when a renewal fails on transport. A healthy
# ninety-minute run exercises the renewal path nine times and those lines zero
# times. The .46 backoff bug was found only because a real Wi-Fi drop happened
# during a recording, which is luck, not testing.
#
# This refuses three grants on purpose and times the gaps between the retries
# against the schedule the shipped constants describe (4s, 8s, 16s). It costs
# two minutes and no quota, and it FAILS on .46's code — verified by putting
# the double-count back and watching it report 8/16/32.
echo "== 2/4  checking the recovery path (offline fault injection) =="
node deploy/voice-record.mjs --offline --minutes 2 --offline-goaway 20000 \
     --offline-fail-mints 3 --out voice-faultcheck \
  || { echo; echo "FAILED: the fault-injection run did not complete. Stop here."; exit 2; }

if ! grep -q "^  PASS" voice-faultcheck.txt; then
  echo
  echo "FAILED: the renewal did not recover on the schedule it claims to use."
  sed -n '/fault injection:/,/^  \(PASS\|FAIL\)/p' voice-faultcheck.txt
  exit 2
fi
echo "recovery path OK"; echo

echo "== 3/4  reading GEMINI_API_KEY from the deployed service =="
KEY=$(gcloud run services describe vyne-api --region us-central1 --format=json 2>/dev/null \
  | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for v in d["spec"]["template"]["spec"]["containers"][0]["env"]:
    if v["name"] == "GEMINI_API_KEY":
        print(v.get("value", ""))')

if [ -z "${KEY:-}" ]; then
  echo "FAILED: could not read GEMINI_API_KEY from vyne-api. Is gcloud logged in?"
  exit 2
fi
export GEMINI_API_KEY="$KEY"
echo "key length ${#KEY} — ok"

# v5.34.51 — record on the model PRODUCTION runs, not the code default.
#
# Found by reading a real interview's trace: the session ran on
# gemini-3.1-flash-live-preview, while this harness and DEFAULT_LIVE_MODEL both
# say gemini-2.5-flash-native-audio-latest. The service overrides it with
# GEMINI_LIVE_MODEL, and nothing here was reading that.
#
# Every measurement taken on 2026-09-12 — the 30-minute run, both 90-minute
# runs, the latency percentiles, the mute-turn and echo counts, the nudge
# comparison — was therefore taken on a model no interviewee ever speaks to.
# It also explains why this harness saw no usageMetadata at all while
# production recorded real token counts: different model, different frames.
LIVE_MODEL=$(gcloud run services describe vyne-api --region us-central1 --format=json 2>/dev/null \
  | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for v in d["spec"]["template"]["spec"]["containers"][0]["env"]:
    if v["name"] == "GEMINI_LIVE_MODEL":
        print(v.get("value", ""))')

if [ -n "${LIVE_MODEL:-}" ]; then
  echo "live model (from the deployed service): $LIVE_MODEL"
else
  LIVE_MODEL="models/gemini-2.5-flash-native-audio-latest"
  echo "!! the service sets no GEMINI_LIVE_MODEL — falling back to $LIVE_MODEL"
  echo "   if production is running something else, this recording measures the wrong thing."
fi
echo

# Archive the previous run before this one overwrites it.
#
# Learned by nearly losing the first clean 14-minute recording: the .wav and
# the trace are only written when a run FINISHES, so starting a second run
# silently destroys the first one's evidence a quarter of an hour later. These
# recordings are the only record of what a session actually sounded like, and
# a comparison needs both sides of it.
if [ -f voice-record.wav ] || [ -f voice-record.log ]; then
  STAMP="$(date -u +%Y%m%d-%H%M%S)"
  mkdir -p voice-runs
  for ext in wav log txt; do
    [ -f "voice-record.$ext" ] && mv "voice-record.$ext" "voice-runs/$STAMP.$ext"
  done
  echo ">> previous run archived to voice-runs/$STAMP.*"
  echo
fi

echo "== 4/4  recording a $MINUTES-minute interview =="
echo "This runs in the background. Walk away."
nohup node deploy/voice-record.mjs --minutes "$MINUTES" --model "$LIVE_MODEL" --out voice-record > voice-runner.log 2>&1 &
echo "started, pid $!"
echo
echo "when it finishes, roughly $MINUTES minutes from now:"
echo "  open   ~/vyne/vyne-saas/voice-record.wav      <- listen to this"
echo "  read   ~/vyne/vyne-saas/voice-record.txt      <- the turn table and verdict"
echo "  keep   ~/vyne/vyne-saas/voice-record.log      <- the page trace, for Claude"
echo
echo "watch it live with:  tail -f ~/vyne/vyne-saas/voice-record.txt"
