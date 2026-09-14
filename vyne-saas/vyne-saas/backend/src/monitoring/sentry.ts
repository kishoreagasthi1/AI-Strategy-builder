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
    Sentry.captureException(err, context ? { extra: context } : undefined);
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
