/**
 * The gate on the gate.
 *
 * Roughly half the assertions in this repo live behind
 * `describe.skipIf(!ENABLED)` with `ENABLED = process.env.RLS_TEST === "1"`.
 * That is the right design — those suites need a real Postgres with RLS
 * policies applied, and there is no honest way to run them without one — but it
 * has a failure mode the repo has already been bitten by: with `RLS_TEST`
 * unset, every one of them reports success having executed nothing, and the
 * summary line says PASSED in the same green as a full run.
 *
 * `npm test` doing that locally is fine and deliberate. CI doing it is not: the
 * whole reason the workflow exists is to be the backstop nobody has to
 * remember, and a backstop that silently degrades to zero coverage on an
 * environment change is worse than none, because the green tick is now
 * evidence of nothing while looking like evidence of everything.
 *
 * So this fails when CI is set and RLS_TEST is not. It cannot check that the
 * database was actually reachable — the gated suites do that themselves, and
 * loudly: their beforeAll connects, so a bad URL is a failure rather than a
 * skip. What it checks is the one case those suites structurally cannot report
 * on, because when it happens they do not run at all.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Test files whose contents are gated on RLS_TEST. */
function gatedFiles(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".test.ts"))
    .filter((f) => /process\.env\.RLS_TEST/.test(readFileSync(join(HERE, f), "utf8")))
    .sort();
}

describe("RLS-gated suites do not silently report success", () => {
  it("there really are gated suites to protect (a guard over nothing is noise)", () => {
    // If this collapses, either the gating convention changed or the detection
    // did, and the assertion below became vacuous without anyone noticing.
    expect(gatedFiles().length).toBeGreaterThan(15);
  });

  it("CI never runs with the gate closed", () => {
    if (!process.env.CI) return;
    const gated = gatedFiles();
    expect(
      process.env.RLS_TEST === "1",
      `CI is running without RLS_TEST=1, so ${gated.length} suites are inert and ` +
        `this run proves nothing about them:\n  ${gated.join("\n  ")}\n` +
        `The workflow's backend job must use \`npm run test:full\`, not \`npm test\`.`
    ).toBe(true);
  });

  it("names what is inert when the gate is closed", () => {
    // Not a failure locally — `npm test` without a database is a legitimate
    // thing to do. But the count belongs somewhere a reader will see, rather
    // than nowhere.
    const gated = gatedFiles();
    if (process.env.RLS_TEST !== "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `\n  [rlsGate] RLS_TEST is not set: ${gated.length} suites did not run.\n` +
          `  For the full suite:\n` +
          `    RLS_TEST=1 TEST_DATABASE_URL=postgres://vyne:vyne@localhost:5433/vyne \\\n` +
          `      RLS_APP_URL=postgres://vyne_app:apppw@localhost:5433/vyne npx vitest run\n`
      );
    }
    expect(gated.length).toBeGreaterThan(0);
  });
});
