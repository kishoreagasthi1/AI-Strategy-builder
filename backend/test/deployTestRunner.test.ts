/**
 * The Docker regression runner, checked by reading. (v5.34.63)
 *
 * ── Why a static test, and what it is honestly worth ────────────────────────
 *
 * `deploy/test/Dockerfile` and `docker-compose.yml` were written in v5.34.56
 * and NEVER BUILT — there is no Docker daemon in the environment they were
 * authored in, and the suite has always run natively, so nobody needed them.
 * Unbuilt infrastructure is not tested infrastructure, and reading them in
 * v5.34.63 turned up two faults that would each have stopped the run before a
 * single test:
 *
 *   1. the compose file told the test container to run `psql ... && npx vitest
 *      run`, and the Playwright base image is not expected to carry a Postgres
 *      client;
 *   2. the Dockerfile has an exec-form ENTRYPOINT, and a compose `command:` is
 *      passed to an exec-form ENTRYPOINT as ARGUMENTS — so that shell one-liner
 *      would have been appended to `npx vitest run` rather than replacing it.
 *
 * These assertions pin the shape of the fixes. They cannot prove the image
 * builds — only `docker compose build` can, and that has to be run somewhere
 * with a daemon. What they do is stop the two known faults being reintroduced
 * by someone editing these files without a daemon either, which is the
 * situation that produced them.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(join(ROOT, "deploy", "test", "Dockerfile"), "utf8");
const compose = readFileSync(join(ROOT, "deploy", "test", "docker-compose.yml"), "utf8");

describe("v5.34.63 — the Docker regression runner", () => {
  it("does not hand a shell command to an exec-form ENTRYPOINT", () => {
    /*
     * The fault. With ENTRYPOINT ["npx","vitest","run"], a compose `command:`
     * is appended as arguments, not substituted — so the container would have
     * run `npx vitest run sh -c "psql ... && npx vitest run"`.
     */
    const hasExecEntrypoint = /ENTRYPOINT\s*\[/.test(dockerfile);
    const testsBlock = compose.slice(compose.indexOf("  tests:"));
    const overridesCommand = /^\s{4}command:/m.test(testsBlock);
    const overridesEntrypoint = /^\s{4}entrypoint:/m.test(testsBlock);
    expect(
      hasExecEntrypoint && overridesCommand && !overridesEntrypoint,
      "compose sets `command:` against an exec-form ENTRYPOINT — the command becomes arguments"
    ).toBe(false);
  });

  it("creates the restricted role without needing a Postgres client in the test image", () => {
    // The role has to exist before the migrations GRANT to it, and the image
    // that runs the tests is a browser image.
    const init = join(ROOT, "deploy", "test", "initdb", "01-app-role.sql");
    expect(existsSync(init), "no initdb script — who creates vyne_app?").toBe(true);
    const sql = readFileSync(init, "utf8");
    expect(sql).toMatch(/CREATE ROLE vyne_app/);
    expect(compose).toMatch(/docker-entrypoint-initdb\.d/);
    // And nothing in the tests service shells out to psql any more.
    const testsBlock = compose.slice(compose.indexOf("  tests:"));
    expect(testsBlock).not.toMatch(/psql/);
  });

  it("the role's password matches the URL the tests connect with", () => {
    // Two literals that must agree, in two files, neither of which anyone runs
    // by hand — exactly the pair that drifts.
    const sql = readFileSync(join(ROOT, "deploy", "test", "initdb", "01-app-role.sql"), "utf8");
    const pw = sql.match(/CREATE ROLE vyne_app LOGIN PASSWORD '([^']+)'/)?.[1];
    expect(pw).toBeTruthy();
    expect(compose).toContain(`postgres://vyne_app:${pw}@db:5432/vyne`);
  });

  it("refuses to let the browser suite skip inside the image built to run it", () => {
    // A silent skip here would mean the frontend quietly stopped being tested,
    // which is the state the whole runner was written to end.
    expect(dockerfile).toMatch(/VYNE_REQUIRE_BROWSER[= ]*1/);
  });

  it("pins the browser image rather than tracking latest", () => {
    const from = dockerfile.match(/^FROM\s+(\S+)/m)?.[1] ?? "";
    expect(from).toMatch(/^mcr\.microsoft\.com\/playwright:v\d/);
    expect(from).not.toMatch(/latest/);
  });

  it("keeps the host's node_modules out of the image", () => {
    /*
     * `COPY backend ./backend` runs after `npm ci`. Without a .dockerignore it
     * copies the HOST's node_modules straight over the ones just installed — so
     * a Linux container would run macOS-built native modules, and pinning the
     * image would have bought nothing.
     */
    const ignore = join(ROOT, ".dockerignore");
    expect(existsSync(ignore), "no .dockerignore — the host's node_modules would overwrite the image's").toBe(true);
    expect(readFileSync(ignore, "utf8")).toMatch(/node_modules/);
  });

  it("runs all three tiers, not just the one that needs nothing", () => {
    expect(compose).toMatch(/RLS_TEST:\s*"1"/);
    expect(compose).toMatch(/TEST_DATABASE_URL/);
    expect(compose).toMatch(/RLS_APP_URL/);
  });
});
