/**
 * v5.34.12 — pause/mute single-source-of-truth invariant.
 *
 * All pause/resume in the Interview Agent flows through one authority
 * (setInterviewPaused in interview_agent.html). This pins the invariant that
 * fn must uphold on EVERY path: the three mute layers
 *   IV_CLOCK.paused  ->  LiveInterview._muted  ->  session.muted
 * always agree, and a NON-paused interview is always audible (unmuted). The
 * silent-restart / silent-resume bugs were all violations of this invariant on
 * one path or another. This models the authority and drives every path.
 */
import { describe, it, expect } from "vitest";

function makeSession(alive = true) {
  return { muted: false, alive, setMuted(m: boolean){ this.muted = !!m; }, isAlive(){ return this.alive; } };
}
function makeLIVE(sess: any) {
  return { session: sess, _muted: false, _openingSent: false,
    isAlive(){ return !!(sess && sess.isAlive()); },
    setMuted(m: boolean){ this._muted = !!m; if (this.session) this.session.setMuted(m); } };
}

function makeWorld() {
  const world: any = { LIVE: null, IV_CLOCK: { paused: false } };
  function startLiveVoice() {
    const sess = makeSession(true);
    world.LIVE = makeLIVE(sess);
    if (world.LIVE && !world.LIVE._openingSent) {
      world.LIVE._openingSent = true;
      if (world.IV_CLOCK.paused) setInterviewPaused(false);
      else world.LIVE.setMuted(false);
    }
  }
  function setInterviewPaused(paused: boolean) {
    paused = !!paused;
    world.IV_CLOCK.paused = paused;
    if (paused) {
      if (world.LIVE && world.LIVE.isAlive()) world.LIVE.setMuted(true);
    } else if (world.LIVE) {
      if (world.LIVE.isAlive()) world.LIVE.setMuted(false);
      else startLiveVoice();
      if (world.LIVE && world.LIVE.isAlive()) world.LIVE.setMuted(false);
    }
  }
  world.startLiveVoice = startLiveVoice;
  world.setInterviewPaused = setInterviewPaused;
  world.consistent = () => {
    const p = world.IV_CLOCK.paused;
    if (!world.LIVE) return true;
    return world.LIVE._muted === p && world.LIVE.session.muted === p;
  };
  return world;
}

describe("pause/mute single source of truth", () => {
  it("fresh start is audible and consistent", () => {
    const w = makeWorld(); w.startLiveVoice();
    expect(w.consistent()).toBe(true);
    expect(w.LIVE.session.muted).toBe(false);
  });
  it("pause mutes; resume(alive) unmutes", () => {
    const w = makeWorld(); w.startLiveVoice();
    w.setInterviewPaused(true);  expect(w.LIVE.session.muted).toBe(true);  expect(w.consistent()).toBe(true);
    w.setInterviewPaused(false); expect(w.LIVE.session.muted).toBe(false); expect(w.consistent()).toBe(true);
  });
  it("resume after grant expiry reconnects AND is audible (the silent bug)", () => {
    const w = makeWorld(); w.startLiveVoice();
    w.setInterviewPaused(true);
    w.LIVE.session.alive = false;      // grant expires while paused
    w.setInterviewPaused(false);
    expect(w.LIVE.isAlive()).toBe(true);
    expect(w.LIVE.session.muted).toBe(false);
    expect(w.consistent()).toBe(true);
  });
  it("restart mid-interview yields an audible session", () => {
    const w = makeWorld(); w.startLiveVoice();
    w.setInterviewPaused(true);
    w.startLiveVoice();                 // restart = fresh session
    expect(w.LIVE.session.muted).toBe(false);
    expect(w.consistent()).toBe(true);
  });
  it("double pause / double resume is idempotent and ends audible", () => {
    const w = makeWorld(); w.startLiveVoice();
    w.setInterviewPaused(true); w.setInterviewPaused(true); expect(w.consistent()).toBe(true);
    w.setInterviewPaused(false); w.setInterviewPaused(false);
    expect(w.LIVE.session.muted).toBe(false); expect(w.consistent()).toBe(true);
  });
  it("5 rapid pause/resume cycles never end muted", () => {
    const w = makeWorld(); w.startLiveVoice();
    for (let i = 0; i < 5; i++) { w.setInterviewPaused(true); w.setInterviewPaused(false); }
    expect(w.LIVE.session.muted).toBe(false); expect(w.consistent()).toBe(true);
  });
});
