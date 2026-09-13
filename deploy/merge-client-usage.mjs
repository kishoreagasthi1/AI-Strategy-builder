/**
 * Reattribute one client's billing ledger onto another client. (v5.34.69 ops)
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A client can sit on the Cost by Client statement and be absent from every
 * product surface at once, because the two are read from different places and
 * only one is ever cleaned up:
 *
 *   - the pickers (including the owner's "delete a client" dropdown) come from
 *     GET /api/my-clients, which is
 *         interviews UNION client_assignments UNION engagements;
 *   - the statement comes from usage_events, which NO product code path ever
 *     deletes from. DELETE /api/clients deliberately does not touch it: the
 *     ledger is the record behind money that was actually spent.
 *
 * So a name that was the active client while calls were metered, and was later
 * deleted or never became an engagement at all, leaves a permanent row on the
 * statement with nothing in the UI that can reach it. Observed in production:
 * "Nissan Motoros Corporation" (a typo of the real client) and
 * "Meridian Foods Test".
 *
 * PATCH /api/clients/rename would have moved the ledger — it runs
 *     UPDATE usage_events SET client_norm = $1 WHERE client_norm = ANY($2)
 * (routes/assignments.ts) — but it REFUSES when the target name already
 * exists, so it can fix a misspelling and cannot merge two clients. There is
 * no merge path in the product. This is that path, run by hand, until there
 * is one.
 *
 * ── Why UPDATE and never DELETE ─────────────────────────────────────────────
 *
 * usage_events is the cost-recovery ledger — the numbers behind an invoice a
 * client has been sent or will be. Deleting the rows makes the money vanish
 * from the statement while it stays on the provider bill, so the firm's own
 * totals stop reconciling and nothing on file says why. Moving them keeps
 * every dollar, attributed to whoever actually incurred it. There is
 * deliberately no delete mode.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 * Run it from backend/, which is where `pg` is installed — same as
 * check-schema.mjs, and for the same reason. psql is NOT required and is not
 * installed on the deploy Mac.
 *
 *   cd backend
 *   DATABASE_URL=postgres://vyne:PASSWORD@localhost:5433/vyne \
 *     node ../deploy/merge-client-usage.mjs --src "Nissan Motoros Corporation" \
 *                                           --dst "Nissan Motors Corporation"
 *
 * That REPORTS and writes nothing. Add --apply to perform the move.
 *
 * Port 5433 is the cloud-sql-proxy. Do NOT use 5432 — that is the local
 * Postgres, where this would report a tidy success and change nothing in
 * production.
 *
 * Names are passed as they are SPELLED; the script normalises them with the
 * same rule normClient() uses (lowercase, every non-alphanumeric character
 * REMOVED — not folded, so "Nestlé USA" becomes "nestlusa" — truncated to
 * 100). Nobody has to type a norm.
 *
 * The tenant is resolved from the database: with one tenant it is used
 * automatically, with several you are shown the list and asked for --tenant.
 *
 * Every statement filters tenant_id EXPLICITLY rather than leaning on RLS.
 * Connected as the owner or a superuser the policy does not apply at all, and
 * an unfiltered version of this would sweep every firm on the instance.
 */
import { createRequire } from "node:module";

const requireFromCwd = createRequire(`${process.cwd()}/`);
let pg;
try {
  pg = requireFromCwd("pg");
} catch {
  console.error("Cannot find the 'pg' driver from here.");
  console.error("Run this from the backend directory:");
  console.error("  cd backend && DATABASE_URL=... node ../deploy/merge-client-usage.mjs ...");
  process.exit(1);
}

// ── Arguments ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const APPLY = argv.includes("--apply");
const SRC_NAME = flag("src");
const DST_NAME = flag("dst");
let TENANT = flag("tenant");

if (!SRC_NAME || !DST_NAME) {
  console.error("Usage:");
  console.error('  node ../deploy/merge-client-usage.mjs --src "Typo Name" --dst "Real Name" [--tenant UUID] [--apply]');
  console.error("");
  console.error("  --src     the ghost client whose ledger rows move (spelled as it appears)");
  console.error("  --dst     the real client they move onto");
  console.error("  --apply   actually write; without it this reports and changes nothing");
  process.exit(1);
}

/** Mirror of normClient() in backend/src/auth/clients.ts. Keep them identical. */
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 100);
const SRC = norm(SRC_NAME);
const DST = norm(DST_NAME);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  console.error("  DATABASE_URL=postgres://vyne:PASSWORD@localhost:5433/vyne node ../deploy/merge-client-usage.mjs ...");
  process.exit(1);
}

const usd = (n) => `$${Number(n ?? 0).toFixed(4)}`;
const die = (msg) => { console.error(`\nREFUSED: ${msg}`); process.exitCode = 1; };

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  // ── Where are we, really? The whole point of check-schema.mjs. ────────────
  /*
   * inet_server_addr() is NULL whenever the backend sees a Unix-socket
   * connection, which is what Cloud SQL reports behind the proxy — so the
   * first version of this line printed "(local:null)" and told the operator
   * nothing, at the exact moment it was supposed to be the check that you are
   * not pointed at your laptop. Print the CLIENT side of the connection (from
   * DATABASE_URL, which is the thing that is actually easy to get wrong) and
   * ask the server a question only Cloud SQL answers yes to.
   */
  const dest = (() => {
    try {
      const u = new URL(url);                 // never log u.password
      return `${u.hostname}:${u.port || 5432}${u.pathname}`;
    } catch { return "unparseable DATABASE_URL"; }
  })();
  const who = (await client.query(
    `SELECT current_database() AS db, current_user AS usr,
            (SELECT count(*) > 0 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser')
              AS is_cloudsql,
            (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
              AS bypasses_rls`)).rows[0];
  console.log(`connected  : ${dest}  as ${who.usr}`);
  console.log(`server     : ${who.is_cloudsql ? "Cloud SQL" : "NOT Cloud SQL — this looks like a local Postgres"}`);
  console.log(`database   : ${who.db}`);
  console.log(`rls        : ${who.bypasses_rls ? "bypassed by this role" : "enforced — app.tenant_id will be set below"}`);
  console.log(`mode       : ${APPLY ? "APPLY — this will write" : "dry run — nothing will be written"}`);
  console.log(`source     : "${SRC_NAME}"  → norm ${SRC}`);
  console.log(`destination: "${DST_NAME}"  → norm ${DST}`);
  console.log("");

  // ── Tenant ────────────────────────────────────────────────────────────────
  if (!TENANT) {
    const t = await client.query(`SELECT id, name FROM tenants ORDER BY created_at`);
    if (t.rowCount === 1) {
      TENANT = t.rows[0].id;
      console.log(`tenant     : ${TENANT}  (${t.rows[0].name}) — the only one`);
    } else {
      /*
       * "Pass --tenant with one of these" was a dead end: it named the tenants
       * and left the operator to guess which firm a ghost client belongs to,
       * and guessing wrong is how you run a merge against the wrong firm. Ask
       * the ledger instead — set the GUC per tenant, because FORCE RLS makes
       * an unset one return zero everywhere and look like a clean "not here".
       */
      console.log(`This instance has ${t.rowCount} tenants. Looking for "${SRC_NAME}" in each:\n`);
      const hits = [];
      for (const r of t.rows) {
        await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [r.id]);
        const c = (await client.query(
          `SELECT count(*)::int AS calls, coalesce(sum(cost_est_usd),0)::numeric AS usd
             FROM usage_events WHERE tenant_id = $1 AND client_norm = $2`, [r.id, SRC])).rows[0];
        console.log(`  ${r.id}  ${r.name} — ${c.calls} ledger row(s)${c.calls ? `, ${usd(c.usd)}` : ""}`);
        if (c.calls > 0) hits.push(r);
      }
      console.log("");
      if (hits.length === 1) {
        console.error(`Re-run with:  --tenant ${hits[0].id}    (${hits[0].name})`);
      } else if (hits.length === 0) {
        console.error(`No tenant has ledger rows for "${SRC_NAME}". Check the spelling against the`);
        console.error(`Cost by Client statement — the norm this resolves to is "${SRC}".`);
      } else {
        console.error(`${hits.length} tenants carry that name. Pick deliberately with --tenant.`);
      }
      process.exit(1);
    }
  } else {
    const t = await client.query(`SELECT name FROM tenants WHERE id = $1`, [TENANT]);
    if (!t.rowCount) { die(`no tenant ${TENANT} on this database`); process.exit(1); }
    console.log(`tenant     : ${TENANT}  (${t.rows[0].name})`);
  }

  /*
   * THE TRAP THIS PROJECT HAS FALLEN INTO FOUR TIMES.
   *
   * Every table below — usage_events, engagements, interviews,
   * client_assignments, module_state and the three BYOK tables — is FORCE ROW
   * LEVEL SECURITY. "FORCE" is the part that matters: it binds the TABLE OWNER
   * too, which ordinary RLS does not (migrations 011, 025, 026 and 027 each had
   * to work around exactly this; 027's comment says it outright).
   *
   * So connected to production as `vyne` — the owner, and NOT a superuser on
   * Cloud SQL — every policy evaluates
   *     tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
   * with the setting unset, which is NULL, which is never true. Every query
   * returns zero rows. The script would then report "has no ledger rows on this
   * tenant" and exit 1: a clean, confident, completely false answer, and the
   * same silent-success failure class the whole runbook exists to prevent.
   *
   * Setting the GUC satisfies the policies. It is deliberately NOT `ALTER TABLE
   * ... NO FORCE` — those migrations had to toggle it for DDL and each one is a
   * window where a bug writes across tenants. The explicit `tenant_id = $1` on
   * every query below stays regardless, so a role that DOES bypass RLS (a local
   * superuser, which is why this went unnoticed in testing) is still confined
   * to one firm.
   */
  await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
  console.log("");

  const ledger = async (n) => (await client.query(
    `SELECT client_name, count(*)::int AS calls, sum(cost_est_usd)::numeric AS usd,
            min(created_at)::date::text AS first_seen, max(created_at)::date::text AS last_seen
       FROM usage_events
      WHERE tenant_id = $1 AND client_norm = $2
      GROUP BY client_name ORDER BY client_name`, [TENANT, n])).rows;

  /** Every product surface a client can appear on — i.e. what /api/my-clients reads. */
  const surfaces = async (n) => (await client.query(
    `SELECT 'engagement' AS surface, client_name FROM engagements
      WHERE tenant_id = $1 AND client_name IS NOT NULL
        AND left(lower(regexp_replace(client_name,'[^A-Za-z0-9]','','g')),100) = $2
     UNION ALL
     SELECT 'interview', client_name FROM interviews
      WHERE tenant_id = $1
        AND left(lower(regexp_replace(client_name,'[^A-Za-z0-9]','','g')),100) = $2
     UNION ALL
     SELECT 'assignment', client_name FROM client_assignments
      WHERE tenant_id = $1 AND client_norm = $2`, [TENANT, n])).rows;

  const byok = async (n) => (await client.query(
    `SELECT 'byok_key' AS kind FROM byok_keys
      WHERE tenant_id = $1 AND client_norm = $2
     UNION ALL SELECT 'client_routing' FROM client_routing
      WHERE tenant_id = $1 AND client_norm = $2
     UNION ALL SELECT 'byok_fallback_grant' FROM byok_fallback_grant
      WHERE tenant_id = $1 AND client_norm = $2`, [TENANT, n])).rows;

  const srcLedger = await ledger(SRC);
  const dstLedger = await ledger(DST);
  const srcSurfaces = await surfaces(SRC);
  const dstSurfaces = await surfaces(DST);
  const srcByok = await byok(SRC);

  console.log("SOURCE ledger — the rows that would move");
  if (!srcLedger.length) console.log("  (none)");
  for (const r of srcLedger)
    console.log(`  ${r.client_name} — ${r.calls} call(s), ${usd(r.usd)}, ${r.first_seen} … ${r.last_seen}`);

  console.log("\nDESTINATION ledger — before");
  if (!dstLedger.length) console.log("  (none)");
  for (const r of dstLedger) console.log(`  ${r.client_name} — ${r.calls} call(s), ${usd(r.usd)}`);

  console.log("\nSOURCE product surfaces (expect NONE — that is what makes it a ghost)");
  if (!srcSurfaces.length) console.log("  (none)");
  for (const r of srcSurfaces) console.log(`  ${r.surface}: ${r.client_name}`);

  console.log("\nDESTINATION product surfaces (expect at least one)");
  if (!dstSurfaces.length) console.log("  (none)");
  for (const r of dstSurfaces) console.log(`  ${r.surface}: ${r.client_name}`);

  console.log("\nSOURCE BYOK rows (expect NONE)");
  if (!srcByok.length) console.log("  (none)");
  for (const r of srcByok) console.log(`  ${r.kind}`);

  /*
   * Workspace residue. Reported, never moved — a norm-keyed key here means a
   * briefing or solution design was started under the ghost name and is still
   * on disk, unreachable. Moving it correctly means rewriting embedded client
   * fields and three shared indexes (see purgeClientKeys/planClientRename),
   * which is the product-level merge this script is standing in for.
   */
  const residue = await client.query(
    `SELECT key, length(value::text) AS bytes, updated_at::date::text AS updated
       FROM module_state
      WHERE tenant_id = $1 AND module = 'workspace' AND key LIKE '%' || $2
      ORDER BY key`, [TENANT, SRC]);
  console.log("\nWorkspace keys carrying the source norm (reported, NOT moved)");
  if (!residue.rowCount) console.log("  (none)");
  for (const r of residue.rows) console.log(`  ${r.key} — ${r.bytes} bytes, updated ${r.updated}`);

  // ── Preconditions ─────────────────────────────────────────────────────────
  console.log("");
  if (SRC === DST) {
    die(`source and destination normalise to the same name (${SRC}) — nothing to merge`);
  } else if (!srcLedger.length) {
    die(`"${SRC_NAME}" has no ledger rows on this tenant. Nothing to move — check the ` +
        `spelling against the Cost by Client statement, and check you are on port 5433.`);
  } else if (srcSurfaces.length) {
    die(`"${SRC_NAME}" still has ${srcSurfaces.length} product row(s) — it is a live client, ` +
        `not a ledger ghost. Use the rename or delete endpoints, which keep the rest of its ` +
        `data consistent.`);
  } else if (srcByok.length) {
    die(`"${SRC_NAME}" has ${srcByok.length} BYOK row(s). That is an attestation that a named ` +
        `client paid for their own inference; moving the ledger out from under it would leave ` +
        `the key answering for calls attributed elsewhere. Settle it on the Client API keys ` +
        `screen first.`);
  } else if (!dstSurfaces.length) {
    die(`"${DST_NAME}" has no engagement, interview or assignment — it is not a real client ` +
        `in this workspace. Merging a ghost into a ghost relabels the problem and loses the ` +
        `evidence of which name was the typo.`);
  }
  if (process.exitCode === 1) process.exit(1);

  const movingCalls = srcLedger.reduce((a, r) => a + r.calls, 0);
  const movingUsd = srcLedger.reduce((a, r) => a + Number(r.usd), 0);
  const afterCalls = movingCalls + dstLedger.reduce((a, r) => a + r.calls, 0);
  const afterUsd = movingUsd + dstLedger.reduce((a, r) => a + Number(r.usd), 0);
  console.log(`Would move ${movingCalls} call(s) / ${usd(movingUsd)} onto "${DST_NAME}",`);
  console.log(`leaving it at ${afterCalls} call(s) / ${usd(afterUsd)}.`);

  if (!APPLY) {
    console.log("\nDry run — nothing was written. Re-run with --apply to perform the move.");
    process.exit(0);
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  /*
   * client_name is carried on every row and is what the statement PRINTS;
   * client_norm is what it GROUPS by. Both have to move, or the merged client
   * shows up as one group under two spellings.
   *
   * Idempotent: a second run matches zero source rows and the precondition
   * above stops it with "no ledger rows" rather than writing again.
   */
  await client.query("BEGIN");
  const upd = await client.query(
    `UPDATE usage_events SET client_norm = $1, client_name = $2
      WHERE tenant_id = $3 AND client_norm = $4`,
    [DST, DST_NAME, TENANT, SRC]);
  if (upd.rowCount !== movingCalls) {
    await client.query("ROLLBACK");
    die(`expected to move ${movingCalls} row(s) but the UPDATE touched ${upd.rowCount}. ` +
        `Rolled back — the ledger is unchanged. Something wrote to usage_events between ` +
        `the report above and the write.`);
    process.exit(1);
  }
  await client.query("COMMIT");

  const after = await ledger(DST);
  console.log(`\nMoved ${upd.rowCount} row(s). Destination now reads:`);
  for (const r of after) console.log(`  ${r.client_name} — ${r.calls} call(s), ${usd(r.usd)}`);
  const leftover = await ledger(SRC);
  console.log(leftover.length
    ? `\nWARNING: ${leftover.length} source group(s) remain — investigate.`
    : `\n"${SRC_NAME}" is gone from the statement.`);
} finally {
  await client.end();
}
