/**
 * A turn discarded during a pause stays discarded. (v5.34.111)
 *
 * ── How this was found ──────────────────────────────────────────────────────
 *
 * Looking for what a ~10-minute handover loses. The first theory was that the
 * turn-close notice — raised by _closeTurn, delivered by
 * _drainTurnCompleteNotice — was left pending when a connection was torn down,
 * because it is drained "when the next frame arrives" and a handover is
 * engineered to happen when no next frame is coming.
 *
 * That theory was WRONG, and the 625-sequence handover enumeration in
 * turnCloseSequences.test.ts is what said so: removing both new drain sites
 * left it green. The reason is that _closeTurn has exactly two callers —
 * the generationComplete salvage timer, which drains immediately after it, and
 * _noteModelActivity, which is called from the socket frame handler, which
 * drains at the END OF THE SAME HANDLER. A turn closed by a turnComplete frame
 * is therefore announced by that frame's own handler, before anything can tear
 * the connection down.
 *
 * Exactly one path breaks that. The frame handler is:
 *
 *      self._noteModelActivity(f);        // <- may call _closeTurn
 *      ...
 *      if (self.muted) { ...; return; }   // <- EARLY RETURN
 *      ...
 *      self._drainTurnCompleteNotice();   // <- never reached
 *
 * So when the interviewee has PAUSED, a turnComplete still closes the turn and
 * still raises the notice, and the drain is skipped. The pause path is
 * deliberate and documented — "a turn that arrives mid-pause is discarded
 * whole ... Drop the entire turn" (v5.34.28) — but the notice it leaves behind
 * is not discarded with it. It sits on the session until some later frame
 * drains it, and then onTurnComplete runs for a turn whose content was thrown
 * away: _flushPending() commits whatever text is around it to the transcript,
 * onTurns() persists that, and _score() scores it. A turn the product decided
 * not to have, arriving in the record minutes later, attached to the wrong
 * moment in the conversation.
 *
 * ── Why this file exists rather than a wider change ─────────────────────────
 *
 * The idle-defer drain added in this same version makes the dangling notice
 * MORE likely to be delivered, not less — the floor-hold timer fires whether
 * or not the session is muted. So the two changes interact, and the pause path
 * has to say explicitly what it means: the turn is dropped, and so is the
 * notice that it happened.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const FE = (f: string) => readFileSync(join(root, "frontend", f), "utf8");
const src = FE("vyne-live.js");

function makeWorld() {
  const sockets: any[] = [];
  class FakeWebSocket {
    static OPEN = 1;
    url: string; readyState = 0; binaryType = "";
    onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
    constructor(url: string) {
      this.url = url; sockets.push(this);
      setTimeout(() => {
        this.readyState = 1; this.onopen && this.onopen();
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) }), 1);
      }, 1);
    }
    send() {}
    close() { this.readyState = 3; }
    frame(sc: any) { this.onmessage?.({ data: JSON.stringify({ serverContent: sc }) }); }
  }
  const ctx = () => ({
    state: "running", sampleRate: 16000, currentTime: 0,
    resume: async () => {}, close: () => {},
    createMediaStreamSource: () => ({ connect() {} }),
    createScriptProcessor: () => ({ connect() {}, disconnect() {}, onaudioprocess: null }),
    createGain: () => ({ gain: { value: 0 }, connect() {} }),
    createBuffer: (_c: number, len: number, rate: number) =>
      ({ getChannelData: () => new Float32Array(len), duration: len / rate }),
    createBufferSource: () => ({ buffer: null, connect() {}, start() {}, stop() {}, onended: null }),
    destination: {},
  });
  const win: any = {
    WebSocket: FakeWebSocket,
    AudioContext: function () { return ctx(); },
    navigator: { mediaDevices: { getUserMedia: async () => ({
      getTracks: () => [],
      getAudioTracks: () => [{ readyState: "live", muted: false, enabled: true, label: "m", getSettings: () => ({ sampleRate: 48000 }) }],
    }) } },
    fetch: async () => ({ ok: true, json: async () => ({
      token: "tok", model: "m", voice: "Kore", pinned: true, maxSeconds: 900, sessionId: "s1" }) }),
    console: { ...console, log: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    TextDecoder,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    VYNE_TURN_CLOSE_GRACE_MS: 15,
    VYNE_OPEN_RETRY_MS: 5000,
    VYNE_REPLY_WATCHDOG_MS: 5000,
    VYNE_MIC_SILENT_WARN_MS: 5000,
  };
  win.window = win; win.self = win;
  const c = vm.createContext(win);
  vm.runInContext(src, c, { filename: "vyne-live.js" });
  return { win, sockets };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const audio = (sock: any) => sock.frame({ modelTurn: { parts: [{ inlineData: {
  mimeType: "audio/pcm;rate=24000", data: "AAAAAAAAAAA=" } }] } });

async function live(onTurnComplete: () => void) {
  const w = makeWorld();
  const s = new w.win.vyneLive.Session({ onTurnComplete });
  const p = s.start(); await wait(12); await p;
  return { s, sock: w.sockets[0] };
}

describe("v5.34.111 — a paused turn is dropped, notice and all", () => {
  it("a turn that completes during a pause is never announced", async () => {
    /*
     * THE defect. Before the fix the notice survived the discard and was
     * delivered by whatever frame came next — often after the interviewee had
     * resumed and the conversation had moved on.
     */
    let notices = 0;
    const { s, sock } = await live(() => { notices++; });
    s.setMuted(true);
    audio(sock); await wait(20);
    sock.frame({ turnComplete: true }); await wait(40);
    expect(notices, "a turn discarded during a pause was announced to the app").toBe(0);
  });

  it("and is not announced later, once the interviewee resumes", async () => {
    /*
     * The part that actually corrupts the record: the notice used to sit on
     * the session and go out attached to the first frame after the resume, so
     * the discarded turn landed in the transcript in the wrong place.
     */
    let notices = 0;
    const { s, sock } = await live(() => { notices++; });
    s.setMuted(true);
    audio(sock); await wait(20);
    sock.frame({ turnComplete: true }); await wait(40);
    s.setMuted(false);
    await wait(20);
    sock.onmessage({ data: JSON.stringify({ usageMetadata: { promptTokenCount: 5, responseTokenCount: 5 } }) });
    await wait(60);
    expect(notices, "the discarded turn was resurrected after the resume").toBe(0);
  });

  it("nor when the paused session is torn down", async () => {
    // A grant that lapses mid-pause is left to die (v5.34.8). stop() drains as
    // a last resort, and must not pay out a turn the pause threw away.
    let notices = 0;
    const { s, sock } = await live(() => { notices++; });
    s.setMuted(true);
    audio(sock); await wait(20);
    sock.frame({ turnComplete: true }); await wait(40);
    s.stop("paused_lapse");
    await wait(30);
    expect(notices).toBe(0);
  });

  it("nor when the floor-hold timer fires during the pause", async () => {
    /*
     * The interaction with this version's other change. _closeTurn arms the
     * floor hold whether or not the session is muted, and that timer now
     * drains the notice — so without a guard the pause fix would be undone by
     * the handover fix.
     */
    let notices = 0;
    const { s, sock } = await live(() => { notices++; });
    s.setMuted(true);
    audio(sock); await wait(20);
    sock.frame({ turnComplete: true });
    await wait(400);
    expect(notices).toBe(0);
  });

  it("a turn that completes while NOT paused is still announced", async () => {
    // The guard must not cost the ordinary path anything.
    let notices = 0;
    const { sock } = await live(() => { notices++; });
    audio(sock); await wait(20);
    sock.frame({ turnComplete: true }); await wait(40);
    expect(notices).toBe(1);
  });

  it("a turn after the resume is announced normally", async () => {
    let notices = 0;
    const { s, sock } = await live(() => { notices++; });
    s.setMuted(true);
    audio(sock); await wait(20);
    sock.frame({ turnComplete: true }); await wait(40);
    s.setMuted(false);
    audio(sock); await wait(20);
    sock.frame({ turnComplete: true }); await wait(40);
    expect(notices, "the interview did not recover after the pause").toBe(1);
  });
});

describe("v5.34.111 — the shape of the frame handler this depends on", () => {
  /*
   * The behaviour above is only interesting because of where the early return
   * sits. Pinned so that a later tidy-up moving the drain, or the muted check,
   * fails here with an explanation rather than silently changing what a pause
   * means.
   */
  const handler = () => {
    const at = src.indexOf("var f = parseServerFrame(msg);");
    expect(at, "the frame handler moved — update this test").toBeGreaterThan(-1);
    const end = src.indexOf("ws.onerror = function", at);
    return src.slice(at, end);
  };

  it("the muted branch still returns before the drain", () => {
    const h = handler();
    const muted = h.indexOf("if (self.muted) {");
    const drain = h.indexOf("self._drainTurnCompleteNotice();");
    expect(muted).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(-1);
    expect(muted, "the muted early return no longer precedes the drain — re-read this file")
      .toBeLessThan(drain);
  });

  it("the turn is still closed before the muted check", () => {
    // _noteModelActivity is what calls _closeTurn, and it runs first. That is
    // the whole reason a notice can be left behind by a paused turn.
    const h = handler();
    expect(h.indexOf("self._noteModelActivity(f);")).toBeLessThan(h.indexOf("if (self.muted) {"));
  });
});
