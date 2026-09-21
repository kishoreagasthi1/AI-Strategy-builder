/**
 * The detection behind deploy/dedupe-transcripts.mjs, on its own so it can be
 * tested. (v5.34.122)
 *
 * It decides what gets deleted from client records, so it does not live inline
 * in a script that opens a database connection at import time — a test would
 * then have to rebuild it, and a test that rebuilds the logic proves only that
 * the test works. (That exact mistake cost three surviving mutations in
 * v5.34.120 and is the reason this file exists.)
 *
 * ── The signature ───────────────────────────────────────────────────────────
 *
 * The v5.34.121 defect appended one complete copy of everything said so far,
 * each time a session was resumed. So the shape in the data is a doubled
 * PREFIX: some p where items[0..p) equals items[p..2p), with the rest of the
 * conversation after it.
 *
 * Deliberately NOT "remove adjacent identical messages". A real interview can
 * repeat a short turn — "Yes." twice, an interviewer re-asking after a
 * connection drop — and that rule would eat them. The block structure is what
 * distinguishes a bug from a conversation.
 *
 * Compared on role+text only. The replay went through addMessage, which
 * stamped a fresh timestamp, so the two copies agree on everything except
 * their clocks.
 */

/** A doubled block of one message is plausibly a real interview. Two is not. */
export const MIN_BLOCK = 2;
/** 2^8 copies of a transcript is not a thing; stop rather than spin. */
export const MAX_PASSES = 8;

/* NUL as the separator: it cannot occur in a role, so "ai"+"X Y" can never
 * collide with "ai X"+"Y" the way a space would. Written as an escape rather
 * than a literal NUL byte, which the first draft embedded in the source and
 * which breaks diffs, editors and grep. */
const SEP = "\u0000";

export const key = (m) => {
  if (!m || typeof m !== "object") return JSON.stringify(m);
  const role = m.role ?? m.who ?? "";
  return role + SEP + String(m.text ?? "").trim();
};

/** Largest p >= MIN_BLOCK such that items[0..p) equals items[p..2p). 0 if none. */
export function doubledPrefix(items) {
  const n = items.length;
  for (let p = Math.floor(n / 2); p >= MIN_BLOCK; p--) {
    let same = true;
    for (let i = 0; i < p; i++) {
      if (key(items[i]) !== key(items[p + i])) { same = false; break; }
    }
    if (same) return p;
  }
  return 0;
}

/**
 * Remove every doubled prefix, repeatedly: two resumes leave a doubling inside
 * a doubling.
 *
 * `removed` is expressed against the array as it stood at each pass, which is
 * why indexMap replays the splices rather than treating the offsets as
 * absolute.
 */
export function dedupe(items) {
  let out = items.slice();
  const removed = [];
  let passes = 0;
  for (;;) {
    const p = doubledPrefix(out);
    if (!p) break;
    removed.push({ from: p, to: 2 * p });
    out = out.slice(0, p).concat(out.slice(2 * p));
    passes++;
    if (passes >= MAX_PASSES) break;
  }
  return { items: out, removed, passes };
}

/**
 * Is A the frozen first-fragment copy of B? (v5.34.132)
 *
 * Before v5.34.132 liveAppend stored every live line twice: addMessage's entry,
 * which kept only the first fragment and carried `at`, and its own mirror
 * entry, which grew into the full line and carried no `at`:
 *
 *     {"at":1789647196985, "who":"Interviewer", "text":"Hi Avery,"}
 *     {"at":null,          "who":"Interviewer", "text":"Hi Avery, I'm Jack Smith…"}
 *
 * All three conditions are required, and the third is what keeps this from
 * eating a real conversation. Same speaker and prefix alone would take a
 * genuine "Yes." followed by "Yes, and the budget is separate." The `at`
 * fingerprint — timed first, untimed second — is produced by this defect and
 * by nothing else in the page: every other writer goes through addMessage,
 * which always stamps it. On the 2026-09-18 record it held for all 52 pairs
 * with no exception, and no prefix pair existed without it.
 *
 * Equal text counts. Half of the real pairs were word-for-word copies: an
 * interviewee's transcription often lands as a single fragment.
 */
export function isFrozenFragment(A, B) {
  if (!A || !B || typeof A !== "object" || typeof B !== "object") return false;
  const ra = A.role ?? A.who, rb = B.role ?? B.who;
  if (ra == null || ra !== rb) return false;
  const a = String(A.text ?? "").trim(), b = String(B.text ?? "").trim();
  if (!a || !b.startsWith(a)) return false;
  return A.at !== null && A.at !== undefined && (B.at === null || B.at === undefined);
}

/**
 * Collapse every frozen-fragment pair into one entry. (v5.34.132)
 *
 * The full line survives; it takes the fragment's `at` (and display timestamp),
 * which is when the line STARTED — the survivor never had one.
 *
 * `removed` is in the same sequential-splice coordinates as dedupe()'s, with
 * kind "fragment" so indexMap twins each removed fragment to the line after it.
 * A pair is consumed whole, so a merged line is never re-read as the first half
 * of the next pair — two consecutive lines from one speaker stay two lines.
 */
export function collapseFragments(items) {
  const out = [];
  const removed = [];
  let i = 0;
  while (i < items.length) {
    const A = items[i], B = items[i + 1];
    if (i + 1 < items.length && isFrozenFragment(A, B)) {
      removed.push({ from: out.length, to: out.length + 1, kind: "fragment" });
      const merged = { ...B, at: A.at };
      if (A.timestamp != null && B.timestamp == null) merged.timestamp = A.timestamp;
      out.push(merged);
      i += 2;
    } else {
      out.push(A);
      i += 1;
    }
  }
  return { items: out, removed, collapsed: removed.length };
}

/**
 * Both repairs, in the order the defects compose. (v5.34.132)
 *
 * The resume replay copied the first sitting — fragment pairs and all — through
 * addMessage, which stamped `at` on every copy. So the replayed block carries no
 * fingerprint and would not collapse; it has to be removed as a doubling first,
 * and then the ORIGINAL sitting's pairs collapse.
 */
export function repair(items) {
  const d = dedupe(items);
  const c = collapseFragments(d.items);
  return { items: c.items, removed: d.removed.concat(c.removed), passes: d.passes, collapsed: c.collapsed };
}

/**
 * The anchors a repair actually moves. (v5.34.132)
 *
 * anchorsAtRisk counts everything at or past the first removed block, which was
 * exact while the only repair was one doubling. Fragment pairs start at message
 * zero, and a record can hold both, so "past the first removal" no longer says
 * which anchors move. This asks the remap itself.
 */
export function anchorsThatMove(record, map) {
  const out = [];
  for (const name of ["scoreEvents", "findingEvents"]) {
    const arr = Array.isArray(record?.[name]) ? record[name] : [];
    for (const e of arr) {
      const a = Number(e?.afterTurn);
      if (!Number.isFinite(a)) continue;
      if (Number(shiftAnchor(e.afterTurn, map)) !== a) out.push({ list: name, afterTurn: a });
    }
  }
  return out;
}

/**
 * The next free migration number, from the files already there. (v5.34.132)
 *
 * The first emitter defaulted to "038", which was right exactly once.
 */
export function nextMigrationNumber(files) {
  let max = 0;
  for (const f of Array.isArray(files) ? files : []) {
    const m = /^(\d+)_.*\.sql$/.exec(String(f));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return String(max + 1).padStart(3, "0");
}

/**
 * oldIndex -> newIndex, for EVERY original index including the removed ones.
 *
 * A removed message resolves to its surviving twin rather than to nothing, and
 * that distinction is the whole point of this function. The first draft
 * returned -1 for removed indices and shiftAnchor then left such anchors
 * unchanged — on the reasoning that a duplicate "has an identical twin in the
 * original anyway". True, and irrelevant: leaving the NUMBER alone does not
 * land on the twin, it lands on whatever now occupies that position. In the
 * 2026-09-18 shape an anchor of 9 pointed at the first line of the replayed
 * copy and, unmoved, came to rest on "Welcome back, Avery" — a finding from the
 * opening minute re-attached to the start of the second sitting.
 *
 * Caught by dedupeDoubledTranscripts.test.ts before this ran against anything.
 *
 * The twin is known structurally: at each pass the item spliced out at position
 * from+i is a copy of the item at position i, in that pass's coordinates. Those
 * pairings are recorded as they happen and resolved transitively at the end,
 * because a twice-resumed transcript removes a block that itself contains
 * removed blocks.
 */
export function indexMap(original, removed) {
  let live = original.map((_, i) => i);
  const twinOf = new Map();          // original index -> original index it copies
  for (const r of removed) {
    /* A doubled block's element i is a copy of the element p places BEFORE it.
     * A frozen fragment (v5.34.132) is the first draft of the element right
     * AFTER it — the line it grew into. Same bookkeeping, other direction. */
    for (let i = r.from; i < r.to; i++) {
      twinOf.set(live[i], r.kind === "fragment" ? live[r.to + (i - r.from)] : live[i - r.from]);
    }
    live = live.slice(0, r.from).concat(live.slice(r.to));
  }
  const pos = new Map();
  live.forEach((orig, i) => pos.set(orig, i));
  const resolve = (i, guard = 0) => {
    if (pos.has(i)) return pos.get(i);
    if (guard > MAX_PASSES || !twinOf.has(i)) return -1;
    return resolve(twinOf.get(i), guard + 1);
  };
  const map = new Map();
  original.forEach((_, i) => map.set(i, resolve(i)));
  return map;
}

/**
 * Move one evidence anchor.
 *
 * `afterTurn` is `S.displayMessages.length` at the moment the finding was
 * recorded (interview_agent.html) — a COUNT of the messages before it, not an
 * index. So it names the boundary just after item afterTurn-1, and it moves to
 * that item's new position plus one.
 *
 * An anchor on a message that was REMOVED is resolved to that message's
 * surviving twin by indexMap, so it still names the same words. It is left
 * untouched only when there is no twin to resolve to, which cannot happen for
 * a doubling but can for a malformed record — and leaving it alone is the right
 * answer there, because moving it would be a guess.
 */
export function shiftAnchor(afterTurn, map) {
  /*
   * Coerces exactly the way anchorsAtRisk does, and that agreement is the
   * point rather than an accident.
   *
   * The first draft required a strict `typeof === "number"` here while the risk
   * detector used Number(). A jsonb record holding afterTurn as the string
   * "20" was therefore REPORTED as evidence that would move, and then silently
   * left where it was — the audit promising a remap that never happened. Two
   * halves of one decision, disagreeing: this project's recurring shape, found
   * by a surviving mutation rather than by a failing test.
   *
   * There were two explicit guards here — one for null/undefined, one for
   * non-positive values. Mutation testing showed neither could be made to fail
   * a test, because both are already covered by the lookup: Number(null) is 0,
   * map.get(-1) is undefined, and `to == null` returns the input untouched. So
   * every degenerate anchor — missing, zero, negative, a word, an object —
   * funnels through the same path and comes back exactly as it arrived.
   *
   * Removed rather than kept as unfalsifiable defence, the same call made on
   * RECAP_MIN_WORDS in v5.34.120. The property they were protecting is now
   * asserted directly instead, across the whole range of bad input, so it is
   * held by a test rather than by construction.
   */
  const to = map.get(Number(afterTurn) - 1);
  return to === -1 || to == null ? afterTurn : to + 1;
}

/** Anchors that sit at or past the first removed block — the ones that move. */
export function anchorsAtRisk(record, firstRemovedAt) {
  const out = [];
  for (const name of ["scoreEvents", "findingEvents"]) {
    const arr = Array.isArray(record?.[name]) ? record[name] : [];
    for (const e of arr) {
      const a = Number(e?.afterTurn);
      if (Number.isFinite(a) && a >= firstRemovedAt) out.push({ list: name, afterTurn: a });
    }
  }
  return out;
}

/**
 * Point a Cloud Run DSN at the local cloud-sql-proxy. (v5.34.124)
 *
 * The DSN in Secret Manager is the one Cloud Run uses, and it names a unix
 * socket — `?host=/cloudsql/<instance>` — that exists only inside Cloud Run.
 * Used as-is from a laptop it fails with
 *
 *     connect ENOENT /cloudsql/vyne-platform-prod:us-central1:vyne-sql/.s.PGSQL.5432
 *
 * The alternative was asking the operator to retype the DSN with the host
 * swapped, which means putting a production password on their clipboard and in
 * their shell history to work around a thing the script can do itself.
 *
 * So: if the DSN names a unix socket, rewrite the host to the proxy and drop
 * the socket parameter. Anything already pointing at a host and port is left
 * exactly alone — someone who passed a deliberate DSN gets the DSN they passed.
 *
 * The password is never parsed out, logged, or reassembled by hand; URL
 * re-serialisation preserves it percent-encoded as written.
 */
export function resolveDsn(raw, proxyPort = 5433) {
  if (!raw) return { dsn: raw, rewritten: false };
  /*
   * The commonest Cloud Run shape has NO host at all —
   *   postgres://user:pw@/vyne?host=/cloudsql/<instance>
   * — and new URL() throws Invalid URL on it. The first cut caught that and
   * returned the DSN unchanged, which meant the one shape this function exists
   * to repair was the one it silently declined to touch. A placeholder host
   * makes it parseable; it is overwritten two lines later either way.
   */
  const parseable = String(raw).replace(/^([a-z+]+:\/\/[^/?#]*@)(\/)/i, "$1placeholder.invalid$2");
  let u;
  try { u = new URL(parseable); } catch { return { dsn: raw, rewritten: false }; }
  const hadNoHost = parseable !== String(raw);
  const socketParam = u.searchParams.get("host");
  const usesSocket = (socketParam && socketParam.startsWith("/")) || hadNoHost || u.hostname === "";
  if (!usesSocket) return { dsn: raw, rewritten: false };
  const was = socketParam || "(no host)";
  u.searchParams.delete("host");
  u.hostname = "127.0.0.1";
  u.port = String(proxyPort);
  return { dsn: u.toString(), rewritten: true, was };
}

/**
 * Rewrite every anchor in one evidence list. (v5.34.126)
 *
 * Lifted out of the apply path so the thing that rewrites client evidence is
 * the thing the tests call. It was previously a closure defined inside the
 * `if (REMAP)` branch of a script that opens a database connection at import
 * time — testable only by rebuilding it, which is the v5.34.120 mistake.
 *
 * Non-arrays pass through untouched (null and undefined are how a record with
 * no evidence is stored), as does any element that is not an object carrying an
 * afterTurn — a malformed entry is left exactly as found rather than repaired
 * on a guess.
 */
export function remapEvidence(arr, map) {
  if (!Array.isArray(arr)) return arr;
  return arr.map((e) =>
    e && typeof e === "object" && "afterTurn" in e ? { ...e, afterTurn: shiftAnchor(e.afterTurn, map) } : e);
}

/**
 * Is this the transcript the audit read? (v5.34.126)
 *
 * The audit and the apply are two separate runs of this script, separated by
 * however long the operator takes to read the output. In between, the very
 * thing being repaired — a live interview — can save again. The apply path then
 * writes `_fixed`, computed from a transcript that is no longer there, over
 * whatever arrived since.
 *
 * Compared on role+text, the same key the detection uses: the two copies of a
 * doubling differ only in their clocks, so a comparison that included `at` would
 * refuse to repair records it should repair.
 */
export function sameTranscript(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (key(a[i]) !== key(b[i])) return false;
  return true;
}

/**
 * May this backed-up record be written over what is in the database now?
 * (v5.34.126)
 *
 * The whole decision, in one place with a return value, rather than three
 * `continue`s inside a transaction loop that only a live database could reach.
 * A guard that can only be tested by asserting its source text is a guard that
 * `if (false && ...)` disables without a single test going red — which is
 * exactly what mutation M151 demonstrated.
 *
 * `current` is the row as it stands now: the turns array (interview_transcripts)
 * or the session record (module_state), or null/undefined when the row is no
 * longer there at all.
 *
 *   gone     — nothing to write to. The row was deleted, or the archive entry
 *              is no longer at the index the audit recorded.
 *   changed  — something is there, but it is not what was audited. `_fixed` was
 *              computed from a transcript that has since moved on, so writing it
 *              would replace a newer conversation with an older one.
 */
export function applyDecision(record, current) {
  if (current == null) return { write: false, reason: "gone" };
  const turns = Array.isArray(current) ? current : current.displayMessages;
  if (!Array.isArray(turns)) return { write: false, reason: "gone" };
  if (!sameTranscript(turns, record && record._original)) return { write: false, reason: "changed" };
  return { write: true, reason: null };
}

const flat = (t, width) => String((t || {}).text ?? "").replace(/\s+/g, " ").slice(0, width);
const clip = (arr, n, width) => flat(arr[n - 1], width);

/*
 * ── v5.34.130: resolve an anchor the way the review page does ───────────────
 *
 * interviews.html attaches evidence with `byTurn[turn.idx + 1]`, where idx is
 * the turn's index as the server recorded it — falling back to the array
 * position only when a turn has no idx. It never uses the position when an idx
 * is there.
 *
 * Every check in this file before v5.34.130 resolved anchors by POSITION. On
 * the 2026-09-18 record those two agreed in the original (idx equalled position
 * for all 170 turns), and stopped agreeing after the repair: the kept turns kept
 * their idx — 0..65, then 132..169 — while the anchors were moved by position.
 * --verify-backup reported all 63 anchors SAME. On the page, 14 of them would
 * have landed on no turn at all and been swept into "After the final exchange".
 *
 * The verifier had checked a model of the consumer rather than the consumer.
 * So this is the page's rule, lifted, and every anchor check goes through it.
 */
export function pageTurn(turns, afterTurn) {
  if (!Array.isArray(turns)) return undefined;
  const k = Number(afterTurn) - 1;
  if (!Number.isFinite(k)) return undefined;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const at = t && typeof t === "object" && t.idx !== null && t.idx !== undefined ? Number(t.idx) : i;
    if (at === k) return t;
  }
  return undefined;
}

/**
 * Give the kept turns the idx their new positions imply. (v5.34.130)
 *
 * The original data held idx === position for every turn; the repair has to
 * leave it that way, or the review page and every position-based reader stop
 * agreeing about which turn an anchor names. Turns without an idx (module_state
 * sessions never had one) are left exactly as they are.
 */
export function renumberIdx(fixed) {
  if (!Array.isArray(fixed)) return fixed;
  if (!fixed.some((t) => t && typeof t === "object" && "idx" in t)) return fixed;
  return fixed.map((t, i) => (t && typeof t === "object" && "idx" in t ? { ...t, idx: i } : t));
}

/**
 * Does every turn's idx equal its position? (v5.34.130)
 *
 * The server filters blank messages out of `turns` and records each survivor's
 * ORIGINAL index, so an interview with a blank turn has idx ahead of position
 * from that point on — anchors then live in a coordinate system with holes the
 * repair cannot see. The doubling detection and the remap both work in
 * positions, so a record like that is refused rather than repaired on a guess.
 * The 2026-09-18 record has no such gap; this is the case nobody has run.
 */
export function idxMatchesPosition(turns) {
  if (!Array.isArray(turns)) return true;
  return turns.every((t, i) => !(t && typeof t === "object") || t.idx === null || t.idx === undefined
    || Number(t.idx) === i);
}

/** The transcript as it will actually be written. */
export const fixedForWrite = (a) => renumberIdx(a && a._fixed);

/**
 * Replay the repair from a backup file and check every anchor, with no database
 * and nothing written. (v5.34.126)
 *
 * The tests prove the remap lands on the same words for a synthetic transcript.
 * They say nothing about the record on this operator's database — 170 messages,
 * one 66-message doubling, seventeen anchors past it. Seventeen findings
 * silently re-attached to the wrong answer, inside the record a client
 * deliverable quotes, is not a thing to take on faith in a fixture.
 *
 * Returns, per anchor, the message it names now and the message it would name
 * afterwards, with a status:
 *
 *   same          — the repair preserves it. The only good outcome.
 *   moved         — it would come to rest on different words. Do not apply.
 *   unverifiable  — it names no message in the original at all (a malformed
 *                   record), so there is nothing to compare and nothing this
 *                   can promise.
 *
 * A backup written before v5.34.126 has no `_evidence`, so the anchors most at
 * risk are the ones it cannot check. That is reported as `evidenceMissing`
 * rather than as an absence of anchors — "no evidence found" and "I cannot see
 * the evidence" are the distinction this whole tool exists to keep, and the
 * v5.34.125 all-clear is what happens when it is lost.
 */
export function verifyBackup(backup, width = 76) {
  const recs = (backup && Array.isArray(backup.affected)) ? backup.affected : [];
  const out = { records: [], checked: 0, mismatches: 0, evidenceMissing: 0 };

  for (const a of recs) {
    const orig = Array.isArray(a._original) ? a._original : [];
    /* What will be WRITTEN, not the intermediate array: the idx renumbering
     * happens between the two, and it is what the page resolves anchors by. */
    const fixed = Array.isArray(a._fixed) ? fixedForWrite(a) : [];
    const removed = Array.isArray(a._removed) ? a._removed : [];
    const map = indexMap(orig, removed);
    const from = (removed[0] && removed[0].from) || 0;

    const seam = [];
    for (let i = Math.max(1, from - 1); i <= Math.min(fixed.length, from + 2); i++) {
      seam.push({ n: i, text: clip(fixed, i, width) });
    }

    const ev = a._evidence;
    const hasEvidence = !!ev && typeof ev === "object";
    /* A backup that predates _evidence AND has anchors the audit said would
     * move: the one case that must not read as "nothing to remap". */
    const blind = !hasEvidence && Number(a.anchorsAtRisk) > 0;
    if (blind) out.evidenceMissing++;

    const anchors = [];
    for (const name of ["scoreEvents", "findingEvents"]) {
      const arr = hasEvidence ? ev[name] : null;
      if (!Array.isArray(arr)) continue;
      arr.forEach((e, i) => {
        if (!e || typeof e !== "object" || !("afterTurn" in e)) return;
        const to = shiftAnchor(e.afterTurn, map);
        const before = pageTurn(orig, e.afterTurn);
        const after = pageTurn(fixed, to);
        let status;
        if (!before) status = "unverifiable";
        else if (after && flat(before, width) === flat(after, width)) status = "same";
        else {
          /* v5.34.132 — an anchor that named a frozen fragment now names the
           * full line it grew into. That is the same spoken line, and it is
           * accepted ONLY when the fragment really was one — the line after it
           * in the original is its untimed completion — and the anchor lands on
           * exactly that completion. Anything looser would let a wrong remap
           * pass for any later line that happens to start with the same words. */
          const bi = orig.indexOf(before);
          const next = bi >= 0 ? orig[bi + 1] : undefined;
          status = after && next && isFrozenFragment(before, next) && flat(after, width) === flat(next, width)
            ? "same-line" : "moved";
        }
        out.checked++;
        if (status !== "same" && status !== "same-line") out.mismatches++;
        anchors.push({
          list: name, index: i, from: e.afterTurn, to, status,
          was: before ? flat(before, width) : null,
          now: after ? flat(after, width) : null,
        });
      });
    }

    out.records.push({
      client: a.client ?? null, stakeholder: a.stakeholder ?? null, where: a.where ?? null,
      before: orig.length, after: fixed.length,
      doublings: Number(a.passes) || 0, collapsed: Number(a.collapsed) || 0,
      anchorsAtRisk: Number(a.anchorsAtRisk) || 0,
      evidenceMissing: blind, seam, anchors,
    });
  }
  return out;
}

/**
 * May this backup be applied? (v5.34.127)
 *
 * ── The hole this closes ────────────────────────────────────────────────────
 *
 * `--apply --backup <file>` used to re-run the whole scan and apply what the
 * scan found, while `--verify-backup <file>` checked the FILE. Two sides of one
 * decision, reading different things — this project's recurring shape, and here
 * it made the verification advisory: the operator proved the remap on a file,
 * and the apply then went off and did its own arithmetic on whatever was in the
 * database at that moment. Worse, the scan wrote its result over the file being
 * applied, so the verified backup was destroyed on the way past.
 *
 * The staleness guard added in v5.34.126 could not fire either: it compared a
 * freshly scanned `_original` against rows read seconds later, so there was
 * nothing for it to catch.
 *
 * Now the apply loads the backup and applies THAT, and this is the gate in
 * front of it. The file the operator verified is the file that gets written,
 * and `verifyBackup` runs again here so the proof is a precondition of writing
 * rather than a step that can be skipped.
 */
export function applyPreflight(backup, remap) {
  const affected = backup && Array.isArray(backup.affected) ? backup.affected : null;
  if (!affected) return { ok: false, reason: "unreadable", report: null };
  if (!affected.length) return { ok: false, reason: "empty", report: null };

  /* v5.34.130 — a coordinate system with holes in it is not one the remap
   * understands. Refused on every path, remap or not: even without moving
   * anchors, renumbering idx on such a record would change what they name. */
  if (affected.some((a) => !idxMatchesPosition(a && a._original))) {
    return { ok: false, reason: "idx-gaps", report: verifyBackup(backup) };
  }

  const report = verifyBackup(backup);
  /* Both only matter when the anchors are actually going to be rewritten.
   * Without --remap-anchors, every record carrying anchors is skipped anyway. */
  if (remap && report.evidenceMissing) return { ok: false, reason: "evidence-missing", report };
  if (remap && report.mismatches) return { ok: false, reason: "anchors-move", report };
  return { ok: true, reason: null, report };
}

/**
 * Which tables a backup's repair will have to write to. (v5.34.128)
 *
 * Derived from the backup rather than assumed, because a run that only has
 * saved sessions to repair should not be refused for lacking UPDATE on
 * interview_transcripts, and vice versa.
 */
export function tablesToWrite(affected) {
  const out = new Set();
  for (const a of Array.isArray(affected) ? affected : []) {
    if (a && a.where === "interview_transcripts") out.add("interview_transcripts");
    else if (a && a.where === "module_state") out.add("module_state");
  }
  return [...out].sort();
}

/**
 * Read a privilege report and decide whether the repair can proceed.
 * (v5.34.128)
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The first live apply got as far as opening a transaction and then died on
 *
 *     permission denied for table interview_transcripts
 *
 * The DSN in Secret Manager is the application's — `vyne_app` — which has
 * SELECT on that table and not UPDATE. That is defensible on the application's
 * side: it inserts a submitted transcript and never edits one. It is not
 * something to discover halfway through a repair.
 *
 * A missing GRANT is not the same failure as a row-level-security denial, and
 * the difference matters: RLS returns zero rows and no error, a missing grant
 * raises. Both end with nothing written, and only one of them is fixed by
 * setting app.tenant_id — so the report distinguishes them rather than leaving
 * the operator to guess which wall they hit.
 */
export function accessVerdict(rows, needed) {
  const byName = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.table, r]));
  const problems = [];
  for (const t of Array.isArray(needed) ? needed : []) {
    const r = byName.get(t);
    if (!r) { problems.push({ table: t, missing: "the table is not visible at all" }); continue; }
    if (!r.can_select) problems.push({ table: t, missing: "SELECT" });
    if (!r.can_update) problems.push({ table: t, missing: "UPDATE" });
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Swap the role in a DSN, keeping everything else. (v5.34.128)
 *
 * The DSN in Secret Manager belongs to the application role, which has SELECT
 * on interview_transcripts and not UPDATE. The repair needs the owner. The
 * alternative was granting the app role UPDATE on a table it never edits — a
 * permanent widening of the application's reach to get one migration done —
 * or asking the operator to retype a DSN with a production password in it.
 *
 * So the credentials are swapped here, from environment variables the operator
 * pipes straight out of Secret Manager. The password is set through the URL
 * object, which percent-encodes it correctly; a hand-assembled DSN turns a
 * password containing @ or / into a confusing auth failure.
 */
export function withOwner(dsn, user, password) {
  if (!dsn || !user) return { dsn, swapped: false };
  let u;
  try { u = new URL(dsn); } catch { return { dsn, swapped: false }; }
  /*
   * encodeURIComponent rather than assigning raw, and the difference is not
   * cosmetic: the URL setter percent-encodes the characters it knows about but
   * leaves a bare `%` exactly as written, so a raw assignment produces a DSN
   * that no longer round-trips through decodeURIComponent.
   *
   * And the decode of the OUTGOING name is guarded, because it reads a string
   * this code did not write. A DSN carrying a stray `%` in its username made
   * decodeURIComponent throw URIError — killing the script at connect time,
   * before it had done anything, with an error about URI decoding. Found by
   * chasing a surviving mutation rather than by anything going wrong.
   */
  const was = safeDecode(u.username || "");
  u.username = encodeURIComponent(user);
  if (password != null) u.password = encodeURIComponent(password);
  return { dsn: u.toString(), swapped: true, was, now: user };
}

/** decodeURIComponent that returns the input rather than throwing on bad input. */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * Emit the verified repair as a migration. (v5.34.129)
 *
 * ── Why the standalone script cannot do this ────────────────────────────────
 *
 * interview_transcripts is deliberately append-only. Migration 024 says so in
 * as many words — "there is still no UPDATE grant and no UPDATE policy, so a
 * transcript remains unmodifiable in place" — and replaced the FOR ALL policy
 * with tenant_read (FOR SELECT) and tenant_write (FOR INSERT). FORCE ROW LEVEL
 * SECURITY binds the table owner too, so even `vyne` reads the row and matches
 * zero rows on UPDATE. The first live apply as the owner failed exactly there,
 * and the rowCount guard rolled it back.
 *
 * That is an invariant, not an obstacle, and quietly adding an UPDATE policy to
 * get around it would remove a guarantee somebody chose on purpose.
 *
 * The house pattern for repairing data in these tables is a migration: 026
 * drops FORCE, does its backfill, and puts FORCE back, all inside the one
 * transaction the runner wraps each file in. So the repair is emitted in that
 * shape, generated from the backup that was verified rather than hand-written,
 * carrying the same guards the script carries:
 *
 *   - the row must still look exactly like the one that was audited (its length
 *     is checked before the write), or the migration RAISEs and rolls back;
 *   - every UPDATE must match exactly one row, or it RAISEs;
 *   - the new length is asserted after the write, in the same transaction.
 *
 * The JSON is dollar-quoted with a tag proven absent from the content, so no
 * quote in a transcript can end the literal early.
 */
export function emitMigration(backup, opts = {}) {
  const pre = applyPreflight(backup, opts.remap !== false);
  if (!pre.ok) return { ok: false, reason: pre.reason, sql: null, report: pre.report };

  const affected = backup.affected;
  const tables = tablesToWrite(affected);
  const number = opts.number || "038";
  const name = opts.name || "dedupe_doubled_transcripts";

  /* A dollar-quote tag that cannot appear in what it wraps. Transcripts are
   * arbitrary text; a fixed tag is a quoting bug waiting for the interviewee
   * who says the wrong thing. */
  const everything = JSON.stringify(affected);
  let tag = "mig";
  while (everything.includes(`$${tag}$`)) tag += "x";
  /*
   * The OUTER block is a dollar-quote too. v5.34.129 wrapped every record in
   * `DO $$ ... $$` and guarded only the inner tag, so a transcript containing
   * "$$" — a speaker saying "$$" is unlikely, a pasted figure is not — would
   * have closed the DO body in the middle of the data and turned the rest of
   * the interview into SQL. Found by reading the generated file against a real
   * record before it went near production, not by anything failing.
   */
  let outer = "do";
  while (everything.includes(`$${outer}$`) || outer === tag) outer += "x";
  const q = (v) => `$${tag}$${JSON.stringify(v)}$${tag}$`;

  const L = [];
  L.push(`-- ${number}_${name}.sql`);
  L.push("--");
  L.push("-- Repair transcripts stored with duplicate entries: the v5.34.121 resume");
  L.push("-- doubling, and the frozen first-fragment copy liveAppend stored beside");
  L.push("-- every spoken line until v5.34.132.");
  L.push("--");
  L.push("-- GENERATED from a verified backup by deploy/dedupe-transcripts.mjs");
  L.push("--");
  L.push("-- !! CONTAINS CLIENT INTERVIEW CONTENT VERBATIM. DO NOT COMMIT THIS FILE.");
  L.push("--    Apply it, move it to backend/repair-archive/ (git-ignored), and commit");
  L.push("--    a stub under the same name in its place — see 038 and 039. The runner");
  L.push("--    keys on the file name, so the stub is equivalent everywhere.");
  L.push("--    migrationsCarryNoInterviewContent.test.ts fails until that is done.");
  L.push(`--   backup taken at: ${backup.takenAt || "(not recorded)"}`);
  L.push(`--   records:         ${affected.length}`);
  L.push(`--   anchors checked: ${pre.report.checked}, every one naming the same message after the repair`);
  L.push("--");
  L.push("-- ── Why this is a migration and not a script ────────────────────────────────");
  L.push("--");
  L.push("-- 024 removed the FOR ALL policy on interview_transcripts and left no UPDATE");
  L.push("-- grant and no UPDATE policy: a submitted transcript is unmodifiable in place,");
  L.push("-- on purpose. FORCE ROW LEVEL SECURITY binds the owner too, so a repair run as");
  L.push("-- `vyne` reads the row and matches zero rows on UPDATE — which is what happened,");
  L.push("-- and the rowCount check rolled it back.");
  L.push("--");
  L.push("-- So this follows 026: drop FORCE, do the work, put FORCE back, inside the one");
  L.push("-- transaction the runner wraps each file in. The invariant is restored before");
  L.push("-- the file ends; it is not weakened.");
  L.push("--");
  L.push("-- The runner wraps each file in a transaction. Applying this BY HAND REQUIRES");
  L.push("-- BEGIN/COMMIT, or a failure below leaves RLS off on a table holding client");
  L.push("-- interviews.");
  L.push("");
  L.push("-- ── RLS off for the repair ──────────────────────────────────────────────────");
  for (const t of tables) {
    L.push(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;`);
    L.push(`ALTER TABLE ${t} DISABLE  ROW LEVEL SECURITY;`);
  }
  L.push("");

  affected.forEach((a, i) => {
    const map = indexMap(a._original, a._removed);
    const ev = a._evidence || {};
    const before = a._original.length, after = a._fixed.length;
    L.push(`-- ── record ${i + 1} of ${affected.length}: ${String(a.client || "?").replace(/[\r\n]/g, " ")} · ${String(a.stakeholder || "?").replace(/[\r\n]/g, " ")} ──`);
    L.push(`-- ${before} messages → ${after}`);
    L.push(`DO $${outer}$`);
    L.push("DECLARE n int; hit int;");
    L.push("BEGIN");
    if (a.where === "interview_transcripts") {
      L.push(`  SELECT jsonb_array_length(turns) INTO n FROM interview_transcripts WHERE id = '${a.id}';`);
      L.push("  IF n IS NULL THEN");
      /* v5.34.131 — absent is "nothing to repair here", not an error. This file
       * lives in migrations/ for good and runs against every FRESH database —
       * it-db.sh, the test suites, the gates deploy.sh runs before shipping —
       * none of which hold this client's row. Raising here would have blocked
       * the next deploy on a repair that had already succeeded. 026 no-ops on
       * empty data for the same reason. A row that IS present but the wrong
       * length still raises: that is the case the guard exists for. */
      L.push(`    RAISE NOTICE '${number}: transcript ${a.id} is not in this database — nothing to repair here.';`);
      L.push("    RETURN;");
      L.push("  END IF;");
      L.push(`  IF n <> ${before} THEN`);
      L.push(`    RAISE EXCEPTION '${number}: transcript ${a.id} holds % messages, not the ${before} that were audited and verified. Re-run the audit.', n;`);
      L.push("  END IF;");
      L.push("");
      L.push("  UPDATE interview_transcripts");
      L.push(`     SET turns       = ${q(fixedForWrite(a))}::jsonb,`);
      L.push(`         turn_count  = ${after},`);
      L.push(`         score_events = ${ev.scoreEvents ? `${q(remapEvidence(ev.scoreEvents, map))}::jsonb` : "NULL"},`);
      L.push(`         findings     = ${ev.findingEvents ? `${q(remapEvidence(ev.findingEvents, map))}::jsonb` : "NULL"}`);
      L.push(`   WHERE id = '${a.id}';`);
    } else {
      L.push(`  SELECT jsonb_array_length(${a.arrayIndex == null ? "value" : `value -> ${a.arrayIndex}`} -> 'displayMessages') INTO n`);
      L.push(`    FROM module_state WHERE module = '${a.module}' AND key = '${a.key}';`);
      L.push("  IF n IS NULL THEN");
      L.push(`    RAISE NOTICE '${number}: ${a.key} is not in this database — nothing to repair here.';`);
      L.push("    RETURN;");
      L.push("  END IF;");
      L.push(`  IF n <> ${before} THEN`);
      L.push(`    RAISE EXCEPTION '${number}: ${a.key} holds % messages, not the ${before} that were audited and verified. Re-run the audit.', n;`);
      L.push("  END IF;");
      L.push("");
      const path = a.arrayIndex == null ? "" : `'{${a.arrayIndex}}'`;
      const base = a.arrayIndex == null ? "value" : `value -> ${a.arrayIndex}`;
      L.push("  UPDATE module_state");
      L.push(`     SET value = ${a.arrayIndex == null ? "" : `jsonb_set(value, ${path}, `}` +
                 `${base} || jsonb_build_object(` +
                 `'displayMessages', ${q(fixedForWrite(a))}::jsonb` +
                 (ev.scoreEvents ? `, 'scoreEvents', ${q(remapEvidence(ev.scoreEvents, map))}::jsonb` : "") +
                 (ev.findingEvents ? `, 'findingEvents', ${q(remapEvidence(ev.findingEvents, map))}::jsonb` : "") +
                 `)${a.arrayIndex == null ? "" : ")"},`);
      L.push("         updated_at = now()");
      L.push(`   WHERE module = '${a.module}' AND key = '${a.key}';`);
    }
    L.push("  GET DIAGNOSTICS hit = ROW_COUNT;");
    L.push("  IF hit <> 1 THEN");
    L.push(`    RAISE EXCEPTION '${number}: the UPDATE matched % rows, not 1. Nothing is being committed.', hit;`);
    L.push("  END IF;");
    L.push("");
    if (a.where === "interview_transcripts") {
      L.push(`  SELECT jsonb_array_length(turns) INTO n FROM interview_transcripts WHERE id = '${a.id}';`);
    } else {
      L.push(`  SELECT jsonb_array_length(${a.arrayIndex == null ? "value" : `value -> ${a.arrayIndex}`} -> 'displayMessages') INTO n`);
      L.push(`    FROM module_state WHERE module = '${a.module}' AND key = '${a.key}';`);
    }
    L.push(`  IF n <> ${after} THEN`);
    L.push(`    RAISE EXCEPTION '${number}: after the repair it holds % messages, not ${after}.', n;`);
    L.push("  END IF;");
    L.push(`  RAISE NOTICE '${number}: repaired ${before} messages to %', n;`);
    L.push(`END $${outer}$;`);
    L.push("");
  });

  L.push("-- ── RLS back on ─────────────────────────────────────────────────────────────");
  for (const t of tables) {
    L.push(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
    L.push(`ALTER TABLE ${t} FORCE  ROW LEVEL SECURITY;`);
  }
  L.push("");
  L.push("-- The policies are untouched: interview_transcripts still has no UPDATE policy");
  L.push("-- and no UPDATE grant, and a submitted transcript is unmodifiable in place again");
  L.push("-- the moment this file commits.");
  L.push("");
  return { ok: true, reason: null, sql: L.join("\n"), report: pre.report, tables };
}

/** The DSN with its password replaced, safe to print. */
export function redactDsn(dsn) {
  try {
    const u = new URL(dsn);
    if (u.password) u.password = "***";
    return u.toString();
  } catch { return "(unparseable DSN)"; }
}
