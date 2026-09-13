/**
 * Error monitoring/alerting (v5.30) — a thin, optional wrapper over
 * @sentry/node.
 *
 * Fully env-gated, same pattern as GEMINI_API_KEY/FIREBASE_API_KEY: with no
 * SENTRY_DSN set, initSentry() is a no-op and captureError() silently does
 * nothing — the app behaves exactly as it did before this file existed.
 * Nothing here is on the hot path of any request; it only fires when
 * something has already gone wrong.
 *
 * Deliberately NOT initialized inside buildServer()/server.ts — that would
 * make every test run (and every buildServer() call in test files) try to
 * touch the Sentry SDK. Only index.ts (the real Cloud Run entrypoint) calls
 * initSentry(); server.ts just calls the best-effort captureError() from its
 * existing global error handler, which is a safe no-op when Sentry was
 * never initialized (e.g. every test run, or dev with no DSN configured).
 *
 * Best-effort by design — same philosophy as gateway.ts's safeMeter() and
 * audit/log.ts's auditLog(): a monitoring failure must never take down (or
 * even slow down) the request it's trying to report on.
 */
import * as Sentry from "@sentry/node";

let active = false;

/**
 * Drop the query string from a URL before it leaves the process
 * (v5.32.65, audit V2-M3).
 *
 * Sentry is a third party, and the URLs this app reports on are not opaque:
 * `/api/solution-design?client=Acme%20Manufacturing`,
 * `/api/scorecard?code=ACME01`, `?email=...`. The path identifies the endpoint,
 * which is all an error report needs; the query string identifies the CUSTOMER
 * of a customer, which is the one thing a consulting product must not spill
 * into a monitoring vendor to make a stack trace slightly easier to read.
 *
 * Applied in two places on purpose. captureError scrubs what the app passes in,
 * and beforeSend scrubs what the SDK collects on its own — request integrations
 * populate `request.url` and `request.query_string` without anyone asking, so
 * scrubbing only at the call site would have missed them.
 */
export function scrubUrl(url: unknown): unknown {
  if (typeof url !== "string") return url;
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  const cut = Math.min(q === -1 ? url.length : q, h === -1 ? url.length : h);
  return url.slice(0, cut);
}

/**
 * Redact the things that identify a person or a client from free text
 * (v5.32.78, external audit).
 *
 * An exception's `message` and its stack frames are the diagnostic value, so
 * this is deliberately NOT a blanket redaction — a scrubbed-to-nothing error is
 * an error nobody can fix. Three specific shapes are removed, because each has
 * been observed carrying customer identity into an error string:
 *
 *   · email addresses — the most direct identifier this product handles
 *   · query strings on any URL inside the text, matching what scrubUrl() already
 *     does to `request.url` (`?client=Acme%20Manufacturing`, `?code=ACME01`)
 *   · Postgres parameter dumps, which quote the actual values that were bound
 *     into the failing statement
 *
 * File paths, line numbers, error types and the sentence describing the failure
 * all survive, which is what a stack trace is for.
 */
export function redactFreeText(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/(https?:\/\/[^\s"')]*|\/api\/[\w/-]*)\?[^\s"')]*/gi, "$1")
    .replace(/\bparameters:\s*\[[^\]]*\]/gi, "parameters: [redacted]");
}

/**
 * The beforeSend hook, named and exported so it can be tested directly. An
 * anonymous inline hook is a hook nobody ever asserts on.
 */
export function scrubEvent<E extends {
  request?: {
    url?: string; query_string?: unknown;
    headers?: unknown; data?: unknown; cookies?: unknown;
  };
  breadcrumbs?: { data?: Record<string, unknown> }[];
  exception?: { values?: { value?: string; stacktrace?: { frames?: { filename?: string }[] } }[] };
  message?: string;
}>(event: E): E {
  if (event.request) {
    if (event.request.url) event.request.url = scrubUrl(event.request.url) as string;
    delete event.request.query_string;
    /*
     * v5.32.76 (audit Low). These were never stripped. Latent today because no
     * Sentry request integration is enabled — but "latent" means one config
     * change away, and the config change is the kind someone makes to get
     * better stack traces.
     *
     * `headers` carries the Authorization bearer token and any cookies: a
     * captured error would hand a third party a live session. `data` is the
     * request body, which on this API is briefing text, interview transcripts
     * and synthesis — the client's own words.
     *
     * Deleted rather than redacted field-by-field. An allow-list here would be
     * one forgotten header away from the same problem, and a stack trace has
     * never needed the body.
     */
    delete event.request.headers;
    delete event.request.data;
    delete event.request.cookies;
  }
  for (const b of event.breadcrumbs ?? []) {
    if (b.data && typeof b.data.url === "string") b.data.url = scrubUrl(b.data.url) as string;
  }
  /*
   * v5.32.78 (external audit). The exception's own message and stack went to
   * Sentry verbatim. A Postgres error names the values it was given, and this
   * codebase constructs plenty of messages by interpolation — so the one field
   * guaranteed to be present in every captured event was the one field never
   * scrubbed. See redactFreeText for what is removed and what is kept.
   */
  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === "string") ex.value = redactFreeText(ex.value);
    for (const fr of ex.stacktrace?.frames ?? []) {
      if (typeof fr.filename === "string") fr.filename = redactFreeText(fr.filename);
    }
  }
  if (typeof event.message === "string") event.message = redactFreeText(event.message);
  return event;
}

function scrubContext(context: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    out[k] = /url|uri|referer|referrer/i.test(k) ? scrubUrl(v) : v;
  }
  return out;
}

export interface SentryInitOptions {
  dsn: string | undefined;
  environment: string;
  /** Release identifier surfaced on every event — pass version.ts's VERSION. */
  release?: string;
}

/**
 * Call once, at process startup, from the real entrypoint only. Returns
 * whether monitoring is actually active (useful for a one-line startup log
 * — "Sentry: on/off" — rather than silently guessing).
 */
export function initSentry(opts: SentryInitOptions): boolean {
  if (!opts.dsn) {
    active = false;
    return false;
  }
  try {
    Sentry.init({
      dsn: opts.dsn,
      environment: opts.environment,
      release: opts.release,
      // Conservative default: capture every error, trace a small sample of
      // transactions (enough to see latency trends without the cost/noise
      // of tracing every request in a diagnostics-focused install).
      tracesSampleRate: opts.environment === "production" ? 0.1 : 0,
      // v5.32.65 (audit V2-M3). Last line of defence: whatever the SDK's own
      // integrations attached, the query string does not leave here. See
      // scrubUrl above for why.
      beforeSend: scrubEvent,
    });
    active = true;
    return true;
  } catch {
    // Never let a monitoring misconfiguration (bad DSN, network issue at
    // init) block the app from starting.
    active = false;
    return false;
  }
}

/**
 * Report an error to Sentry if monitoring is active; otherwise a no-op.
 * Never throws — call this from any catch block without wrapping it.
 */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!active) return;
  try {
    Sentry.captureException(err, context ? { extra: scrubContext(context) } : undefined);
  } catch {
    // Swallowed — see file doc comment.
  }
}

/** Test-only escape hatch: reset the module-level active flag between tests. */
export function _resetForTests(): void {
  active = false;
}

export function isActive(): boolean {
  return active;
}
