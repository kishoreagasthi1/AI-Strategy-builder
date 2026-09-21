/**
 * The repair pass for the transcripts doubled before v5.34.121. (v5.34.122)
 *
 * ── Why this file is longer than the thing it tests ─────────────────────────
 *
 * deploy/dedupe-lib.mjs decides what gets deleted from records of real client
 * interviews. Every other test in this repo protects a behaviour; this one
 * protects data that cannot be regenerated — the executive is not sitting down
 * for a second hour because a migration ate a turn.
 *
 * So the bar is different. It is not enough that it removes the duplicates: it
 * has to be shown NOT to touch a conversation that merely looks repetitive, and
 * the evidence anchors have to land on the same words afterwards as before.
 *
 * ── The defect being repaired ───────────────────────────────────────────────
 *
 * Before v5.34.121 a resume replayed the stored history through addMessage,
 * which pushed into the array being replayed, so each resume appended one
 * complete copy of everything said so far. The 2026-09-18 transcript shows it
 * plainly: every line twice, and the interviewer's lines as a truncated
 * fragment followed by the full line.
 */
import { describe, it, expect } from "vitest";
import {
  MIN_BLOCK, doubledPrefix, dedupe, indexMap, shiftAnchor, anchorsAtRisk, resolveDsn, redactDsn,
  remapEvidence, sameTranscript, applyDecision, verifyBackup, applyPreflight,
  tablesToWrite, accessVerdict, withOwner, emitMigration,
  pageTurn, renumberIdx, idxMatchesPosition, fixedForWrite,
  isFrozenFragment, collapseFragments, repair, anchorsThatMove, nextMigrationNumber,
} from "../../deploy/dedupe-lib.mjs";

type Msg = { role: string; text: string; at?: number };
const ai = (t: string, at = 0): Msg => ({ role: "ai", text: t, at });
const you = (t: string, at = 0): Msg => ({ role: "user", text: t, at });
const texts = (a: Msg[]) => a.map((m) => m.text);

/** The first sitting of the 2026-09-18 interview, abbreviated but in shape. */
const FIRST_SITTING: Msg[] = [
  ai("Hi Avery, I'm Jack Smith. This is just a short, candid conversation...", 1000),
  you("Hey Jack. I don't feel like talking about AI today. What about the stock market?", 1100),
  ai("I understand your interest, but my purpose here is to focus on Northwind's A I readiness.", 1200),
  you("Good answer. I was just testing you. Thank you.", 1300),
  ai("Glad we're on the same page. Getting back to the question...", 1400),
  you("Yeah, so AI is going to become a core and central part of our strategy at Northwind.", 1500),
  ai("That CEO vision sounds really clear. What kind of investment has been allocated?", 1600),
  you("No, it is formally budgeted and we also have room within our IT budget.", 1700),
];
/** What the second sitting added, after the doubled replay. */
const SECOND_SITTING: Msg[] = [
  ai("Welcome back, Avery. Are those guardrails focused primarily on legal compliance?", 9000),
  you("I think it combines everything. We look at it holistically.", 9100),
  ai("Right, a holistic approach. Where are most of your ideas coming from?", 9200),
  you("They're coming from all areas because we're looking at all projects through one funnel.", 9300),
];
/** The replayed copy carried fresh timestamps — that is how it was written. */
const replayed = (a: Msg[], base = 5000) => a.map((m, i) => ({ ...m, at: base + i }));

describe("v5.34.122 — it finds the doubling the resume defect produced", () => {
  it("repairs a once-resumed interview", () => {
    const stored = [...FIRST_SITTING, ...replayed(FIRST_SITTING), ...SECOND_SITTING];
    const d = dedupe(stored);
    expect(d.passes).toBe(1);
    expect(texts(d.items)).toEqual(texts([...FIRST_SITTING, ...SECOND_SITTING]));
  });

  it("repairs a twice-resumed interview", () => {
    /*
     * The doubling compounds: the second resume replays an array that is
     * already doubled plus whatever the second sitting added, so the shape is
     * [A A B][A A B] C — a doubling wrapped around a doubling.
     */
    const once = [...FIRST_SITTING, ...replayed(FIRST_SITTING), ...SECOND_SITTING];
    const twice = [...once, ...replayed(once, 7000), ai("And one more thing?", 9900)];
    const d = dedupe(twice);
    expect(d.passes).toBe(2);
    expect(texts(d.items)).toEqual(
      texts([...FIRST_SITTING, ...SECOND_SITTING, ai("And one more thing?")]));
  });

  it("keeps the ORIGINAL copy, not the replayed one", () => {
    /*
     * They differ only in their clocks. The first copy carries the real times;
     * the replay carries the moment of resume, which is what made the whole
     * restored history read as 07:22. Keeping the wrong one would preserve the
     * lie this repair exists to remove.
     */
    const stored = [...FIRST_SITTING, ...replayed(FIRST_SITTING)];
    const d = dedupe(stored) as { items: Msg[] };
    expect(d.items[0].at).toBe(1000);
    expect(d.items[d.items.length - 1].at).toBe(1700);
  });

  it("leaves a clean interview completely alone", () => {
    const clean = [...FIRST_SITTING, ...SECOND_SITTING];
    const d = dedupe(clean);
    expect(d.passes).toBe(0);
    expect(d.removed).toEqual([]);
    expect(texts(d.items)).toEqual(texts(clean));
  });
});

describe("v5.34.122 — it does not eat a real conversation", () => {
  it("spares a genuinely repeated short answer", () => {
    /*
     * "Yes." twice is a conversation, not a bug. A rule that removed adjacent
     * identical messages would take it, which is why detection is on block
     * structure instead.
     */
    const convo = [ai("Is that formally budgeted?"), you("Yes."), ai("And funded for year two?"), you("Yes.")];
    expect(dedupe(convo).passes).toBe(0);
  });

  it("spares an interviewer who re-asked after a connection drop", () => {
    /* v5.34.112: the recovery nudge makes it repeat its last question. Two
     * identical questions with different answers between them is normal. */
    const convo = [
      ai("Where does your data sit right now?"), you("We have a global data lake."),
      ai("Where does your data sit right now?"), you("As I said, a global data lake and a warehouse."),
    ];
    expect(dedupe(convo).passes).toBe(0);
  });

  it("spares a two-message interview that happens to repeat", () => {
    /*
     * The pathological minimum: [X, X] IS a doubled prefix of length 1, and a
     * greeting answered "Hello" twice would match. MIN_BLOCK is what stops it.
     */
    expect(MIN_BLOCK).toBeGreaterThanOrEqual(2);
    expect(dedupe([ai("Hello."), ai("Hello.")]).passes).toBe(0);
    expect(doubledPrefix([ai("Hello."), ai("Hello.")])).toBe(0);
  });

  it("does not run away on a pathological input", () => {
    const many = Array.from({ length: 64 }, () => ai("Same."));
    const d = dedupe(many);
    expect(d.passes).toBeLessThanOrEqual(8);
    expect(d.items.length).toBeGreaterThan(0);
  });

  it("compares on role and text, ignoring the clocks that differ by design", () => {
    const a = [ai("Q1", 1), you("A1", 2)];
    const b = [ai("Q1", 999), you("A1", 1000)];
    expect(dedupe([...a, ...b]).passes).toBe(1);
    // Different SPEAKER is a different message even with identical words.
    expect(dedupe([ai("Mm."), you("Mm."), ai("Mm."), you("Mm.")]).passes).toBe(1);
    expect(dedupe([ai("Mm."), you("Mm."), you("Mm."), ai("Mm.")]).passes).toBe(0);
  });
});

describe("v5.34.122 — the evidence still points at the same words", () => {
  /*
   * THE thing that makes this migration dangerous. `afterTurn` is
   * S.displayMessages.length at the moment a finding was recorded — a count,
   * not an index — so evidence from the second sitting points past the
   * duplicated block. Remove the block without moving those anchors and every
   * finding from the second half silently re-attaches to the wrong answer.
   *
   * A visibly doubled transcript announces itself. A misplaced finding does
   * not, and it is the thing the deliverable quotes.
   */
  const stored = [...FIRST_SITTING, ...replayed(FIRST_SITTING), ...SECOND_SITTING];
  const d = dedupe(stored);
  const map = indexMap(stored, d.removed);

  /** The message an anchor sits just after, before and after the repair. */
  const anchoredText = (arr: Msg[], afterTurn: number) => arr[afterTurn - 1]?.text;

  it("an anchor in the second sitting still names the same message", () => {
    const beforeAt = stored.length;            // recorded at the very end
    expect(anchoredText(stored, beforeAt)).toBe(SECOND_SITTING[SECOND_SITTING.length - 1].text);
    const afterAt = shiftAnchor(beforeAt, map);
    expect(anchoredText(d.items as Msg[], afterAt)).toBe(anchoredText(stored, beforeAt));
  });

  it("every anchor in the whole interview survives the move", () => {
    for (let a = 1; a <= stored.length; a++) {
      const moved = shiftAnchor(a, map);
      const was = anchoredText(stored, a);
      const now = anchoredText(d.items as Msg[], moved);
      // An anchor on the REMOVED copy must resolve to its surviving TWIN.
      // Leaving its number alone does not do that — it lands on whatever now
      // occupies that position, which is how anchor 9 came to rest on
      // "Welcome back, Avery" in the first draft of indexMap.
      expect(now, `anchor ${a} ("${was}") landed on "${now}"`).toBe(was);
    }
  });

  it("an unshifted anchor would have been wrong — so the test is not vacuous", () => {
    /*
     * Without this, every assertion above would pass on a shiftAnchor that
     * returned its input unchanged.
     */
    const last = stored.length;
    expect(anchoredText(d.items as Msg[], last)).not.toBe(anchoredText(stored, last));
    expect(shiftAnchor(last, map)).not.toBe(last);
  });

  it("leaves anchors before the duplicate exactly where they were", () => {
    for (let a = 1; a <= FIRST_SITTING.length; a++) expect(shiftAnchor(a, map)).toBe(a);
  });

  it("leaves a missing anchor missing", () => {
    // Number(null) is 0, which is finite — so these must be caught before any
    // coercion or a record with no evidence acquires an anchor at position 0.
    /*
     * Every shape of bad input, asserted to come back exactly as it arrived.
     * This replaces two explicit guards that no mutation could kill — the
     * property is real, the guards were not the thing enforcing it.
     */
    const bad: unknown[] = [undefined, null, 0, -3, "", "not a number", NaN, {}, []];
    for (const b of bad) {
      expect(shiftAnchor(b as number, map), `shiftAnchor(${JSON.stringify(b)}) changed it`).toBe(b);
    }
  });

  it("moves a STRING anchor, because the risk detector counts it as one", () => {
    /*
     * M112. anchorsAtRisk coerces with Number(); shiftAnchor originally
     * required a strict number. A jsonb record holding "20" was reported as
     * evidence that would move and then not moved — an audit promising a remap
     * it did not perform. The two must agree, and this is the test that says so.
     */
    const asNumber = shiftAnchor(stored.length, map);
    const asString = shiftAnchor(String(stored.length) as unknown as number, map);
    expect(asString).toBe(asNumber);
    expect(anchorsAtRisk({ findingEvents: [{ afterTurn: String(stored.length) }] }, d.removed[0].from))
      .toHaveLength(1);
  });
});

describe("v5.34.122 — the audit tells the truth about the risk", () => {
  const stored = [...FIRST_SITTING, ...replayed(FIRST_SITTING), ...SECOND_SITTING];
  const d = dedupe(stored);

  it("flags a record whose evidence would move", () => {
    const rec = { scoreEvents: [{ afterTurn: 20 }], findingEvents: [{ afterTurn: 3 }] };
    const risk = anchorsAtRisk(rec, d.removed[0].from);
    expect(risk).toHaveLength(1);
    expect(risk[0].afterTurn).toBe(20);
  });

  it("does not flag a record whose evidence all sits before the duplicate", () => {
    expect(anchorsAtRisk({ findingEvents: [{ afterTurn: 2 }, { afterTurn: 5 }] }, d.removed[0].from))
      .toHaveLength(0);
  });

  it("copes with a record that has no evidence at all", () => {
    // Every interview before v5.32.66 has none; NULL and [] must both be safe.
    expect(anchorsAtRisk({}, 4)).toHaveLength(0);
    expect(anchorsAtRisk({ scoreEvents: null, findingEvents: undefined }, 4)).toHaveLength(0);
  });
});

function readScript() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { dirname, join } = require("node:path") as typeof import("node:path");
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "..", "deploy", "dedupe-transcripts.mjs"), "utf8");
}
const src = readScript();

describe("v5.34.122 — the script cannot write by accident", () => {

  it("writes nothing without --apply", () => {
    expect(src).toMatch(/const APPLY = has\("--apply"\);/);
    expect(src).toMatch(/if \(!APPLY\) \{/);
    expect(src).toMatch(/This was a READ-ONLY audit\. Nothing has been written\./);
  });

  it("refuses to apply without a backup on disk", () => {
    expect(src).toMatch(/if \(!existsSync\(BACKUP\)\)/);
    expect(src).toMatch(/Refusing to apply/);
    // Re-read rather than trusting the in-memory copy: if the file is not what
    // we think it is, the way back is not there.
    expect(src).toMatch(/JSON\.parse\(readFileSync\(BACKUP, "utf8"\)\)/);
  });

  it("skips records whose anchors would move unless that is asked for", () => {
    expect(src).toMatch(/if \(a\.anchorsAtRisk && !REMAP\)/);
    expect(src).toMatch(/skipped \(anchors would move\)/);
  });

  it("works in transactions and rolls back on any failure", () => {
    /*
     * v5.34.125 narrowed this from one transaction to one PER TENANT, because
     * each tenant's rows are only reachable inside its own app.tenant_id
     * context. The guarantee is therefore per tenant now, and this assertion
     * was updated rather than deleted — it caught the change, which is what it
     * is for.
     */
    expect(src).toMatch(/await db\.query\("BEGIN"\)/);
    expect(src).toMatch(/await db\.query\("COMMIT"\)/);
    expect(src).toMatch(/await db\.query\("ROLLBACK"\)/);
    expect(src).toMatch(/that tenant rolled back, nothing of theirs changed/);
  });

  it("resolves pg from backend/node_modules, not from its own directory", () => {
    /*
     * v5.34.123. `import pg from "pg"` resolves relative to the SCRIPT, not the
     * working directory, so a script in deploy/ looks in deploy/node_modules,
     * walks up, and finds nothing — the first run failed with
     * ERR_MODULE_NOT_FOUND despite the documented `cd backend` first.
     * createRequire anchored at backend/package.json resolves it the way the
     * backend does, from wherever the script is run.
     */
    expect(src).toMatch(/createRequire\(new URL\("\.\.\/backend\/package\.json", import\.meta\.url\)\)/);
    expect(src).toMatch(/requireFromBackend\("pg"\)/);
    expect(src, "a bare pg import would resolve against deploy/, which has no node_modules")
      .not.toMatch(/^import pg from "pg";/m);
    // And it says what to do when the driver genuinely is not installed.
    expect(src).toMatch(/Run `npm install` in vyne-saas\/backend/);
  });

  it("uses the tested library rather than its own copy of the logic", () => {
    /*
     * The v5.34.120 lesson, applied before it could cost anything: three
     * mutations of the real classifier survived because the test had rebuilt
     * it. Here the script imports what this file tests.
     */
    expect(src).toMatch(/from "\.\/dedupe-lib\.mjs"/);
    expect(src, "the script has its own copy of the detection")
      .not.toMatch(/function doubledPrefix/);
  });
});

/**
 * ── v5.34.124: pointing Cloud Run's DSN at the local proxy ──────────────────
 *
 * The DSN in Secret Manager is the one Cloud Run uses and names a unix socket
 * that exists only inside Cloud Run, so on a laptop it fails with
 *
 *     connect ENOENT /cloudsql/vyne-platform-prod:us-central1:vyne-sql/.s.PGSQL.5432
 *
 * The alternative to handling it here was asking the operator to retype the
 * DSN with the host swapped, which puts a production password on their
 * clipboard and in their shell history to work around something the script can
 * do itself.
 */
describe("v5.34.124 — the DSN reaches the database", () => {
  const CLOUD_RUN_NO_HOST = "postgres://vyne:p%40ss%2Fword@/vyne?host=/cloudsql/proj:us-central1:inst";
  const CLOUD_RUN_WITH_HOST = "postgresql://vyne:secret@localhost/vyne?host=/cloudsql/proj:us-central1:inst";

  it("rewrites the shape that has no host at all", () => {
    /*
     * THE one that matters, and the one the first cut got wrong: new URL()
     * THROWS on `user:pw@/db`, so a try/catch returning the input unchanged
     * declined to repair the exact DSN this exists for. Found by running it.
     */
    const r = resolveDsn(CLOUD_RUN_NO_HOST);
    expect(r.rewritten).toBe(true);
    const u = new URL(r.dsn!);
    expect(u.hostname).toBe("127.0.0.1");
    expect(u.port).toBe("5433");
    expect(u.searchParams.get("host"), "the socket parameter would still win").toBe(null);
    expect(u.pathname).toBe("/vyne");
  });

  it("rewrites the shape that names a host AND a socket", () => {
    // pg prefers the socket parameter, so a localhost hostname is not enough.
    const r = resolveDsn(CLOUD_RUN_WITH_HOST);
    expect(r.rewritten).toBe(true);
    expect(new URL(r.dsn!).searchParams.get("host")).toBe(null);
    expect(new URL(r.dsn!).host).toBe("127.0.0.1:5433");
  });

  it("preserves the password byte for byte", () => {
    /*
     * The password is never parsed out or reassembled by hand. A DSN whose
     * password contains an encoded @ and / must survive the round trip, or the
     * rewrite swaps one connection failure for a confusing auth failure.
     */
    expect(new URL(resolveDsn(CLOUD_RUN_NO_HOST).dsn!).password).toBe("p%40ss%2Fword");
  });

  it("leaves a DSN that already points somewhere real completely alone", () => {
    for (const dsn of [
      "postgres://vyne:secret@localhost:5433/vyne",
      "postgres://vyne:secret@10.1.2.3:5432/vyne",
      "postgres://vyne@db.internal:6432/vyne",
    ]) {
      const r = resolveDsn(dsn);
      expect(r.rewritten, `rewrote a deliberate DSN: ${dsn}`).toBe(false);
      expect(r.dsn).toBe(dsn);
    }
  });

  it("honours a different proxy port", () => {
    expect(new URL(resolveDsn(CLOUD_RUN_NO_HOST, 6543).dsn!).port).toBe("6543");
  });

  it("does not throw on nonsense", () => {
    expect(resolveDsn("not a dsn at all").rewritten).toBe(false);
    expect(resolveDsn("").dsn).toBe("");
    expect(resolveDsn(undefined).dsn).toBe(undefined);
  });

  it("never prints the password", () => {
    const shown = redactDsn(resolveDsn(CLOUD_RUN_NO_HOST).dsn!);
    expect(shown).not.toContain("p%40ss%2Fword");
    expect(shown).toContain("***");
    expect(redactDsn("garbage")).toBe("(unparseable DSN)");
  });

  it("the script uses it, and says so without leaking", () => {
    expect(src).toMatch(/resolveDsn\(process\.env\.DATABASE_URL/);
    expect(src).toMatch(/redactDsn\(resolved\.dsn\)/);
    expect(src, "a connection failure should name the proxy, not just fail")
      .toMatch(/Is cloud-sql-proxy running\?/);
    expect(src, "the raw DATABASE_URL is handed to the client unresolved")
      .not.toMatch(/connectionString: process\.env\.DATABASE_URL/);
  });
});

/**
 * ── v5.34.125: seeing nothing is not the same as seeing nothing wrong ───────
 *
 * The first live run of the audit printed:
 *
 *     scanned:   0 record(s)
 *     affected:  0
 *     Nothing is doubled. … Nothing to do.
 *
 * It had seen nothing at all. Both module_state and interview_transcripts
 * carry FORCE ROW LEVEL SECURITY with
 *
 *     tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
 *
 * and the connection set no app.tenant_id, so every row was filtered — from
 * the owner too, because the policy is FORCEd. Postgres behaved correctly; the
 * script turned an empty view into a clean bill of health.
 *
 * That is worse than the defect it was written to repair. A doubled transcript
 * is at least visible in the record; a repair tool that reports "nothing to do"
 * because it could not see closes the question permanently.
 *
 * Two fixes, and the second is the one that generalises: scan inside each
 * tenant's context the way the application does, and never report a clean
 * result without saying how much was actually examined.
 */
describe("v5.34.125 — the audit cannot report a clean result it did not earn", () => {
  it("scans inside each tenant's RLS context", () => {
    expect(src, "the scan no longer sets a tenant, so RLS will hide everything")
      .toMatch(/SELECT set_config\('app\.tenant_id', \$1, true\)", \[t\.id\]/);
    expect(src).toMatch(/SELECT id, name FROM tenants/);
  });

  it("counts what was VISIBLE, separately from what was wrong", () => {
    /*
     * The distinction the first version could not make. Row counts per table
     * are what tell "the database is clean" apart from "I could not read the
     * database".
     */
    expect(src).toMatch(/sessionRows/);
    expect(src).toMatch(/transcriptRows/);
    expect(src).toMatch(/visible:.*saved session\/archive row\(s\)/);
    expect(src).toMatch(/examined:.*record\(s\) long enough to contain a doubling/);
  });

  it("refuses to call an empty view an all-clear", () => {
    expect(src).toMatch(/if \(sessionRows === 0 && transcriptRows === 0\)/);
    expect(src).toMatch(/NOT AN ALL-CLEAR/);
    expect(src, "it should name RLS, which is the cause every time")
      .toMatch(/row-level security/i);
    expect(src, "a blind run must not exit 0 and look like success")
      .toMatch(/process\.exit\(3\)/);
  });

  it("only says 'nothing is doubled' with the number it examined", () => {
    expect(src).toMatch(/Nothing is doubled, across \$\{scanned\} record\(s\) that were actually examined/);
  });

  it("stops if it cannot even read the tenant list", () => {
    // No tenants means no way to scan anything; that is also not an all-clear.
    expect(src).toMatch(/Could not read the tenants table/);
    expect(src).toMatch(/Nothing was examined; this is NOT an all-clear/);
  });

  it("applies inside the tenant context too, and verifies each write landed", () => {
    /*
     * The same policy applies to UPDATE through its USING clause: with no
     * tenant set, every UPDATE matches zero rows and reports success. The
     * repair would have committed cleanly and changed nothing — the audit's
     * silence, repeated on the write side.
     *
     * rowCount is the check that would have caught this class the first time.
     */
    expect(src).toMatch(/SELECT set_config\('app\.tenant_id', \$1, true\)", \[tenantId\]/);
    expect(src).toMatch(/w1\.rowCount !== 1/);
    expect(src).toMatch(/w2\.rowCount !== 1/);
    expect(src).toMatch(/UPDATE matched \$\{w1\.rowCount\} rows, not 1/);
  });

  it("is still atomic, now per tenant, and says so honestly", () => {
    expect(src).toMatch(/const byTenant = new Map\(\)/);
    expect(src).toMatch(/that tenant rolled back, nothing of theirs changed/);
    expect(src, "the backup must still be named on failure").toMatch(/covers them all/);
  });
});

/**
 * ── v5.34.126: proving the repair on THIS operator's data ───────────────────
 *
 * The 2026-09-18 audit found one affected record — 170 messages, a single
 * 66-message doubling, seventeen finding and score anchors sitting past it.
 *
 * Everything above proves the remap lands on the same words for a transcript I
 * wrote. It says nothing about that one. Seventeen findings silently
 * re-attached to the wrong answer, inside the record a client deliverable
 * quotes, is not something to accept on the strength of a fixture.
 *
 * Two additions, and they are different in kind:
 *
 *   --verify-backup  replays the repair from the backup file, with no database
 *                    and nothing written, and prints for every anchor the
 *                    message it names now and the message it would name
 *                    afterwards. Proof about the real data.
 *
 *   the backup       now carries the evidence as well as the transcript. The
 *                    first backup carried only the words — so the part most at
 *                    risk of being put in the wrong place was the part with no
 *                    way back.
 */
describe("v5.34.126 — the backup carries the evidence it is going to rewrite", () => {
  const stored = [...FIRST_SITTING, ...replayed(FIRST_SITTING), ...SECOND_SITTING];
  const d = dedupe(stored);
  const map = indexMap(stored, d.removed);

  it("moves every anchor in an evidence list", () => {
    const evidence = [{ afterTurn: stored.length, dimension: "strategy", quote: "one funnel" }];
    const moved = remapEvidence(evidence, map) as typeof evidence;
    expect(moved[0].afterTurn).toBe(shiftAnchor(stored.length, map));
    expect(moved[0].afterTurn).not.toBe(stored.length);   // not vacuous
  });

  it("keeps every other field on the event untouched", () => {
    const e = { afterTurn: 20, dimension: "governance", score: 3, quote: "holistically", nested: { a: 1 } };
    const [out] = remapEvidence([e], map) as Array<typeof e>;
    expect(out.dimension).toBe("governance");
    expect(out.score).toBe(3);
    expect(out.quote).toBe("holistically");
    expect(out.nested).toBe(e.nested);
  });

  it("does not mutate the backup it was handed", () => {
    /* The backup is the way back. A remap that edited it in place would leave
     * the file on disk describing the repaired state, not the original. */
    const evidence = [{ afterTurn: stored.length }];
    remapEvidence(evidence, map);
    expect(evidence[0].afterTurn).toBe(stored.length);
  });

  it("passes a record with no evidence through unchanged", () => {
    // Every interview before v5.32.66 has none. null and undefined are how that
    // is stored, and neither may become [] or throw.
    expect(remapEvidence(null, map)).toBe(null);
    expect(remapEvidence(undefined, map)).toBe(undefined);
    expect(remapEvidence([], map)).toEqual([]);
  });

  it("leaves a malformed event exactly as it found it", () => {
    const junk = [null, 7, "x", {}, { noAnchor: true }];
    /* toStrictEqual, not toEqual: without the `"afterTurn" in e` guard these
     * come back as { afterTurn: undefined }, which toEqual calls equal to {}.
     * M143 survived a green suite on exactly that. */
    expect(remapEvidence(junk, map)).toStrictEqual(junk);
  });

  it("the apply path uses that function rather than its own copy", () => {
    expect(src).toMatch(/remapEvidence\(ev\.scoreEvents, map\)/);
    expect(src).toMatch(/remapEvidence\(ev\.findingEvents, map\)/);
    expect(src, "a second inline copy of the remap is how the two drift apart")
      .not.toMatch(/const fix = \(arr\)/);
  });

  it("the audit backs the evidence up alongside the transcript", () => {
    /*
     * The backup written on 2026-09-18 had `_original` and nothing else, so the
     * seventeen anchors --remap-anchors rewrites had no way back. Found by
     * reading the file rather than by trusting that a backup is a backup.
     */
    expect(src).toMatch(/_evidence: \{ scoreEvents: rec\.scoreEvents/);
    expect(src).toMatch(/_evidence: \{ scoreEvents: row\.score_events/);
  });

  it("the apply path writes the evidence it backed up, not a fresh read", () => {
    // Otherwise --verify-backup would be proving something about a different
    // starting point than the one the write uses.
    expect(src).toMatch(/const ev = a\._evidence \|\| \{\};/);
    expect(src, "a fresh SELECT of score_events would be a second source of truth")
      .not.toMatch(/SELECT score_events/);
  });
});

describe("v5.34.126 — it will not write over a record that moved since the audit", () => {
  /*
   * The audit and the apply are two separate runs, and the whole design puts a
   * human reading the output in between. A live interview can save in that
   * window — this defect IS about resumes — and `_fixed` was computed from a
   * transcript that is then no longer there.
   *
   * The v5.34.125 rowCount check does not catch it: the UPDATE matches its one
   * row and succeeds, having replaced a newer conversation with an older one,
   * silently.
   */
  it("recognises the transcript it audited", () => {
    const a = [ai("Q", 1), you("A", 2)];
    expect(sameTranscript(a, a)).toBe(true);
    expect(sameTranscript(a, a.map((m) => ({ ...m })))).toBe(true);
  });

  it("ignores the clocks, which differ by design", () => {
    /* The two copies of a doubling differ only in `at`. A comparison that
     * included it would refuse to repair every record this tool exists for. */
    expect(sameTranscript([ai("Q", 1)], [ai("Q", 999_999)])).toBe(true);
  });

  it("notices a turn appended since the audit", () => {
    const a = [ai("Q", 1), you("A", 2)];
    expect(sameTranscript(a, [...a, ai("And one more thing?")])).toBe(false);
  });

  it("notices an edited or re-spoken turn", () => {
    expect(sameTranscript([ai("Q"), you("A")], [ai("Q"), you("A, revised")])).toBe(false);
    expect(sameTranscript([ai("Q"), you("A")], [ai("Q"), ai("A")])).toBe(false);
  });

  it("treats anything that is not a pair of arrays as not a match", () => {
    for (const bad of [null, undefined, {}, "", 0]) {
      expect(sameTranscript(bad, [ai("Q")]), `${JSON.stringify(bad)} matched`).toBe(false);
      expect(sameTranscript([ai("Q")], bad), `${JSON.stringify(bad)} matched`).toBe(false);
    }
  });

  /*
   * The decision itself, not the shape of the line that makes it. M151 and M152
   * disabled the guard with `if (false && ...)` and every source-text assertion
   * still matched — a guard testable only by grep is a guard that can be turned
   * off without a test going red.
   */
  const audited = { _original: [ai("Q", 1), you("A", 2)] };

  it("writes when the row is still the one that was audited", () => {
    expect(applyDecision(audited, [ai("Q", 1), you("A", 2)])).toEqual({ write: true, reason: null });
    // module_state hands it the session record, not the array.
    expect(applyDecision(audited, { displayMessages: [ai("Q"), you("A")] }).write).toBe(true);
  });

  it("refuses when the transcript changed under it", () => {
    const grown = [ai("Q"), you("A"), ai("And one more thing?")];
    expect(applyDecision(audited, grown)).toEqual({ write: false, reason: "changed" });
    expect(applyDecision(audited, { displayMessages: grown }).reason).toBe("changed");
  });

  it("refuses when the row is gone, or the archive entry moved", () => {
    for (const missing of [null, undefined, {}, { displayMessages: null }]) {
      expect(applyDecision(audited, missing), `${JSON.stringify(missing)} was written`)
        .toEqual({ write: false, reason: "gone" });
    }
  });

  it("tells the two apart, because they need different advice", () => {
    // "gone" is nothing to do; "changed" means re-run the audit and look again.
    expect(applyDecision(audited, null).reason).not.toBe(applyDecision(audited, [ai("X")]).reason);
  });

  it("the apply path routes both tables through it", () => {
    expect(src).toMatch(/SELECT turns FROM interview_transcripts WHERE id = \$1/);
    expect(src).toMatch(/const d = applyDecision\(a, cur\.rows\.length \? cur\.rows\[0\]\.turns : null\);/);
    expect(src).toMatch(/const d = applyDecision\(a, rec\);/);
    expect(src).toMatch(/if \(!d\.write\) \{ refuse\(d\.reason,/);
    expect(src, "a skipped record must be visible in the totals, not just in the log")
      .toMatch(/changed since the audit: \$\{stale\}/);
    expect(src, "and it must say what to do, not only that it happened")
      .toMatch(/Re-run the audit/);
  });
});

describe("v5.34.126 — --verify-backup proves the remap on the real record", () => {
  /** A backup in the exact shape the audit writes, with anchors past the block. */
  const makeBackup = (over: Record<string, unknown> = {}) => {
    const orig = [...FIRST_SITTING, ...replayed(FIRST_SITTING), ...SECOND_SITTING];
    const d2 = dedupe(orig);
    const last = orig.length;
    return {
      takenAt: "2026-09-18T17:36:40.036Z",
      affected: [{
        where: "interview_transcripts", client: "Northwind", stakeholder: "Avery Keller",
        before: orig.length, after: d2.items.length, anchorsAtRisk: 2,
        _original: orig, _fixed: d2.items, _removed: d2.removed,
        _evidence: {
          scoreEvents: [{ afterTurn: last, dimension: "strategy" }],
          findingEvents: [{ afterTurn: last - 1, text: "one funnel" }],
        } as { scoreEvents: Array<Record<string, unknown>> | null;
               findingEvents: Array<Record<string, unknown>> | null },
        ...over,
      }],
    };
  };

  it("reports every anchor as naming the same message", () => {
    const r = verifyBackup(makeBackup());
    expect(r.checked).toBe(2);
    expect(r.mismatches).toBe(0);
    expect(r.evidenceMissing).toBe(0);
    expect(r.records[0].anchors.map((a) => a.status)).toEqual(["same", "same"]);
  });

  it("and the anchors genuinely MOVED, so 'same' means preserved, not untouched", () => {
    /*
     * Without this, a verifier that reported "same" for everything — including
     * one that never shifted anything — would pass the test above.
     */
    const r = verifyBackup(makeBackup());
    for (const a of r.records[0].anchors) expect(a.to).not.toBe(a.from);
  });

  it("catches a repair that would move the evidence", () => {
    /*
     * The failure mode this exists to detect: the block is recorded as removed,
     * so the anchors shift, but the transcript was not actually shortened. Every
     * anchor then lands on different words. If this reads clean, the verifier is
     * decorative.
     */
    const b = makeBackup();
    b.affected[0]._fixed = b.affected[0]._original;     // shifted anchors, unshortened text
    const r = verifyBackup(b);
    expect(r.mismatches).toBe(2);
    expect(r.records[0].anchors.every((a) => a.status === "moved")).toBe(true);
    expect(r.records[0].anchors[0].was).not.toBe(r.records[0].anchors[0].now);
  });

  it("refuses to call an anchor it cannot check a pass", () => {
    // An anchor naming no message in the original is a malformed record. Both
    // sides read as the empty string, so a naive comparison calls it SAME —
    // the v5.34.125 all-clear, in miniature.
    const b = makeBackup();
    b.affected[0]._evidence.scoreEvents = [{ afterTurn: 9999 }];
    b.affected[0]._evidence.findingEvents = [{ afterTurn: 0 }];
    const r = verifyBackup(b);
    expect(r.records[0].anchors.map((a) => a.status)).toEqual(["unverifiable", "unverifiable"]);
    expect(r.mismatches).toBe(2);
  });

  it("flags a backup written before the evidence was backed up at all", () => {
    /*
     * THE case on this operator's disk: dedupe-backup-2026-09-18T17-36-40-036Z
     * has `_original` and no `_evidence`, and the record it covers has
     * seventeen anchors at risk. Reporting that as "no anchored evidence —
     * nothing to remap" would be a false all-clear about the single most
     * dangerous part of the migration.
     */
    const b = makeBackup();
    delete (b.affected[0] as Record<string, unknown>)._evidence;
    const r = verifyBackup(b);
    expect(r.evidenceMissing).toBe(1);
    expect(r.records[0].evidenceMissing).toBe(true);
    expect(r.checked).toBe(0);
  });

  it("does not cry wolf over a record that genuinely has no evidence", () => {
    // anchorsAtRisk 0 and no _evidence is an interview from before findings
    // existed. Nothing is missing; nothing needs remapping.
    const b = makeBackup({ anchorsAtRisk: 0 });
    delete (b.affected[0] as Record<string, unknown>)._evidence;
    const r = verifyBackup(b);
    expect(r.evidenceMissing).toBe(0);
    expect(r.records[0].anchors).toEqual([]);
  });

  it("shows the seam, so the join can be read as a conversation", () => {
    /*
     * The index arithmetic can be right and the result still wrong. Printing
     * the messages either side of the join is the check a person can make that
     * no assertion in this file can.
     */
    const seam = verifyBackup(makeBackup()).records[0].seam;
    expect(seam.length).toBeGreaterThanOrEqual(3);
    // The join itself: the last message of the first sitting, then the first
    // message of the second, adjacent and in that order. Nothing of the
    // replayed copy between them.
    const at = seam.findIndex((s) => s.text.includes("formally budgeted"));
    expect(at, "the last kept message is not in the printed window").toBeGreaterThanOrEqual(0);
    expect(seam[at + 1].text).toContain("Welcome back, Avery");
    expect(seam.map((s) => s.n)).toEqual([...seam.map((s) => s.n)].sort((a, b) => a - b));
    expect(seam.some((s) => s.text.includes("Hi Avery, I'm Jack Smith")),
           "a replayed opener still sits in the seam — the block was not removed").toBe(false);
    // Context on BOTH sides, or it cannot be read as a conversation — a window
    // that starts at the join shows only the second half of it.
    expect(at, "no context before the join").toBeGreaterThanOrEqual(1);
    expect(seam.length - at - 1, "no context after the join").toBeGreaterThanOrEqual(2);
  });

  it("the audit sends the operator to verify BEFORE it offers --apply", () => {
    /* M158. The apply command was printed whether or not the verify command
     * was, so the one step that proves the remap on real data was optional in
     * the only place the operator reads. */
    const audit = src.slice(src.indexOf("if (!APPLY) {"));
    const v = audit.indexOf("--verify-backup ${BACKUP}");
    const ap = audit.indexOf("--apply --backup ${BACKUP}");
    expect(v, "the audit never prints the verify command").toBeGreaterThan(-1);
    expect(ap).toBeGreaterThan(-1);
    expect(v, "--apply is offered before the verification it depends on").toBeLessThan(ap);
    expect(audit).toMatch(/Every anchor must read SAME/);
  });

  it("survives an empty or malformed backup without pretending to have checked", () => {
    for (const b of [{}, { affected: [] }, { affected: null }, null]) {
      const r = verifyBackup(b);
      expect(r.checked).toBe(0);
      expect(r.mismatches).toBe(0);
      expect(r.records).toEqual([]);
    }
    const partial = verifyBackup({ affected: [{ where: "x" }] });
    expect(partial.records[0].before).toBe(0);
    expect(partial.checked).toBe(0);
  });
});

/**
 * ── v5.34.126: run the actual script ────────────────────────────────────────
 *
 * Every failure of this tool so far has been a failure to RUN, not a failure to
 * compute: `pg` unresolvable from deploy/, a DSN naming a socket that only
 * exists inside Cloud Run, an RLS policy hiding every row. Three green suites in
 * a row while the script could not get off the ground.
 *
 * So --verify-backup, the one mode that touches no database, is exercised by
 * spawning node on the real file and reading its exit code. It is the only
 * assertion here that would have caught any of those three.
 */
describe("v5.34.126 — the verify mode runs, end to end", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { writeFileSync, mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { dirname, join } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { fileURLToPath } = require("node:url") as typeof import("node:url");

  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "dedupe-transcripts.mjs");
  const dir = mkdtempSync(join(tmpdir(), "vyne-dedupe-"));

  /** Runs it with DATABASE_URL deliberately absent; verify must not need one. */
  const run = (backup: unknown) => {
    const file = join(dir, `b-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(backup));
    const env = { ...process.env };
    delete env.DATABASE_URL;
    try {
      const out = execFileSync(process.execPath, [script, "--verify-backup", file],
                               { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: (err.stdout ?? "") + (err.stderr ?? "") };
    }
  };

  const orig = [...FIRST_SITTING, ...replayed(FIRST_SITTING), ...SECOND_SITTING];
  const d3 = dedupe(orig);
  const good = {
    affected: [{
      where: "interview_transcripts", client: "Northwind", stakeholder: "Avery Keller", anchorsAtRisk: 1,
      _original: orig, _fixed: d3.items, _removed: d3.removed,
      _evidence: { scoreEvents: [{ afterTurn: orig.length }], findingEvents: null },
    }],
  };

  it("exits 0 and says the remap is safe, with no DATABASE_URL in the environment", () => {
    const r = run(good);
    expect(r.out).toContain("Northwind · Avery Keller");
    expect(r.out).toContain("the seam");
    expect(r.out).toMatch(/SAME/);
    expect(r.out).toContain("name the same message before and after");
    expect(r.code, r.out).toBe(0);
  });

  it("exits 4 when an anchor would land on different words", () => {
    const bad = JSON.parse(JSON.stringify(good));
    bad.affected[0]._fixed = bad.affected[0]._original;
    const r = run(bad);
    expect(r.out).toMatch(/MOVED/);
    expect(r.out).toContain("Do not apply with --remap-anchors");
    expect(r.code, r.out).toBe(4);
  });

  it("emit refuses a migration number that is already taken, and writes nothing", () => {
    /*
     * M213. Asserting the refusal's source text passed with the guard disabled.
     * 037 exists in every checkout, so this needs no setup and runs the real
     * script. Overwriting a numbered file would either collide with a different
     * migration or rewrite one that has already run — history, in both cases.
     */
    const b = join(dir, `clash-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(b, JSON.stringify(good));
    const target = join(dir, "037_clash.sql");
    const env = { ...process.env }; delete env.DATABASE_URL;
    let code = 0, out = "";
    try {
      execFileSync(process.execPath, [script, "--emit-migration", target, "--backup", b, "--remap-anchors"],
                   { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? -1; out = (err.stdout ?? "") + (err.stderr ?? "");
    }
    expect(code, out).toBe(2);
    expect(out).toMatch(/already has 037_/);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect((require("node:fs") as typeof import("node:fs")).existsSync(target), "it wrote the file anyway").toBe(false);
  });

  it("exits 5 on the backup this operator already has on disk", () => {
    /*
     * dedupe-backup-2026-09-18T17-36-40-036Z.json: transcript, no evidence,
     * seventeen anchors at risk. It must refuse rather than report a record
     * with nothing to remap.
     */
    const old = JSON.parse(JSON.stringify(good));
    delete old.affected[0]._evidence;
    old.affected[0].anchorsAtRisk = 17;
    const r = run(old);
    expect(r.out).toContain("NO copy of the evidence");
    expect(r.out).toContain("Re-run the audit on v5.34.126");
    expect(r.code, r.out).toBe(5);
  });
});

/**
 * ── v5.34.127: the verification has to govern the write ─────────────────────
 *
 * `--apply --backup <file>` used to re-run the whole scan and repair what the
 * scan found, while `--verify-backup <file>` checked the FILE. Two sides of one
 * decision reading different things — this project's recurring shape, and here
 * it made the proof advisory: the operator verified a backup, and the apply
 * then did its own arithmetic on whatever was in the database at that moment.
 *
 * It was destructive as well. The scan wrote its result over --backup on the
 * way past, so the verified file was replaced by an unverified one before the
 * first UPDATE, and the v5.34.126 staleness guard could never fire because it
 * was comparing a scan against rows read seconds after it.
 *
 * Now apply loads the backup and applies that, and this is the gate in front.
 */
describe("v5.34.127 — apply runs the file that was verified, or it does not run", () => {
  const orig = [...FIRST_SITTING, ...replayed(FIRST_SITTING), ...SECOND_SITTING];
  const d4 = dedupe(orig);
  const backup = (over: Record<string, unknown> = {}) => ({
    takenAt: "2026-09-18T18:43:17.326Z",
    affected: [{
      where: "interview_transcripts", client: "Northwind", stakeholder: "Avery Keller", anchorsAtRisk: 1,
      _original: orig, _fixed: d4.items, _removed: d4.removed,
      _evidence: { scoreEvents: [{ afterTurn: orig.length }], findingEvents: null },
      ...over,
    }],
  });

  it("lets a verified backup through, and reports what it checked", () => {
    const pre = applyPreflight(backup(), true);
    expect(pre.ok).toBe(true);
    expect(pre.reason).toBe(null);
    expect(pre.report!.checked).toBe(1);
    expect(pre.report!.mismatches).toBe(0);
  });

  it("refuses a backup whose anchors would move", () => {
    const b = backup();
    b.affected[0]._fixed = b.affected[0]._original;
    const pre = applyPreflight(b, true);
    expect(pre.ok).toBe(false);
    expect(pre.reason).toBe("anchors-move");
  });

  it("refuses a backup with no evidence when it is asked to move anchors", () => {
    const b = backup();
    delete (b.affected[0] as Record<string, unknown>)._evidence;
    expect(applyPreflight(b, true)).toMatchObject({ ok: false, reason: "evidence-missing" });
  });

  it("but lets that same backup through when no anchors are being moved", () => {
    /*
     * Without --remap-anchors every record carrying anchors is skipped by the
     * apply loop anyway, so refusing here would block a repair that was never
     * going to touch the evidence.
     */
    const b = backup();
    delete (b.affected[0] as Record<string, unknown>)._evidence;
    expect(applyPreflight(b, false).ok).toBe(true);
  });

  it("refuses something that is not a backup at all", () => {
    for (const junk of [null, {}, { affected: "yes" }, { affected: {} }]) {
      expect(applyPreflight(junk, true), JSON.stringify(junk))
        .toMatchObject({ ok: false, reason: "unreadable" });
    }
    expect(applyPreflight({ affected: [] }, true)).toMatchObject({ ok: false, reason: "empty" });
  });

  it("the script loads the backup instead of re-scanning, and never writes over it", () => {
    /* Just the branch, not the rest of the file: the audit that legitimately
     * writes the backup sits below it, and a slice to end-of-file would swallow
     * it and make the last assertion here always fail. The `else` is matched at
     * column 0, because the preflight's own if/else sits inside the branch. */
    const start = src.indexOf("if (APPLY) {");
    const apply = src.slice(start, src.indexOf("\n} else {", start));
    expect(start).toBeGreaterThan(-1);
    expect(apply).toMatch(/applyPreflight\(loaded, REMAP\)/);
    expect(apply).toMatch(/affected = loaded\.affected;/);
    expect(apply).toMatch(/Nothing is re-scanned: this is the file that was verified\./);
    expect(src, "the backup is written in exactly one place, the audit")
      .toMatch(/writeFileSync\(BACKUP/);
    expect(src.match(/writeFileSync\(BACKUP/g)).toHaveLength(1);
    expect(apply, "the apply branch must not write the backup")
      .not.toMatch(/writeFileSync\(BACKUP/);
  });

  it("a row is examined once, tagged with the tenant that owns it", () => {
    /*
     * Found by rehearsing against a real database: one doubled transcript and
     * one doubled session were reported as FOUR affected records. The scan reads
     * inside each tenant's RLS context, and a role that bypasses RLS sees every
     * row in every context. Identity has to come from the row, not the loop —
     * otherwise the apply sets app.tenant_id to a tenant that does not own the
     * row and matches nothing.
     */
    expect(src).toMatch(/const seen = new Set\(\);/);
    expect(src).toMatch(/if \(seen\.has\(rowId\)\) continue;/);
    expect(src).toMatch(/tenantId: owner,/);
    expect(src).toMatch(/tenantId: row\.tenant_id,/);
    expect(src, "the loop's tenant must not be used as the row's identity")
      .not.toMatch(/tenantId: t\.id,/);
    expect(src, "and the extra reach should be reported, not quietly enjoyed")
      .toMatch(/Row-level security is not filtering for this role/);
  });
});

/**
 * ── v5.34.128: a missing GRANT is knowable before the first BEGIN ───────────
 *
 * The first live apply opened a transaction, set the tenant, and died on
 *
 *     permission denied for table interview_transcripts
 *
 * Nothing was lost — the transaction rolled back — but the tool had already
 * printed "applying <backup> … nothing is re-scanned" before finding out it
 * could not write. The DSN in Secret Manager is the application's, and the
 * application role has SELECT on that table and not UPDATE, which is correct
 * for an app that inserts a submitted transcript and never edits one.
 *
 * A missing grant is a different wall from the v5.34.125 one, and the
 * difference is the whole point: row-level security returns zero rows and no
 * error, a missing grant raises. Both end with nothing written and only one is
 * fixed by setting app.tenant_id.
 */
describe("v5.34.128 — it finds out what it may do before it tries", () => {
  it("asks only about the tables this particular repair will write to", () => {
    /* A run with only saved sessions to repair must not be refused for lacking
     * UPDATE on interview_transcripts, and the reverse. */
    expect(tablesToWrite([{ where: "interview_transcripts" }])).toEqual(["interview_transcripts"]);
    expect(tablesToWrite([{ where: "module_state" }])).toEqual(["module_state"]);
    expect(tablesToWrite([{ where: "module_state" }, { where: "interview_transcripts" },
                          { where: "module_state" }]))
      .toEqual(["interview_transcripts", "module_state"]);
    expect(tablesToWrite([]), "nothing to write means nothing to ask about").toEqual([]);
    expect(tablesToWrite([{ where: "somewhere_else" }, null, 7, undefined])).toEqual([]);
    expect(tablesToWrite(null)).toEqual([]);
  });

  const row = (table: string, over = {}) =>
    ({ table, owner: "vyne", can_select: true, can_update: true, ...over });

  it("lets a role that can read and write through", () => {
    const v = accessVerdict([row("interview_transcripts"), row("module_state")],
                            ["interview_transcripts", "module_state"]);
    expect(v).toEqual({ ok: true, problems: [] });
  });

  it("names the table and the privilege that is missing", () => {
    const v = accessVerdict([row("interview_transcripts", { can_update: false })],
                            ["interview_transcripts"]);
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual([{ table: "interview_transcripts", missing: "UPDATE" }]);
  });

  it("catches a role that cannot even read", () => {
    const v = accessVerdict([row("module_state", { can_select: false, can_update: false })],
                            ["module_state"]);
    expect(v.problems.map((p) => p.missing)).toEqual(["SELECT", "UPDATE"]);
  });

  it("treats a table it cannot see at all as a problem, not as fine", () => {
    // has_table_privilege returns no ROW for a table outside the search path.
    // Reading that absence as permission would be the v5.34.125 mistake again.
    const v = accessVerdict([], ["interview_transcripts"]);
    expect(v.ok).toBe(false);
    expect(v.problems[0].missing).toMatch(/not visible/);
  });

  it("ignores tables this repair does not touch", () => {
    const v = accessVerdict([row("interview_transcripts"), row("tenants", { can_update: false })],
                            ["interview_transcripts"]);
    expect(v.ok).toBe(true);
  });

  it("does not throw on a report it cannot read", () => {
    expect(accessVerdict(null, ["x"]).ok).toBe(false);
    expect(accessVerdict([], null as unknown as string[]).ok).toBe(true);
  });
});

describe("v5.34.128 — the owner role is swapped in, not typed out", () => {
  const DSN = "postgres://vyne_app:apppass@127.0.0.1:5433/vyne";

  it("changes the role and password, and nothing else", () => {
    const r = withOwner(DSN, "vyne", "ownerpass");
    expect(r.swapped).toBe(true);
    const u = new URL(r.dsn!);
    expect(u.username).toBe("vyne");
    expect(u.password).toBe("ownerpass");
    expect(u.host).toBe("127.0.0.1:5433");
    expect(u.pathname).toBe("/vyne");
    expect(r.was).toBe("vyne_app");
  });

  it("encodes a password that would otherwise break the DSN", () => {
    /*
     * A hand-assembled DSN turns a password containing @ or / into a confusing
     * auth failure — or into a host that does not exist. This is the reason the
     * swap happens here rather than in the operator's shell.
     */
    const r = withOwner(DSN, "vyne", "p@ss/word:80");
    const u = new URL(r.dsn!);
    expect(u.password).toBe("p%40ss%2Fword%3A80");
    expect(decodeURIComponent(u.password)).toBe("p@ss/word:80");
    expect(u.host, "the @ in the password stole the host").toBe("127.0.0.1:5433");
  });

  it("leaves the DSN alone when no owner is named", () => {
    for (const user of [undefined, "", null]) {
      const r = withOwner(DSN, user as string | undefined, "x");
      expect(r.swapped, `swapped on ${JSON.stringify(user)}`).toBe(false);
      expect(r.dsn).toBe(DSN);
    }
    expect(withOwner(undefined, "vyne", "x").swapped).toBe(false);
    expect(withOwner("not a dsn", "vyne", "x").swapped).toBe(false);
  });

  it("encodes the ROLE NAME too, so the DSN round-trips", () => {
    /*
     * M177. The URL setter percent-encodes the characters it knows about but
     * leaves a bare % exactly as written, so assigning the name raw produces a
     * DSN that no longer decodes back to the name that was asked for.
     */
    const odd = "role%weird@host";
    const r = withOwner(DSN, odd, "x");
    const u = new URL(r.dsn!);
    expect(u.username).toBe(encodeURIComponent(odd));
    expect(decodeURIComponent(u.username)).toBe(odd);
    expect(u.host, "an @ in the role name stole the host").toBe("127.0.0.1:5433");
  });

  it("does not die reading a username it cannot decode", () => {
    /*
     * decodeURIComponent throws URIError on a stray %, and this reads a string
     * the DSN supplied rather than one this code wrote. Unguarded it killed the
     * script at connect time, before it had done anything at all.
     */
    const r = withOwner("postgres://od%dity:p@127.0.0.1:5433/vyne", "vyne", "x");
    expect(r.swapped).toBe(true);
    expect(r.was).toBe("od%dity");
    expect(new URL(r.dsn!).username).toBe("vyne");
  });

  it("keeps the existing password when none is given", () => {
    const r = withOwner(DSN, "vyne");
    expect(new URL(r.dsn!).password).toBe("apppass");
  });

  it("the script uses it, and never prints what it was given", () => {
    expect(src).toMatch(/withOwner\(resolved\.dsn, process\.env\.DB_OWNER, process\.env\.DB_OWNER_PASSWORD\)/);
    expect(src).toMatch(/connecting as \$\{owned\.now\} instead of/);
    expect(src, "the client must get the swapped DSN, not the original")
      .toMatch(/new Client\(\{ connectionString: owned\.dsn \}\)/);
    expect(src, "DB_OWNER_PASSWORD must never reach a log line")
      .not.toMatch(/console\.log\([^)]*DB_OWNER_PASSWORD/);
  });

  it("the apply path checks access before opening a transaction", () => {
    const start = src.indexOf("if (APPLY) {");
    const apply = src.slice(start, src.indexOf("\n} else {", start));
    expect(apply).toMatch(/const verdict = accessVerdict\(access\.rows, needed\);/);
    expect(apply).toMatch(/no transaction was opened/);
    expect(apply).toMatch(/process\.exit\(6\)/);
    expect(apply.indexOf("accessVerdict"), "the check must come before the apply loop")
      .toBeLessThan(apply.indexOf("applying ${BACKUP}"));
    expect(apply, "and it must not claim to be applying before it knows")
      .toMatch(/accessVerdict[\s\S]*applying \$\{BACKUP\}/);
  });
});

/**
 * ── v5.34.129: the table is append-only on purpose ──────────────────────────
 *
 * Migration 024 replaced the FOR ALL policy on interview_transcripts with
 * tenant_read (FOR SELECT) and tenant_write (FOR INSERT), left no UPDATE grant
 * and no UPDATE policy, and said why in the file: "a transcript remains
 * unmodifiable in place". FORCE ROW LEVEL SECURITY binds the table owner too,
 * so the first live apply as `vyne` read the row and matched zero rows on the
 * UPDATE. The v5.34.125 rowCount check turned that into a rollback.
 *
 * That is an invariant somebody chose, not an obstacle. Adding an UPDATE policy
 * to get past it would remove a guarantee quietly, so the repair is emitted as
 * a migration in the shape 026 established — drop FORCE, do the work, put FORCE
 * back, inside the runner's transaction — generated from the verified backup
 * rather than written by hand.
 */
describe("v5.34.129 — the repair as a migration", () => {
  const orig = [...FIRST_SITTING, ...replayed(FIRST_SITTING), ...SECOND_SITTING];
  const d5 = dedupe(orig);
  const backup = () => ({
    takenAt: "2026-09-18T18:43:17.326Z",
    affected: [{
      where: "interview_transcripts", id: "0f8f-id", client: "Northwind", stakeholder: "Avery Keller",
      anchorsAtRisk: 1, _original: orig, _fixed: d5.items, _removed: d5.removed,
      _evidence: { scoreEvents: [{ afterTurn: orig.length }], findingEvents: null },
    }],
  });

  it("suspends FORCE and restores it, in that order", () => {
    const sql = emitMigration(backup()).sql!;
    const off = sql.indexOf("NO FORCE ROW LEVEL SECURITY");
    const on = sql.lastIndexOf("FORCE  ROW LEVEL SECURITY");
    expect(off).toBeGreaterThan(-1);
    expect(on).toBeGreaterThan(off);
    expect(sql).toContain("ALTER TABLE interview_transcripts ENABLE ROW LEVEL SECURITY;");
  });

  it("does not quietly grant what 024 withheld", () => {
    /*
     * The failure mode that would look like success: an UPDATE policy, or an
     * UPDATE grant, left behind so the script could work next time. That is the
     * invariant being deleted rather than suspended.
     */
    const sql = emitMigration(backup()).sql!;
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]{0,200}FOR UPDATE/);
    expect(sql).not.toMatch(/GRANT[^;]*UPDATE/);
  });

  it("refuses to write over a row that is not the length it audited", () => {
    const sql = emitMigration(backup()).sql!;
    expect(sql).toMatch(new RegExp(`IF n <> ${orig.length} THEN`));
    expect(sql).toMatch(/RAISE EXCEPTION[^;]*Re-run the audit/);
    expect(sql).toMatch(/GET DIAGNOSTICS hit = ROW_COUNT;/);
    expect(sql).toMatch(/IF hit <> 1 THEN/);
    // and it checks the result afterwards, in the same transaction
    expect(sql).toMatch(new RegExp(`IF n <> ${d5.items.length} THEN`));
  });

  it("moves the anchors, the same way the script would", () => {
    const sql = emitMigration(backup()).sql!;
    const moved = shiftAnchor(orig.length, indexMap(orig, d5.removed));
    expect(moved).not.toBe(orig.length);
    expect(sql).toContain(`"afterTurn":${moved}`);
    expect(sql).not.toContain(`"afterTurn":${orig.length}`);
  });

  it("picks a dollar-quote tag the transcript cannot contain", () => {
    /*
     * A fixed tag is a quoting bug waiting for the interviewee who says the
     * wrong thing — and it ends the literal early, so the rest of the
     * transcript becomes SQL.
     */
    /*
     * Built as a REAL doubling containing the tag, not by hand-editing _fixed:
     * a backup whose _fixed does not follow from its _original is one the
     * preflight rejects, so that shortcut tests nothing. Both copies carry the
     * text, or there is no doubled prefix to find.
     */
    const nastyFirst = FIRST_SITTING.map((m, i) =>
      i === 0 ? ai("we said $mig$ and then $migx$ out loud", m.at) : m);
    const nastyOrig = [...nastyFirst, ...replayed(nastyFirst), ...SECOND_SITTING];
    const nd = dedupe(nastyOrig);
    const out = emitMigration({
      takenAt: "t", affected: [{
        where: "interview_transcripts", id: "x", client: "c", stakeholder: "s", anchorsAtRisk: 1,
        _original: nastyOrig, _fixed: nd.items, _removed: nd.removed,
        _evidence: { scoreEvents: [{ afterTurn: nastyOrig.length }], findingEvents: null },
      }],
    });
    expect(out.ok, "the fixture itself was rejected").toBe(true);
    const sql = out.sql!;
    expect(sql).toContain("$mig$ and then $migx$");          // the data survived
    expect(sql).toContain("$migxx$");                         // the tag was widened past both
    expect(sql, "the literal is opened with a tag its own contents contain")
      .not.toMatch(/= \$mig\$/);
    expect(sql).not.toMatch(/= \$migx\$/);
  });

  it("will not emit from a backup that has not been verified clean", () => {
    const b = backup();
    b.affected[0]._fixed = b.affected[0]._original;
    const out = emitMigration(b);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("anchors-move");
    expect(out.sql, "it produced a migration from a backup it just rejected").toBe(null);

    const c = backup();
    delete (c.affected[0] as Record<string, unknown>)._evidence;
    expect(emitMigration(c).reason).toBe("evidence-missing");
    expect(emitMigration({ affected: [] }).reason).toBe("empty");
  });

  it("says in the file why it exists, so a reviewer is not guessing", () => {
    const sql = emitMigration(backup()).sql!;
    expect(sql).toContain("unmodifiable in place");
    expect(sql).toContain("024");
    expect(sql).toContain("026");
    expect(sql, "applying it by hand without BEGIN leaves RLS off")
      .toMatch(/BY HAND REQUIRES/);
    expect(sql).toContain("2026-09-18T18:43:17.326Z");
  });

  it("the script refuses to write the file when the backup is rejected", () => {
    expect(src).toMatch(/const out = emitMigration\(backup, \{ number, name, remap: REMAP \}\);/);
    const emit = src.slice(src.indexOf("if (EMIT) {"));
    expect(emit.indexOf("process.exit(5)"), "it writes before it checks")
      .toBeLessThan(emit.indexOf("writeFileSync(EMIT"));
  });
});

/**
 * ── v5.34.130: check the consumer, not a model of it ────────────────────────
 *
 * interviews.html attaches evidence with `byTurn[turn.idx + 1]` — the turn's
 * server-recorded index, falling back to position only when there is no idx.
 * Every check before this version resolved anchors by POSITION.
 *
 * On the real 2026-09-18 record the two agreed before the repair (idx equalled
 * position for all 170 turns) and stopped agreeing after it: the kept turns kept
 * idx 0..65 and 132..169 while the anchors were moved by position. The verifier
 * reported all 63 anchors SAME. On the page, 14 would have found no turn and
 * been swept into "After the final exchange". Found by reading the generated
 * migration against the real record, not by any test — the fixtures had no idx.
 */
describe("v5.34.130 — anchors land where the review page will look", () => {
  /* Shaped like production: server turns carry who/text/idx. */
  const turn = (who: string, text: string, idx: number) => ({ who, text, idx, at: 1000 + idx });
  const S1 = Array.from({ length: 10 }, (_, i) => turn(i % 2 ? "Interviewee" : "Interviewer", `first ${i}`, i));
  const S2 = Array.from({ length: 4 }, (_, i) => turn(i % 2 ? "Interviewee" : "Interviewer", `second ${i}`, 0));
  const orig = [...S1, ...S1, ...S2].map((t, i) => ({ ...t, idx: i }));   // idx === position, as in production
  const d6 = dedupe(orig);
  const ev = { scoreEvents: [{ afterTurn: 3 }, { afterTurn: 10 }, { afterTurn: 22 }, { afterTurn: 24 }],
               findingEvents: [{ afterTurn: 21, text: "second-sitting finding" }] };
  const backup = () => ({ affected: [{
    where: "interview_transcripts", id: "x", anchorsAtRisk: 3,
    _original: orig, _fixed: d6.items, _removed: d6.removed, _evidence: ev,
  }] });

  it("resolves an anchor by idx when the turn has one, by position when not", () => {
    const withIdx = [{ text: "a", idx: 5 }, { text: "b", idx: 9 }];
    expect(pageTurn(withIdx, 10)?.text).toBe("b");
    expect(pageTurn(withIdx, 2), "fell back to position although idx was present").toBe(undefined);
    expect(pageTurn([{ text: "a" }, { text: "b" }], 2)?.text).toBe("b");
    expect(pageTurn([{ text: "a", idx: null }, { text: "b" }], 1)?.text).toBe("a");
    expect(pageTurn(null, 1)).toBe(undefined);
    expect(pageTurn([{ text: "a" }], "nope")).toBe(undefined);
  });

  it("the repair as written puts every anchor on the turn it named before", () => {
    const r = verifyBackup(backup());
    expect(r.mismatches).toBe(0);
    expect(r.records[0].anchors.every((a) => a.status === "same")).toBe(true);
    const written = fixedForWrite(backup().affected[0]) as Array<{ idx: number; text: string }>;
    for (const e of [...ev.scoreEvents, ...ev.findingEvents]) {
      const moved = shiftAnchor(e.afterTurn, indexMap(orig, d6.removed));
      expect(pageTurn(written, moved)?.text).toBe(pageTurn(orig, e.afterTurn)?.text);
    }
  });

  it("and WITHOUT renumbering the page would lose them — so this is not vacuous", () => {
    /* The v5.34.129 migration, exactly: anchors moved, idx left alone. */
    const unrenumbered = d6.items;
    const lost = ev.findingEvents.filter((e) =>
      pageTurn(unrenumbered, shiftAnchor(e.afterTurn, indexMap(orig, d6.removed))) === undefined);
    expect(lost.length, "the old repair would have placed this correctly anyway").toBe(1);
  });

  it("renumbers idx to position and touches nothing else", () => {
    const out = renumberIdx(d6.items) as typeof d6.items;
    expect(out.map((t) => t.idx)).toEqual(out.map((_, i) => i));
    expect(out.map((t) => t.text)).toEqual(d6.items.map((t) => t.text));
    expect(out[out.length - 1].at, "a field other than idx changed").toBe(d6.items[d6.items.length - 1].at);
    expect(d6.items[d6.items.length - 1].idx, "renumbering mutated the backup").not.toBe(out.length - 1);
  });

  it("leaves turns that never had an idx exactly as they were", () => {
    const plain = [{ role: "ai", text: "a" }, { role: "user", text: "b" }];
    expect(renumberIdx(plain)).toBe(plain);
    expect(renumberIdx(null)).toBe(null);
  });

  it("refuses a transcript whose idx already has holes in it", () => {
    /*
     * The server filters blank messages out of `turns` and keeps each
     * survivor's original idx. Anchors then live in a coordinate system with
     * gaps that the position-based remap cannot see. Nobody has run that case,
     * so it is refused rather than repaired on a guess.
     */
    expect(idxMatchesPosition(orig)).toBe(true);
    expect(idxMatchesPosition([{ idx: 0 }, { idx: 2 }])).toBe(false);
    expect(idxMatchesPosition([{ text: "no idx" }, { text: "still none" }])).toBe(true);
    expect(idxMatchesPosition([{ idx: null }, { idx: 1 }])).toBe(true);

    const b = backup();
    b.affected[0]._original = orig.map((t, i) => (i > 5 ? { ...t, idx: i + 1 } : t));
    const pre = applyPreflight(b, true);
    expect(pre.ok).toBe(false);
    expect(pre.reason).toBe("idx-gaps");
    expect(applyPreflight(b, false).reason, "refused only when remapping — renumbering still happens").toBe("idx-gaps");
    expect(emitMigration(b).ok).toBe(false);
  });

  it("the migration writes the renumbered turns", () => {
    const sql = emitMigration(backup()).sql!;
    const last = d6.items.length - 1;
    expect(sql).toContain(`"idx":${last}`);
    expect(sql, "a kept second-sitting turn still carries its pre-repair idx")
      .not.toContain(`"idx":${orig.length - 1}`);
  });

  it("the apply path writes the renumbered turns too", () => {
    expect(src).toMatch(/JSON\.stringify\(fixedForWrite\(a\)\), a\._fixed\.length, a\.id/);
    expect(src).toMatch(/rec\.displayMessages = fixedForWrite\(a\);/);
    expect(src, "a raw _fixed reaches a write").not.toMatch(/JSON\.stringify\(a\._fixed\)/);
  });

  it("the outer DO block's quote cannot be closed by the data either", () => {
    /*
     * v5.34.129 guarded the inner tag and wrapped every record in a bare
     * `DO $$ ... $$`. A transcript containing "$$" would have ended the block
     * in the middle of the interview. Found reading the generated file.
     */
    const nasty = S1.map((t, i) => (i === 0 ? { ...t, text: "paid $$ and $do$ both" } : t));
    const o2 = [...nasty, ...nasty, ...S2].map((t, i) => ({ ...t, idx: i }));
    const dd = dedupe(o2);
    const sql = emitMigration({ affected: [{
      where: "interview_transcripts", id: "y", anchorsAtRisk: 0,
      _original: o2, _fixed: dd.items, _removed: dd.removed, _evidence: { scoreEvents: null, findingEvents: null },
    }] }).sql!;
    expect(sql).not.toMatch(/^DO \$\$$/m);
    expect(sql).toMatch(/^DO \$dox\$$/m);
    expect(sql).toMatch(/^END \$dox\$;$/m);
  });
});

/**
 * ── v5.34.132: the frozen first-fragment copies ─────────────────────────────
 *
 * Until v5.34.132 liveAppend stored every live line twice — addMessage's entry,
 * frozen at the first fragment and timed, and its own mirror, grown into the
 * full line and untimed. The 2026-09-18 record: 104 entries, 52 pairs, 27
 * interviewer and 25 interviewee, the `at` pattern on every one, and 25 of the
 * pairs word-for-word identical. These tests hold the detection to that exact
 * fingerprint, and above all to NOT touching a conversation that only looks
 * like it.
 */
describe("v5.34.132 — collapsing the frozen fragment copies", () => {
  type T = { who: string; text: string; at: number | null; idx?: number };
  const fr = (who: string, text: string, at: number): T => ({ who, text, at });
  const full = (who: string, text: string): T => ({ who, text, at: null });

  it("recognises the defect's exact fingerprint", () => {
    expect(isFrozenFragment(fr("Interviewer", "Hi Avery,", 1), full("Interviewer", "Hi Avery, I'm Jack."))).toBe(true);
    // An answer that arrived whole: identical text is still the defect.
    expect(isFrozenFragment(fr("Interviewee", "Hey Jack.", 1), full("Interviewee", "Hey Jack."))).toBe(true);
    // Session records use role, not who.
    expect(isFrozenFragment({ role: "ai", text: "Hi", at: 1 }, { role: "ai", text: "Hi there" })).toBe(true);
  });

  it("refuses everything that is merely similar", () => {
    const A = fr("Interviewee", "Yes.", 1);
    expect(isFrozenFragment(A, { who: "Interviewee", text: "Yes, and more.", at: 2 }),
           "both timed: a real repeat, not the defect").toBe(false);
    expect(isFrozenFragment({ ...A, at: null }, full("Interviewee", "Yes. And more.")),
           "first untimed: not what addMessage writes").toBe(false);
    expect(isFrozenFragment(A, full("Interviewer", "Yes. And more.")), "different speaker").toBe(false);
    expect(isFrozenFragment(A, full("Interviewee", "No.")), "not a prefix").toBe(false);
    expect(isFrozenFragment(fr("Interviewee", "   ", 1), full("Interviewee", "anything")), "empty fragment").toBe(false);
    expect(isFrozenFragment(null, full("x", "y"))).toBe(false);
    expect(isFrozenFragment({ text: "a", at: 1 }, { text: "ab" }), "no speaker at all").toBe(false);
  });

  it("collapses a whole interview to one entry per line, keeping when each began", () => {
    const pairs: T[] = [
      fr("Interviewer", "Hi", 10), full("Interviewer", "Hi Avery."),
      fr("Interviewee", "Hey.", 20), full("Interviewee", "Hey."),
      fr("Interviewer", "Where", 30), full("Interviewer", "Where is it?"),
    ];
    const c = collapseFragments(pairs);
    expect(c.collapsed).toBe(3);
    expect(c.items.map((t) => t.text)).toEqual(["Hi Avery.", "Hey.", "Where is it?"]);
    expect(c.items.map((t) => t.at), "the survivor did not take the start time").toEqual([10, 20, 30]);
    expect(c.removed.every((r) => r.kind === "fragment")).toBe(true);
    expect(pairs[1].at, "collapsing mutated the original").toBe(null);
  });

  it("never merges across two lines from the same speaker", () => {
    /* A1 B1 A2 B2 — the merged B1 must not then be read as the fragment of A2. */
    const two: T[] = [
      fr("Interviewer", "First", 1), full("Interviewer", "First question?"),
      fr("Interviewer", "Second", 2), full("Interviewer", "Second question?"),
    ];
    expect(collapseFragments(two).items.map((t) => t.text)).toEqual(["First question?", "Second question?"]);
  });

  it("leaves a clean transcript exactly as it was", () => {
    const clean: T[] = [
      { who: "Interviewer", text: "Q?", at: 1 }, { who: "Interviewee", text: "A.", at: 2 },
    ];
    const c = collapseFragments(clean);
    expect(c.collapsed).toBe(0);
    expect(c.items).toEqual(clean);
  });

  /* The 2026-09-18 record exactly: a first sitting of fragment pairs, the resume
   * replay of it (every copy timed by addMessage), then a second sitting of pairs. */
  const sitting = (tag: string, n: number, t0: number): T[] => Array.from({ length: n }, (_, k) => [
    fr(k % 2 ? "Interviewee" : "Interviewer", `${tag}${k}`, t0 + k),
    full(k % 2 ? "Interviewee" : "Interviewer", `${tag}${k} and the rest of it`),
  ]).flat();
  const s1 = sitting("one-", 4, 100);
  const replay = s1.map((t, i) => ({ ...t, at: 5000 + i }));
  const s2 = sitting("two-", 3, 9000);
  const record = [...s1, ...replay, ...s2].map((t, i) => ({ ...t, idx: i }));

  it("repairs a resumed AND fragmented record in the order the defects compose", () => {
    const r = repair(record);
    expect(r.passes, "the replay was not removed as a doubling").toBe(1);
    expect(r.collapsed).toBe(7);
    expect(r.items.map((t) => t.text)).toEqual([...s1, ...s2].filter((t) => t.at === null).map((t) => t.text));
  });

  it("every anchor on that record lands on the same line on the review page", () => {
    const r = repair(record);
    const map = indexMap(record, r.removed);
    const written = renumberIdx(r.items);
    // Every full line in the original, and one fragment, as an anchor.
    const anchors = record.map((t, i) => i + 1).filter((n) => record[n - 1].at === null || n === 1);
    for (const n of anchors) {
      const before = pageTurn(record, n)!;
      const expected = before.at === null ? before.text : (record as T[])[(record as T[]).indexOf(before as unknown as T) + 1].text;
      const replayed = (replay as T[]).includes(before as unknown as T);
      if (replayed) continue;          // anchors never point into the replayed block
      expect(pageTurn(written, shiftAnchor(n, map))?.text, `anchor ${n}`).toBe(expected);
    }
  });

  it("verify accepts a fragment anchor as its own line, and only that", () => {
    const r = repair(record);
    const mk = (afterTurn: number) => verifyBackup({ affected: [{
      where: "interview_transcripts", anchorsAtRisk: 1,
      _original: record, _fixed: r.items, _removed: r.removed,
      _evidence: { scoreEvents: [{ afterTurn }], findingEvents: null },
    }] });
    const onFragment = mk(1);                           // names "one-0", the first fragment
    expect(onFragment.records[0].anchors[0].status).toBe("same-line");
    expect(onFragment.mismatches).toBe(0);

    // A remap that lands one line off must still fail, fragment or not.
    const broken = repair(record);
    broken.items = [broken.items[1], ...broken.items.slice(1)];
    const bad = verifyBackup({ affected: [{
      where: "interview_transcripts", anchorsAtRisk: 1,
      _original: record, _fixed: broken.items, _removed: broken.removed,
      _evidence: { scoreEvents: [{ afterTurn: 1 }], findingEvents: null },
    }] });
    expect(bad.records[0].anchors[0].status, "a wrong landing passed as the same line").toBe("moved");
  });

  it("a later line that merely starts with the same words is NOT the same line", () => {
    /*
     * M210. The looser rule — "same speaker, starts with the fragment" — passes
     * a remap that lands on the wrong line whenever a later line opens with the
     * same words, and short fragments ("Yes", "I", "So") make that common. Only
     * the fragment's own completion counts.
     */
    const rec: T[] = [
      fr("Interviewee", "Yes", 1), full("Interviewee", "Yes."),
      fr("Interviewer", "And", 2), full("Interviewer", "And the budget?"),
      fr("Interviewee", "Yes,", 3), full("Interviewee", "Yes, and it is separate."),
    ].map((t, i) => ({ ...t, idx: i }));
    const r = repair(rec);
    const wrong = [r.items[2], r.items[1], r.items[0]];       // anchor 1 now lands on "Yes, and it is separate."
    const v = verifyBackup({ affected: [{
      where: "interview_transcripts", anchorsAtRisk: 1,
      _original: rec, _fixed: wrong, _removed: r.removed,
      _evidence: { scoreEvents: [{ afterTurn: 1 }], findingEvents: null },
    }] });
    expect(v.records[0].anchors[0].now).toBe("Yes, and it is separate.");
    expect(v.records[0].anchors[0].status, "a different line passed as the fragment's own").toBe("moved");
  });

  it("counts only the anchors that actually move", () => {
    /* The boundary anchor names the last kept message and never moves; the old
     * "at or past the first removal" rule counted it anyway. */
    const d = dedupe(orig5);
    const map = indexMap(orig5, d.removed);
    const p = d.removed[0].from;
    const moving = anchorsThatMove({ scoreEvents: [{ afterTurn: p }, { afterTurn: orig5.length }] }, map);
    expect(moving.map((m) => m.afterTurn)).toEqual([orig5.length]);
  });

  it("numbers the next migration from what is already there", () => {
    expect(nextMigrationNumber(["001_core.sql", "037_x.sql", "038_dedupe_doubled_transcripts.sql"])).toBe("039");
    expect(nextMigrationNumber(["README.md", "009_a.sql"])).toBe("010");
    expect(nextMigrationNumber([])).toBe("001");
  });

  it("the audit uses the combined repair and the real count of moving anchors", () => {
    expect(src).toMatch(/const d = repair\(turns\);/);
    expect(src).toMatch(/const d = repair\(dm\);/);
    expect(src).toMatch(/anchorsThatMove\(/);
    expect(src, "the audit still detects doublings only").not.toMatch(/const d = dedupe\(turns\)/);
  });

  it("emit refuses a number migrations/ already holds", () => {
    expect(src).toMatch(/Refusing: migrations\/ already has \$\{clash\}/);
    expect(src).toMatch(/A migration that has run is history/);
  });
});
const orig5 = [...FIRST_SITTING, ...replayed(FIRST_SITTING), ...SECOND_SITTING];
