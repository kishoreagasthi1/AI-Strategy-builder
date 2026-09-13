/**
 * Drive the REAL frontend pages in a REAL browser. (v5.34.56)
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Every frontend "test" in this repo before today was a string search over an
 * HTML file. Those catch a renamed id and nothing else. They cannot tell you
 * whether the tab switches, the fetch fires, the table fills, or the submit
 * button ever enables — and on 2026-09-12 they did not: a pane of markup was
 * inserted INSIDE a <script> block, which would have rendered the rest of
 * billing.html's JavaScript as visible text, and every static assertion about
 * that page still passed. It was caught by reading, which is not a process.
 *
 * So: Chromium, the actual files from frontend/, a stub API, and assertions
 * about what a person would see.
 *
 * ── The stub, and what it deliberately does not do ──────────────────────────
 *
 * The API is stubbed rather than run, because the point is the PAGE. Route
 * behaviour has its own tests against real Postgres (byokRoutes.test.ts); what
 * is untested until now is whether the page calls them correctly and does
 * something sensible with the answer. Stubbing also lets a test produce a 500,
 * an empty list, or a malformed row on demand — states that are tedious to
 * arrange for real and are exactly where pages break.
 *
 * Chromium is preinstalled in this container; playwright-core drives it and
 * downloads nothing.
 */
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/*
 * playwright-core is imported LAZILY, inside the function that needs it.
 *
 * v5.34.58. It was a top-level import, and a top-level import runs at module
 * LOAD — before any describe.skipIf can execute. So on a machine where the
 * devDependency is not installed (a consultant's checkout that has not run
 * `npm install` since v5.34.56) the whole suite failed to COLLECT, and
 * `deploy.sh` failed with it. The skip guard was written for a missing
 * BROWSER and did not cover a missing PACKAGE, which is the likelier absence.
 *
 * Types are imported type-only, which is erased at compile time and costs
 * nothing at runtime.
 */
import type { Browser, Page } from "playwright-core";

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "frontend");

/**
 * Chromium's path inside this image. Resolved rather than hardcoded, because
 * the build number changes when the base image is rebuilt and a hardcoded one
 * turns into "tests silently stopped running" the day it does.
 */
function chromiumPath(): string {
  /*
   * Two layouts, because this suite runs in two places and a hardcoded path
   * turns into "the UI tests silently stopped running" the day either changes:
   *
   *   /opt/pw-browsers/chromium-<build>/chrome-linux/chrome   this container
   *   /ms-playwright/chromium-<build>/chrome-linux/chrome     the Playwright
   *                                                           Docker image
   *
   * PLAYWRIGHT_CHROMIUM overrides both, for anywhere neither holds.
   */
  const explicit = process.env.PLAYWRIGHT_CHROMIUM;
  if (explicit && existsSync(explicit)) return explicit;

  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/ms-playwright", "/opt/pw-browsers"]
    .filter((r): r is string => Boolean(r) && existsSync(r as string));

  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  for (const root of roots) {
    for (const d of readdirSync(root).filter((x) => x.startsWith("chromium"))) {
      for (const rel of [["chrome-linux", "chrome"], ["chrome-linux", "headless_shell"]]) {
        const p = join(root, d, ...rel);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error(
    `No Chromium found. Looked under ${roots.join(", ") || "(nothing)"}. ` +
    `Set PLAYWRIGHT_CHROMIUM to the binary, or run these through ` +
    `deploy/run-ui-tests.sh which uses the Playwright image.`
  );
}

/**
 * Can this machine run the browser suite at all?
 *
 * On a consultant's Mac running `deploy.sh`, Chromium is not installed and
 * these tests must SKIP rather than fail the release — a gate that cannot be
 * satisfied locally gets bypassed, and a bypassed gate is worse than none.
 *
 * Inside the Docker runner VYNE_REQUIRE_BROWSER=1 is set, and a missing browser
 * is then a hard failure: that is the environment whose whole job is to have
 * one, and a silent skip there would mean the frontend quietly stopped being
 * tested. Which is exactly the state this suite was written to end.
 */
export function playwrightInstalled(): boolean {
  try {
    (require as any).resolve("playwright-core");
    return true;
  } catch { return false; }
}

export function browserAvailable(): boolean {
  if (!playwrightInstalled()) return false;
  try { chromiumPath(); return true; } catch { return false; }
}

export function browserRequired(): boolean {
  return process.env.VYNE_REQUIRE_BROWSER === "1";
}

/** `describe.skipIf(skipBrowser())` — with a loud note when it skips. */
export function skipBrowser(): boolean {
  if (browserAvailable()) return false;
  const why = playwrightInstalled()
    ? "no Chromium on this machine"
    : "playwright-core is not installed (run: cd backend && npm install)";
  if (browserRequired()) {
    throw new Error(
      `VYNE_REQUIRE_BROWSER=1 but the browser suite cannot run: ${why}. ` +
      "It must not be skipped in the container whose purpose is to run it."
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    `\n  ⚠ browser tests SKIPPED — ${why}.\n` +
    "    Run the full suite with:  bash deploy/run-ui-tests.sh\n"
  );
  return true;
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
};

export type StubHandler = (
  req: { method: string; url: string; body: any }
) => { status?: number; body?: unknown } | undefined;

export interface Harness {
  page: Page;
  /** Every /api/ request the page made, in order. */
  calls: { method: string; url: string; body: any }[];
  url(file: string, query?: string): string;
  close(): Promise<void>;
}

/**
 * Serve frontend/ and intercept /api/*.
 *
 * `session` seeds sessionStorage BEFORE any script runs, which is how a page
 * that redirects unauthenticated visitors can be tested at all.
 */
export async function openPage(opts: {
  file: string;
  query?: string;
  stub?: StubHandler;
  session?: { token: string; role: string; email?: string } | null;
}): Promise<Harness> {
  const calls: { method: string; url: string; body: any }[] = [];

  const server: Server = createServer((req, res) => {
    const url = req.url || "/";
    if (url.startsWith("/api/")) {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        let body: any;
        try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
        const call = { method: req.method || "GET", url, body };
        calls.push(call);
        const out = opts.stub?.(call);
        res.writeHead(out?.status ?? (out ? 200 : 404), { "content-type": "application/json" });
        res.end(JSON.stringify(out?.body ?? { error: "no_stub" }));
      });
      return;
    }
    const file = join(FRONTEND, url.split("?")[0].replace(/^\//, "") || "index.html");
    if (!file.startsWith(FRONTEND) || !existsSync(file)) { res.writeHead(404); res.end("nope"); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "text/plain" });
    res.end(readFileSync(file));
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  const { chromium } = await import("playwright-core");
  const browser: Browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();

  // Surface page errors as test failures rather than silent breakage — an
  // uncaught ReferenceError is exactly what a static string check misses.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  (page as any)._vyneErrors = pageErrors;

  if (opts.session !== null) {
    const s = opts.session ?? { token: "test-token", role: "owner", email: "owner@firm.com" };
    await page.addInitScript((sess) => {
      try { sessionStorage.setItem("vyne_session", JSON.stringify(sess)); } catch (e) { void e; }
    }, s);
  }

  const url = `${base}/${opts.file}${opts.query ?? ""}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  return {
    page,
    calls,
    url: (f, q) => `${base}/${f}${q ?? ""}`,
    async close() {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Any uncaught JS error the page threw. Empty is the only acceptable value. */
export function pageErrors(page: Page): string[] {
  return (page as any)._vyneErrors ?? [];
}
