/**
 * Google Cloud Error Reporting sink (v5.32.70).
 *
 * WHY THIS EXISTS. The v5.32.69 preflight came back with SENTRY_DSN unset on
 * production, which meant captureError() was a silent no-op — and captureError()
 * is what the v5.32.65 metering-failure alerting reports through. Usage could be
 * spent and never billed, and the only trace would be a log line nobody reads.
 *
 * Sentry would fix that and the code for it already exists next door. It also
 * ships this product's error payloads to a third party, and the things that ride
 * along in a consulting tool's errors are the names of the CUSTOMER'S customers.
 * sentry.ts carries a careful URL scrubber for exactly that reason. Error
 * Reporting is already inside vyne-platform-prod, needs no account, no DSN and
 * no credentials, and nothing leaves Google.
 *
 * HOW IT WORKS — and why there is no SDK here. Cloud Run forwards the process's
 * stdout to Cloud Logging, and Error Reporting automatically ingests any log
 * entry carrying the ReportedErrorEvent @type marker. So a correctly shaped
 * console.error IS the integration: no dependency, no client to initialise, no
 * network call on the failure path, and nothing that can itself throw or hang
 * while reporting that something else already went wrong. Adding
 * @google-cloud/error-reporting would buy nothing here and would put an HTTP
 * client in the one code path that must never have one.
 *
 * The same scrubbing as the Sentry path applies. Logs are read by more people
 * than a monitoring console is, so a client name in an error payload is not
 * meaningfully safer for having stayed inside GCP.
 *
 * v5.33.3 (audit HIGH) — that paragraph was ASPIRATIONAL, and had been since
 * redactFreeText() was written. captureError() fans out to two sinks; the new
 * free-text scrub was attached to Sentry's beforeSend and to nothing else, so
 * the message and the stack reached Cloud Logging unredacted. Worse than an
 * ordinary twin-miss, because the twins are not symmetric: initErrorReporting()
 * is unconditional in production while Sentry needs SENTRY_DSN, which this
 * project's own v5.32.69 preflight found UNSET. The only live sink in
 * production was the unscrubbed one. A `client_not_assigned "Acme
 * Manufacturing"` throw, a pg error quoting its bound parameters, or a stack
 * frame carrying `?client=…&email=…` landed in Cloud Logging with identity
 * intact, readable by anyone holding Log Viewer.
 *
 * The doc comment was the whole defence, and a doc comment is not a code path.
 */
import { scrubUrl, redactFreeText } from "./sentry.js";

const REPORTED_ERROR_TYPE =
  "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent";

let service = "";
let version = "";
let active = false;

export interface ErrorReportingInitOptions {
  /** Cloud Run service name — groups errors per service in the console. */
  service: string;
  /** Release identifier; pass version.ts's VERSION so a regression is dateable. */
  version: string;
  /**
   * Off outside production by default. A test run or a dev box writing
   * ReportedErrorEvent-shaped lines to stdout is noise at best, and at worst it
   * files a developer's deliberate error into the same list as a real one.
   */
  enabled: boolean;
}

export function initErrorReporting(opts: ErrorReportingInitOptions): boolean {
  service = opts.service;
  version = opts.version;
  active = opts.enabled;
  return active;
}

/**
 * The payload Error Reporting ingests, built and returned separately from the
 * write so a test can assert on its exact shape. An inline object inside a
 * console.error is a payload nobody ever checks, and the @type marker is a
 * magic string — get it subtly wrong and this silently reports nothing, which
 * is precisely the failure mode the whole file exists to remove.
 */
export function buildReportedErrorEvent(
  err: unknown,
  context?: Record<string, unknown>
): Record<string, unknown> {
  /*
   * `message` must carry the STACK TRACE, not just the error text. Error
   * Reporting groups by stack; given a bare message it files every occurrence
   * as its own issue and the console becomes a flat list instead of "this has
   * now happened 400 times".
   */
  let message: string;
  if (err instanceof Error) {
    message = err.stack && err.stack.includes(err.message)
      ? err.stack
      : `${err.name}: ${err.message}`;
  } else if (typeof err === "string") {
    message = err;
  } else {
    try { message = JSON.stringify(err); } catch { message = String(err); }
  }

  const event: Record<string, unknown> = {
    severity: "ERROR",
    "@type": REPORTED_ERROR_TYPE,
    /* v5.33.3. `message` IS the stack trace (see above), so this is the field
     * that carries interpolated request data — and it was the field with no
     * scrub on it at all. redactFreeText removes emails, URL query strings and
     * Postgres parameter dumps while leaving file paths, line numbers, error
     * types and the failure sentence intact: Error Reporting still groups by
     * stack, and the entry is still worth reading. */
    message: redactFreeText(message),
    serviceContext: { service, version },
  };
  if (context) {
    const scrubbed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(context)) {
      /* Key-name matching alone was the other half of the gap: a context value
       * only got scrubbed if its KEY looked url-ish, so `{ detail: "failed for
       * a@b.com" }` passed through untouched. Every string value now goes
       * through the same free-text scrub; url-ish keys additionally get
       * scrubUrl, which strips a whole query string rather than its contents. */
      const byKey = /url|uri|referer|referrer/i.test(k);
      scrubbed[k] = byKey ? scrubUrl(v)
        : typeof v === "string" ? redactFreeText(v)
        : v;
    }
    event.context = scrubbed;
  }
  return event;
}

/**
 * Report to Cloud Error Reporting. Never throws — a monitoring failure must not
 * become the incident.
 */
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  if (!active) return;
  try {
    // One line, so Cloud Logging parses it as a single structured entry.
    // A multi-line write would be ingested as several unrelated text entries
    // and the @type marker would be lost.
    process.stdout.write(JSON.stringify(buildReportedErrorEvent(err, context)) + "\n");
  } catch {
    /* swallowed by design — see the file comment */
  }
}

export function isErrorReportingActive(): boolean { return active; }

/** Test-only: reset module state between cases. */
export function _resetForTests(): void { service = ""; version = ""; active = false; }
