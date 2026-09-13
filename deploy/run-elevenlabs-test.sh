#!/bin/bash
# EXPERIMENT 2 — does a 120-minute voice call survive on ElevenLabs Agents?
#
#   bash deploy/run-elevenlabs-test.sh <agent_id>          120 minutes
#   bash deploy/run-elevenlabs-test.sh <agent_id> 30        a 30-minute shakedown
#
# The offline rig check runs first. It needs no key and costs nothing, and it
# is here because a broken harness and a broken vendor produce identical
# output — a mistake this project has already made four times.
set -u

AGENT="${1:-}"
MINUTES="${2:-120}"
KEYFILE="$HOME/vyne/elevenlabs-key.txt"

cd "$HOME/vyne/vyne-saas" || { echo "cannot find ~/vyne/vyne-saas"; exit 1; }

if [ -z "$AGENT" ]; then
  echo "usage: bash deploy/run-elevenlabs-test.sh <agent_id> [minutes]"
  echo "       the agent id is on the agent's page in the ElevenLabs dashboard"
  exit 1
fi

echo "== 1/3  checking the harness itself (offline, no key, no cost) =="
node deploy/elevenlabs-record.mjs --offline --minutes 1.1 --out elevenlabs-selfcheck \
  || { echo; echo "FAILED: the harness is broken before ElevenLabs is involved. Stop here."; exit 2; }
grep -q "disconnects: 0" elevenlabs-selfcheck.txt \
  || { echo; echo "FAILED: the offline check reported a disconnect it should not have. Stop here."; exit 2; }
echo "harness OK"; echo

echo "== 2/3  reading the ElevenLabs key =="
if [ ! -f "$KEYFILE" ]; then
  echo "FAILED: $KEYFILE does not exist."
  echo "  Create it with your ElevenLabs API key on one line:"
  echo "    Settings -> API Keys -> Create, then paste it into that file."
  echo "  Do NOT paste the key into a chat window."
  exit 2
fi
ELEVENLABS_API_KEY="$(tr -d ' \t\n\r' < "$KEYFILE")"
export ELEVENLABS_API_KEY
if [ -z "$ELEVENLABS_API_KEY" ]; then echo "FAILED: $KEYFILE is empty."; exit 2; fi
chmod 600 "$KEYFILE" 2>/dev/null
echo "key length ${#ELEVENLABS_API_KEY} — ok"; echo

echo "== 3/3  holding a $MINUTES-minute call with agent $AGENT =="
echo "This runs in the background and will use about $MINUTES call-minutes."
nohup node deploy/elevenlabs-record.mjs --agent "$AGENT" --minutes "$MINUTES" --out elevenlabs-record \
  > elevenlabs-runner.log 2>&1 &
echo "started, pid $!"
echo
echo "watch it live:   tail -f ~/vyne/vyne-saas/elevenlabs-record.txt"
echo "when it ends:    open ~/vyne/vyne-saas/elevenlabs-record.wav"
echo "                 read ~/vyne/vyne-saas/elevenlabs-record.txt   <- send this to Claude"
