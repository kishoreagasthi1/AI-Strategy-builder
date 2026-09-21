/**
 * The repair, run for real. (v5.34.127)
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * dedupeDoubledTranscripts.test.ts proves the arithmetic. It cannot prove the
 * script RUNS, and every failure this tool has had was a failure to run:
 *
 *   v5.34.123  `pg` unresolvable from deploy/
 *   v5.34.124  a DSN naming a socket that only exists inside Cloud Run
 *   v5.34.125  an RLS policy hiding every row, reported as a clean bill of health
 *
 * Three green suites in a row while the script could not get off the ground.
 *
 * So this one builds a miniature of production in its own schema — two tenants,
 * FORCE ROW LEVEL SECURITY keyed on app.tenant_id, a doubled transcript with
 * anchors either side of the block, a clean transcript that must not be touched,
 * and a doubled module_state session — and then spawns the actual script through
 * audit → verify → apply → re-apply, reading the database back each time.
 *
 * It earned its place immediately: the first rehearsal reported ONE doubled
 * transcript as FOUR affected records. The scan walks tenants and reads inside
 * each one's RLS context, and the rehearsal connected as a role that bypasses
 * RLS, so every row was visible under every tenant and examined once per tenant.
 * No unit test would have found that, because the bug is in the shape of the
 * scan and not in any function it calls.
 *
 * Run: RLS_TEST=1 TEST_DATABASE_URL=... npx vitest run test/dedupeRepairAgainstPostgres.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ENABLED = process.env.RLS_TEST === "1";
const BASE = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";
const SCHEMA = "dedupe_rehearsal";
/* The script names its tables unqualified, so the rehearsal schema is put in
 * front of the search path rather than the tables being renamed. Nothing in the
 * real schema is reachable from inside the test. */
const SCOPED = `${BASE}${BASE.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${SCHEMA}`)}`;

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "dedupe-transcripts.mjs");
/* A role with SELECT and no UPDATE — production's shape, where the app inserts
 * a submitted transcript and never edits one. */
const RO_ROLE = "dedupe_ro";
const RO_PASS = "ro-pass";
/* A role that MAY write, with a password that appears nowhere else, so
 * "the password is never printed" is an assertion and not a coincidence. */
const RW_ROLE = "dedupe_rw";
const RW_PASS = "wr1te-s3cret-never-printed";
const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const TRANSCRIPT = "aaaaaaaa-0000-0000-0000-000000000001";
const UNTOUCHED = "aaaaaaaa-0000-0000-0000-000000000002";

type Msg = { role: string; text: string; at: number; idx?: number };
const first: Msg[] = Array.from({ length: 12 }, (_, i) => ({
  role: i % 2 ? "user" : "ai", text: `one ${i}`, at: 1000 + i }));
const second: Msg[] = Array.from({ length: 6 }, (_, i) => ({
  role: i % 2 ? "user" : "ai", text: `two ${i}`, at: 9000 + i }));
/* The shape the defect left behind: the first sitting, a replay of it carrying
 * the clock of the moment of resume, then the second sitting. 30 -> 18. */
/*
 * v5.34.130 — every turn carries `idx`, the way the server writes them, because
 * the review page resolves anchors by idx and not by position. Until this
 * version the fixtures had no idx, so the page's rule was never exercised, and
 * a repair that would have swept 14 of 63 real findings into "After the final
 * exchange" passed every test here.
 */
const withIdx = (a: Msg[]) => a.map((m, i) => ({ ...m, idx: i }));
const DOUBLED: Msg[] = withIdx([...first, ...first.map((m, i) => ({ ...m, at: 5000 + i })), ...second]);
const REPAIRED: Msg[] = withIdx([...first, ...second]);

/*
 * Anchors chosen to cover the three cases that matter. 4 sits well before the
 * block. 12 sits exactly ON the boundary and must NOT move, because the message
 * it names is the last one kept. 25 and 30 sit past it. One anchor is the
 * STRING "29" — jsonb records hold them that way, and an audit that counts a
 * string as at-risk while the remap declines to move it is the v5.34.122 defect.
 */
const SCORE = [{ afterTurn: 4, dim: "a" }, { afterTurn: 12, dim: "b" },
                { afterTurn: 25, dim: "c" }, { afterTurn: 30, dim: "d" }];
const FINDING = [{ afterTurn: 27, text: "f1" }, { afterTurn: "29", text: "f2" }];

const named = (arr: Msg[], n: unknown) => arr[Number(n) - 1]?.text;
/** interviews.html's rule, verbatim in effect: idx when present, else position. */
const onPage = (arr: Msg[], n: unknown) => {
  const k = Number(n) - 1;
  return arr.find((t, i) => (t.idx === null || t.idx === undefined ? i : Number(t.idx)) === k)?.text;
};

let admin: pg.Client;
let dir: string;
let backup: string;

/** Runs the real script, returning its exit code and combined output. */
function run(args: string[], env: Record<string, string | undefined> = {}) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DATABASE_URL: SCOPED, ...env },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

async function asTenant<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  await admin.query("BEGIN");
  await admin.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
  try { return await fn(); } finally { await admin.query("COMMIT"); }
}

async function seed() {
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.query(`SET search_path = ${SCHEMA}`);
  await admin.query(`CREATE TABLE tenants (id uuid PRIMARY KEY, name text NOT NULL)`);
  await admin.query(`CREATE TABLE interview_transcripts (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, interview_id uuid,
      client_name text, interviewee_name text, round_number int,
      turns jsonb, turn_count int, score_events jsonb, findings jsonb)`);
  await admin.query(`CREATE TABLE module_state (
      tenant_id uuid NOT NULL, module text NOT NULL, key text NOT NULL,
      value jsonb, updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (tenant_id, module, key))`);
  for (const t of ["interview_transcripts", "module_state"]) {
    await admin.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await admin.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await admin.query(`CREATE POLICY iso ON ${t} USING
      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`);
  }
  await admin.query(`INSERT INTO tenants VALUES ($1,'Alpha'), ($2,'Beta')`, [T1, T2]);

  await admin.query(`DROP ROLE IF EXISTS ${RO_ROLE}`).catch(() => {});
  await admin.query(`CREATE ROLE ${RO_ROLE} LOGIN PASSWORD '${RO_PASS}'`).catch(() => {});
  await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${RO_ROLE}`);
  await admin.query(`GRANT SELECT ON tenants, interview_transcripts, module_state TO ${RO_ROLE}`);
  await admin.query(`DROP ROLE IF EXISTS ${RW_ROLE}`).catch(() => {});
  await admin.query(`CREATE ROLE ${RW_ROLE} LOGIN PASSWORD '${RW_PASS}'`).catch(() => {});
  await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${RW_ROLE}`);
  await admin.query(`GRANT SELECT, UPDATE ON interview_transcripts, module_state TO ${RW_ROLE}`);
  await admin.query(`GRANT SELECT ON tenants TO ${RW_ROLE}`);

  await asTenant(T1, async () => {
    await admin.query(
      `INSERT INTO interview_transcripts
         (id, tenant_id, client_name, interviewee_name, round_number, turns, turn_count, score_events, findings)
       VALUES ($1,$2,'Acme','Dana',1,$3::jsonb,$4,$5::jsonb,$6::jsonb)`,
      [TRANSCRIPT, T1, JSON.stringify(DOUBLED), DOUBLED.length,
       JSON.stringify(SCORE), JSON.stringify(FINDING)]);
    await admin.query(
      `INSERT INTO interview_transcripts
         (id, tenant_id, client_name, interviewee_name, round_number, turns, turn_count)
       VALUES ($1,$2,'Acme','Ravi',1,$3::jsonb,$4)`,
      [UNTOUCHED, T1, JSON.stringify(REPAIRED), REPAIRED.length]);
    await admin.query(
      `INSERT INTO module_state (tenant_id, module, key, value)
       VALUES ($1,'interview','vynora_session_abc',$2::jsonb)`,
      [T1, JSON.stringify({ client: "Acme", stakeholderName: "Dana",
                            displayMessages: DOUBLED, scoreEvents: SCORE, findingEvents: FINDING })]);
  });
  await asTenant(T2, () => admin.query(
    `INSERT INTO interview_transcripts
       (id, tenant_id, client_name, interviewee_name, round_number, turns, turn_count)
     VALUES ('bbbbbbbb-0000-0000-0000-000000000001',$1,'Globex','Sam',1,$2::jsonb,$3)`,
    [T2, JSON.stringify(REPAIRED), REPAIRED.length]));
}

async function readBack() {
  return asTenant(T1, async () => ({
    repaired: (await admin.query(
      `SELECT turns, turn_count, score_events, findings FROM interview_transcripts WHERE id = $1`,
      [TRANSCRIPT])).rows[0],
    untouched: (await admin.query(
      `SELECT turns, turn_count FROM interview_transcripts WHERE id = $1`, [UNTOUCHED])).rows[0],
    session: (await admin.query(
      `SELECT value FROM module_state WHERE key = 'vynora_session_abc'`)).rows[0].value,
  }));
}

/** The same DSN, as the role that may read but not write. */
function asReadOnly(dsn: string) {
  const u = new URL(dsn);
  u.username = RO_ROLE;
  u.password = RO_PASS;
  return u.toString();
}

describe.skipIf(!ENABLED)("v5.34.127 — the repair, against a real Postgres", () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: BASE });
    await admin.connect();
    await seed();
    dir = mkdtempSync(join(tmpdir(), "vyne-dedupe-it-"));
    backup = join(dir, "backup.json");
  }, 60_000);

  afterAll(async () => {
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await admin.end().catch(() => {});
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("the audit finds each affected row exactly once, and writes a backup", () => {
    /*
     * "Exactly once" is the assertion the first rehearsal failed: one doubled
     * transcript and one doubled session came back as FOUR affected records,
     * because a role that bypasses RLS sees every tenant's rows inside every
     * tenant's context. The counts below are the ones that exposed it.
     */
    const r = run(["--backup", backup]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/visible: +1 saved session\/archive row\(s\), 3 submitted transcript\(s\)/);
    expect(r.out).toMatch(/affected: +2/);
    expect(r.out).toMatch(/30 messages → 18/);
    /* 4, not 5. The anchor at 12 sits exactly on the boundary and names the
     * last kept message, so it never moves; v5.34.131 counted it anyway because
     * "at or past the first removal" was its definition of risk. v5.34.132 asks
     * the remap which anchors actually change. */
    expect(r.out).toMatch(/4 finding\/score anchor\(s\) would move with the repair/);
    expect(r.out).toContain("This was a READ-ONLY audit. Nothing has been written.");
    expect(existsSync(backup)).toBe(true);
  }, 60_000);

  it("and it changed nothing while saying so", async () => {
    const db = await readBack();
    expect(db.repaired.turns).toHaveLength(30);
    expect(db.session.displayMessages).toHaveLength(30);
  });

  it("the backup carries the evidence, not only the words", () => {
    const b = JSON.parse(readFileSync(backup, "utf8"));
    expect(b.affected).toHaveLength(2);
    for (const a of b.affected) {
      expect(a._original).toHaveLength(30);
      expect(a._fixed).toHaveLength(18);
      expect(a._evidence.scoreEvents, "the anchors --remap-anchors rewrites have no way back")
        .toHaveLength(4);
      expect(a._evidence.findingEvents).toHaveLength(2);
    }
  });

  it("verify proves the remap on that backup without opening a database", () => {
    const r = run(["--verify-backup", backup], { DATABASE_URL: undefined });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("no database is opened");
    // The boundary anchor names the last kept message, so it must NOT move.
    expect(r.out).toMatch(/SAME +scoreEvents\[1\] +12 → 12/);
    // The ones past the block move by exactly the size of the removed block.
    expect(r.out).toMatch(/SAME +scoreEvents\[2\] +25 → 13/);
    expect(r.out).toMatch(/SAME +findingEvents\[1\] +29 → 17/);
    expect(r.out).toContain("name the same message before and after");
  }, 60_000);

  it("apply repairs both rows and preserves every anchor's words", async () => {
    const r = run(["--apply", "--backup", backup, "--remap-anchors"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Nothing is re-scanned: this is the file that was verified.");
    expect(r.out).toMatch(/repaired: 2 +skipped: 0 +changed since the audit: 0/);

    const db = await readBack();
    expect(db.repaired.turns.map((t: Msg) => t.text)).toEqual(REPAIRED.map((t) => t.text));
    expect(db.repaired.turn_count).toBe(18);
    /* The surviving copy must be the ORIGINAL, whose clocks are the real ones —
     * keeping the replay would preserve the lie the repair exists to remove. */
    expect(db.repaired.turns.slice(0, 12).map((t: Msg) => t.at)).toEqual(first.map((t) => t.at));

    for (const [list, before] of [["score_events", SCORE], ["findings", FINDING]] as const) {
      const after = db.repaired[list] as Array<{ afterTurn: unknown }>;
      expect(after.map((e) => named(db.repaired.turns, e.afterTurn)))
        .toEqual(before.map((e) => named(DOUBLED, e.afterTurn)));
    }
    // Fields other than the anchor survive the rewrite untouched.
    expect((db.repaired.score_events as Array<{ dim: string }>).map((e) => e.dim))
      .toEqual(["a", "b", "c", "d"]);
    // And the string anchor actually moved, rather than being counted and skipped.
    expect((db.repaired.findings as Array<{ afterTurn: unknown }>)[1].afterTurn).not.toBe("29");

    expect(db.session.displayMessages.map((m: Msg) => m.text)).toEqual(REPAIRED.map((t) => t.text));
    expect(db.session.scoreEvents.map((e: { afterTurn: unknown }) => named(db.session.displayMessages, e.afterTurn)))
      .toEqual(SCORE.map((e) => named(DOUBLED, e.afterTurn)));

    /* v5.34.130 — and where the REVIEW PAGE would put them, which is by idx. */
    expect((db.repaired.turns as Msg[]).map((t) => t.idx), "idx no longer equals position")
      .toEqual(REPAIRED.map((_, i) => i));
    for (const [list, before] of [["score_events", SCORE], ["findings", FINDING]] as const) {
      const after = db.repaired[list] as Array<{ afterTurn: unknown }>;
      expect(after.map((e) => onPage(db.repaired.turns, e.afterTurn)),
             `${list}: on the review page an anchor lands on the wrong turn, or on none`)
        .toEqual(before.map((e) => onPage(DOUBLED, e.afterTurn)));
    }
  }, 60_000);

  it("leaves a clean transcript, and another tenant's rows, completely alone", async () => {
    const db = await readBack();
    expect(db.untouched.turns.map((t: Msg) => t.text)).toEqual(REPAIRED.map((t) => t.text));
    expect(db.untouched.turn_count).toBe(18);
    /* Selected by tenant_id rather than by relying on the policy to filter:
     * this harness connects as a role that bypasses RLS, which is the same fact
     * the last test in this file asserts. A test that leaned on the filtering
     * would be asserting something it has already proved is not in force. */
    const other = await asTenant(T2, async () => (await admin.query(
      `SELECT turn_count FROM interview_transcripts WHERE tenant_id = $1`, [T2])).rows);
    expect(other).toHaveLength(1);
    expect(other[0].turn_count).toBe(18);
  });

  it("refuses to run the same backup twice, because the rows have moved on", async () => {
    /*
     * The v5.34.126 staleness guard, doing the job it could not do before
     * v5.34.127: when apply re-scanned, `_original` was always a few seconds
     * old and the guard could never fire.
     */
    const r = run(["--apply", "--backup", backup, "--remap-anchors"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/changed since the audit: 2/);
    expect(r.out).toContain("CHANGED since the audit");
    expect(r.out).toMatch(/repaired: 0/);
    const db = await readBack();
    expect(db.repaired.turns, "a second apply changed the data").toHaveLength(18);
  }, 60_000);

  it("never overwrites the backup it was told to apply", () => {
    /*
     * It used to. The scan ran first and wrote its result over --backup, so the
     * verified file was replaced by an unverified one before the first UPDATE.
     */
    const b = JSON.parse(readFileSync(backup, "utf8"));
    expect(b.affected[0]._original, "the backup now describes the repaired state")
      .toHaveLength(30);
  });

  it("refuses a backup with no evidence when it is asked to move anchors", () => {
    const b = JSON.parse(readFileSync(backup, "utf8"));
    for (const a of b.affected) delete a._evidence;
    const stripped = join(dir, "no-evidence.json");
    writeFileSync(stripped, JSON.stringify(b));
    const r = run(["--apply", "--backup", stripped, "--remap-anchors"]);
    expect(r.code, r.out).toBe(5);
    expect(r.out).toContain("no backed-up evidence");
  }, 60_000);

  it("refuses a backup that does not exist rather than scanning for one", () => {
    const r = run(["--apply", "--backup", join(dir, "nope.json"), "--remap-anchors"]);
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain("does not exist");
  }, 60_000);

  /*
   * ── v5.34.128 ──────────────────────────────────────────────────────────────
   *
   * The first live apply opened a transaction, set the tenant, and died on
   * "permission denied for table interview_transcripts". Nothing was lost, but
   * the tool had already announced that it was applying a verified backup, and
   * a missing GRANT is knowable in one query before the first BEGIN.
   */
  it("refuses before opening a transaction when it cannot write", () => {
    const r = run(["--apply", "--backup", backup, "--remap-anchors"],
                  { DATABASE_URL: asReadOnly(SCOPED) });
    expect(r.code, r.out).toBe(6);
    expect(r.out).toContain("cannot perform this repair");
    expect(r.out).toContain("interview_transcripts: missing UPDATE");
    expect(r.out).toContain("no transaction was opened");
    expect(r.out, "a missing grant is not RLS, and saying so is the point")
      .toContain("not row-level security");
    expect(r.out, "it must name the role that can do it").toMatch(/DB_OWNER=\w+/);
    expect(r.out, "it must not claim to be applying anything")
      .not.toContain("Nothing is re-scanned");
  }, 60_000);

  it("--check-access reports the privileges without touching a row", () => {
    const r = run(["--check-access"], { DATABASE_URL: asReadOnly(SCOPED) });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`connected as: ${RO_ROLE}`);
    expect(r.out).toMatch(/interview_transcripts +owner \w+ +SELECT yes {2}UPDATE NO/);
    expect(r.out).toContain("cannot perform it");
    expect(r.out, "the DSN is printed, the password is not").not.toContain(RO_PASS);
  }, 60_000);

  it("and says so plainly when the role CAN do it", () => {
    const r = run(["--check-access"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("This role can perform the repair.");
  }, 60_000);

  it("DB_OWNER swaps the role in, so the same command succeeds", async () => {
    /*
     * The alternative was granting the app role UPDATE on a table it never
     * edits — permanently widening the application's reach to get one migration
     * done — or asking the operator to retype a production DSN by hand.
     */
    await seed();
    const fresh = join(dir, "owner-run.json");
    const a = run(["--backup", fresh], { DATABASE_URL: asReadOnly(SCOPED) });
    expect(a.code, a.out).toBe(0);

    const r = run(["--apply", "--backup", fresh, "--remap-anchors"], {
      DATABASE_URL: asReadOnly(SCOPED),
      DB_OWNER: RW_ROLE,
      DB_OWNER_PASSWORD: RW_PASS,
    });
    expect(r.out).toContain(`connecting as ${RW_ROLE} instead of ${RO_ROLE}`);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/repaired: 2/);

    const db = await readBack();
    expect(db.repaired.turns).toHaveLength(18);
    expect(r.out, "the owner password must never be printed").not.toContain(RW_PASS);
  }, 60_000);

  /*
   * ── v5.34.129 ──────────────────────────────────────────────────────────────
   *
   * interview_transcripts is append-only by design. Migration 024 removed the
   * FOR ALL policy and left tenant_read (FOR SELECT) and tenant_write (FOR
   * INSERT), with no UPDATE grant and no UPDATE policy — "a transcript remains
   * unmodifiable in place", in that file's own words. FORCE RLS binds the owner
   * too, so the first live apply as `vyne` read the row and matched zero rows.
   *
   * The repair therefore has to be a migration, in the shape 026 established.
   * These tests run the EMITTED SQL against a real database: a generated
   * migration that has only been eyeballed is a migration nobody has run.
   */
  it("emits a migration that restores the invariant it suspends", async () => {
    await seed();
    const b = join(dir, "for-migration.json");
    expect(run(["--backup", b]).code).toBe(0);
    const sqlFile = join(dir, "901_dedupe.sql");
    const e = run(["--emit-migration", sqlFile, "--backup", b, "--remap-anchors"],
                  { DATABASE_URL: undefined });
    expect(e.code, e.out).toBe(0);
    const sql = readFileSync(sqlFile, "utf8");

    // FORCE comes off and goes back on, and the ON comes last.
    expect(sql).toContain("ALTER TABLE interview_transcripts NO FORCE ROW LEVEL SECURITY;");
    expect(sql).toContain("ALTER TABLE interview_transcripts FORCE  ROW LEVEL SECURITY;");
    expect(sql.lastIndexOf("NO FORCE ROW LEVEL SECURITY"))
      .toBeLessThan(sql.lastIndexOf("FORCE  ROW LEVEL SECURITY"));
    // It must not quietly grant the thing 024 withheld.
    expect(sql, "the migration adds an UPDATE policy").not.toMatch(/CREATE POLICY[\s\S]*FOR UPDATE/);
    expect(sql, "the migration grants UPDATE").not.toMatch(/GRANT[^;]*UPDATE/);
  }, 60_000);

  it("the emitted migration actually repairs the rows when run", async () => {
    const sql = readFileSync(join(dir, "901_dedupe.sql"), "utf8");
    await admin.query("BEGIN");
    await admin.query(sql);
    await admin.query("COMMIT");

    const db = await readBack();
    expect(db.repaired.turns.map((t: Msg) => t.text)).toEqual(REPAIRED.map((t) => t.text));
    expect(db.repaired.turn_count).toBe(18);
    expect(db.session.displayMessages.map((m: Msg) => m.text)).toEqual(REPAIRED.map((t) => t.text));
    for (const [list, before] of [["score_events", SCORE], ["findings", FINDING]] as const) {
      const after = db.repaired[list] as Array<{ afterTurn: unknown }>;
      expect(after.map((e) => named(db.repaired.turns, e.afterTurn)))
        .toEqual(before.map((e) => named(DOUBLED, e.afterTurn)));
    }
    expect(db.untouched.turn_count, "the clean transcript was touched").toBe(18);
    expect(db.untouched.turns).toHaveLength(18);

    /* v5.34.130 — the check v5.34.129's migration would have failed. */
    expect((db.repaired.turns as Msg[]).map((t) => t.idx)).toEqual(REPAIRED.map((_, i) => i));
    for (const [list, before] of [["score_events", SCORE], ["findings", FINDING]] as const) {
      const after = db.repaired[list] as Array<{ afterTurn: unknown }>;
      expect(after.map((e) => onPage(db.repaired.turns, e.afterTurn)),
             `${list}: the migration leaves anchors the review page cannot place`)
        .toEqual(before.map((e) => onPage(DOUBLED, e.afterTurn)));
    }
  }, 60_000);

  it("and FORCE row level security is back on both tables afterwards", async () => {
    const r = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = ANY($2)`,
      [SCHEMA, ["interview_transcripts", "module_state"]]);
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.relrowsecurity, `${row.relname} left with RLS disabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} left un-FORCEd`).toBe(true);
    }
  });

  it("refuses to run twice, rather than repairing an already-repaired row", async () => {
    /*
     * The length guard, in SQL. A migration re-run by hand against a repaired
     * row must raise rather than write 18 messages over 18 different ones.
     */
    const sql = readFileSync(join(dir, "901_dedupe.sql"), "utf8");
    await admin.query("BEGIN");
    await expect(admin.query(sql)).rejects.toThrow(/not the 30 that were audited/);
    await admin.query("ROLLBACK");
    const db = await readBack();
    expect(db.repaired.turns).toHaveLength(18);
  }, 60_000);

  it("runs cleanly on a fresh database that never held the row", async () => {
    /*
     * v5.34.131. The migration lives in migrations/ permanently, so it runs on
     * every fresh database — it-db.sh, every suite that calls migrate(), the
     * gates deploy.sh runs before a release. None of them hold this client's
     * row. v5.34.130 raised "not there any more" and would have failed all of
     * them, blocking the next deploy on a repair that had already worked.
     */
    const sql = readFileSync(join(dir, "901_dedupe.sql"), "utf8");
    await admin.query(`DELETE FROM interview_transcripts`);
    await admin.query(`DELETE FROM module_state`);
    await admin.query("BEGIN");
    await expect(admin.query(sql), "a fresh database cannot run the migration").resolves.toBeTruthy();
    await admin.query("COMMIT");
    const r = await admin.query(
      `SELECT c.relname, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'interview_transcripts'`, [SCHEMA]);
    expect(r.rows[0].relforcerowsecurity, "the early return skipped putting FORCE back").toBe(true);
  }, 60_000);

  it("dollar-quotes with a tag the transcript cannot contain", async () => {
    /*
     * A fixed tag is a quoting bug waiting for the interviewee who says the
     * wrong thing. This seeds a transcript containing the obvious tag and a
     * single quote, and requires the emitted SQL to survive being run.
     */
    await seed();
    /* BOTH copies, or the doubled prefix no longer matches and there is nothing
     * to repair — which is how this test first failed, on its own fixture. */
    const NASTY = "it's $mig$ and $mig$ and 'quoted' \\ backslash";
    const nasty = DOUBLED.map((m, i) => (i === 0 || i === first.length ? { ...m, text: NASTY } : m));
    await asTenant(T1, () => admin.query(
      `UPDATE interview_transcripts SET turns = $1::jsonb WHERE id = $2`,
      [JSON.stringify(nasty), TRANSCRIPT]));

    const b2 = join(dir, "nasty.json");
    expect(run(["--backup", b2]).code).toBe(0);
    const f2 = join(dir, "902_nasty.sql");
    expect(run(["--emit-migration", f2, "--backup", b2, "--remap-anchors"],
               { DATABASE_URL: undefined }).code).toBe(0);
    const sql = readFileSync(f2, "utf8");
    expect(sql, "the tag it picked appears inside the data it wraps").toContain("$migx$");

    await admin.query("BEGIN");
    await admin.query(sql);
    await admin.query("COMMIT");
    const db = await readBack();
    expect(db.repaired.turns).toHaveLength(18);
    expect((db.repaired.turns[0] as Msg).text).toContain("$mig$");
  }, 60_000);

  it("refuses to emit from a backup whose anchors would move", () => {
    const b = JSON.parse(readFileSync(join(dir, "for-migration.json"), "utf8"));
    b.affected[0]._fixed = b.affected[0]._original;
    const bad = join(dir, "bad-for-migration.json");
    writeFileSync(bad, JSON.stringify(b));
    const e = run(["--emit-migration", join(dir, "never.sql"), "--backup", bad, "--remap-anchors"],
                  { DATABASE_URL: undefined });
    expect(e.code, e.out).toBe(5);
    expect(existsSync(join(dir, "never.sql")), "it wrote a migration anyway").toBe(false);
  }, 60_000);

  /*
   * ── v5.34.132: the frozen-fragment copies ─────────────────────────────────
   *
   * liveAppend stored every live line twice until v5.34.132: addMessage's entry,
   * frozen at the first fragment and timed, and its own mirror entry, grown into
   * the full line and untimed. The 2026-09-18 record held 52 such pairs and
   * nothing else. This seeds that exact shape — `who`, `idx`, the `at` pattern —
   * and runs the whole path: audit, verify, emit, migrate, then reads the row
   * back and asks where the review page would put each anchor.
   */
  it("collapses fragment copies end to end, and the page still finds every anchor", async () => {
    await seed();
    const lines = [
      ["Interviewer", "Hi Avery,", "Hi Avery, I'm Jack Smith."],
      ["Interviewee", "Hey Jack.", "Hey Jack."],                        // arrived whole: identical copies
      ["Interviewer", "Where does", "Where does your data sit?"],
      ["Interviewee", "In a lake", "In a lake, mostly."],
      ["Interviewer", "And", "And who owns it?"],
      ["Interviewee", "IT does.", "IT does."],
    ] as const;
    const frag = lines.flatMap(([who, a, b], k) => [
      { who, text: a, at: 7000 + k },
      { who, text: b, at: null },
    ]).map((t, i) => ({ ...t, idx: i }));
    /* Anchors on the full lines (where scoring lands, after a turn completes),
     * plus one on a FRAGMENT — the case verify must accept as the same line. */
    const score = [{ afterTurn: 4, dim: "x" }, { afterTurn: 8, dim: "y" }, { afterTurn: 12, dim: "z" }];
    const finds = [{ afterTurn: 6, text: "data in a lake" }, { afterTurn: 5, text: "anchored on a fragment" }];
    const FRAG = "aaaaaaaa-0000-0000-0000-00000000f000";
    await asTenant(T1, () => admin.query(
      `INSERT INTO interview_transcripts
         (id, tenant_id, client_name, interviewee_name, round_number, turns, turn_count, score_events, findings)
       VALUES ($1,$2,'Acme','Avery',1,$3::jsonb,$4,$5::jsonb,$6::jsonb)`,
      [FRAG, T1, JSON.stringify(frag), frag.length, JSON.stringify(score), JSON.stringify(finds)]));

    const b = join(dir, "fragments.json");
    const a = run(["--backup", b]);
    expect(a.code, a.out).toBe(0);
    expect(a.out).toMatch(/12 messages → 6 {3}\(6 fragment copies merged into the lines they began\)/);

    const v = run(["--verify-backup", b], { DATABASE_URL: undefined });
    expect(v.code, v.out).toBe(0);
    expect(v.out, "the fragment anchor should resolve to its own full line").toMatch(/LINE +findingEvents\[1\] +5 → 3/);

    const f = join(dir, "903_fragments.sql");
    const e = run(["--emit-migration", f, "--backup", b, "--remap-anchors"], { DATABASE_URL: undefined });
    expect(e.code, e.out).toBe(0);
    const sql = readFileSync(f, "utf8");
    expect(sql).toContain("-- 903_fragments.sql");

    await admin.query("BEGIN"); await admin.query(sql); await admin.query("COMMIT");

    const row = await asTenant(T1, async () => (await admin.query(
      `SELECT turns, turn_count, score_events, findings FROM interview_transcripts WHERE id = $1`, [FRAG])).rows[0]);
    type T = { who: string; text: string; at: number | null; idx: number };
    const turns = row.turns as T[];
    expect(turns.map((t) => t.text)).toEqual(lines.map(([, , full]) => full));
    expect(turns.map((t) => t.idx)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(turns.every((t) => typeof t.at === "number"), "a surviving line has no start time").toBe(true);
    expect(turns[0].at).toBe(7000);
    expect(row.turn_count).toBe(6);

    /* Where the review page puts each anchor, by its own rule. The fragment
     * anchor must land on the line the fragment began. */
    /* Expected values DERIVED from the original by the page's rule, not typed
     * in: the first draft of this test hand-counted them and got one wrong.
     * A fragment anchor is expected on the full line that fragment began. */
    const place = (n: unknown) => onPage(turns as unknown as Msg[], n);
    const fragTurns = frag as unknown as Msg[];
    const wasOn = (n: unknown) => {
      const t = fragTurns.find((x) => x.idx === Number(n) - 1)!;
      return (t as unknown as { at: number | null }).at === null
        ? t.text
        : fragTurns[fragTurns.indexOf(t) + 1].text;        // a fragment: its completion
    };
    expect((row.score_events as Array<{ afterTurn: number }>).map((x) => place(x.afterTurn)))
      .toEqual(score.map((x) => wasOn(x.afterTurn)));
    expect((row.findings as Array<{ afterTurn: number }>).map((x) => place(x.afterTurn)))
      .toEqual(finds.map((x) => wasOn(x.afterTurn)));
    expect(place((row.findings as Array<{ afterTurn: number }>)[1].afterTurn),
           "the fragment anchor should land on the line the fragment began").toBe("Where does your data sit?");
  }, 60_000);

  it("leaves a real conversation that merely repeats itself alone", async () => {
    /* Same speaker, prefix, both TIMED: a genuine "Yes." then "Yes, and…".
     * Without the at-fingerprint this would have been eaten. */
    await seed();
    const real = [
      { who: "Interviewer", text: "Is it budgeted?", at: 1, idx: 0 },
      { who: "Interviewee", text: "Yes.", at: 2, idx: 1 },
      { who: "Interviewee", text: "Yes, and the budget is separate.", at: 3, idx: 2 },
      { who: "Interviewer", text: "Thanks.", at: 4, idx: 3 },
    ];
    await asTenant(T1, () => admin.query(`UPDATE interview_transcripts SET turns = $1::jsonb WHERE id = $2`,
                                         [JSON.stringify(real), UNTOUCHED]));
    const r = run(["--backup", join(dir, "real.json")]);
    expect(r.out, "the genuine repeat was reported as damage").not.toContain("Ravi");
  }, 60_000);

  it("reports that this connection can see across tenants", () => {
    /*
     * The rehearsal's own finding, kept as an assertion: the test role bypasses
     * RLS, and a tool about to write to client records should say so rather than
     * quietly enjoy the extra reach.
     */
    const r = run(["--backup", join(dir, "again.json")]);
    expect(r.out).toContain("Row-level security is not filtering for this role");
  }, 60_000);
});
