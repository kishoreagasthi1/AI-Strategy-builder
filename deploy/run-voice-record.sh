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
# v5.34.111 — this script takes POSITIONAL arguments, and said so nowhere.
#
# `run-voice-record.sh --minutes 20 --loop` set MINUTES to the string
# "--minutes", which reached voice-record.mjs as NaN, armed a NaN time limit,
# and ended the run at 0.0s with a full verdict that read as a dead product.
# Caught here as well as in the .mjs, because by the time the .mjs sees it the
# seven-stage preflight has already run.
case "$MINUTES" in
  -*) echo "!! this script takes POSITIONAL arguments, not flags." >&2
      echo "   you passed: $*" >&2
      echo "   try:        bash deploy/run-voice-record.sh 20 soak" >&2
      exit 2 ;;
esac
case "$MINUTES" in
  ''|*[!0-9.]*|.|*.*.*) echo "!! first argument must be a number of minutes, got '$MINUTES'." >&2
      echo "   try: bash deploy/run-voice-record.sh 20 soak" >&2
      exit 2 ;;
esac
if [ "${2:-}" != "" ] && [ "${2:-}" != "soak" ]; then
  echo "!! second argument must be the word 'soak' (or omitted), got '${2}'." >&2
  echo "   try: bash deploy/run-voice-record.sh 20 soak" >&2
  exit 2
fi
# v5.34.79 — second argument: "soak".
#
# A normal run ends when the interviewer closes or the eight scripted answers
# run out, both inside two minutes, which is the right default and is enough to
# judge whether the interviewer repeats itself in a single pass.
#
# It is NOT enough to reach the ~10-minute session handover, and the handover is
# where the nastiest repetition bug lived: the fresh session starts with no
# memory of the conversation and learns what has already been asked only from
# the context sent with its grant. A soak loops the tape so the clock runs long
# enough to get there.
#
# Read a soak for ONE thing: does the interviewer repeat a question across the
# handover. Do not read it for question quality — past answer eight the
# interviewee is a tape, so anything that looks like a dead conversation is.
SOAK="${2:-}"
EXTRA=""
if [ "$SOAK" = "soak" ]; then
  EXTRA="--loop"
  if [ "${MINUTES%%.*}" -lt 12 ] 2>/dev/null; then
    echo "!! a soak shorter than 12 minutes never reaches the handover it exists to test." >&2
    echo "   try: bash deploy/run-voice-record.sh 14 soak" >&2
    exit 1
  fi
fi
cd "$HOME/vyne/vyne-saas" || { echo "cannot find ~/vyne/vyne-saas"; exit 1; }

echo "== 1/8  checking the harness itself (offline, no key, no quota) =="
# --loop: this stage is an endurance check, so the tape must keep playing past
# the eight scripted answers. v5.34.78 stops at the end of the script by default.
node deploy/voice-record.mjs --offline --loop --minutes 1.3 --offline-goaway 30000 --out voice-selfcheck \
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
echo "== 2/8  checking the recovery path (offline fault injection) =="
node deploy/voice-record.mjs --offline --loop --minutes 2 --offline-goaway 20000 \
     --offline-fail-mints 3 --out voice-faultcheck \
  || { echo; echo "FAILED: the fault-injection run did not complete. Stop here."; exit 2; }

if ! grep -q "^  PASS" voice-faultcheck.txt; then
  echo
  echo "FAILED: the renewal did not recover on the schedule it claims to use."
  sed -n '/fault injection:/,/^  \(PASS\|FAIL\)/p' voice-faultcheck.txt
  exit 2
fi
echo "recovery path OK"; echo

# v5.34.78 — the check that proves the VERDICT, not just the recording.
#
# voice-record.mjs registered its interview-close detector on `onAgentText`,
# which vyne-live-interview.js consumes and does not forward. The handler was
# therefore never called, and `closed by agent` could only ever print "no".
# It printed "no" about a 2026-09-14 run in which the interviewer closed the
# interview at 112 seconds, and two earlier sessions were spent widening that
# detector's regex to fix a failure that was never in the regex.
#
# Nothing in stages 1 and 2 could see it: the offline stub sent no transcript
# at all, so every path downstream of it was untestable without a paid live
# run. It sends one now, and this stage makes it close on purpose and insists
# the harness notices. Thirty seconds, no key, no quota.
echo "== 3/8  checking the harness NOTICES a closed interview =="
node deploy/voice-record.mjs --offline --loop --offline-close-after 4 --minutes 2 \
     --out voice-closecheck \
  || { echo; echo "FAILED: the close-detection run did not complete. Stop here."; exit 2; }

# v5.34.81 — tell a STALLED run apart from a failed detection.
#
# A Mac that sleeps mid-run freezes the process: timers stop, the uplink never
# drains, and the run limps to its limit with one reply. The old message blamed
# close detection for that and told you every verdict was worthless, which sent
# a debugging session after code that was working. Check the run happened before
# judging what it found.
REPLIES=$(grep -o "replies:  *[0-9]*" voice-closecheck.txt | grep -o "[0-9]*$")
if [ -z "$REPLIES" ] || [ "$REPLIES" -lt 3 ]; then
  echo
  echo "INCONCLUSIVE: the offline run only produced ${REPLIES:-0} replies, so nothing was tested."
  echo "This is a stalled run, not a product or detection failure. The usual cause on a"
  echo "laptop is the machine sleeping mid-run — look for a long gap in the trace and a"
  echo "wall clock far longer than the booked minutes:"
  grep -E "never drained|nothing has happened|stopped because|replies:" voice-closecheck.txt
  echo
  echo "Re-run it, and keep the machine awake:  caffeinate -i bash deploy/run-voice-record.sh $MINUTES"
  exit 3
fi

if ! grep -q "closed by agent: yes" voice-closecheck.txt; then
  echo
  echo "FAILED: the interviewer closed the interview and the harness did not notice."
  echo "Every 'closed by agent' line this harness prints is worthless until this passes."
  grep -E "closed by agent|replies:" voice-closecheck.txt
  exit 2
fi
echo "close detection OK"; echo

echo "== 4/8  rendering the shipped interviewer persona =="
# Rendered BEFORE the offline checks, not after the key fetch, because it needs
# no key — only tsx. Stage 4 then runs the offline rig against the REAL
# instruction, which is the only way to exercise anything the instruction
# carries without paying Google for it.
INSTRUCTION_FILE="$(pwd)/voice-instruction.txt"
( cd backend && npx tsx ../deploy/interviewer-instruction.ts > "$INSTRUCTION_FILE" ) \
  || { echo "FAILED: could not render the interviewer persona. Stop here."; exit 2; }
CHARS=$(wc -c < "$INSTRUCTION_FILE" | tr -d ' ')
if [ "$CHARS" -lt 200 ]; then
  echo "FAILED: the rendered persona is only $CHARS characters. That is not it."; exit 2
fi
echo "persona rendered: $CHARS characters -> voice-instruction.txt"
grep -q "seven dimensions of A I readiness" "$INSTRUCTION_FILE" \
  || { echo "FAILED: the rendered persona carries no dimension agenda."; exit 2; }
grep -q "Finishing early is a good outcome" "$INSTRUCTION_FILE" \
  || { echo "FAILED: the rendered persona carries no closing rules."; exit 2; }
echo "agenda and closing rules present"; echo

# v5.34.79 — the check that proves the interviewer is TOLD what it already asked.
#
# The no-repeat fix works by recomputing the instruction at every mint: the
# questions already asked and answered, and the required ones still outstanding.
# A harness that pinned one instruction for the whole run could not exercise any
# of it — it hands every session the same "nothing asked yet" snapshot, which is
# the state the fix exists to prevent, so it would have reported a clean pass on
# the bug. This runs the offline rig against the real instruction and insists the
# numbers actually move.
echo "== 5/8  checking the interviewer is told what it already asked =="
node deploy/voice-record.mjs --offline --loop --minutes 2 --offline-goaway 45000 \
     --instruction-file "$INSTRUCTION_FILE" --out voice-trackcheck \
  || { echo; echo "FAILED: the tracking run did not complete. Stop here."; exit 2; }

grep -q "RE-RENDERED at every mint" voice-trackcheck.txt \
  || { echo "FAILED: the instruction was pinned, not re-rendered. Nothing below is meaningful."; exit 2; }
if grep -q "questions tracked: 0 " voice-trackcheck.txt; then
  echo
  echo "FAILED: the harness recorded ZERO answered questions in a full conversation."
  echo "The interviewer is being told nothing about what it already asked."
  grep -E "questions tracked|replies:" voice-trackcheck.txt
  exit 2
fi
if ! grep -q "required questions: 1 of 2 covered" voice-trackcheck.txt; then
  echo
  echo "FAILED: a required question was asked and answered and did not come off the list."
  echo "That is the fault that asked one question three times in 43 seconds."
  grep -E "required questions|questions tracked" voice-trackcheck.txt
  exit 2
fi
GREW=$(grep -o "instruction at last mint: [0-9]*" voice-trackcheck.txt | grep -o "[0-9]*$")
if [ -z "$GREW" ] || [ "$GREW" -le "$CHARS" ]; then
  echo "FAILED: the instruction did not grow across the run ($GREW vs $CHARS at open)."
  echo "Nothing about the conversation is reaching the next session."
  exit 2
fi
echo "tracking OK — instruction grew $CHARS -> $GREW chars across the run"; echo
# =============================================================================
# v5.34.117 — the goAway'd connection that stops answering.
#
# Reported from a live interview on v5.34.116: thirty to forty seconds of total
# silence at minute nine. The 🩺 trace showed the server sending goAway,
# transcribing a 38.7-second answer, and then producing no model frame for
# twenty seconds while the client waited for a turn boundary that connection was
# never going to produce. The interviewee broke the deadlock by asking whether
# anyone was there.
#
# No offline stage above could reach it. Stage 1 exercises a HEALTHY handover
# and stage 2 a failed MINT; this is neither — the mint succeeds first time and
# the socket is fine. The fault is a socket that has announced its own closure
# and gone quiet on one turn, which is the one shape the rig could not fake.
#
# --offline-silent-after is the near miss: it silences the stub forever, which
# lands in a different code path (the renewed-silence watchdog) from a
# connection that stalls once because it is closing. The whole v5.34.117 fix
# lives in the gap between those two.
#
# Costs no quota and about three minutes. VERIFIED against all three builds on
# the same run: v5.34.116 reports "the stall was injected 2x and the client
# NEVER noticed it"; v5.34.117 holds the silence to 5.9s; v5.34.118 holds it to
# 1.8s, because the stub now sends the second goAway the real server sends and
# the client acts on it.
#
# Three minutes, not ninety seconds: at 1.5 the wrap-up notice lands on the
# stalled turn and answers it (a text nudge gets a reply from the stub), so the
# stall is short-circuited and the stage passes without testing anything.
# =============================================================================
echo "== 6/8  checking a dying connection cannot hold the interview hostage =="
node deploy/voice-record.mjs --offline --loop --minutes 3 --offline-goaway 20000 \
     --offline-stall-after-goaway 25000 --out voice-stallcheck \
  || { echo; echo "FAILED: the stall-injection run did not complete. Stop here."; exit 2; }

if grep -q "stalled handover: NOT EXERCISED" voice-stallcheck.txt; then
  echo; echo "FAILED: the run ended before a goAway, so nothing was tested."
  grep -E "stalled handover" voice-stallcheck.txt; exit 2
fi
if grep -q "the client NEVER noticed it" voice-stallcheck.txt; then
  echo; echo "FAILED: this is the v5.34.116 defect. The handover is waiting on a"
  echo "connection that has stopped producing turns."
  grep -E "stalled handover|!!" voice-stallcheck.txt; exit 2
fi
if grep -q "the recovery nudge was the" voice-stallcheck.txt; then
  echo; echo "FAILED: the interviewer came back with the wrong sentence."
  echo "It holds the answer in full; it must respond to it, not ask for it again."
  grep -E "recovery nudge" voice-stallcheck.txt; exit 2
fi
# The number the interviewee actually feels: transcript -> the new session
# speaking.
#
# Four seconds, tightened from ten in v5.34.118. The rig sends the second
# goAway the real server sends, so the confirmed path is the one under test and
# it measures 1.8s offline. v5.34.117, which waits out its full 5s margin,
# measures 5.9s on this same run — so the threshold sits between the two builds
# rather than merely above the reported defect, which is the only way this gate
# can fail for the reason it claims.
SIL=$(grep -o "interviewee heard nothing for [0-9.]*s" voice-stallcheck.txt | grep -o "[0-9.]*" | head -1)
if [ -z "$SIL" ]; then
  echo; echo "FAILED: the stall verdict did not report a silence duration."; exit 2
fi
if awk -v s="$SIL" 'BEGIN { exit !(s > 4) }'; then
  echo; echo "FAILED: the interviewee heard nothing for ${SIL}s. A goAway landed on an"
  echo "already-transcribed turn, which is the server saying it will not answer —"
  echo "the handover should not still be waiting out the unconfirmed margin."
  grep -E "stalled handover" voice-stallcheck.txt; exit 2
fi
echo "stall escape OK — silence held to ${SIL}s against a 25s injected stall"; echo


echo "== 7/8  reading GEMINI_API_KEY from the deployed service =="
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

#
# v5.34.74 — render the SHIPPED interviewer before recording against it.
#
# voice-record.mjs used to pin its own three-sentence prompt, so the thing under
# test was never the product's interviewer. Everything judged from a recording
# about coverage, repetition, question quality or when the interview ended was a
# judgement about that stub. This builds the real instruction — persona, agenda,
# closing rules, and a representative briefing — and hands it over.
#
# Built with the backend's own tsx because buildInterviewerInstruction is
# TypeScript and security-relevant: it is what fences interviewee-supplied
# context away from the rules. A JS copy in the harness would drift, and drift
# here is indistinguishable from a product change.
#

# v5.34.78 — $MINUTES is a CEILING now, not a duration.
#
# The run ends at whichever comes first: the interviewer closing the interview,
# the eight scripted answers running out, or the clock. Before this, only the
# clock could end it — so the 2026-09-14 run billed twenty-eight minutes of live
# model output for the tape being replayed at an interviewer that had finished
# at 112 seconds and spent the rest of the half hour saying "we covered that".
#
# Add --loop below ONLY for a deliberate endurance soak (the ~10-minute
# handover needs more conversation than eight answers can supply). A soak
# cannot be read for question quality: past answer eight the interviewee is a
# tape, so any repetition in the verdict is the rig's, not the interviewer's.
echo "== 8/8  recording an interview, up to $MINUTES minutes${EXTRA:+ (SOAK — tape loops, judge repetition only)} =="
echo "It stops early when the interviewer closes or the script runs out."
echo "This runs in the background. Walk away."
# v5.34.112 — KEEP THE MACHINE AWAKE, rather than reminding you to.
#
# A Mac that sleeps mid-run freezes the process: timers stop, the uplink never
# drains, the socket rots, and the trace becomes indistinguishable from a
# network fault. The 2026-09-15 20-minute run lost three minutes that way and
# reported it as the connection jamming — a 30-second timeout that fired 184
# seconds after it was armed. This script has advised `caffeinate -i` since
# v5.34.81; advice that has to be remembered every time is not a guard.
#
# -i prevents idle sleep only. A closed lid still sleeps, which is correct:
# nothing should stop the owner shutting their laptop.
CAFFEINATE=""
if command -v caffeinate >/dev/null 2>&1; then
  CAFFEINATE="caffeinate -i"
  echo "(keeping the machine awake for the run: caffeinate -i)"
else
  echo "!! caffeinate not found — if this machine sleeps mid-run the numbers will be about"
  echo "   the machine, not the model. The verdict now says so explicitly if it happens."
fi
nohup $CAFFEINATE node deploy/voice-record.mjs --minutes "$MINUTES" --model "$LIVE_MODEL" $EXTRA \
      --instruction-file "$INSTRUCTION_FILE" --out voice-record > voice-runner.log 2>&1 &
echo "started, pid $!"
echo
echo "when it finishes — $MINUTES minutes at the very most, often far less:"
echo "  open   ~/vyne/vyne-saas/voice-record.wav      <- listen to this"
echo "  read   ~/vyne/vyne-saas/voice-record.txt      <- the turn table and verdict"
echo "  keep   ~/vyne/vyne-saas/voice-record.log      <- the page trace, for Claude"
echo
echo "watch it live with:  tail -f ~/vyne/vyne-saas/voice-record.txt"
