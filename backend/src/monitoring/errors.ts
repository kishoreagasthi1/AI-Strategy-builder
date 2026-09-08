/**
 * The single place an error is reported from (v5.32.70).
 *
 * There are now two sinks — Google Cloud Error Reporting (always on in
 * production, no configuration) and Sentry (only when SENTRY_DSN is set) — and
 * every call site should stay ignorant of which are live. server.ts's global
 * error handler, safeMeter's swallowed metering failure and index.ts's
 * process-level handlers all call captureError() and nothing else.
 *
 * Keeping the fan-out here rather than inside sentry.ts matters for a dull
 * reason: the v5.32.69 preflight failed because SENTRY_DSN was unset, and the
 * lesson of that is that the reporting path must not be named after, or
 * conditional on, any one vendor. Adding a third sink later is an edit to this
 * file and nowhere else.
 *
 * Both sinks are best-effort and neither can throw. A failure to report is
 * never allowed to become the incident.
 */
import { captureError as captureToSentry } from "./sentry.js";
import { reportError as reportToCloud } from "./errorReporting.js";

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  // Independently guarded: one sink throwing or being misconfigured must not
  // cost us the other. Each already swallows internally; this is the belt to
  // that pair of braces, because the whole value of this path is that it still
  // works on the day something unexpected is wrong.
  try { reportToCloud(err, context); } catch { /* ignore */ }
  try { captureToSentry(err, context); } catch { /* ignore */ }
}

export { initSentry, scrubUrl, scrubEvent, isActive as isSentryActive } from "./sentry.js";
export { initErrorReporting, isErrorReportingActive } from "./errorReporting.js";
