/**
 * Put one client's BYOK key into `failed`, and put it back. (v5.34.71 ops)
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * v5.34.70 fixed a defect that only shows itself on the SECOND call after a
 * vendor refuses a client's key: activeKeyFor() filtered `status = 'active'`,
 * so a refused key read as "no key at all", confinement did not engage, and the
 * firm's credential quietly paid for that client from then on.
 *
 * Reproducing it needs a key in `failed` status. Nothing in the product can put
 * one there deliberately — the UI offers `disabled` (the Owner's own decision,
 * which correctly means the firm pays) and `failed` is written only by
 * server.ts's onByokRejected when a vendor actually refuses a credential.
 * Waiting for a real refusal means revoking a working key, which is worse.
 *
 * So this sets the status directly, and sets it back. It is a TEST INSTRUMENT,
 * not a repair tool — `--restore` is half of the procedure, not an afterthought.
 *
 * ── Guards ──────────────────────────────────────────────────────────────────
 *
 *   · only `failed` ⇄ `active`. It cannot reach `disabled` or `pending`, so it
 *     can never contradict a decision the Owner made on the keys screen.
 *   · the client must already have exactly one key on file for the provider —
 *     it creates nothing and it touches no other row.
 *   · one tenant, filtered explicitly, and app.tenant_id is set: all eight BYOK
 *     tables are FORCE RLS, which binds the owner role too, so without the GUC
 *     every query returns zero rows and reports a tidy false "not found".
 *   · prints before and after, and refuses if the row is not where it expects.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 * From backend/, which is where `pg` is installed:
 *
 *   cd backend
 *   export DATABASE_URL="postgres://vyne:PASSWORD@localhost:5433/vyne"
 *   node ../deploy/byok-set-status.mjs --client "ZZ BYOK Test" --fail
 *   ... exercise the app, observe the 402 ...
 *   node ../deploy/byok-set-status.mjs --client "ZZ BYOK Test" --restore
 *
 * Port 5433 is the cloud-sql-proxy. Not 5432 — that is the local Postgres,
 * where this reports a tidy success and changes nothing in production.
 *
 * Without --fail or --restore it only REPORTS, and writes nothing.
 */
import { createRequire } from "node:module";

const requireFromCwd = createRequire(`${process.cwd()}/`);
let pg;
try {
  pg = requireFromCwd("pg");
} catch {
  console.error("Cannot find the 'pg' driver from here.");
  console.error("  cd backend && DATABASE_URL=... node ../deploy/byok-set-status.mjs ...");
  process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };
const CLIENT = flag("client");
const PROVIDER = flag("provider") ?? "gemini-aistudio";
let TENANT = flag("tenant");
const FAIL = argv.includes("--fail");
const RESTORE = argv.includes("--restore");

if (!CLIENT || (FAIL && RESTORE)) {
  console.error('Usage: node ../deploy/byok-set-status.mjs --client "Name" [--provider P] [--tenant UUID] [--fail | --restore]');
  console.error("  --fail     mark the key refused, as a vendor rejection would");
  console.error("  --restore  put it back to active and clear the recorded error");
  console.error("  neither    report only");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set."); process.exit(1); }

/** Mirror of normClient() in backend/src/auth/clients.ts. */
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 100);
const NORM = norm(CLIENT);

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const who = (await c.query(
    `SELECT current_database() AS db, current_user AS usr,
            (SELECT count(*) > 0 FROM pg_roles WHERE rolname='cloudsqlsuperuser') AS is_cloudsql`)).rows[0];
  const dest = (() => { try { const u = new URL(url); return `${u.hostname}:${u.port || 5432}${u.pathname}`; }
                        catch { return "unparseable DATABASE_URL"; } })();
  console.log(`connected : ${dest} as ${who.usr}`);
  console.log(`server    : ${who.is_cloudsql ? "Cloud SQL" : "NOT Cloud SQL — this looks like a local Postgres"}`);
  console.log(`client    : "${CLIENT}" → norm ${NORM}, provider ${PROVIDER}`);
  console.log(`mode      : ${FAIL ? "--fail (writes)" : RESTORE ? "--restore (writes)" : "report only"}`);

  if (!TENANT) {
    const t = await c.query(`SELECT id, name FROM tenants ORDER BY created_at`);
    if (t.rowCount === 1) { TENANT = t.rows[0].id; }
    else {
      /*
       * Ask the DATA which tenant, rather than listing them and leaving the
       * operator to guess. merge-client-usage.mjs learned this the same way on
       * 2026-09-13 and this script shipped without it hours later, so the first
       * two runs of the procedure it exists for both died here.
       *
       * The GUC is set per candidate because all eight BYOK tables are FORCE
       * RLS, which binds the owner role too: without it every probe returns
       * zero and reports a confident "no key anywhere".
       */
      console.log(`\n${t.rowCount} tenants. Looking for "${CLIENT}" / ${PROVIDER} in each:\n`);
      const hits = [];
      for (const r of t.rows) {
        await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [r.id]);
        const n = (await c.query(
          `SELECT count(*)::int AS n FROM byok_keys
            WHERE tenant_id = $1 AND client_norm = $2 AND provider = $3`,
          [r.id, NORM, PROVIDER])).rows[0].n;
        console.log(`  ${r.id}  ${r.name} — ${n} key(s)`);
        if (n > 0) hits.push(r);
      }
      console.log("");
      if (hits.length === 1) {
        TENANT = hits[0].id;
        console.log(`Using ${hits[0].name}.\n`);
      } else if (hits.length === 0) {
        console.error(`No tenant has a ${PROVIDER} key for "${CLIENT}".`);
        process.exit(1);
      } else {
        console.error(`${hits.length} tenants hold that client. Pick deliberately with --tenant.`);
        process.exit(1);
      }
    }
  }
  // FORCE RLS binds the table owner. Without this every read below is empty.
  await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
  console.log(`tenant    : ${TENANT}\n`);

  const read = async () => (await c.query(
    `SELECT client_name, status, key_hint, last_error
       FROM byok_keys
      WHERE tenant_id = $1 AND client_norm = $2 AND provider = $3`,
    [TENANT, NORM, PROVIDER])).rows;

  const before = await read();
  if (before.length !== 1) {
    console.error(before.length === 0
      ? `No key on file for "${CLIENT}" / ${PROVIDER} on this tenant.`
      : `${before.length} rows matched — refusing to touch an ambiguous set.`);
    process.exit(1);
  }
  const row = before[0];
  console.log(`before    : ${row.client_name} — ${row.status}, ••••${row.key_hint}` +
              `${row.last_error ? `, last_error="${row.last_error}"` : ""}`);

  if (!FAIL && !RESTORE) { console.log("\nReport only — nothing written."); process.exit(0); }

  const want = FAIL ? "failed" : "active";
  const from = FAIL ? "active" : "failed";
  if (row.status === want) { console.log(`\nAlready ${want} — nothing to do.`); process.exit(0); }
  if (row.status !== from) {
    console.error(`\nREFUSED: the key is '${row.status}', and this only moves '${from}' → '${want}'.`);
    console.error(`'disabled' and 'pending' are the Owner's own states — change those on the keys screen.`);
    process.exit(1);
  }

  await c.query(
    FAIL
      // Same literal server.ts writes on a real rejection, so the 402 the app
      // produces is the one a genuine refusal would produce.
      ? `UPDATE byok_keys SET status='failed', last_error='refused by the provider during a call',
                              last_error_at=now(), updated_at=now()
          WHERE tenant_id=$1 AND client_norm=$2 AND provider=$3 AND status='active'`
      : `UPDATE byok_keys SET status='active', last_error=NULL, last_error_at=NULL, updated_at=now()
          WHERE tenant_id=$1 AND client_norm=$2 AND provider=$3 AND status='failed'`,
    [TENANT, NORM, PROVIDER]);

  const after = (await read())[0];
  console.log(`after     : ${after.client_name} — ${after.status}` +
              `${after.last_error ? `, last_error="${after.last_error}"` : ""}`);
  console.log(FAIL
    ? `\nThe keys screen will now show this key red. Run a generation for this client:\n` +
      `expect a 402 naming them, NOT a silent success on your credential.\n` +
      `Put it back with:  --client "${CLIENT}" --restore`
    : `\nBack to normal.`);
} finally {
  await c.end();
}
