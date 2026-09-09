/**
 * Single source of truth for "what code is actually running."
 *
 * Deploys here are manual (a zip package, unzipped locally, then
 * `firebase deploy` for the frontend and `gcloud run deploy` for the API —
 * see deploy/deploy.sh) rather than CI/CD with automatic build stamping.
 * That has a sharp edge: it is entirely possible to redeploy the frontend
 * from a stale local checkout and have it succeed with no error, silently
 * leaving an old build live (this happened: the v5.27 billing module was
 * invisible in production because `firebase deploy` was run from an old
 * v5.26 folder — nothing in the app itself could show that mismatch).
 *
 * VERSION is the fix: GET /api/version (routes/health.ts) serves this
 * string, and frontend/about.html compares it against its own hardcoded
 * VYNE_VERSION (frontend/vyne-client.js) — a mismatch between what the
 * frontend claims and what the backend claims is now visible from inside
 * the running app, not just discoverable by hand-diffing deployed files.
 *
 * Bump this by hand with every release, in lockstep with the identical
 * string in frontend/vyne-client.js's VYNE_VERSION. test/version.test.ts
 * fails if the two ever drift apart, so forgetting one is caught by the
 * same test run that gates every other release.
 */
export const VERSION = "5.34.14";
