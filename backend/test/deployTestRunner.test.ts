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
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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

  it("copies every repo directory the suite reads from", () => {
    /*
     * v5.34.64, found by the first real `docker compose run`. The image copied
     * backend/ and frontend/ only, so five test files — every one that reads a
     * deploy script — failed to LOAD: their readFileSync is at module top
     * level, so vitest reported failed suites before a single test executed.
     *
     * Asserted by scanning the tests themselves rather than by listing
     * directories here, so a new test that reaches for a sixth directory fails
     * this immediately instead of in a container nobody runs for a month.
     */
    const testDir = join(ROOT, "backend", "test");
    const read = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? read(join(dir, e.name))
        : e.name.endsWith(".ts") ? [readFileSync(join(dir, e.name), "utf8")] : []);

    const wanted = new Set<string>();
    for (const src of read(testDir)) {
      // join(ROOT, "deploy", …) and join(__dirname, "..", "..", "deploy", …)
      for (const m of src.matchAll(/"\.\.",\s*"\.\.",\s*"([a-zA-Z0-9_.-]+)"/g)) wanted.add(m[1]);
      for (const m of src.matchAll(/join\(\s*ROOT\s*,\s*"([a-zA-Z0-9_.-]+)"/g)) wanted.add(m[1]);
      // securityAuditFixes wraps its own reader: ROOT(".gcloudignore"). Only the
      // first path segment matters — ROOT("deploy/deploy.sh") needs deploy/.
      for (const m of src.matchAll(/\bROOT\(\s*"([a-zA-Z0-9_.-]+)/g)) wanted.add(m[1]);
    }
    wanted.delete("..");          // ROOT itself
    wanted.delete("backend");     // the WORKDIR

    for (const dir of wanted) {
      // The same patterns also match repo-root FILES — join(ROOT, ".dockerignore")
      // — and a file is not something COPY needs a line of its own for. Ask the
      // filesystem rather than maintaining a list of exceptions.
      const p = join(ROOT, dir);
      if (!existsSync(p)) continue;
      /*
       * Files and directories both matter, and both were missing: the first
       * container run failed five suites on deploy/ and then two more on the
       * repo-root dotfiles, which no directory COPY reaches. A file needs its
       * name on a COPY line exactly as a directory does.
       */
      const isDir = statSync(p).isDirectory();
      expect(
        new RegExp(`^COPY\\s[^\\n]*(?<![\\w.-])${dir.replace(/\./g, "\\.")}(\\s|$)`, "m").test(dockerfile),
        `the suite reads ${dir}${isDir ? "/" : ""} but the image never copies it — `
        + `those tests cannot load inside the container`
      ).toBe(true);
    }
  });

  it("runs all three tiers, not just the one that needs nothing", () => {
    expect(compose).toMatch(/RLS_TEST:\s*"1"/);
    expect(compose).toMatch(/TEST_DATABASE_URL/);
    expect(compose).toMatch(/RLS_APP_URL/);
  });
});
