/**
 * The deploy script must grant what the code needs. (v5.34.60)
 *
 * A static check over deploy.sh, which is unusual in this suite and earns its
 * place: on 2026-09-13 the first client who ever supplied an API key got a 500,
 * because the service account could read one secret and create none. The code
 * was right, every test passed, and the gap was in a bash file nothing tests.
 *
 * A permission is not something a unit test can exercise — but "the script
 * still grants it" is, and that is the part that rots when someone edits this
 * file next year.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sh = readFileSync(join(ROOT, "deploy", "deploy.sh"), "utf8");

/**
 * deploy.sh with its COMMENTS STRIPPED.
 *
 * The first version of the "no admin role" assertion below searched the whole
 * file for "roles/secretmanager.admin" — and failed, because the comment
 * explaining why that role is NOT used contains the string. That is the third
 * time in this codebase a test has matched a word inside its own justification;
 * each time it looks like a real failure for a minute.
 *
 * An assertion about what a script GRANTS has to read the script's commands.
 */
const code = sh.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

describe("v5.34.60 — deploy.sh grants the BYOK secret permissions", () => {
  it("grants every permission llm/byok/secretStore.ts actually calls", () => {
    /*
     * Derived from the module rather than listed by hand, so a new Secret
     * Manager call in secretStore.ts that nobody granted fails HERE instead of
     * in front of a client's administrator.
     */
    const store = readFileSync(join(ROOT, "backend", "src", "llm", "byok", "secretStore.ts"), "utf8");
    const needs: [RegExp, string][] = [
      [/secrets\?secretId=/, "secretmanager.secrets.create"],
      [/:addVersion/,        "secretmanager.versions.add"],
      [/:access/,            "secretmanager.versions.access"],
      [/:disable/,           "secretmanager.versions.disable"],
    ];
    for (const [call, permission] of needs) {
      expect(call.test(store), `secretStore.ts no longer makes the call for ${permission}`).toBe(true);
      expect(code, `deploy.sh does not grant ${permission}`).toContain(permission);
    }
  });

  it("binds the role to the API's service account", () => {
    expect(code).toMatch(/add-iam-policy-binding[^\n]*\n?[^\n]*vyneByokWriter/);
  });

  it("does NOT hand the API project-wide Secret Manager admin", () => {
    /*
     * The lazy fix. roles/secretmanager.admin over the project would let an
     * SSRF or RCE in this service read and destroy vyne-database-url — the
     * database owner password — which sits three secrets away from the client
     * keys. A custom role with four permissions is the whole point.
     */
    expect(code).not.toContain("roles/secretmanager.admin");
    expect(code).not.toContain("roles/secretmanager.editor");
  });

  it("does not grant delete or destroy on secrets", () => {
    // A client's key should be disable-able and rotatable by this service,
    // never erasable by it — the Secret Manager history is the audit trail.
    expect(code).not.toContain("secretmanager.secrets.delete");
    expect(code).not.toContain("secretmanager.versions.destroy");
  });

  it("keeps the database URL grant bound to that one secret", () => {
    // v5.32.29's audit fix, which the BYOK grant must not quietly undo by
    // widening secretAccessor back to the project.
    expect(code).toMatch(/gcloud secrets add-iam-policy-binding vyne-database-url/);
    expect(code).not.toMatch(/add-iam-policy-binding "\$PROJECT_ID"[^\n]*\n[^\n]*roles\/secretmanager\.secretAccessor/);
  });
});
