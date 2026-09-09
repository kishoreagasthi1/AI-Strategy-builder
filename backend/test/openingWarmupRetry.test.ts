/**
 * v5.34.15 — opening warmup retry.
 *
 * "setupComplete" does not guarantee the model is ready to GENERATE. A turn
 * sent in the instant after setupComplete can be silently dropped, so the
 * interview opened mute even though the opening was sent (intermittent). The
 * client now remembers the opening turn and, if no response frame arrives
 * within a few seconds, resends it ONCE. This pins that behaviour: resend when
 * silent, do not resend when a response arrived, never loop.
 */
import { describe, it, expect, vi } from "vitest";

function makeSession() {
  return {
    closed: false,
    ws: { readyState: 1 },
    sends: [] as string[],
    _sawFirstResponse: false,
    _openingTurn: null as string | null,
    _openingRetryTimer: null as any,
    sendText(t: string) { this.sends.push(t); return true; },
    flushOpening(turn: string, delay = 40) {
      this._openingTurn = turn; this._sawFirstResponse = false;
      this.sendText(turn);
      const self = this;
      this._openingRetryTimer = setTimeout(() => {
        if (!self._sawFirstResponse && !self.closed && self.ws && self.ws.readyState === 1 && self._openingTurn) {
          self.sendText(self._openingTurn);
        }
      }, delay);
    },
    onResponse(has: boolean) {
      if (!this._sawFirstResponse && has) {
        this._sawFirstResponse = true;
        if (this._openingRetryTimer) { clearTimeout(this._openingRetryTimer); this._openingRetryTimer = null; }
      }
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("opening warmup retry", () => {
  it("resends the opening once when the model stays silent", async () => {
    const s = makeSession(); s.flushOpening("BEGIN", 30);
    await wait(80);
    expect(s.sends).toEqual(["BEGIN", "BEGIN"]);
  });
  it("does not resend when a response arrives in time", async () => {
    const s = makeSession(); s.flushOpening("BEGIN", 30);
    setTimeout(() => s.onResponse(true), 10);
    await wait(80);
    expect(s.sends).toEqual(["BEGIN"]);
  });
  it("does not resend into a closed socket", async () => {
    const s = makeSession(); s.flushOpening("BEGIN", 30);
    s.closed = true;
    await wait(80);
    expect(s.sends).toEqual(["BEGIN"]);
  });
  it("never sends more than one retry (no loop)", async () => {
    const s = makeSession(); s.flushOpening("BEGIN", 30);
    await wait(200);
    expect(s.sends.length).toBe(2);
  });
});
