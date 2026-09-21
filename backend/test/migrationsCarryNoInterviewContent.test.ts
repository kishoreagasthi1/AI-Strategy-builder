/**
 * No migration in the repository carries interview content. (v5.34.132)
 *
 * Data repairs on interview_transcripts have to be migrations: the table is
 * append-only by design (024), and FORCE row level security binds the owner, so
 * the house pattern (026) suspends FORCE inside the runner's transaction. A
 * repair migration therefore carries the repaired transcript as data — a client
 * interviewee's words, verbatim.
 *
 * 038 and 039 did exactly that, and were one `git add` from GitHub when this was
 * written. They were applied, archived outside the repository, and replaced by
 * stubs under the same names; the runner keys on the file name, so the stubs are
 * equivalent everywhere.
 *
 * This fails while a full repair sits in migrations/, which is the point: the
 * deploy gates run this suite, so the next one cannot ship to source control by
 * accident. Apply it, archive it, stub it, and this passes again.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "db", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

/* What a transcript looks like as data: a turn object with a speaker and words. */
const TURN = /"(who|role)"\s*:\s*"[^"]{1,40}"\s*,\s*"text"\s*:|"text"\s*:\s*"[^"]*"\s*,\s*"(who|role)"\s*:/;

describe("v5.34.132 — migrations carry no interview content", () => {
  it("finds the migrations it is checking", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain("038_dedupe_doubled_transcripts.sql");
  });

  for (const f of files) {
    it(`${f} holds no transcript turns`, () => {
      const sql = readFileSync(join(dir, f), "utf8");
      expect(TURN.test(sql),
        `${f} contains interview turns as data. Apply it, move it to backend/repair-archive/, ` +
        "and commit a stub under the same name (see 038).").toBe(false);
    });
  }

  it("recognises the real thing, so it is not passing vacuously", () => {
    expect(TURN.test('{"at":1,"idx":0,"who":"Interviewer","text":"Hi"}')).toBe(true);
    expect(TURN.test('{"text":"Hi","role":"ai"}')).toBe(true);
    expect(TURN.test("-- the interviewer said hello")).toBe(false);
  });

  it("the emitter says so in every repair it writes", () => {
    const lib = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "dedupe-lib.mjs"), "utf8");
    expect(lib).toMatch(/CONTAINS CLIENT INTERVIEW CONTENT VERBATIM\. DO NOT COMMIT THIS FILE\./);
  });
});
