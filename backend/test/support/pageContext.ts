/**
 * Run the REAL frontend page code inside the test suite. (v5.34.95)
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Every defect this codebase has shipped recently lived in the browser half or
 * at the browser/server seam — dimTiers lost by the server merge, coverageByDim
 * lost by the browser builder, the two roleWeight lookups diverging, the
 * recovery path writing to a key nothing reads, onNote never forwarded. And
 * every one of them passed the suite, because the suite could not RUN the
 * browser half. It could only read it as text.
 *
 * Source-text assertions are what you write when you cannot execute the thing.
 * They pin spelling, not behaviour; they go green against a function wired to
 * nothing; and this session has already produced one that broke on a rename
 * while the behaviour was correct. Executing the page is strictly better, and
 * it turns out to be possible: the pages are plain ES5 with no bundler, so the
 * inline <script> blocks run in a vm context given a sufficient browser shim.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 *
 * Not a DOM implementation. The element proxy answers everything and records
 * nothing, because these tests are about DATA — what goes into the engagement
 * record, what comes out of the scoring — not about rendering. A test that
 * needs real layout belongs in test/browser/ with Playwright.
 *
 * The shim is deliberately permissive: an unstubbed DOM call returns another
 * proxy rather than throwing, so adding a line of UI code to a page cannot
 * break a data test. The trade is that a typo'd DOM call is invisible here —
 * which is fine, because that is what the browser tests are for.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO = join(__dirname, "..", "..", "..");
const FE = join(REPO, "frontend");

/** An element that answers every call with another of itself. */
function fakeEl(): any {
  const store: Record<string, unknown> = { style: {}, dataset: {}, value: "", textContent: "", innerHTML: "" };
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return (t as Record<string | symbol, unknown>)[k];
      if (k === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (k === "children" || k === "childNodes") return [];
      if (k === "parentNode" || k === "parentElement") return null;
      if (typeof k === "symbol") return undefined;
      return () => fakeEl();
    },
    set(t, k, v) { (t as Record<string | symbol, unknown>)[k] = v; return true; },
  });
}

/** A localStorage that behaves like one, and that tests can read directly. */
export interface MemStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
  /** Test-only: the raw map, for asserting on what the page persisted. */
  _raw: Record<string, string>;
}

function memStore(): MemStore {
  const m: Record<string, string> = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    key: (i) => Object.keys(m)[i] ?? null,
    get length() { return Object.keys(m).length; },
    _raw: m,
  };
}

export interface PageContext {
  /** Network calls the page attempted, in order. */
  net(): Array<Record<string, unknown>>;
  /**
   * The sandbox. `var` and `function` declarations land here; `const` and `let`
   * do NOT — V8 puts top-level lexical declarations in the context's global
   * lexical environment, which is shared between scripts but is not a property
   * bag. So `win.DIMENSIONS` is undefined while `evalIn("DIMENSIONS")` works,
   * and `S` (declared `let S = {…}`) is only reachable through evalIn.
   */
  win: any;
  /** The page's localStorage, readable by the test. */
  store: MemStore;
  /** Call a page function by name, with a clear error if it is gone. */
  call<T = unknown>(fn: string, ...args: unknown[]): T;
  /** Evaluate an expression in the page's own scope — reaches const/let too. */
  evalIn<T = unknown>(expr: string): T;
  /** The page's mutable interview state object, `S`. */
  readonly S: any;
}

/**
 * Load a frontend page's inline scripts, plus the shared modules it includes.
 *
 * Every <script src> in the page's head is loaded first, in the page's own
 * order, so the modules see each other exactly as they do in a browser —
 * load-order bugs (a module capturing an undefined global at load time) are
 * therefore reproducible here rather than masked.
 */
export function loadPage(pageFile: string, opts: { store?: MemStore } = {}): PageContext {
  const html = readFileSync(join(FE, pageFile), "utf8");
  const store = opts.store ?? memStore();

  const noop = () => {};
  const sandbox: any = {
    console,
    JSON, Math, Date, Promise, RegExp, Object, Array, String, Number, Boolean, Error,
    Map, Set, WeakMap, Symbol, Proxy, Reflect, Intl,
    isFinite, isNaN, parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    btoa: globalThis.btoa, atob: globalThis.atob,
    crypto: globalThis.crypto, performance: globalThis.performance,
    /*
     * Timers are NEUTRALISED, not faked.
     *
     * The pages arm several background loops at load: the session keepalive,
     * the autosave, the silent token refresh. Left live they keep the vm
     * context (and the vitest worker) alive forever, and they fire real fetches
     * mid-assertion. A test that wants a scheduled callback should call it
     * directly — that is clearer than winding a clock.
     */
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    queueMicrotask: noop,
    /*
     * No network — but SILENTLY no network, not loudly.
     *
     * vyneStore is a local cache in front of a server-backed module_state, and
     * it flushes through XHR. A throwing XHR takes vyne-client.js down at load
     * and there is no storage facade at all; a stub that merely records keeps
     * the local half — which is the half these tests are about — working
     * exactly as it does in a browser whose flush has not come back yet.
     *
     * The calls are recorded rather than discarded so a test CAN assert that a
     * write was queued for the server, and so that an accidental network
     * dependency in a data path is visible instead of silent.
     */
    fetch: (...args: unknown[]) => {
      sandbox.__net.push({ kind: "fetch", args });
      return Promise.reject(new Error("pageContext: network is not available in tests"));
    },
    XMLHttpRequest: function (this: any) {
      const rec: any = { kind: "xhr", method: "", url: "", body: null };
      sandbox.__net.push(rec);
      const self = this;
      this.open = (m: string, u: string) => { rec.method = m; rec.url = u; };
      this.setRequestHeader = noop;
      /*
       * HYDRATION MUST SUCCEED, or the store silently drops every write.
       *
       * vyneStore is a cache in front of server-held module_state, and when its
       * hydrating GET fails it enters a deliberate READ-ONLY mode — "could not
       * load saved state — this session is READ-ONLY until it reconnects" —
       * rather than accumulating local edits it can never reconcile. Correct
       * product behaviour, and fatal to a test harness: setItem returns
       * normally, getItem then returns null, and a pipeline test asserting on
       * what was persisted passes or fails for reasons that have nothing to do
       * with the code under test. It cost an hour to notice, which is exactly
       * how long it would cost the next person.
       *
       * So GETs of module-state answer 200 with an empty state — a signed-in
       * consultant opening a workspace they have not written to yet. Writes
       * (the flush PUT) answer 200 and change nothing local, because the local
       * cache is already the source of truth for the assertions.
       */
      this.send = (b: unknown) => {
        rec.body = b;
        const isState = /\/api\/module-state\//.test(rec.url);
        self.status = isState ? 200 : 0;
        self.readyState = 4;
        /*
         * Hydration answers with the SHARED state, which is what makes a
         * multi-page test possible at all.
         *
         * vyneStore is not localStorage — it is an in-memory cache in front of
         * server-held module_state, hydrated once at page load and flushed back
         * on a debounced timer. With timers neutralised that flush never runs,
         * so a naive harness gives every page its own empty cache: the briefing
         * Pre-Engagement writes is invisible to the Interview Agent, and a
         * chain test silently exercises three unrelated blank workspaces. It
         * cost a confusing "no engagement was written" against logs that said
         * one had been.
         *
         * Answering with the shared map models the real architecture — one
         * server-held state that every page of a workspace sees — without
         * depending on a timer the harness has deliberately stopped.
         */
        self.responseText = isState ? JSON.stringify({ state: { ...store._raw }, versions: {} }) : "";
        if (typeof self.onreadystatechange === "function") { try { self.onreadystatechange(); } catch { /* page's own handler */ } }
        if (typeof self.onload === "function") { try { self.onload(); } catch { /* page's own handler */ } }
      };
      this.abort = noop;
      this.addEventListener = noop;
      this.readyState = 0;
      this.status = 0;
      this.responseText = "";
    },
    navigator: { userAgent: "node", language: "en-GB", mediaDevices: {}, sendBeacon: () => true },
    location: { href: `http://test/${pageFile}`, search: "", pathname: `/${pageFile}`, origin: "http://test", hash: "" },
    history: { replaceState: noop, pushState: noop },
    localStorage: store,
    sessionStorage: memStore(),
    addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
    matchMedia: () => ({ matches: false, addListener: noop, removeListener: noop, addEventListener: noop }),
    alert: noop, confirm: () => true, prompt: () => null,
    speechSynthesis: { cancel: noop, speak: noop, getVoices: () => [] },
    Audio: function () { return fakeEl(); },
    Blob: function () { return {}; },
    FileReader: function () { return fakeEl(); },
    Worker: function () { return fakeEl(); },
    WebSocket: function () { throw new Error("pageContext: no sockets in tests"); },
  };
  sandbox.__net = [];
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  /*
   * SIGNED IN, because every real pipeline runs signed in.
   *
   * vyne-client.js returns early when readSession() finds nothing ("Not signed
   * in → back to the shell. Modules never run unauthenticated.") and that
   * return happens BEFORE window.vyneStore is defined. It is not an exception,
   * so nothing reports it — the page simply loads without the storage facade
   * every persistence path depends on, and the first call to saveSession() or
   * writeInterviewToEngagement() dies on `vyneStore is not defined`.
   *
   * Seeding the session is therefore not test convenience, it is the only
   * configuration in which the page under test is the page that ships.
   */
  sandbox.sessionStorage.setItem("vyne_session", JSON.stringify({
    at: Date.now(), la: Date.now(),
    role: "consultant", email: "test@vynora.test", tenantId: "t-test",
  }));
  sandbox.document = new Proxy({}, {
    get(_t, k) {
      if (k === "getElementById" || k === "querySelector" || k === "createElement" ||
          k === "createTextNode" || k === "createDocumentFragment") return () => fakeEl();
      if (k === "querySelectorAll" || k === "getElementsByClassName" ||
          k === "getElementsByTagName") return () => [];
      if (k === "addEventListener" || k === "removeEventListener") return noop;
      if (k === "body" || k === "head" || k === "documentElement") return fakeEl();
      if (k === "readyState") return "complete";
      if (k === "cookie") return "";
      if (k === "title") return "test";
      if (typeof k === "symbol") return undefined;
      return () => fakeEl();
    },
    set() { return true; },
  });

  vm.createContext(sandbox);

  // The page's own <script src> list, in the page's own order.
  const deps = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const failures: string[] = [];
  for (const d of deps) {
    if (/^https?:/.test(d)) continue; // CDN scripts are not part of the data path
    let src: string;
    try { src = readFileSync(join(FE, d), "utf8"); } catch { continue; }
    try { vm.runInContext(src, sandbox, { filename: d }); }
    catch (e) { failures.push(`${d}: ${(e as Error).message}`); }
  }

  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).filter((s) => s.trim());
  blocks.forEach((b, i) => {
    try { vm.runInContext(b, sandbox, { filename: `${pageFile}#inline${i}` }); }
    catch (e) { failures.push(`${pageFile}#inline${i}: ${(e as Error).message}`); }
  });

  /*
   * A partial load is the dangerous outcome, not an obvious one: function
   * declarations hoist, so the functions exist and look callable while the
   * `var` initialisations after the throw never ran. Every test built on this
   * would then be asserting against half-built state. Fail loudly instead.
   */
  if (failures.length) {
    throw new Error(
      `pageContext: ${pageFile} did not load cleanly, so any test using it would run against ` +
      `half-initialised state. Add the missing browser API to the shim in ` +
      `test/support/pageContext.ts:\n  - ` + failures.join("\n  - "),
    );
  }

  /*
   * WRITE-THROUGH, so what one page stores the next page loads.
   *
   * The counterpart of the hydration above: vyneStore holds its writes in its
   * own cache until a debounced flush that this harness has stopped, so without
   * this the shared state only ever flows one way and every assertion about
   * "the record that was written" reads an empty map. Mirroring setItem and
   * removeItem into the same map keeps the two directions symmetric, and keeps
   * `store._raw` an honest view of what the product persisted.
   *
   * Wrapped AFTER load, deliberately: doing it earlier would mean the page's
   * own hydration wrote itself back through the wrapper.
   */
  const vs = sandbox.vyneStore;
  if (vs && typeof vs.setItem === "function") {
    const origSet = vs.setItem.bind(vs);
    const origDel = typeof vs.removeItem === "function" ? vs.removeItem.bind(vs) : null;
    vs.setItem = (k: string, v: unknown) => { origSet(k, v); store.setItem(k, String(v)); };
    if (origDel) vs.removeItem = (k: string) => { origDel(k); store.removeItem(k); };
  }

  const evalIn = <T,>(expr: string): T => vm.runInContext(expr, sandbox, { filename: "evalIn" }) as T;

  return {
    win: sandbox,
    store,
    evalIn,
    net: () => sandbox.__net,
    /* `S` is `let S = {…}`, so it is a lexical binding, not a sandbox property.
     * A getter rather than a snapshot: the page reassigns S wholesale on resume
     * (`S = {...S, ...sess}`), and a captured reference would silently go stale
     * exactly where a resume test needs it not to. */
    get S() { return evalIn<any>("S"); },
    call<T>(fn: string, ...args: unknown[]): T {
      // Functions hoist onto the sandbox; fall back to a lexical lookup for a
      // page that ever declares one as `const f = () => …`.
      const f = typeof sandbox[fn] === "function" ? sandbox[fn] : evalIn<unknown>(`typeof ${fn}==='function'?${fn}:null`);
      if (typeof f !== "function") {
        throw new Error(`pageContext: ${pageFile} has no function ${fn}() — it was renamed or removed`);
      }
      return (f as (...a: unknown[]) => T).apply(sandbox, args);
    },
  };
}

export const loadInterviewAgent = (store?: MemStore) =>
  loadPage("interview_agent.html", { store });
export const loadSynthesis = (store?: MemStore) =>
  loadPage("synthesis.html", { store });
