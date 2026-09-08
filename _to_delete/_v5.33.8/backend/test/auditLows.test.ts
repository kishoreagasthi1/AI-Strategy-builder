/**
 * The two Low findings from the v5.33.2 external bug hunt (v5.33.4).
 *
 * Both are identity defects, and both are the SAME identity defect this
 * codebase keeps re-finding: something that is not a person is used as if it
 * were one. v5.32.86 found it in the refresh pipeline (a round-2 refresh
 * recorded against an interviewee literally named "COO"). v5.33.2 found it in
 * mandatory questions (one CTO answering silenced the second). Here it is a
 * role standing in for a person, and an engagement code standing in for a
 * tenant.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const interviews = readFileSync(join(SRC, "routes", "interviews.ts"), "utf8");
const synthetic = readFileSync(join(SRC, "routes", "synthetic.ts"), "utf8");

describe("5332-8 — a follow-up probe cannot quote a COLLEAGUE back at somebody", () => {
  /**
   * `ownByDim` feeds `probeFor`, which is INTERVIEWEE-FACING text of the form
   * "Last time you said…". The justification for putting specific material
   * there is that quoting somebody back to THEMSELVES discloses nothing — so
   * the identity test underneath it has to actually establish identity.
   *
   * sourceInterviewId is the only field that does. Rounds recorded before it
   * was stamped do not have it, and the old fallback was role alone:
   *
   *     isThem = iv.sourceInterviewId ? iv.sourceInterviewId === p.id
   *                                   : iv.role === p.interviewee_role
   *
   * Two divisional COOs, and B's finding is read back to A as A's own words.
   *
   * REVERT TEST: restore that ternary and both cases below fail.
   */
  const block = interviews.slice(
    interviews.indexOf("const ownByDim = new Map"),
    interviews.indexOf("const byDim = new Map")
  );

  it("the ownByDim block exists and is what we think it is", () => {
    // A slice that silently comes back empty makes every assertion below pass
    // for the wrong reason — the exact failure mode this repo keeps hitting.
    expect(block.length).toBeGreaterThan(400);
    expect(block).toContain("sourceInterviewId");
  });

  it("the legacy fallback requires a NAME, not just a role", () => {
    expect(block).toMatch(/iv\.role === p\.interviewee_role && !!ivName && !!myName && ivName === myName/);
  });

  it("role alone is no longer sufficient anywhere in the block", () => {
    // The precise old expression, and any spacing variant of it, standing on
    // its own as the whole test.
    expect(block).not.toMatch(/:\s*iv\.role === p\.interviewee_role\s*;/);
    expect(block).not.toMatch(/\?\s*iv\.sourceInterviewId === p\.id\s*:\s*iv\.role === p\.interviewee_role/);
  });

  it("an unidentifiable legacy entry is SKIPPED, not guessed at", () => {
    // `!!ivName && !!myName` is what makes a nameless legacy row fall out
    // rather than match on role. The follow-up then uses its generic probe —
    // less specific, which is the correct trade against quoting the wrong
    // person.
    expect(block).toContain("!!ivName && !!myName");
    expect(block).toContain("myName");
  });
});

describe("5332-9 — synthetic logins are tenant-keyed", () => {
  /**
   * `users` is GLOBAL — no tenant_id, no RLS, unique on
   * identity_platform_uid. Engagement codes are unique per TENANT (migration
   * 025 indexes on (tenant_id, code) deliberately), so `synthetic:<code>:<person>`
   * collided across firms and `ON CONFLICT DO UPDATE SET name` let one firm
   * overwrite another's row.
   *
   * REVERT TEST: drop the tenantId parameter from syntheticLogin and the first
   * three cases fail.
   */
  it("syntheticLogin takes the tenant as its first input", () => {
    expect(synthetic).toMatch(/function syntheticLogin\(\s*\n?\s*tenantId: string, code: string, name: string, role: string/);
  });

  it("the tenant is in the uid, before the code", () => {
    expect(synthetic).toContain(`uid: "synthetic:" + t + ":" + c + ":" + person`);
  });

  it("every caller passes the request's tenant, not a literal", () => {
    /* Comments are stripped first. The first draft of this test scanned the raw
     * source and matched the PROSE `syntheticLogin(tenantId, code, name, role)`
     * inside the backfill endpoint's doc comment, reporting a call site that
     * does not exist. A checker that reads documentation as code is the same
     * class of mistake as a ratchet that reads CSS as an expression — it
     * reports something narrower, or wider, than it appears to. */
    const code = synthetic
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const calls = [...code.matchAll(/syntheticLogin\(([^)]*)\)/g)]
      .map((m) => m[1].trim())
      .filter((a) => !a.includes(": string"));            // the declaration itself
    expect(calls.length, "no syntheticLogin call sites found — the scan broke")
      .toBeGreaterThan(1);
    for (const c of calls) {
      expect(c, `syntheticLogin called without ctx.tenantId: ${c}`).toMatch(/^ctx\.tenantId,/);
    }
  });

  it("the email is not deliverable and cannot authenticate", () => {
    // .invalid is reserved by RFC 2606. If this ever became a real domain the
    // rows would stop being inert, which is the assumption the whole
    // "leave the old ones alone" transition rests on.
    expect(synthetic).toContain(".synthetic.invalid");
  });

  it("no code path deletes a users row", () => {
    // The transition deliberately strands old rows rather than deleting them:
    // deleting from a global table inside one tenant's request is the exact
    // cross-tenant coupling this finding is about.
    expect(synthetic).not.toMatch(/DELETE\s+FROM\s+users/i);
  });
});
