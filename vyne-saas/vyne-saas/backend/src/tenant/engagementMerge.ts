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
  refreshRound?: number;
  refreshScope?: string[];
  coverageByDim?: Record<string, number>;
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

/** Same role-weight table as interview_agent.html's writeInterviewToEngagement(). */
const ROLE_WEIGHTS: Record<string, Record<string, number>> = {
  D1: { CDO: 1.0, CTO: 0.8, CEO: 0.4, COO: 0.5 },
  D2: { CTO: 1.0, CDO: 0.7, CEO: 0.3, COO: 0.4 },
  D3: { CEO: 1.0, CDO: 0.9, CTO: 0.7, COO: 0.6 },
  D4: { CHRO: 1.0, CDO: 0.7, CEO: 0.6, COO: 0.5, CTO: 0.5 },
  D5: { COO: 1.0, CEO: 0.5, CDO: 0.5, CTO: 0.5 },
  D6: { CDO: 0.9, CTO: 0.8, CEO: 0.5 },
  D7: { CEO: 1.0, COO: 0.7, CDO: 0.6, CTO: 0.5 },
};

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
 * Fold one interviewee's finished session into the firm's engagement record
 * for their client. Pure function — callers own the DB read/write.
 */
export function mergeSessionIntoEngagement(
  eng: EngagementRecord | null,
  code: string,
  session: SessionRecord,
  opts: { sourceInterviewId: string; kind: "initial" | "follow_up"; parentInterviewId?: string | null }
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
  if (session.isRefresh && session.refreshRound) {
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
    return opts.kind === "initial" && rec.role === ivRecord.role && !rec.followUp;
  });
  if (existingIdx >= 0) round.interviews[existingIdx] = ivRecord;
  else round.interviews.push(ivRecord);
  round.status = "complete";

  // Recompute this round's weighted scores; carry forward the prior round's
  // value for any dimension nothing in this round scored.
  const rs: Record<string, number> = {};
  for (const d of DIMS) {
    const entries = round.interviews
      .map((i) => i as { scores?: Record<string, number>; role?: string })
      .filter((i) => typeof i.scores?.[d] === "number" && (i.scores?.[d] ?? 0) > 0)
      .map((i) => ({ score: i.scores![d], weight: (ROLE_WEIGHTS[d] || {})[i.role ?? ""] ?? 0.5 }));
    if (!entries.length) continue;
    const tw = entries.reduce((s, x) => s + x.weight, 0);
    rs[d] = Math.round((entries.reduce((s, x) => s + x.score * x.weight, 0) / tw) * 10) / 10;
  }
  const ri = e.rounds.indexOf(round);
  if (ri > 0) {
    for (const d of DIMS) {
      if (rs[d] == null) {
        for (let pi = ri - 1; pi >= 0; pi--) {
          const ps = e.rounds[pi].scores;
          if (ps && ps[d] != null) {
            rs[d] = ps[d];
            break;
          }
        }
      }
    }
  }
  round.scores = rs;

  return e;
}
