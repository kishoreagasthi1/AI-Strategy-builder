#!/usr/bin/env node
/**
 * Repair the transcripts doubled by the v5.34.121 resume defect.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 *
 * Before v5.34.121, resuming a session replayed the stored history with
 *
 *     S.displayMessages.forEach(m => addMessage(...))
 *
 * and addMessage's last line pushed into S.displayMessages. forEach visits the
 * indices present when it starts, so each resume appended one complete copy of
 * everything said so far. One resume doubles the transcript; two quadruple it.
 *
 * It is not a display artefact. On the voice path the saved session, the
 * archive, the submitted record and interview_transcripts.turns are all built
 * from that array, so the duplication is in the database.
 *
 * ── What this does, and does not do ─────────────────────────────────────────
 *
 * By default: NOTHING is written. It reads, reports what it would change, and
 * writes a full JSON backup of every affected row. `--apply` is refused unless
 * that backup exists, so there is always a way back.
 *
 *     node ../deploy/dedupe-transcripts.mjs                     (audit)
 *     node ../deploy/dedupe-transcripts.mjs --verify-backup <f> (prove the remap)
 *     node ../deploy/dedupe-transcripts.mjs --apply --backup <f>
 *
 * Run it from anywhere with cloud-sql-proxy up on 5433; `pg` is resolved from
 * backend/node_modules explicitly, so the working directory does not matter:
 *
 *     ~/cloud-sql-proxy vyne-platform-prod:us-central1:vyne-sql --port 5433 &
 *     DATABASE_URL="$(gcloud secrets versions access latest --secret=vyne-database-url)" \\
 *       node deploy/dedupe-transcripts.mjs
 *
 * The secret is Cloud Run's DSN and names a unix socket; resolveDsn points it
 * at the proxy. PROXY_PORT overrides 5433.
 *
 * ── The one genuinely dangerous part ────────────────────────────────────────
 *
 * Findings and score events anchor to a POSITION in the transcript —
 * `afterTurn` is literally `S.displayMessages.length` at the moment they were
 * recorded (interview_agent.html:3075, :3854). Evidence recorded during the
 * SECOND sitting therefore points past the duplicated block, and removing that
 * block without shifting those anchors would silently re-attach every finding
 * from the second half of the interview to the wrong answer.
 *
 * Wrong evidence attached to the right-looking transcript is worse than a
 * visibly doubled one: the doubling announces itself, a misplaced finding does
 * not. So the audit reports, per record, whether any anchor lands past the
 * duplicate boundary — and `--apply` REFUSES any record where it does, unless
 * `--remap-anchors` is passed as a separate, deliberate decision.
 *
 * ── Detection ───────────────────────────────────────────────────────────────
 *
 * The signature is a doubled PREFIX: some p where items[0..p) equals
 * items[p..2p). Not pairwise-adjacent duplicates — a real interview can
 * legitimately repeat a short turn, and "de-duplicate adjacent identical
 * messages" would eat those.
 *
 * Compared on role+text only. The replayed copy was written through
 * addMessage, which stamped a FRESH timestamp, so the two copies differ in
 * `at`/`timestamp` and agree in nothing else. That asymmetry is also the
 * corroboration the report prints: the second copy's timestamps cluster at the
 * moment of resume.
 */
/*
 * ── Resolving `pg` from a script that does not live beside it (v5.34.123) ────
 *
 * `import pg from "pg"` resolves relative to THIS FILE, not the working
 * directory, so running from backend/ does not help: node looks in
 * deploy/node_modules, walks up, and finds nothing. The first version of this
 * script told the operator to cd into backend/ and then failed with
 * ERR_MODULE_NOT_FOUND anyway.
 *
 * createRequire anchored at backend/package.json resolves it exactly as the
 * backend would, from wherever this is run. pg is CommonJS, so require is the
 * correct door.
 */
import { createRequire } from "node:module";
const requireFromBackend = createRequire(new URL("../backend/package.json", import.meta.url));
let pg;
try {
  pg = requireFromBackend("pg");
} catch (e) {
  console.error("Could not load the 'pg' driver from backend/node_modules.");
  console.error("Run `npm install` in vyne-saas/backend, then try again.");
  console.error(String(e && e.message));
  process.exit(2);
}
import {
  MIN_BLOCK, dedupe, indexMap, anchorsAtRisk, remapEvidence, applyDecision, verifyBackup,
  applyPreflight, tablesToWrite, accessVerdict, withOwner, emitMigration, fixedForWrite,
  repair, anchorsThatMove, nextMigrationNumber,
  resolveDsn, redactDsn,
} from "./dedupe-lib.mjs";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";

const line = (s) => console.log(s);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const APPLY = has("--apply");
const VERIFY = val("--verify-backup", null);
const REMAP = has("--remap-anchors");
const ONLY_CLIENT = val("--client", null);
const CHECK_ACCESS = has("--check-access");
const EMIT = val("--emit-migration", null);
/* v5.34.132 — the number comes from the file name being written, or the next
 * free one in migrations/. The first emitter defaulted to "038", which was
 * right exactly once. */
const MIGRATIONS_DIR = new URL("../backend/src/db/migrations/", import.meta.url);
const BACKUP = val("--backup", `dedupe-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

/* ── verify ────────────────────────────────────────────────────────────────── */
/*
 * ── v5.34.126: prove the remap on the REAL data, before writing ─────────────
 *
 * The 2026-09-18 audit found one affected record with seventeen finding and
 * score anchors sitting past the duplicated block. Tests prove the remap lands
 * on the same words for a synthetic transcript; they say nothing about this
 * one. Seventeen misplaced findings in the record a client deliverable quotes
 * is not something to take on faith in a test fixture.
 *
 * So this replays the repair from the backup — no database, nothing written —
 * and prints, for every anchor, the message it names now and the message it
 * would name afterwards. If every line reads SAME, the remap is proven on the
 * actual data rather than on mine.
 *
 * It also prints the seam: the last messages kept and the first ones after the
 * removed block, so the join can be read as a conversation rather than trusted
 * as an index calculation.
 */
if (VERIFY) {
  const report = verifyBackup(JSON.parse(readFileSync(VERIFY, "utf8")));
  console.log("");
  console.log(`── verifying ${VERIFY} ──────────────────────────────────────────`);
  console.log(`records: ${report.records.length}   (nothing is written; no database is opened)`);

  for (const r of report.records) {
    console.log("");
    console.log(`  ${r.client || "(no client)"} · ${r.stakeholder || "(no name)"}  [${r.where}]`);
    console.log(`  ${r.before} messages → ${r.after}` +
      (r.doublings || r.collapsed
        ? `   (${[r.doublings ? `${r.doublings} doubling(s)` : "", r.collapsed ? `${r.collapsed} fragment copies merged` : ""].filter(Boolean).join(", ")})`
        : ""));
    console.log("");
    console.log("  the seam — what the repaired transcript reads like across the join:");
    for (const s of r.seam) console.log(`    ${String(s.n).padStart(4)}  ${s.text}`);

    if (r.evidenceMissing) {
      console.log("");
      console.log(`  !! this backup has NO copy of the evidence, and the audit counted`);
      console.log(`     ${r.anchorsAtRisk} anchor(s) that the repair would move. It was written by a`);
      console.log("     version before v5.34.126. There is nothing here to check and");
      console.log("     nothing here to restore the findings from.");
      continue;
    }
    if (!r.anchors.length) {
      console.log("");
      console.log("  no anchored evidence on this record — nothing to remap.");
      continue;
    }
    console.log("");
    console.log(`  ${r.anchors.length} anchor(s) — the message each one names, before and after:`);
    for (const an of r.anchors) {
      /* v5.34.132 — LINE: the anchor named a frozen fragment and now names the
       * full line that fragment grew into. Printed with both texts so it can be
       * read rather than trusted. */
      const tag = an.status === "same" ? "SAME " : an.status === "same-line" ? "LINE "
                : an.status === "moved" ? "MOVED" : "?????";
      console.log(`    ${tag}  ${an.list}[${an.index}]  ${an.from} → ${an.to}`);
      if (an.status !== "same") {
        console.log(`             was: ${an.was === null ? "(no such message)" : `"${an.was}"`}`);
        console.log(`             now: ${an.now === null ? "(no such message)" : `"${an.now}"`}`);
      }
    }
  }

  console.log("");
  if (report.evidenceMissing) {
    console.log(`!! ${report.evidenceMissing} record(s) have anchors at risk and no backed-up evidence.`);
    console.log("   Re-run the audit on v5.34.126 to write a complete backup, then verify that.");
    console.log("   Do not apply with --remap-anchors against this one.");
    process.exit(5);
  }
  if (report.mismatches) {
    console.log(`!! ${report.mismatches} of ${report.checked} anchor(s) would NOT name the same message.`);
    console.log("   Do not apply with --remap-anchors. Send me the lines above.");
    process.exit(4);
  }
  console.log(`All ${report.checked} anchor(s) name the same message before and after. The remap is safe`);
  console.log("for this data, not merely for the test fixtures.");
  process.exit(0);
}

/* ── emit ──────────────────────────────────────────────────────────────────── */
/*
 * ── v5.34.129: interview_transcripts is append-only on purpose ──────────────
 *
 * Migration 024 removed the FOR ALL policy and left tenant_read (FOR SELECT)
 * and tenant_write (FOR INSERT) — no UPDATE grant, no UPDATE policy, and it
 * says why in the file: "a transcript remains unmodifiable in place". FORCE ROW
 * LEVEL SECURITY binds the table owner too, so the repair run as `vyne` read
 * the row and matched zero rows on the UPDATE.
 *
 * That is a guarantee somebody chose, and adding an UPDATE policy to get past
 * it would quietly remove it. The house pattern for data work on these tables
 * is a migration — 026 drops FORCE, backfills, and puts FORCE back inside the
 * runner's transaction — so the repair is emitted in that shape, generated from
 * the verified backup rather than written by hand.
 */
if (EMIT) {
  const backup = JSON.parse(readFileSync(BACKUP, "utf8"));
  let existing = [];
  try { existing = readdirSync(MIGRATIONS_DIR); } catch { existing = []; }
  const named = /^(\d+)_(.+)\.sql$/.exec(basename(EMIT));
  const number = named ? named[1] : nextMigrationNumber(existing);
  const name = named ? named[2] : "repair_transcript_duplicates";
  const clash = existing.find((f) => f.startsWith(`${number}_`) && f !== basename(EMIT));
  if (clash) {
    console.error(`\nRefusing: migrations/ already has ${clash} as number ${number}.`);
    console.error(`Name the file ${nextMigrationNumber(existing)}_${name}.sql instead.`);
    process.exit(2);
  }
  if (existing.includes(basename(EMIT))) {
    console.error(`\nRefusing: migrations/ already has ${basename(EMIT)}, and it may already be applied.`);
    console.error("A migration that has run is history. Emit the next one under a new number.");
    process.exit(2);
  }
  const out = emitMigration(backup, { number, name, remap: REMAP });
  if (!out.ok) {
    console.error("");
    console.error(out.reason === "evidence-missing"
      ? `${BACKUP} has anchors at risk and no backed-up evidence. Re-run the audit.`
      : out.reason === "idx-gaps"
        ? `${BACKUP} holds a transcript whose idx does not match position (blank turns). Refused.`
      : out.reason === "anchors-move"
        ? `${BACKUP}: anchors would not name the same message. Run --verify-backup ${BACKUP}.`
        : `${BACKUP} is not a backup this can turn into a migration (${out.reason}).`);
    process.exit(5);
  }
  writeFileSync(EMIT, out.sql);
  line("");
  line(`migration written: ${EMIT}`);
  line(`  records: ${backup.affected.length}   tables: ${out.tables.join(", ")}`);
  line(`  anchors: ${out.report.checked} checked, every one naming the same message afterwards`);
  line("");
  line("It drops FORCE ROW LEVEL SECURITY, repairs, and restores it, the way 026 does,");
  line("inside the one transaction the runner wraps each file in. It refuses to write if");
  line("the row is not the length that was audited, and asserts the result afterwards.");
  line("");
  line("Read it, then move it into backend/src/db/migrations/ and run the migrate step.");
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Start cloud-sql-proxy on 5433 and export it.");
  process.exit(2);
}

/* ── scan ──────────────────────────────────────────────────────────────────── */

/*
 * ── v5.34.125: why this walks tenants instead of selecting everything ───────
 *
 * The first version ran one SELECT over module_state and interview_transcripts
 * and reported "scanned: 0 … Nothing is doubled. Nothing to do."
 *
 * Both tables carry FORCE ROW LEVEL SECURITY with
 *
 *     tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
 *
 * so with no app.tenant_id set the comparison is against NULL, which is never
 * true, and every row is filtered — from the owner too, because the policy is
 * FORCEd. Postgres did exactly the right thing; the script then announced a
 * clean bill of health it had not earned.
 *
 * That is worse than the defect it was written to repair. A doubled transcript
 * is visible in the record; a repair tool that says "nothing to do" because it
 * could not see closes the question for good.
 *
 * So: enumerate tenants (the one table without RLS), scan inside each one's
 * context the way the application does, and — the part that matters — count
 * what was VISIBLE, so an empty result can be told apart from an empty table.
 */
const { Client } = pg;
const resolved = resolveDsn(process.env.DATABASE_URL, Number(process.env.PROXY_PORT) || 5433);
if (resolved.rewritten) {
  console.log(`(DSN names the unix socket ${resolved.was} — using the proxy instead: ${redactDsn(resolved.dsn)})`);
}
/*
 * ── v5.34.128: connecting as the owner without retyping a DSN ───────────────
 *
 * DATABASE_URL is the application's, and the application role has SELECT on
 * interview_transcripts but not UPDATE — correct for an app that inserts a
 * submitted transcript and never edits one, and fatal to a repair that does.
 *
 * DB_OWNER and DB_OWNER_PASSWORD swap the role in, straight out of Secret
 * Manager, so no production password is assembled by hand or left in a shell
 * history. Everything else about the DSN — host, port, database, the proxy
 * rewrite above — is untouched.
 */
const owned = withOwner(resolved.dsn, process.env.DB_OWNER, process.env.DB_OWNER_PASSWORD);
if (owned.swapped) {
  console.log(`(connecting as ${owned.now} instead of ${owned.was || "the DSN's role"})`);
}
const db = new Client({ connectionString: owned.dsn });
try {
  await db.connect();
} catch (e) {
  console.error(`\nCould not connect to ${redactDsn(owned.dsn)}`);
  console.error(String(e && e.message));
  console.error("\nIs cloud-sql-proxy running?  ~/cloud-sql-proxy vyne-platform-prod:us-central1:vyne-sql --port 5433 &");
  process.exit(2);
}

/*
 * ── v5.34.128: find out what this role may do BEFORE writing anything ───────
 *
 * The first live apply opened a transaction, set the tenant, and then died on
 *
 *     permission denied for table interview_transcripts
 *
 * Nothing was lost — the transaction rolled back — but the tool had already
 * told the operator it was applying a verified backup. A missing GRANT is
 * knowable in one query before the first BEGIN, and a repair that can announce
 * it up front should never discover it halfway through.
 *
 * It is also a different wall from the one v5.34.125 hit, and the report keeps
 * them apart: row-level security returns zero rows and no error, a missing
 * grant raises. Both end with nothing written and only one is fixed by setting
 * app.tenant_id.
 */
async function accessReport(tables) {
  const q = await db.query(
    `SELECT c.relname AS table,
            pg_get_userbyid(c.relowner) AS owner,
            c.relrowsecurity  AS rls_enabled,
            c.relforcerowsecurity AS rls_forced,
            has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
            has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = ANY($1) AND n.nspname = ANY(current_schemas(true))`,
    [tables]);
  const who = (await db.query(`SELECT current_user AS who, session_user AS session`)).rows[0];
  return { rows: q.rows, who };
}

const ALL_TABLES = ["interview_transcripts", "module_state", "tenants"];

if (CHECK_ACCESS) {
  const { rows, who } = await accessReport(ALL_TABLES);
  line("");
  line("── what this connection may do ─────────────────────────────────────────");
  line(`connected as: ${who.who}${who.session !== who.who ? ` (session ${who.session})` : ""}`);
  line(`DSN:          ${redactDsn(owned.dsn)}`);
  line("");
  for (const t of ALL_TABLES) {
    const r = rows.find((x) => x.table === t);
    if (!r) { line(`  ${t.padEnd(22)} not visible to this role at all`); continue; }
    line(`  ${t.padEnd(22)} owner ${String(r.owner).padEnd(12)} ` +
         `SELECT ${r.can_select ? "yes" : "NO "}  UPDATE ${r.can_update ? "yes" : "NO "}` +
         `${r.rls_forced ? "  (RLS forced)" : r.rls_enabled ? "  (RLS on)" : ""}`);
  }
  line("");
  const needsUpdate = rows.filter((r) => r.table !== "tenants" && !r.can_update);
  if (needsUpdate.length) {
    line("The repair writes to interview_transcripts and module_state, so this role");
    line("cannot perform it. Re-run with the owner role:");
    line("");
    line(`    DB_OWNER=${rows.find((r) => r.table === "interview_transcripts")?.owner ?? "<owner>"} \\`);
    line("    DB_OWNER_PASSWORD=\"$(gcloud secrets versions access latest --secret=vyne-db-owner-password)\" \\");
    line("    ...and the rest of your command, unchanged");
    line("");
    line("Nothing is granted, changed or widened by doing that — it connects as the");
    line("role that already owns the tables, for one run.");
  } else {
    line("This role can perform the repair.");
  }
  await db.end();
  process.exit(0);
}

let affected = [];
let scanned = 0;              // records with a transcript long enough to examine
let sessionRows = 0;          // distinct module_state rows actually visible
let transcriptRows = 0;       // distinct interview_transcripts rows actually visible

/*
 * ── v5.34.127: a row belongs to its own tenant, not to the loop ──────────────
 *
 * Found by rehearsing the apply against a throwaway database: one doubled
 * transcript and one doubled session were reported as FOUR affected records,
 * and the visible counts were exactly doubled.
 *
 * The scan walks tenants and reads inside each one's RLS context, which is
 * right when the policy is filtering. It was not: the rehearsal connected as a
 * superuser, and a superuser bypasses row-level security even when the policy
 * is FORCEd. So every row was visible inside every tenant's context and was
 * examined once per tenant.
 *
 * Production reads as `vyne_app`, where the policy does filter — the live audit
 * reported one record with counts that add up. But a tool that quietly does the
 * wrong thing when run as the wrong role is a tool waiting to do it on a day
 * when someone reaches for a different DSN, and the record it would have
 * written twice is a client's.
 *
 * Two corrections, and the second is the one that generalises:
 *
 *   - identity comes from the ROW, not from the loop. `tenant_id` is selected
 *     and used, so a record is tagged with the tenant that owns it even if it
 *     was read inside someone else's context. Without this the apply would set
 *     app.tenant_id to a tenant that does not own the row and match nothing.
 *   - a row already examined is not examined again, whatever context it shows
 *     up in.
 *
 * And the fact itself gets reported rather than silently absorbed: a connection
 * that can see across tenants has more reach than the application does, and the
 * operator should know which they are holding.
 */
const seen = new Set();
let crossTenant = 0;

/*
 * ── v5.34.127: --apply applies the VERIFIED file, and does not re-scan ───────
 *
 * Until now --apply re-ran the whole scan and repaired what the scan found,
 * while --verify-backup checked the FILE. Two sides of one decision reading
 * different things: the operator proved the remap on a backup, and the apply
 * then did its own arithmetic on whatever was in the database at that moment.
 * The proof governed nothing.
 *
 * It was also destructive. The scan wrote its result over --backup on the way
 * past, so the verified file was replaced by an unverified one before the first
 * UPDATE — and the v5.34.126 staleness guard could never fire, because it was
 * comparing a scan against rows read seconds after it.
 *
 * So the two modes are now genuinely different runs: audit reads and writes a
 * backup, apply reads that backup and writes the database. Neither does the
 * other's job.
 */
if (APPLY) {
  if (!existsSync(BACKUP)) {
    console.error(`\nRefusing to apply: backup ${BACKUP} does not exist.`);
    console.error("Run the audit first; --apply writes nothing without a backup on disk.");
    console.error("And pass --backup <file> explicitly — the default name is today's timestamp.");
    await db.end();
    process.exit(2);
  }
  let loaded;
  try {
    loaded = JSON.parse(readFileSync(BACKUP, "utf8"));
  } catch (e) {
    console.error(`\nRefusing to apply: ${BACKUP} is not readable JSON.`);
    console.error(String(e && e.message));
    await db.end();
    process.exit(2);
  }

  const pre = applyPreflight(loaded, REMAP);
  if (!pre.ok) {
    console.error("");
    if (pre.reason === "unreadable") {
      console.error(`${BACKUP} has no "affected" list. That is not a backup this can apply.`);
    } else if (pre.reason === "empty") {
      console.error(`${BACKUP} lists no affected records. Nothing to apply.`);
    } else if (pre.reason === "idx-gaps") {
      console.error(`${BACKUP} holds a transcript whose turn idx does not match its position —`);
      console.error("it had blank messages filtered out. The repair works in positions and the");
      console.error("review page reads idx, so this record is refused rather than guessed at.");
    } else if (pre.reason === "evidence-missing") {
      console.error(`${BACKUP} has ${pre.report.evidenceMissing} record(s) with anchors at risk and`);
      console.error("no backed-up evidence. It predates v5.34.126. Re-run the audit to write a");
      console.error("complete backup, verify that one, and apply it instead.");
    } else {
      console.error(`${BACKUP}: ${pre.report.mismatches} anchor(s) would NOT name the same message.`);
      console.error(`Run --verify-backup ${BACKUP} to see which, and do not apply this.`);
    }
    await db.end();
    process.exit(5);
  }

  affected = loaded.affected;

  /* Before the first BEGIN: can this role actually do it? */
  const needed = tablesToWrite(affected);
  const access = await accessReport(needed);
  const verdict = accessVerdict(access.rows, needed);
  if (!verdict.ok) {
    const owner = access.rows.find((r) => r.can_update === false)?.owner
      || access.rows[0]?.owner || "<owner>";
    console.error("");
    console.error(`Connected as ${access.who.who}, which cannot perform this repair:`);
    for (const p2 of verdict.problems) console.error(`    ${p2.table}: missing ${p2.missing}`);
    console.error("");
    console.error("Nothing has been written and no transaction was opened.");
    console.error("");
    console.error("This is a missing GRANT, not row-level security — RLS returns no rows");
    console.error("rather than an error. The application role has SELECT here and not");
    console.error("UPDATE, which is right for an app that never edits a submitted");
    console.error("transcript. Run it once as the role that owns the tables:");
    console.error("");
    console.error(`    DB_OWNER=${owner} \\`);
    console.error("    DB_OWNER_PASSWORD=\"$(gcloud secrets versions access latest --secret=vyne-db-owner-password)\" \\");
    console.error("    ...and the rest of your command, unchanged");
    console.error("");
    console.error("That grants nothing and widens nothing. --check-access prints the full");
    console.error("picture without touching a row.");
    await db.end();
    process.exit(6);
  }

  line("");
  line(`applying ${BACKUP}`);
  line(`  taken at: ${loaded.takenAt || "(not recorded)"}`);
  line(`  records:  ${affected.length}`);
  line(`  anchors:  ${pre.report.checked} checked, all naming the same message after the repair`);
  line(`  writing:  ${needed.join(", ")} as ${access.who.who}`);
  line("  Nothing is re-scanned: this is the file that was verified.");
} else {

let tenants;
try {
  tenants = (await db.query(`SELECT id, name FROM tenants ORDER BY name`)).rows;
} catch (e) {
  console.error("\nCould not read the tenants table, so there is no way to scan anything.");
  console.error(String(e && e.message));
  console.error("\nThis user may lack SELECT on tenants. Nothing was examined; this is NOT an all-clear.");
  await db.end();
  process.exit(2);
}

for (const t of tenants) {
  /* The application's own pattern: set the tenant for the transaction, so the
   * RLS policy admits that tenant's rows and only those. */
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.tenant_id', $1, true)", [t.id]);

  const ms = await db.query(
    `SELECT tenant_id, module, key, value FROM module_state
      WHERE key LIKE 'vynora_session_%' OR key LIKE 'vynora_interview_archive_%'`);

  for (const row of ms.rows) {
    const owner = row.tenant_id;
    const rowId = `module_state:${owner}|${row.module}|${row.key}`;
    if (seen.has(rowId)) continue;
    seen.add(rowId);
    sessionRows++;
    if (String(owner) !== String(t.id)) crossTenant++;

    const v = row.value;
    if (!v || typeof v !== "object") continue;
    /* A session blob, or an archive which is an array of interview records. */
    const records = Array.isArray(v) ? v : [v];
    records.forEach((rec, ri) => {
      const dm = rec && Array.isArray(rec.displayMessages) ? rec.displayMessages : null;
      if (!dm || dm.length < MIN_BLOCK * 2) return;
      scanned++;
      if (ONLY_CLIENT && String(rec.client || "") !== ONLY_CLIENT) return;
      const d = repair(dm);
      if (!d.removed.length) return;
      const risk = anchorsThatMove(rec, indexMap(dm, d.removed));
      affected.push({
        where: "module_state", tenantId: owner, tenantName: t.name,
        module: row.module, key: row.key,
        arrayIndex: Array.isArray(v) ? ri : null,
        client: rec.client ?? null, stakeholder: rec.stakeholderName ?? rec.stakeholderRole ?? null,
        sessionCode: rec.sessionCode ?? null,
        before: dm.length, after: d.items.length, passes: d.passes, collapsed: d.collapsed,
        anchorsAtRisk: risk.length, sample: dm.slice(0, 2).map((m) => String(m.text || "").slice(0, 70)),
        _original: dm, _fixed: d.items, _removed: d.removed,
        /* v5.34.126 — the evidence --remap-anchors rewrites, backed up with the
         * transcript. Without it the backup covers the words and not the thing
         * most at risk of being put in the wrong place. */
        _evidence: { scoreEvents: rec.scoreEvents ?? null, findingEvents: rec.findingEvents ?? null },
      });
    });
  }

  const tr = await db.query(
    `SELECT id, tenant_id, interview_id, client_name, interviewee_name, round_number,
            turns, turn_count, score_events, findings
       FROM interview_transcripts`);

  for (const row of tr.rows) {
    const rowId = `interview_transcripts:${row.id}`;
    if (seen.has(rowId)) continue;
    seen.add(rowId);
    transcriptRows++;
    if (String(row.tenant_id) !== String(t.id)) crossTenant++;

    const turns = Array.isArray(row.turns) ? row.turns : [];
    if (turns.length < MIN_BLOCK * 2) continue;
    scanned++;
    if (ONLY_CLIENT && String(row.client_name || "") !== ONLY_CLIENT) continue;
    const d = repair(turns);
    if (!d.removed.length) continue;
    const risk = anchorsThatMove({ scoreEvents: row.score_events, findingEvents: row.findings },
                                 indexMap(turns, d.removed));
    affected.push({
      where: "interview_transcripts", id: row.id, tenantId: row.tenant_id, tenantName: t.name,
      interview_id: row.interview_id, client: row.client_name,
      stakeholder: row.interviewee_name, round: row.round_number,
      before: turns.length, after: d.items.length, passes: d.passes, collapsed: d.collapsed,
      anchorsAtRisk: risk.length, sample: turns.slice(0, 2).map((t2) => String(t2.text || "").slice(0, 70)),
      _original: turns, _fixed: d.items, _removed: d.removed,
      _evidence: { scoreEvents: row.score_events ?? null, findingEvents: row.findings ?? null },
    });
  }

  await db.query("COMMIT");
}

/* ── report ────────────────────────────────────────────────────────────────── */

line("");
line("── v5.34.121 transcript de-duplication ─────────────────────────────────");
line(`tenants:   ${tenants.length}`);
line(`visible:   ${sessionRows} saved session/archive row(s), ${transcriptRows} submitted transcript(s)`);
line(`examined:  ${scanned} record(s) long enough to contain a doubling${ONLY_CLIENT ? ` (client filter: ${ONLY_CLIENT})` : ""}`);
line(`affected:  ${affected.length}`);

if (crossTenant) {
  line("");
  line(`!! ${crossTenant} row(s) were visible inside a tenant's context that does not own them.`);
  line("   Row-level security is not filtering for this role — a superuser, or a role");
  line("   with BYPASSRLS, ignores the policy even where it is FORCEd. Each row was");
  line("   still examined exactly once and is tagged with the tenant that owns it, so");
  line("   the numbers above are right; but this connection has more reach than the");
  line("   application does, which is worth knowing before it writes anything.");
}

/*
 * v5.34.125 — an empty result is only good news if something was actually
 * looked at. Seeing nothing and seeing nothing wrong are different facts, and
 * the previous version printed the second when it meant the first.
 */
if (sessionRows === 0 && transcriptRows === 0) {
  line("");
  line("!! NOT AN ALL-CLEAR. No rows were visible in either table across any tenant,");
  line("   which is not what a working database looks like. The likeliest cause is");
  line("   row-level security: both tables FORCE an RLS policy keyed on app.tenant_id,");
  line("   so a connection that cannot satisfy it sees an empty database rather than");
  line("   an error.");
  line("");
  line(`   Connected as: ${redactDsn(resolved.dsn)}`);
  line(`   Tenants found: ${tenants.length}`);
  line("   Nothing has been examined and nothing has been changed.");
  await db.end();
  process.exit(3);
}
if (!affected.length) {
  line("");
  line(`Nothing is doubled, across ${scanned} record(s) that were actually examined.`);
  line("No resumed interview reached the database before the fix, or they have been");
  line("repaired already.");
  await db.end();
  process.exit(0);
}

const risky = affected.filter((a) => a.anchorsAtRisk > 0);
for (const a of affected) {
  line("");
  line(`  ${a.where}  ${a.client || "(no client)"} · ${a.stakeholder || "(no name)"}${a.sessionCode ? " · " + a.sessionCode : ""}`);
  const what = [];
  if (a.passes) what.push(`${a.passes} doubling${a.passes === 1 ? "" : "s"} removed`);
  if (a.collapsed) what.push(`${a.collapsed} fragment cop${a.collapsed === 1 ? "y" : "ies"} merged into the line${a.collapsed === 1 ? "" : "s"} they began`);
  line(`    ${a.before} messages → ${a.after}   (${what.join(", ")})`);
  line(`    first line: "${a.sample[0] || ""}…"`);
  if (a.anchorsAtRisk) {
    line(`    !! ${a.anchorsAtRisk} finding/score anchor(s) would move with the repair.`);
    line(`       Removing entries shifts the evidence unless the anchors move with it.`);
  }
}
line("");
line(`records whose evidence anchors would move: ${risky.length}`);
line("");

writeFileSync(BACKUP, JSON.stringify({ takenAt: new Date().toISOString(), affected }, null, 2));
line(`backup written: ${BACKUP}`);
line("  Every affected row, as it stands right now, before anything is changed.");

if (!APPLY) {
  line("");
  line("This was a READ-ONLY audit. Nothing has been written.");
  if (risky.length) {
    /* v5.34.126 — verification is step one, not an option. The anchors are the
     * part of this repair that can be wrong without looking wrong. */
    line("");
    line("FIRST, check the remap against this data — no database, nothing written:");
    line(`    node ../deploy/dedupe-transcripts.mjs --verify-backup ${BACKUP}`);
    line("");
    line("Every anchor must read SAME. Then, and only then:");
  } else {
    line("To apply, re-run with:");
  }
  line(`    node ../deploy/dedupe-transcripts.mjs --apply --backup ${BACKUP}` +
       (risky.length ? " --remap-anchors" : ""));
  if (risky.length) {
    line("");
    line(`--remap-anchors is required because ${risky.length} record(s) have evidence`);
    line("anchored past the duplicate. Without it those records are SKIPPED, and the");
    line("rest are repaired.");
  }
  await db.end();
  process.exit(0);
}
}

/* ── apply ─────────────────────────────────────────────────────────────────── */

let done = 0, skipped = 0, stale = 0;

/*
 * ── v5.34.126: do not write over a record that moved since the audit ─────────
 *
 * The audit and the apply are two separate runs, and the design deliberately
 * puts a human reading the output in between — minutes at best, in practice a
 * day. In that window the very thing being repaired can save again: this defect
 * IS about resumes, and a live interview writes to these rows.
 *
 * `a._fixed` was computed from the transcript as it stood at audit time.
 * Writing it unconditionally replaces whatever arrived since with an older
 * conversation, and nothing in the output would say so. The rowCount check
 * added in v5.34.125 does not catch it: the UPDATE matches its one row and
 * succeeds.
 *
 * Re-running the audit costs a minute. A lost turn is recoverable from nothing
 * but this backup.
 */
const refuse = (reason, what) => {
  stale++;
  if (reason === "gone") {
    line(`skipped (no longer in the database): ${what}`);
  } else {
    line(`skipped (CHANGED since the audit): ${what}`);
    line("   This is no longer the record that was audited. Re-run the audit.");
  }
};

/*
 * ── v5.34.125: the writes need the tenant context too ───────────────────────
 *
 * The RLS policy that made the scan blind applies to UPDATE as well, through
 * its USING clause: without app.tenant_id set, every UPDATE matches zero rows
 * and reports success. The repair would have committed cleanly and changed
 * nothing — the same silence as the audit, on the write side.
 *
 * So the work is grouped by tenant, each tenant's repairs in their own
 * transaction with their own app.tenant_id. A failure rolls back that tenant
 * and stops; tenants already committed stay repaired, and the backup covers
 * every one of them.
 *
 * Verified rather than assumed: each UPDATE checks rowCount, and a write that
 * touched no row is counted as a failure rather than a success. That check is
 * what would have caught this class in the first place.
 */
const byTenant = new Map();
for (const a of affected) {
  if (!byTenant.has(a.tenantId)) byTenant.set(a.tenantId, []);
  byTenant.get(a.tenantId).push(a);
}

for (const [tenantId, items] of byTenant) {
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  try {
  for (const a of items) {
    if (a.anchorsAtRisk && !REMAP) {
      line(`skipped (anchors would move): ${a.client} · ${a.stakeholder}`);
      skipped++;
      continue;
    }
    const map = indexMap(a._original, a._removed);
    const ev = a._evidence || {};

    if (a.where === "interview_transcripts") {
      /*
       * ── v5.34.126: do not write over a row that moved since the audit ──────
       *
       * The audit and the apply are two separate runs, separated by however
       * long the operator spends reading the output — minutes at best, and in
       * practice a day, because the audit is meant to be read before anything
       * is written. In between, the very thing being repaired can save again:
       * an interview resumes, submits, and the row changes underneath.
       *
       * `a._fixed` was computed from the transcript as it stood at audit time.
       * Writing it unconditionally replaces whatever arrived since with an
       * older conversation, and nothing in the output would say so. The
       * rowCount check added in v5.34.125 would not catch it — the UPDATE
       * matches one row and succeeds.
       *
       * So: re-read, confirm the transcript is still the one that was audited,
       * and skip loudly if it is not. Re-running the audit is cheap; a lost
       * turn is not recoverable from anything but this backup.
       */
      const cur = await db.query(`SELECT turns FROM interview_transcripts WHERE id = $1`, [a.id]);
      const d = applyDecision(a, cur.rows.length ? cur.rows[0].turns : null);
      if (!d.write) { refuse(d.reason, `${a.client} · ${a.stakeholder}`); continue; }

      const w1 = await db.query(
        `UPDATE interview_transcripts SET turns = $1::jsonb, turn_count = $2 WHERE id = $3`,
        [JSON.stringify(fixedForWrite(a)), a._fixed.length, a.id]);
      if (w1.rowCount !== 1) throw new Error(`transcript ${a.id}: UPDATE matched ${w1.rowCount} rows, not 1`);
      if (REMAP) {
        /* From the BACKED-UP evidence, not a fresh SELECT: what is written is
         * then derived from what is on disk in the backup, so `--verify-backup`
         * and the apply can never be describing different starting points. */
        const w3 = await db.query(
          `UPDATE interview_transcripts SET score_events = $1::jsonb, findings = $2::jsonb WHERE id = $3`,
          [ev.scoreEvents ? JSON.stringify(remapEvidence(ev.scoreEvents, map)) : null,
           ev.findingEvents ? JSON.stringify(remapEvidence(ev.findingEvents, map)) : null, a.id]);
        if (w3.rowCount !== 1) throw new Error(`transcript ${a.id}: evidence UPDATE matched ${w3.rowCount} rows, not 1`);
      }
    } else {
      const cur = await db.query(
        `SELECT value FROM module_state WHERE module = $1 AND key = $2`, [a.module, a.key]);
      const v = cur.rows.length ? cur.rows[0].value : null;
      const rec = v == null ? null : (a.arrayIndex == null ? v : v[a.arrayIndex]);
      const d = applyDecision(a, rec);
      if (!d.write) { refuse(d.reason, a.key); continue; }
      rec.displayMessages = fixedForWrite(a);
      if (REMAP) {
        for (const nm of ["scoreEvents", "findingEvents"]) {
          if (Array.isArray(ev[nm])) rec[nm] = remapEvidence(ev[nm], map);
        }
      }
      const w2 = await db.query(
        `UPDATE module_state SET value = $1::jsonb, updated_at = now() WHERE module = $2 AND key = $3`,
        [JSON.stringify(v), a.module, a.key]);
      if (w2.rowCount !== 1) throw new Error(`${a.key}: UPDATE matched ${w2.rowCount} rows, not 1`);
    }
    done++;
  }
  await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    console.error(`\nFAILED on tenant ${tenantId} — that tenant rolled back, nothing of theirs changed:`, e.message);
    console.error(`Repairs already committed for other tenants stand; ${BACKUP} covers them all.`);
    await db.end();
    process.exit(1);
  }
}

line("");
line(`repaired: ${done}   skipped: ${skipped}   changed since the audit: ${stale}`);
line(`backup:   ${BACKUP}`);
if (stale) {
  line("");
  line(`${stale} record(s) were left alone because they are not the records that were`);
  line("audited. Re-run the audit to see them as they stand now.");
}
await db.end();
