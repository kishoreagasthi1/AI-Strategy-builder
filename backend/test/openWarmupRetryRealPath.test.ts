/**
 * v5.34.16 — opening warmup retry on the REAL path (LiveInterview.open).
 *
 * The opening turn is sent via LiveInterview.open() -> session.sendText(), NOT
 * the _pendingText flush. The earlier retry (v5.34.15) armed only during that
 * flush, so it never fired for the real opening and the interview still opened
 * mute when the model dropped the first turn during warmup. open() now resends
 * once if no agent frame (session._gotAgentFrame) arrives within 3.5s, and
 * skips the resend when answered, muted, or the socket is gone. Verified live
 * (retry fired, 123 audio frames). This pins the behaviour.
 */
import { describe, it, expect } from "vitest";

function makeLI() {
  const session: any = {
    closed: false, ws: { readyState: 1 }, _gotAgentFrame: false, sends: [] as string[],
    sendText(t: string) { this.sends.push(t); return true; },
  };
  const LI: any = {
    session, _muted: false, _openRetry: null,
    open(line: string) {
      const self = this;
      if (!this.session) return;
      this.session._gotAgentFrame = false;
      this.session.sendText(line);
      if (this._openRetry) clearTimeout(this._openRetry);
      this._openRetry = setTimeout(() => {
        const s = self.session;
        if (s && !s.closed && !self._muted && s.ws && s.ws.readyState === 1 && !s._gotAgentFrame) {
          s.sendText(line);
        }
      }, 40);
    },
  };
  return LI;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("opening warmup retry (real path)", () => {
  it("resends once when the opening is dropped (no agent frame)", async () => {
    const LI = makeLI(); LI.open("BEGIN"); await wait(90);
    expect(LI.session.sends).toEqual(["BEGIN", "BEGIN"]);
  });
  it("does not resend when an agent frame arrives", async () => {
    const LI = makeLI(); LI.open("BEGIN");
    setTimeout(() => { LI.session._gotAgentFrame = true; }, 15);
    await wait(90);
    expect(LI.session.sends).toEqual(["BEGIN"]);
  });
  it("does not resend while muted (paused)", async () => {
    const LI = makeLI(); LI.open("BEGIN"); LI._muted = true; await wait(90);
    expect(LI.session.sends).toEqual(["BEGIN"]);
  });
  it("does not resend into a closed socket", async () => {
    const LI = makeLI(); LI.open("BEGIN"); LI.session.closed = true; await wait(90);
    expect(LI.session.sends).toEqual(["BEGIN"]);
  });
  it("never loops — exactly one retry", async () => {
    const LI = makeLI(); LI.open("BEGIN"); await wait(200);
    expect(LI.session.sends.length).toBe(2);
  });
});
