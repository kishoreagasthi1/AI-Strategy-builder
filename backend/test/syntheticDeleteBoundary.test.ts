/**
 * The audit record must not be deletable by SPOOFING A DISPLAY NAME
 * (v5.33.3, external audit HIGH — proven against real Postgres).
 *
 * THE DEFECT. Migration 017 deliberately gave the application no DELETE on
 * interview_transcripts: "an audit record the application can erase is not much
 * of an audit record." Migration 024 needed synthetic practice transcripts to be
 * removable on regeneration, granted DELETE back, and narrowed it with:
 *
 *     USING (tenant_id = … AND interviewee_name LIKE '%[Synthetic]')
 *
 * asserting in its own comment that '[Synthetic]' "is appended by the generator
 * and by nothing else". interviewee_name is caller input — routes/interviews.ts
 * accepts z.string().min(1).max(200) and writes it verbatim into the audit
 * table. The auditors demonstrated it as the non-owner vyne_app role with RLS
 * forced: two real transcripts in, the one named "Mallory Vance [Synthetic]"
 * gone. It also fires by ACCIDENT on any real interviewee named that way.
 *
 * THE FIX (migration 026). Syntheticity becomes a column on both tables, set by
 * the generator and backfilled from state_module — which is server-generated in
 * both paths ('iv_' || uuid for real interviews, 'iv_synth_…' for synthetic)
 * and never echoes caller input. The application is granted no UPDATE on either
 * table, so it cannot flip the flag on a real row. The RLS policy is re-keyed
 * onto the column and the name test is dropped.
 *
 * WHAT THIS FILE ASSERTS. The SQL and the query paths, statically. The runtime
 * proof that the policy holds belongs with the other policy tests
 * (rlsPenetration.test.ts), which need a live database and are gated on
 * RLS_TEST; this runs everywhere and fails the moment the name predicate comes
 * back anywhere in the delete path.
 *
 * REVERT TEST: restore `interviewee_name LIKE '%[Synthetic]'` in
 * routes/synthetic.ts's prior-set query, or in 026's policy, and the
 * correspondingly named case below fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "src", "db", "migrations");
const SYNTHETIC_TS = join(ROOT, "src", "routes", "synthetic.ts");

const m026 = readFileSync(join(MIGRATIONS, "026_synthetic_flag_column.sql"), "utf8");
const synthetic = readFileSync(SYNTHETIC_TS, "utf8");

describe("synthetic deletion is keyed on a column, not a display name (v5.33.3)", () => {
  it("026 adds the column to both tables, NOT NULL and defaulting false", () => {
    // DEFAULT false is the load-bearing half: an existing row, or a row
    // inserted by a path that does not know about this column, must be
    // UNDELETABLE rather than deletable.
    expect(m026).toMatch(/ALTER TABLE interviews\s+ADD COLUMN IF NOT EXISTS synthetic boolean NOT NULL DEFAULT false/);
    expect(m026).toMatch(/ALTER TABLE interview_transcripts\s+ADD COLUMN IF NOT EXISTS synthetic boolean NOT NULL DEFAULT false/);
  });

  it("026 backfills from state_module, never from the interviewee name", () => {
    // state_module is server-generated in both paths. The name is caller input,
    // which is the entire bug.
    expect(m026).toContain(`WHERE state_module LIKE 'iv\\_synth\\_%'`);
    const backfill = m026.slice(m026.indexOf("UPDATE interviews"), m026.indexOf("-- What the old policy"));
    expect(backfill).not.toContain("interviewee_name");
  });

  it("026's DELETE policy tests the column and drops the name predicate", () => {
    const policy = m026.slice(m026.indexOf("CREATE POLICY tenant_delete_synthetic_only"));
    expect(policy).toContain("AND synthetic");
    expect(policy).not.toContain("interviewee_name");
    expect(policy).not.toContain("[Synthetic]");
  });

  it("026 leaves RLS enabled and FORCED on both tables when it finishes", () => {
    // It disables RLS to backfill — the same trap that failed 025 in
    // production. Ending with it off would be immeasurably worse than the bug.
    const tail = m026.slice(m026.indexOf("-- ── RLS back ON"));
    expect(tail).toContain("ALTER TABLE interview_transcripts ENABLE ROW LEVEL SECURITY");
    expect(tail).toContain("ALTER TABLE interview_transcripts FORCE  ROW LEVEL SECURITY");
    expect(tail).toContain("ALTER TABLE interviews            ENABLE ROW LEVEL SECURITY");
    expect(tail).toContain("ALTER TABLE interviews            FORCE  ROW LEVEL SECURITY");
    // ...and the ENABLE must come after the last DISABLE, not before it.
    expect(m026.lastIndexOf("DISABLE  ROW LEVEL SECURITY"))
      .toBeLessThan(m026.indexOf("ENABLE ROW LEVEL SECURITY"));
  });

  it("the generator SETS the column on both inserts", () => {
    // A policy keyed on a column nobody sets deletes nothing, and regeneration
    // silently starts stacking duplicate practice engagements instead.
    const ivInsert = synthetic.slice(synthetic.indexOf("INSERT INTO interviews"));
    expect(ivInsert.slice(0, 600)).toContain("interviewee_user_id, synthetic)");
    const trInsert = synthetic.slice(synthetic.indexOf("INSERT INTO interview_transcripts"));
    expect(trInsert.slice(0, 600)).toContain("score_events, synthetic)");
  });

  it("the regeneration path selects and deletes on the column", () => {
    expect(synthetic).toContain("SELECT id FROM interviews WHERE client_name = $1 AND synthetic");
    expect(synthetic).toContain("DELETE FROM interviews WHERE client_name = $1 AND synthetic");
    expect(synthetic).toContain("DELETE FROM interview_transcripts WHERE interview_id = ANY($1::uuid[]) AND synthetic");
  });

  it("NO query anywhere in the backend still selects or deletes by the name suffix", () => {
    /* The broad one. The two call sites above are the ones that existed; this
     * catches the third somebody adds later, and it is why this test reads the
     * whole source tree rather than one file. The literal may still appear in
     * INSERT values and in prose — the generator does append it as a display
     * marker, and that is fine. What must not exist is a WHERE that trusts it. */
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith(".ts") && !e.name.endsWith(".sql")) continue;
        const src = readFileSync(p, "utf8");
        // interviewee_name compared against the marker, in any direction.
        for (const m of src.matchAll(/interviewee_name\s+(LIKE|=|~)\s*'[^']*\[Synthetic\][^']*'/gi)) {
          const line = src.slice(0, m.index!).split("\n").length;
          /* Two files are exempt, both for the same reason: they are HISTORY,
           * not live rules.
           *   024 — the migration that introduced the bad policy. It has been
           *         applied to production; editing it would change nothing that
           *         has run and would diverge the file from the database. 026
           *         DROPs the policy this line creates.
           *   026 — quotes the old predicate in its NOTICE/WARNING text so an
           *         operator can list the rows that were exposed.
           * Every other occurrence is a live query and fails this test. */
          if (p.endsWith("024_synthetic_transcript_cleanup.sql")) continue;
          if (p.endsWith("026_synthetic_flag_column.sql")) continue;
          offenders.push(`${e.name}:${line} → ${m[0]}`);
        }
      }
    };
    walk(join(ROOT, "src"));
    expect(
      offenders.join("\n      "),
      "\n\n  A query keys a decision on the '[Synthetic]' DISPLAY NAME, which is " +
      "caller input\n  (routes/interviews.ts writes intervieweeName verbatim). Use the " +
      "`synthetic`\n  column added by migration 026.\n\n      "
    ).toBe("");
  });

  it("026 actually DROPs the policy 024 created (the exemption above depends on it)", () => {
    // The sweep exempts 024 on the grounds that its policy is dead. If this
    // DROP ever disappears, that exemption is hiding a live rule.
    expect(m026).toContain("DROP POLICY IF EXISTS tenant_delete_synthetic_only ON interview_transcripts");
    expect(m026.indexOf("DROP POLICY IF EXISTS tenant_delete_synthetic_only"))
      .toBeLessThan(m026.indexOf("CREATE POLICY tenant_delete_synthetic_only"));
  });

  it("026 comes after 024 and is not a silent edit of it", () => {
    // Editing an already-applied migration changes nothing that has run and
    // diverges the file from the database. The repair has to be a forward step.
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain("024_synthetic_transcript_cleanup.sql");
    expect(files).toContain("026_synthetic_flag_column.sql");
    const m024 = readFileSync(join(MIGRATIONS, "024_synthetic_transcript_cleanup.sql"), "utf8");
    // 024 is left exactly as it was applied, name predicate and all.
    expect(m024).toContain("interviewee_name LIKE '%[Synthetic]'");
  });
});

/**
 * ── The SQL is EXECUTED, not string-matched (v5.33.6) ──────────────────────
 *
 * The block below used to be source assertions only, and its own header argued
 * that was enough. It was not. `expect(src).toContain("pg_advisory_xact_lock")`
 * passes just as happily on a call that Postgres cannot resolve, and that is
 * precisely what shipped:
 *
 *     pg_advisory_xact_lock(hashtextextended(a,0), hashtextextended(b,0))
 *     ERROR: function pg_advisory_xact_lock(bigint, bigint) does not exist
 *
 * The only overloads are (bigint) and (int4, int4); hashtextextended returns
 * bigint and int8→int4 is not an implicit cast. Every synthetic commit failed
 * at the SAVE step — after every model call had already succeeded — so a
 * consultant watched ten personas generate and lost all of them to
 * "Generation failed: internal_error".
 *
 * A string match cannot distinguish a valid call from an invalid one. Only
 * running it can. This suite is gated like the other DB tests; rlsGate.test.ts
 * is what stops it skipping silently in CI.
 */
const DB_ENABLED = process.env.RLS_TEST === "1" && !!process.env.TEST_DATABASE_URL;

describe.skipIf(!DB_ENABLED)("the regeneration SQL actually RUNS (v5.33.6)", () => {
  it("the advisory lock resolves to a real function and is held in-transaction", async () => {
    const pg = (await import("pg")).default;
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query("SET app.tenant_id = '11111111-1111-1111-1111-111111111111'");
      await client.query("BEGIN");
      /* EXTRACTED from routes/synthetic.ts, not copied into this file. A copy
       * would keep passing after the route's SQL changed — which is the same
       * "the test tests itself" failure as string-matching. What ships is what
       * runs here. */
      const m = synthetic.match(/`(SELECT pg_advisory_xact_lock\(\s*[\s\S]*?\))`/);
      expect(m, "could not find the advisory-lock statement in routes/synthetic.ts").toBeTruthy();
      const lockSql = m![1];
      expect(lockSql, "extracted the wrong statement").toContain("pg_advisory_xact_lock");
      await client.query(lockSql, ["Acme Industrial"]);
      const held = await client.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'");
      expect(held.rows[0].n, "the lock was not actually taken").toBeGreaterThan(0);
      await client.query("COMMIT");
      // xact-scoped: released by COMMIT, with no unlock call to forget.
      const after = await client.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'");
      expect(after.rows[0].n, "the lock outlived its transaction").toBe(0);
    } finally {
      await client.end();
    }
  });

  it("the two-argument form this replaced genuinely does NOT resolve", async () => {
    /* The counterweight. Without it, the case above could pass against a
     * Postgres where BOTH forms work, and the assertion would prove nothing
     * about why the change was made. */
    const pg = (await import("pg")).default;
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query("SET app.tenant_id = '11111111-1111-1111-1111-111111111111'");
      await expect(client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('a', 0), hashtextextended('b', 0))`
      )).rejects.toThrow(/does not exist/);
    } finally {
      await client.end();
    }
  });

  it("every other statement this release added parses and resolves", async () => {
    /* PREPARE does full parse + name resolution without executing, so a typo or
     * a missing column in any of these fails here rather than in production. */
    const pg = (await import("pg")).default;
    const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      for (const [name, sql] of [
        ["rename re-keys billing",
         "UPDATE usage_events SET client_norm = $1 WHERE client_norm = ANY($2::text[])"],
        ["regeneration selects by column",
         "SELECT id FROM interviews WHERE client_name = $1 AND synthetic"],
        ["regeneration deletes interviews by column",
         "DELETE FROM interviews WHERE client_name = $1 AND synthetic"],
        ["regeneration deletes transcripts by column",
         "DELETE FROM interview_transcripts WHERE interview_id = ANY($1::uuid[]) AND synthetic"],
      ] as [string, string][]) {
        await expect(
          client.query(`PREPARE stmt_${name.replace(/\W/g, "_")} AS ${sql}`),
          `${name}: ${sql}`
        ).resolves.toBeTruthy();
      }
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  });
});

describe("synthetic regeneration is serialized (v5.33.3, audit MEDIUM)", () => {
  it("takes a transaction-scoped advisory lock keyed on tenant and client", () => {
    /* Delete-then-insert with no unique key, under READ COMMITTED: two
     * concurrent POST /api/synthetic/commit for one client each see an empty
     * set after their own delete and each insert the full set. Doubled
     * interviews, transcripts and tracker sittings, while the upserted
     * vynora_engagement_<code> array stays singular — so the tracker and
     * Synthesis disagree and nothing explains why.
     *
     * pg_advisory_XACT_lock, not pg_advisory_lock: released at COMMIT or
     * ROLLBACK, with no unlock call to forget on an error path. */
    expect(synthetic).toContain("pg_advisory_xact_lock");
    const lock = synthetic.slice(synthetic.indexOf("`SELECT pg_advisory_xact_lock"));
    expect(lock.slice(0, 400)).toContain("app.tenant_id");
    expect(synthetic).not.toContain("pg_advisory_unlock");
    /* The SINGLE-bigint form. v5.33.3 shipped the two-argument form fed by
     * hashtextextended, and pg_advisory_xact_lock has no (bigint, bigint)
     * overload — only (bigint) and (int4, int4). Every synthetic commit 500'd
     * at the save step. See the runtime case below, which is what should have
     * been here from the start. */
    expect(lock.slice(0, 400)).not.toMatch(/hashtextextended\([\s\S]*?\),\s*\n?\s*hashtextextended\(/);
  });

  it("the lock is taken BEFORE the delete, or it serializes nothing", () => {
    const lockAt = synthetic.indexOf("pg_advisory_xact_lock");
    const selectAt = synthetic.indexOf("SELECT id FROM interviews WHERE client_name = $1 AND synthetic");
    expect(lockAt).toBeGreaterThan(0);
    expect(selectAt).toBeGreaterThan(lockAt);
  });
});
