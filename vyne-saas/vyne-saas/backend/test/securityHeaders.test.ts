/**
 * V225-audit H1 fix (defense-in-depth): buildServer() now sends a
 * Content-Security-Policy (plus a few standard hardening headers) on every
 * response via a global onSend hook (server.ts). This is NOT the primary
 * fix for the LLM/interviewee-text XSS finding — that's the esc() escaping
 * applied at every render site in synthesis.html/interview_agent.html — but
 * it closes the exfiltration channel (connect-src 'self' blocks fetch/XHR
 * to an attacker's origin) even if some future sink is missed. See the
 * matching header block in frontend/firebase.json for the header actually
 * served to browsers in production (Firebase Hosting serves the frontend
 * there, not this API — this hook covers local/dev same-server serving and
 * this API's own JSON responses).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildServer } from "../src/server.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

class NoVerifier implements TokenVerifier {
  async verify(): Promise<VerifiedIdentity> {
    throw new Error("unused");
  }
}

describe("global security headers", () => {
  it("sends a restrictive CSP + hardening headers on every response", async () => {
    const app = await buildServer({
      config: {
        env: "test", port: 0, databaseUrl: "postgres://unused/unused", blockFreeTier: false,
      } as never,
      verifier: new NoVerifier(),
      adapters: [],
      meter: async () => {},
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/health" });

    const csp = res.headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    // The exfiltration-blocking clause: even if a sink is missed and inline
    // script executes, it cannot fetch()/XHR to an attacker-controlled origin
    // — except the Google Identity endpoints the Firebase Auth SDK itself
    // needs (5.31.1 hotfix: the original 'self'-only clause blocked login;
    // 5.31.3 hotfix: apis.google.com added — Firebase Auth's SDK loads its
    // internal gapi iframe-messaging bootstrap from here on EVERY init,
    // regardless of sign-in method, to coordinate auth state across tabs).
    expect(csp).toContain("connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://apis.google.com");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // 5.31.1 hotfix: script-src must allow the Firebase SDK's own dynamic
    // import from gstatic.com, or sign-in fails with a CSP violation.
    expect(csp).toContain("https://www.gstatic.com");
    // 5.31.3 hotfix: apis.google.com/js/api.js is the gapi loader Firebase
    // Auth fetches internally on init (see connect-src comment above).
    expect(csp).toContain("https://apis.google.com");
    // 5.31.3 hotfix: Firebase Auth's internal cross-tab/cross-window
    // coordination iframe is hosted on the project's authDomain — with no
    // frame-src set, default-src 'self' silently blocked it (a different
    // origin than vyne-platform-prod.web.app, even though same project).
    expect(csp).toContain("frame-src https://vyne-platform-prod.firebaseapp.com");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");

    await app.close();
  });
});

// 5.31.2 fix: with no cache-busting filenames anywhere in this app, a stale
// index.html/vyne-client.js could sit in a returning browser's disk cache
// indefinitely — surviving even a full browser restart — showing a login
// page from before the last deploy (this caused real, repeated confusion:
// "Auth not configured" reappearing after a fix had already shipped).
// Firebase Hosting serves the production frontend, so the fix has to live
// in its own header config, not just this API's onSend hook.
describe("frontend Cache-Control (firebase.json)", () => {
  it("forces revalidation on every response so a stale build can never be served silently", () => {
    const firebaseJson = JSON.parse(
      readFileSync(`${repoRoot}/frontend/firebase.json`, "utf8")
    );
    const headerBlock = firebaseJson.hosting.headers.find((h: { source: string }) => h.source === "**");
    const cacheControl = headerBlock.headers.find((h: { key: string }) => h.key === "Cache-Control");
    expect(cacheControl?.value).toBe("no-cache");
  });
});

// 5.31.2 fix: deploy/deploy.sh's deploy_api() used --set-env-vars/
// --set-secrets (REPLACE semantics), which silently wiped FIREBASE_API_KEY,
// SIGNUP_ACCESS_KEY, REQUIRE_MFA, etc. from the live Cloud Run service the
// one time this script's pattern got hand-copied into an ad-hoc deploy
// command. --update-* (MERGE semantics) is the only safe choice here.
describe("deploy script env-var safety (deploy/deploy.sh)", () => {
  it("never uses replace-mode --set-env-vars/--set-secrets for the API deploy", () => {
    // Strip comment lines first — the doc comment above deploy_api()
    // deliberately names the forbidden flags to explain why they're
    // forbidden, which would otherwise self-trip this check.
    const codeOnly = readFileSync(`${repoRoot}/deploy/deploy.sh`, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(codeOnly).not.toMatch(/--set-env-vars/);
    expect(codeOnly).not.toMatch(/--set-secrets/);
    expect(codeOnly).toContain("--update-env-vars");
    expect(codeOnly).toContain("--update-secrets");
  });

  // v5.32.3: a fresh checkout has no committed .firebaserc, so
  // `firebase deploy` has no project context of its own — it fails with
  // "No currently active project" even when gcloud is correctly pointed at
  // PROJECT_ID, since the two CLIs track project selection separately.
  // Pin an explicit --project so deploy_frontend() never silently depends
  // on `firebase use` having been run by hand in that exact directory.
  it("passes --project explicitly to the frontend (firebase) deploy", () => {
    const codeOnly = readFileSync(`${repoRoot}/deploy/deploy.sh`, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    const frontendFnMatch = codeOnly.match(/deploy_frontend\(\)\s*\{[^}]*\}/);
    expect(frontendFnMatch).not.toBeNull();
    expect(frontendFnMatch![0]).toMatch(/firebase deploy .*--project ["']?\$PROJECT_ID["']?/);
  });
});

// V225-audit billing Low fix: CORS was `origin: true` (reflects any Origin
// back) — now pinned to config.appBaseUrl when it's set.
describe("CORS", () => {
  it("reflects only the configured appBaseUrl once it's set, not an arbitrary Origin", async () => {
    const app = await buildServer({
      config: {
        env: "test", port: 0, databaseUrl: "postgres://unused/unused", blockFreeTier: false,
        appBaseUrl: "https://app.example.com",
      } as never,
      verifier: new NoVerifier(),
      adapters: [],
      meter: async () => {},
    });
    await app.ready();

    const trusted = await app.inject({
      method: "GET", url: "/api/health",
      headers: { origin: "https://app.example.com" },
    });
    expect(trusted.headers["access-control-allow-origin"]).toBe("https://app.example.com");

    const untrusted = await app.inject({
      method: "GET", url: "/api/health",
      headers: { origin: "https://attacker.example" },
    });
    expect(untrusted.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  it("falls back to permissive CORS when appBaseUrl is unset (local dev)", async () => {
    const app = await buildServer({
      config: {
        env: "test", port: 0, databaseUrl: "postgres://unused/unused", blockFreeTier: false,
      } as never,
      verifier: new NoVerifier(),
      adapters: [],
      meter: async () => {},
    });
    await app.ready();

    const res = await app.inject({
      method: "GET", url: "/api/health",
      headers: { origin: "https://anything.example" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://anything.example");

    await app.close();
  });
});
