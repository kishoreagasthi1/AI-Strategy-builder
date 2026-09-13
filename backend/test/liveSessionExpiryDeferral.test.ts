/**
 * v5.34.33 — the app session must not tear down a running voice interview.
 *
 * Two separate paths in frontend/vyne-client.js ended with
 * `location.href = "index.html?expired=1"`: a hard 401/403 from any background
 * call (the per-turn scoring pass, a state flush) and the 30-minute idle sweep,
 * whose activity signal is click/keydown/mousemove/touchstart — none of which a
 * hands-free interview produces. Either one replaced the document while the
 * realtime socket was still working, because that socket talks to Google with
 * an ephemeral token and needs nothing from our API. It also destroyed the
 * in-memory diagnostic trace, which is how a ten-minute failure came back
 * unreadable.
 *
 * These run the SHIPPED vyne-client.js in a vm and assert on navigation, not
 * on source text: the bug was in when the redirect fires, so that is what is
 * pinned here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "..", "..", "frontend", "vyne-client.js"), "utf8");

const MINUTE = 60 * 1000;

function makeApp(opts: { live?: boolean; sessionAgeMs?: number; idleMs?: number } = {}) {
  const store: Record<string, string> = {};
  const navigations: string[] = [];
  const logged: string[] = [];
  const now = Date.now();

  const win: any = {
    VYNE_MODULE: "interview_agent",
    sessionStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = String(v); },
      removeItem: (k: string) => { delete store[k]; },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    // location.href is the whole point: assigning it is the navigation.
    location: {
      search: "",
      _href: "interview_agent.html",
      get href() { return this._href; },
      set href(v: string) { this._href = v; navigations.push(v); },
    },
    document: {
      addEventListener: () => {}, readyState: "complete", getElementById: () => null,
      createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
      body: { appendChild() {} },
    },
    addEventListener: () => {},
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    XMLHttpRequest: function (this: any) {
      this.open = () => {}; this.setRequestHeader = () => {}; this.send = () => {};
      this.status = 200; this.responseText = "{}";
    },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    console: { ...console, log: () => {}, info: () => {}, error: () => {} },
    navigator: { userAgent: "node" },
    // vyne-live.js is not loaded here; these are the two globals it publishes.
    __vyneLiveActive: !!opts.live,
    vyneLiveLog: (m: string) => { logged.push(String(m)); },
    vyneLiveLogFlush: () => { logged.push("FLUSHED"); },
  };
  win.window = win; win.self = win;

  store["vyne_session"] = JSON.stringify({
    token: "t", mode: "idp",
    at: now - (opts.sessionAgeMs ?? MINUTE),
    la: now - (opts.idleMs ?? MINUTE),
  });

  vm.runInContext(SRC, vm.createContext(win), { filename: "vyne-client.js" });
  return { win, store, navigations, logged };
}

/**
 * Age the STORED session, which is how time passes for the policy: the page
 * loads with a good session (the module bails to the shell at load time
 * otherwise, before any interview exists) and crosses the idle or absolute
 * line while the interview is already running. That is the real sequence.
 */
function age(app: { store: Record<string, string> }, patch: { idleMs?: number; ageMs?: number }) {
  const s = JSON.parse(app.store["vyne_session"]);
  const now = Date.now();
  if (patch.idleMs !== undefined) s.la = now - patch.idleMs;
  if (patch.ageMs !== undefined) s.at = now - patch.ageMs;
  app.store["vyne_session"] = JSON.stringify(s);
}

describe("v5.34.33 — a 401 mid-interview defers the sign-out", () => {
  it("with no live session, a 401 returns to login immediately (unchanged)", () => {
    const app = makeApp({ live: false });
    expect(app.win.vyneAuth.handleAuthFailure(401)).toBe(true);
    expect(app.navigations).toEqual(["index.html?expired=1"]);
    expect(app.store["vyne_session"]).toBeUndefined();
  });

  it("with a live session, the same 401 drops the token but does NOT navigate", () => {
    const app = makeApp({ live: true });
    expect(app.win.vyneAuth.handleAuthFailure(401)).toBe(true);
    expect(app.navigations).toEqual([]);
    // The dead token is gone regardless — no further call goes out on it.
    expect(app.store["vyne_session"]).toBeUndefined();
    expect(app.logged.join(" ")).toMatch(/sign-out DEFERRED until live ends/);
  });

  it("the deferred sign-out fires the moment the live session goes idle", () => {
    const app = makeApp({ live: true });
    app.win.vyneAuth.handleAuthFailure(401);
    expect(app.navigations).toEqual([]);
    expect(typeof app.win.__vyneOnLiveIdle).toBe("function");
    app.win.__vyneLiveActive = false;
    app.win.__vyneOnLiveIdle();                       // vyne-live.js calls this from _set
    expect(app.navigations).toEqual(["index.html?expired=1"]);
    // …and the across-navigation trace copy is written before the page goes.
    expect(app.logged).toContain("FLUSHED");
  });

  it("a second failure while one is already deferred does not queue a second redirect", () => {
    const app = makeApp({ live: true });
    app.win.vyneAuth.handleAuthFailure(401);
    app.win.vyneAuth.handleAuthFailure(403);
    app.win.vyneAuth.handleAuthFailure("invalid_token");
    app.win.__vyneOnLiveIdle();
    expect(app.navigations).toEqual(["index.html?expired=1"]);
  });

  it("an explicit sign-out is still immediate — deferral is for expiry, not intent", () => {
    const app = makeApp({ live: true });
    app.win.vyneAuth.signOut();
    expect(app.navigations).toEqual(["index.html"]);
  });
});

describe("v5.34.33 — idle expiry counts talking as activity", () => {
  it("exposes vyneTouchSession so the live path can refresh the idle clock", () => {
    const app = makeApp();
    age(app, { idleMs: 25 * MINUTE });
    expect(typeof app.win.vyneTouchSession).toBe("function");
    const before = JSON.parse(app.store["vyne_session"]).la;
    app.win.vyneTouchSession();
    const after = JSON.parse(app.store["vyne_session"]).la;
    expect(after).toBeGreaterThan(before);
    // …and the refreshed clock is what keeps the session alive.
    expect(app.win.vyneAuth.session()).toBeTruthy();
    expect(app.navigations).toEqual([]);
  });

  it("an idle session with no live interview still expires on the next call", () => {
    const app = makeApp({ live: false });
    age(app, { idleMs: 31 * MINUTE });
    expect(app.win.vyneAuth.session()).toBe(null);
    expect(app.navigations).toEqual(["index.html?expired=1"]);
  });

  it("an idle session DURING a live interview does not yank the page away", () => {
    const app = makeApp({ live: true });
    age(app, { idleMs: 31 * MINUTE });
    expect(app.win.vyneAuth.session()).toBe(null);   // the session is over…
    expect(app.navigations).toEqual([]);             // …but the interview is not
    app.win.__vyneOnLiveIdle();
    expect(app.navigations).toEqual(["index.html?expired=1"]);
  });

  it("the absolute 12-hour cap behaves the same way — deferred, never ignored", () => {
    const app = makeApp({ live: true });
    age(app, { ageMs: 13 * 60 * MINUTE });
    expect(app.win.vyneAuth.session()).toBe(null);
    expect(app.navigations).toEqual([]);
    app.win.__vyneOnLiveIdle();
    expect(app.navigations).toEqual(["index.html?expired=1"]);
  });
});
