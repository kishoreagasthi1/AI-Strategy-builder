/**
 * Tracker → Synthesis auto-flow (server-side).
 *
 * A CONSULTANT-run interview (same browser tab, interview_agent.html) writes
 * straight into the shared 'workspace' module_state — its own client-side
 * writeInterviewToEngagement() bridge folds the finished interview into
 * vynora_engagement_<code> the instant "Finish & Submit" runs.
 *
 * A DISTRIBUTED interview (the interviewee's own login) can never do that:
 * interviewees are sandboxed to a private per-interview module_state
 * namespace (iv_<id>) and cannot read or write 'workspace' at all (see
 * auth/clients.ts + vyne-client.js's INTERVIEWEE branch). Their finished
 * session — scores, findings, transcript — sat only in that private
 * namespace; the previous workflow required a consultant to click "Session"
 * in the tracker, download the raw JSON, and hand-import it into the
 * Synthesis Dashboard.
 *
 * This module is the missing half of the bridge: a pure, server-side port of
 * writeInterviewToEngagement() that POST /api/interviews/mine/complete calls
 * (with the platform's own tenant-scoped DB access, not the interviewee's)
 * to fold their private session into the SAME shared engagement record —
 * same round/score/upsert semantics a consultant-run session already gets,
 * so Synthesis sees it immediately with no manual export/import step.
 */

import {
  computeRoundScores,
  isRefreshRound,
  lowestRoundNumber,
  priorScoresFor,
  roundEventRollup,
  TIER_WEIGHT,
  type ScoringInterview,
} from "./scoring.js";

export interface SessionRecord {
  sessionId?: string;
  sessionCode?: string;
  client?: string;
  stakeholderRole?: string;
  stakeholderName?: string;
  industry?: string;
  scores?: Record<string, number>;
  findings?: { dimension: string; text: string }[];
  isRefresh?: boolean;
  refreshRound?: number | null;
  refreshScope?: string[];
  coverageByDim?: Record<string, number>;
  /** v5.34.93: the lead/cover/light tiering that governed this interview. */
  dimTiers?: Record<string, string>;
  eventDriven?: boolean;
  eventContext?: unknown;
  eventCoveredDims?: string[];
  lastSaved?: number;
}

export interface EngagementRound {
  roundId: string;
  roundNumber: number;
  label: string;
  type: string;
  date: string;
  scopeDimensions: string[];
  interviews: Record<string, unknown>[];
  scores: Record<string, number>;
  status: string;
  /* v5.34.96 — external-event attribution, DERIVED from this round's interviews
   * by roundEventRollup(). Declared here rather than cast in at the assignment
   * because synthesis.html reads all three off the round (its ⚡ marker), which
   * makes them part of the record's contract, not incidental extras. */
  eventDriven?: boolean;
  eventContext?: unknown;
  eventCoveredDims?: string[];
}

export interface EngagementRecord {
  code: string;
  client: string;
  industry?: string;
  createdAt?: number;
  rounds?: EngagementRound[];
  currentRoundId?: string;
  [key: string]: unknown;
}

const DIMS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"];

/** Coverage arrives from an interviewee-authored session blob. Keep only the
 *  seven real dimensions and only finite values in [0,1]; returns null rather
 *  than an empty object so "reported nothing" stays distinguishable from
 *  "reported zero coverage everywhere". */
/**
 * v5.34.93 — the tiering, sanitised on the way in.
 *
 * Exactly the shape of sanitizeCoverage below, and here for exactly the same
 * reason: the session blob is authored by the INTERVIEWEE's browser, and this
 * value lands in the weights that decide the client's headline number
 * (dimensionWeights → overallOf). Keys restricted to the seven real dimensions,
 * values to the three tier names — anything else is dropped rather than
 * carried, so a crafted blob cannot invent a tier the scoring has never heard
 * of and take the `0` fallback path by accident.
 *
 * What this does NOT do is make the tiering trustworthy, and it should not
 * pretend to: the SCORES arrive in the same blob and are accepted as given, so
 * anyone able to forge a tiering can already forge the number it weights.
 * Sanitising here keeps the value well-formed; the trust boundary is the
 * session blob itself and is unchanged by this version.
 */
function sanitizeDimTiers(t: Record<string, string> | undefined | null): Record<string, string> | null {
  if (!t || typeof t !== "object") return null;
  const out: Record<string, string> = {};
  for (const d of DIMS) {
    const v = (t as Record<string, unknown>)[d];
    if (typeof v !== "string") continue;
    if (!Object.prototype.hasOwnProperty.call(TIER_WEIGHT, v)) continue;
    out[d] = v;
  }
  /* An empty result is a real answer, not a missing one: a role with every
   * dimension switched off in Pre-Engagement legitimately tiers nothing. But
   * `{}` and null behave identically downstream — dimensionWeights returns null
   * either way — so returning null keeps one representation of "no usable
   * tiering" rather than two that a future reader has to know are the same. */
  return Object.keys(out).length ? out : null;
}

function sanitizeCoverage(cov: Record<string, number> | undefined | null): Record<string, number> | null {
  if (!cov || typeof cov !== "object") return null;
  const out: Record<string, number> = {};
  for (const d of DIMS) {
    const v = (cov as Record<string, unknown>)[d];
    if (typeof v !== "number" || !isFinite(v)) continue;
    out[d] = Math.max(0, Math.min(1, v));
  }
  return Object.keys(out).length ? out : null;
}

/**
 * v5.32.25: this was a FOUR-role subset while synthesis.html's dashboard used a
 * TEN-role table, and both fell back to 0.5 for anything missing. So every CFO,
 * CHRO, IT_Director, VP_Sales, Operations_Manager and General_Counsel interview
 * was weighted 0.5 here — in the number actually PERSISTED to the engagement and
 * served by /api/scorecard — and at its real weight on screen. A D7 with
 * CHRO=5.0 and CEO=1.0 read 3.0 "AI Capable" in the dashboard and 2.3
 * "AI Exploring" in the stored score the client deck and the Solution Design
 * generator both consume.
 *
 * Now the full ten-role table, kept byte-identical to VYNE_ROLE_WEIGHTS in
 * frontend/vyne-client.js. test/roleWeightParity.test.ts fails if they drift —
 * the browser can't import this module and this module can't import a browser
 * script, so a test is the only thing holding them together.
 */
export const ROLE_WEIGHTS: Record<string, Record<string, number>> = {
  D1: { CDO: 1.0, CTO: 0.8, IT_Director: 0.7, CEO: 0.4, CFO: 0.4, COO: 0.5, CHRO: 0.3, VP_Sales: 0.3, Operations_Manager: 0.3, General_Counsel: 0.2 },
  D2: { CTO: 1.0, IT_Director: 0.9, CDO: 0.7, CEO: 0.3, CFO: 0.3, COO: 0.4, CHRO: 0.2, VP_Sales: 0.2, Operations_Manager: 0.4, General_Counsel: 0.1 },
  D3: { CEO: 1.0, CDO: 0.9, CFO: 0.8, CTO: 0.7, COO: 0.6, CHRO: 0.4, VP_Sales: 0.5, IT_Director: 0.3, Operations_Manager: 0.3, General_Counsel: 0.3 },
  D4: { CHRO: 1.0, CDO: 0.7, CEO: 0.6, COO: 0.5, CTO: 0.5, CFO: 0.4, VP_Sales: 0.4, IT_Director: 0.4, Operations_Manager: 0.6, General_Counsel: 0.2 },
  D5: { COO: 1.0, Operations_Manager: 0.9, CFO: 0.7, CEO: 0.5, CDO: 0.5, CTO: 0.5, VP_Sales: 0.6, CHRO: 0.4, IT_Director: 0.4, General_Counsel: 0.2 },
  D6: { General_Counsel: 1.0, CDO: 0.9, CTO: 0.8, IT_Director: 0.8, CEO: 0.5, CFO: 0.6, COO: 0.4, CHRO: 0.3, VP_Sales: 0.2, Operations_Manager: 0.3 },
  D7: { CEO: 1.0, CHRO: 1.0, COO: 0.7, CDO: 0.6, CTO: 0.5, CFO: 0.4, VP_Sales: 0.5, Operations_Manager: 0.8, IT_Director: 0.3, General_Counsel: 0.2 },
};

/**
 * Roles arrive as bare keys ("COO") from invites and as display labels
 * ("COO / VP Operations") from synthetic and imported engagements. A raw lookup
 * missed every display label and silently returned 0.5, collapsing the whole
 * weighting scheme into an unweighted mean for those engagements.
 */
export function roleWeight(dim: string, role: string | undefined): number {
  const table = ROLE_WEIGHTS[dim] ?? {};
  const r = String(role ?? "").trim();
  if (Object.prototype.hasOwnProperty.call(table, r)) return table[r];

  /*
   * v5.32.57. Splitting on the first separator and taking the HEAD works for
   * nine of the ten catalog labels and fails for the tenth:
   *
   *   "Operations / Frontline Manager" → "Operations" → not in the table → 0.5
   *
   * Executed: CEO(D5=1) + Operations_Manager(D5=5) gives 3.6; the same pair
   * using the display label gives 3.0 — identical to a role the table has
   * never heard of. D5 is Process & Operations, where the frontline manager is
   * the second most authoritative voice in the room (0.9), so their answer was
   * being discounted by nearly half on the dimension they know best. Synthetic
   * and imported engagements store the display label, so this was the normal
   * case for them rather than an edge one.
   *
   * Try BOTH sides of the separator, and a whole-label normalisation, before
   * giving up. Still falls back to 0.5 for a genuinely unknown role — a custom
   * role a consultant invents has no defensible weight — but it no longer
   * throws away a role the table does know under a different spelling.
   */
  const candidates: string[] = [];
  const push = (v: string) => {
    const k = v.trim().replace(/\s+/g, "_");
    if (k && candidates.indexOf(k) === -1) candidates.push(k);
  };
  push(r);
  for (const part of r.split(/[/(\u2014\u2013-]/)) push(part);
  // "VP Sales / Revenue" → "VP_Sales"; "Operations / Frontline Manager" →
  // "Operations_Manager" needs the LAST word of the tail joined to the head.
  const segs = r.split(/[/(\u2014\u2013-]/).map((x) => x.trim()).filter(Boolean);
  if (segs.length >= 2) {
    const headWord = segs[0].split(/\s+/)[0];
    const tailWords = segs[1].split(/\s+/);
    push(headWord + "_" + tailWords[tailWords.length - 1]);
  }
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(table, c)) return table[c];
  }
  return 0.5;
}

/** Pick the most-recently-saved session record out of an interview's private
 *  module_state rows (there is normally exactly one vynora_session_* key per
 *  interview; ties/multiples resolve to the latest lastSaved). */
export function pickLatestSession(state: Record<string, string>): SessionRecord | null {
  let best: SessionRecord | null = null;
  for (const [k, v] of Object.entries(state)) {
    if (!k.startsWith("vynora_session_")) continue;
    try {
      const rec = JSON.parse(v) as SessionRecord;
      if (!best || (rec.lastSaved ?? 0) > (best.lastSaved ?? 0)) best = rec;
    } catch {
      /* skip malformed */
    }
  }
  return best;
}

/**
 * Strip everything an interviewee must not be allowed to assert (v5.32.29,
 * audit CR-2).
 *
 * `PUT /api/interviews/mine/state` accepts `z.record(z.string())` — by design,
 * because it is the interview agent's own scratch space. That makes every
 * field of the session blob attacker-controlled, and three of them are not
 * opinions about their own answers, they are claims about the engagement:
 *
 *   · stakeholderRole / stakeholderName — the upsert IDENTITY. Whoever the
 *     session says you are is whose record you replace, and the weighting
 *     table keys off the role, so a fabricated "CEO" also re-weights the
 *     round's scores. The invite row is the only trustworthy source: a
 *     consultant set it, and it is returned by the same UPDATE that closes
 *     the interview.
 *   · isRefresh / refreshRound — an interviewee could mint a brand-new round
 *     and move `currentRoundId` onto it. Verified: rounds [1] became [1, 7].
 *     Which round an interview belongs to is the consultant's call, expressed
 *     through the interview row's `kind`; it is never the interviewee's.
 *   · eventDriven / eventContext — free-text that lands in consultant-facing
 *     round metadata with no other validation.
 *
 * `client` is pinned by the caller for the same reason (the v5.32.25 fix).
 */
export function sanitizeIntervieweeSession(
  session: SessionRecord,
  trusted: { client: string; role: string; name: string }
): SessionRecord {
  const s: SessionRecord = { ...session };
  s.client = trusted.client;
  s.stakeholderRole = trusted.role;
  s.stakeholderName = trusted.name;
  s.isRefresh = false;
  s.refreshRound = null;
  s.refreshScope = [];
  s.eventDriven = false;
  s.eventContext = null;
  return s;
}

/**
 * Fold one interviewee's finished session into the firm's engagement record
 * for their client. Pure function — callers own the DB read/write.
 */
export function mergeSessionIntoEngagement(
  eng: EngagementRecord | null,
  code: string,
  session: SessionRecord,
  opts: {
    sourceInterviewId: string;
    kind: "initial" | "follow_up";
    parentInterviewId?: string | null;
    /**
     * The round this interview was invited FOR (v5.32.55).
     *
     * Absent means "whatever round is current", which is the historical
     * behaviour. Present means the consultant said so on the invite, and it is
     * the only reliable signal available — a re-interview of the same person
     * looks identical to a redo of the current one from every other angle.
     */
    roundNumber?: number | null;
  }
): EngagementRecord {
  const e: EngagementRecord = eng ?? {
    code,
    client: session.client || "",
    industry: session.industry || "",
    createdAt: Date.now(),
    rounds: [],
  };
  if (!e.rounds) e.rounds = [];

  const ivRecord: Record<string, unknown> = {
    role: session.stakeholderRole || "",
    interviewee: session.stakeholderName || "",
    name: session.stakeholderName || "",
    industry: session.industry || "",
    sessionId: session.sessionId,
    sessionCode: session.sessionCode,
    scores: Object.assign({}, session.scores || {}),
    findings: (session.findings || []).slice(),
    isRefresh: !!session.isRefresh,
    refreshRound: session.isRefresh ? session.refreshRound ?? null : null,
    refreshScope: session.isRefresh ? session.refreshScope || [] : null,
    /* v5.32.59 (F6). coverageByDim was declared on SessionRecord and read by
     * synthesis.html's blend, but never copied here — so every interview that
     * completed through the distributed auto-flow arrived at the merge with its
     * coverage and left without it. The blend then fell back to the 0.3
     * default for all of them, permanently understating movement on dimensions
     * a refresh had actually re-covered in full. It only became visible once
     * both writers used the same formula; before that the browser recomputed
     * from its own copy of the session and quietly papered over the loss.
     *
     * Sanitised on the way in. The session blob is authored by the INTERVIEWEE,
     * so this is untrusted input landing in a number the client is shown: keys
     * restricted to the seven real dimensions, values to finite [0,1]. */
    coverageByDim: session.isRefresh ? sanitizeCoverage(session.coverageByDim) : null,
    /* v5.34.93 — THE SAME DEFECT AS coverageByDim ABOVE, one version later.
     *
     * v5.34.92 added dimTiers to the interview record in
     * interview_agent.html's writeInterviewToEngagement(), and every consumer
     * of the overall reads it. This function rebuilds the record field by
     * field, so an interview completing through the DISTRIBUTED auto-flow —
     * which is the path an interviewee-run invite takes, i.e. the normal one —
     * arrived here carrying its tiering and left without it.
     *
     * dimensionWeights() is all-or-nothing per round by design, so a single
     * distributed interview was enough to drop the whole round back to the
     * plain mean. The weighting would have been dead in production on exactly
     * the engagements the product is built around, while passing every test,
     * because the consultant-run browser path writes the field directly and
     * never goes through here.
     *
     * Unconditional, not gated on isRefresh: the tiering governs every
     * interview, initial ones included. */
    dimTiers: sanitizeDimTiers(session.dimTiers),
    eventCoveredDims: !session.isRefresh && session.eventDriven
      ? (session.eventCoveredDims || []).filter((d) => DIMS.indexOf(String(d)) >= 0).slice(0, DIMS.length)
      : null,
    eventDriven: !session.isRefresh && !!session.eventDriven,
    eventContext: !session.isRefresh && session.eventDriven ? session.eventContext ?? null : null,
    interviewDate: new Date().toISOString(),
    // Auto-flow bookkeeping — distinguishes distributed-login interviews from
    // consultant-run ones, and lets re-completion (should never happen; the
    // route guards status transitions) replace rather than duplicate.
    sourceInterviewId: opts.sourceInterviewId,
    followUp: opts.kind === "follow_up",
    parentInterviewId: opts.parentInterviewId ?? null,
    distributed: true,
  };

  let targetNum: number;
  if (opts.roundNumber && opts.roundNumber > 0) {
    // The consultant's explicit choice wins over everything else. This is what
    // makes a second diagnostic land in round 2 instead of replacing round 1.
    targetNum = Math.floor(opts.roundNumber);
  } else if (session.isRefresh && session.refreshRound) {
    targetNum = session.refreshRound;
  } else {
    const current = e.rounds.find((r) => r.roundId === e.currentRoundId) ?? e.rounds[e.rounds.length - 1];
    targetNum = current ? current.roundNumber : 1;
  }

  let round = e.rounds.find((r) => r.roundNumber === targetNum);
  if (!round) {
    round = {
      roundId: `round-${targetNum}-${Date.now()}`,
      roundNumber: targetNum,
      label: targetNum === 1 ? "Initial Diagnostic" : `Round ${targetNum} — Refresh`,
      type: targetNum === 1 ? "initial" : "refresh",
      date: new Date().toISOString().slice(0, 10),
      scopeDimensions: DIMS.slice(),
      interviews: [],
      scores: {},
      status: "active",
    };
    e.rounds.push(round);
    e.currentRoundId = round.roundId;
  }
  round.interviews = round.interviews || [];

  // Upsert: dedupe by sourceInterviewId first (idempotent — re-merging the
  // same completed interview replaces its own entry, never duplicates).
  // Otherwise, INITIAL interviews upsert by role (re-running an initial
  // interview for a role replaces the prior one, matching the client-side
  // bridge). FOLLOW-UPs always append a fresh entry — they update specific
  // dimensions on top of the initial read the same way a refresh round does,
  // rather than replacing the whole interview.
  const existingIdx = round.interviews.findIndex((i) => {
    const rec = i as Record<string, unknown>;
    if (rec.sourceInterviewId === opts.sourceInterviewId) return true;
    // v5.32.25: role alone used to be the identity, so a firm interviewing two
    // COOs (two business units) or a CTO and a divisional CTO had the second
    // completion silently REPLACE the first — seven dimension scores and every
    // finding gone, round scores recomputed as if one person was interviewed,
    // and nothing in the tracker showing a record had been dropped. Match on
    // the person too when we know who they are.
    if (opts.kind !== "initial" || rec.followUp) return false;
    if (rec.role !== ivRecord.role) return false;
    const a = String((rec.interviewee as string) ?? "").trim().toLowerCase();
    const b = String(ivRecord.interviewee ?? "").trim().toLowerCase();
    // v5.32.29 SECURITY (audit CR-2). This was `if (a && b && a !== b) return
    // false`, so an EMPTY name on either side fell through to `return true`
    // and matched purely on role. An interviewee controls their own session
    // blob, so submitting {"stakeholderRole":"CEO","stakeholderName":""}
    // replaced the real CEO's record outright — verified: scores 2.0 -> 5.0,
    // findings overwritten, interview count still 1.
    //
    // Identity now has to be POSITIVE. Two records are the same person only
    // when both names are known and equal; anything else is a distinct
    // interview and both are kept. The worst case flips from silent
    // destruction to a duplicate row the consultant can see and delete —
    // which is the same trade v5.32.25 made when it added the name check.
    if (!a || !b) return false;
    if (a !== b) return false;
    return true;
  });
  if (existingIdx >= 0) {
    /* v5.32.55 — keep what is being replaced.
     *
     * A replacement here is usually right: re-merging the SAME interview is
     * idempotent, and re-running an interview for a role should supersede it.
     * But when the incoming record comes from a DIFFERENT interview, this line
     * is the last moment a completed interview's scores and findings exist
     * anywhere — the engagement record is what Synthesis, the scorecard and
     * the client document all read from, and there is no other copy.
     *
     * Overwriting is still the right default (two live entries for one person
     * would double their weight in the round average — see the recompute
     * below). But the old record is archived instead of dropped, so a mistake
     * is recoverable and an audit can show what the round used to say. */
    const prev = round.interviews[existingIdx] as Record<string, unknown>;
    if (prev && prev.sourceInterviewId && prev.sourceInterviewId !== opts.sourceInterviewId) {
      const rr = round as unknown as Record<string, unknown>;
      const archive = Array.isArray(rr.superseded) ? (rr.superseded as unknown[]) : [];
      archive.push({ ...prev, supersededBy: opts.sourceInterviewId });
      // Bounded: this is a safety net, not a history feature.
      rr.superseded = archive.slice(-20);
    }
    round.interviews[existingIdx] = ivRecord;
  } else {
    round.interviews.push(ivRecord);
  }
  round.status = "complete";

  /* v5.34.96 — roll the event tags UP to the round; see roundEventRollup().
   * Synthesis draws its ⚡ marker from round.eventDriven/eventCoveredDims and
   * nothing had ever written them, on either path. eventContext is only filled
   * in when the round has none: Pre-Engagement authors that string and the
   * consultant's wording outranks an interview's. */
  const _evt = roundEventRollup(round.interviews as ScoringInterview[]);
  round.eventDriven = _evt.eventDriven;
  round.eventCoveredDims = _evt.eventCoveredDims;
  if (!round.eventContext && _evt.eventContext) round.eventContext = _evt.eventContext;

  /* Recompute this round's scores through the ONE formula (v5.32.59, F6).
   *
   * This block used to be its own weighted mean with its own carry-forward.
   * It agreed with nothing else: synthesis.html computed the same round at a
   * different precision AND applied a coverage blend that this side had never
   * heard of, and both wrote to `round.scores`. Whichever ran last won, so a
   * client's maturity level depended on whether the consultant had opened
   * Synthesis since the last interview completed. See tenant/scoring.ts.
   *
   * Carry-forward BY ROUND NUMBER (v5.32.57) is preserved inside
   * priorScoresFor: rounds are pushed in completion order, so [1, 3, 2] is a
   * real array once a consultant can pin round 3 before round 2 completes, and
   * walking it by index copied a LATER round's numbers backwards into an
   * earlier one.
   */
  const priorScores = priorScoresFor(e.rounds, round.roundNumber);
  const result = computeRoundScores(round.interviews as ScoringInterview[], {
    priorScores,
    isRefreshRound: isRefreshRound(round as never, lowestRoundNumber(e.rounds)),
    roleWeight,
  });
  round.scores = result.scores;
  /* The blend audit is internal — it is what lets a consultant answer "why did
   * D5 only move 0.4 when the refresh scored it 2 points higher". Stored on
   * the round the same way synthesis.html has always stored it, so the two
   * writers now produce identical records and not merely identical numbers. */
  const rr = round as unknown as Record<string, unknown>;
  if (Object.keys(result.blend).length) rr.scoreBlend = result.blend;
  else delete rr.scoreBlend;

  return e;
}
