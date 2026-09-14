/**
 * No teardown may reach another test file's data. (v5.34.65)
 *
 * ── The failure this prevents ───────────────────────────────────────────────
 *
 * `interviews.test.ts` ended with:
 *
 *     DELETE FROM users WHERE identity_platform_uid LIKE '%client.com'
 *
 * Seven files use @client.com addresses. Vitest runs files in parallel, so
 * whichever finished first deleted the others' interviewees while they were
 * still running. The visible symptom was a foreign-key violation in the
 * teardown itself; the INVISIBLE symptoms were two assertion failures that
 * looked exactly like product bugs — an engagement record that should have been
 * adopted was instead duplicated, and another came back undefined — because the
 * users those records hung off had just been deleted underneath them.
 *
 * It cost a round of investigation into the engagement-merge code, which was
 * innocent. And it only ever appeared on a machine with enough cores to run the
 * two files at the same time: on a 2-core box the four extra workers do not
 * exist and the overlap essentially never happens. A bug that reproduces only
 * on the faster machine is one that reaches a laptop long before it reaches CI.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * A pattern-matched DELETE is fine when the pattern belongs to ONE file. It is
 * not fine when the string appears in several, because then it is deleting data
 * some other file is relying on. This test reads the suite and enforces exactly
 * that, which is cheaper than hoping the next person remembers.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function testFiles(dir: string): { name: string; src: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? testFiles(join(dir, e.name))
    : e.name.endsWith(".test.ts")
      ? [{ name: e.name, src: readFileSync(join(dir, e.name), "utf8") }]
      : []);
}

const FILES = testFiles(TEST_DIR);

/** Every `LIKE '<pattern>'` used in a DELETE, per file. */
function deletePatterns(src: string): string[] {
  const out: string[] = [];
  // Scan DELETE statements only — a LIKE in a SELECT harms nothing.
  for (const stmt of src.matchAll(/DELETE\s+FROM[\s\S]{0,600}?`/gi)) {
    for (const m of stmt[0].matchAll(/LIKE\s+'([^']+)'/gi)) out.push(m[1]);
  }
  return out;
}

describe("v5.34.65 — test teardowns stay inside their own file", () => {
  it("no DELETE matches a pattern another test file also uses", () => {
    const offences: string[] = [];

    for (const { name, src } of FILES) {
      if (name === "teardownIsolation.test.ts") continue;   // this file quotes them
      for (const pattern of new Set(deletePatterns(src))) {
        /*
         * The literal part of the pattern, with SQL wildcards stripped:
         * '%client.com' -> 'client.com', 'uid-bf-%' -> 'uid-bf-'. That literal
         * is what decides whose rows are hit.
         */
        const literal = pattern.replace(/%/g, "").replace(/_/g, "");
        if (literal.length < 4) continue;   // too generic to attribute; not our call

        const others = FILES.filter(
          (f) => f.name !== name
            && f.name !== "teardownIsolation.test.ts"
            && f.src.includes(literal)
        ).map((f) => f.name);

        if (others.length) {
          offences.push(
            `${name}: DELETE ... LIKE '${pattern}' also matches data owned by ` +
            `${others.join(", ")} — scope it to this file's own rows`
          );
        }
      }
    }

    expect(offences.join("\n")).toBe("");
  });

  it("still allows a pattern that is genuinely this file's own namespace", () => {
    /*
     * A guard that forbade every LIKE would be obeyed by rewriting teardowns
     * into something worse. File-unique prefixes — 'uid-chunk%', 'uid-bf-%' —
     * are the RIGHT pattern and must keep passing, so this pins that the rule
     * above distinguishes them rather than banning the form.
     */
     const own = deletePatterns(`
       await admin.query(\`DELETE FROM users WHERE identity_platform_uid LIKE 'uid-chunk%'\`);
     `);
    expect(own).toEqual(["uid-chunk%"]);
    const shared = FILES
      .filter((f) => f.name !== "teardownIsolation.test.ts")   // this file quotes it
      .filter((f) => f.src.includes("uid-chunk")).map((f) => f.name);
    expect(shared, "uid-chunk is no longer unique to one file").toHaveLength(1);
  });
});
