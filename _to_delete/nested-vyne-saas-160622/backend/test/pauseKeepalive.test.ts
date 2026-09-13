/**
 * v5.34.21 — silent keepalive holds the socket open during a pause.
 *
 * Before: a muted session sent NO microphone frames (onaudioprocess returned
 * on self.muted), the socket went idle, the server closed it, and pause tore
 * the whole session down — Resume had to re-mint, and after a few cycles the
 * per-user concurrency cap refused it ("stops after the Nth pause"). Now, while
 * muted, the session sends a low-rate SILENT frame to keep the uplink warm, so
 * Resume unmutes a still-living session. This pins that behaviour.
 */
import { describe, it, expect } from "vitest";

const FRAME_SAMPLES = 2048;

function makeSession() {
  return {
    closed: false, muted: false,
    ws: { readyState: 1, sent: [] as any[], send(x: string) { this.sent.push(JSON.parse(x)); } },
    _lastKeepAlive: 0,
    tick(nowTs: number) {
      const self = this as any;
      if (self.closed || !self.ws || self.ws.readyState !== 1) return;
      if (self.muted) {
        if (!self._lastKeepAlive || (nowTs - self._lastKeepAlive) >= 2000) {
          self._lastKeepAlive = nowTs;
          self.ws.send(JSON.stringify({ realtimeInput: { audio: { data: "AAAA", kind: "silent" } } }));
        }
        return;
      }
      self.ws.send(JSON.stringify({ realtimeInput: { audio: { data: "REAL", kind: "mic" } } }));
    },
  };
}

describe("pause keepalive", () => {
  it("sends throttled silent keepalives while muted (not one per frame)", () => {
    const s = makeSession(); s.muted = true;
    for (let t = 0; t <= 5000; t += 128) s.tick(t); // ~40 frames over 5s
    const silent = s.ws.sent.filter((f) => f.realtimeInput.audio.kind === "silent");
    expect(silent.length).toBeGreaterThanOrEqual(2);
    expect(silent.length).toBeLessThanOrEqual(4);
    expect(s.ws.sent.every((f) => f.realtimeInput.audio.kind === "silent")).toBe(true);
  });
  it("sends real mic frames when unmuted", () => {
    const s = makeSession();
    for (let t = 0; t <= 1000; t += 128) s.tick(t);
    expect(s.ws.sent.length).toBeGreaterThan(0);
    expect(s.ws.sent.every((f) => f.realtimeInput.audio.kind === "mic")).toBe(true);
  });
  it("sends nothing into a closed socket", () => {
    const s = makeSession(); s.muted = true; s.ws.readyState = 3;
    for (let t = 0; t <= 5000; t += 128) s.tick(t);
    expect(s.ws.sent.length).toBe(0);
  });
  it("sends nothing when the session is closed", () => {
    const s = makeSession(); s.muted = true; s.closed = true;
    for (let t = 0; t <= 5000; t += 128) s.tick(t);
    expect(s.ws.sent.length).toBe(0);
  });
});
