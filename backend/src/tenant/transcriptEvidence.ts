/**
 * The evidence that sits beside a transcript (v5.32.66).
 *
 * A transcript answers "what was said". The question people actually ask is
 * "why is this dimension a 2.4", and answering it needs two more things next to
 * the words: the findings the agent recorded, and every score MOVEMENT with the
 * point in the conversation it happened at.
 *
 * Both arrive from the interviewee's browser inside the session blob, which
 * makes them untrusted input in the same sense as everything else in that blob:
 * not adversarial in the normal case — it is their own interview — but
 * model-shaped, occasionally malformed, and unbounded unless something bounds
 * it. Everything here is defensive for that reason rather than a security one.
 *
 * Pure functions, no database, so the shaping rules can be tested without a
 * completion flow around them.
 */

/** One dimension moving from one value to another, at a point in the talk. */
export interface ScoreEvent {
  dimension: string;
  /** null when the dimension had no score before this — its first evidence. */
  from: number | null;
  to: number;
  /** How many display messages had been shown when this happened. */
  afterTurn: number;
  at: number | null;
  /**
   * True when this was reconstructed server-side from the raw model messages
   * rather than journalled by the browser as it happened. Reconstructed events
   * are accurate about WHAT moved and in what order, and approximate about
   * where in the conversation — see deriveScoreEventsFromMessages. The UI says
   * so rather than presenting the two as equivalent.
   */
  derived?: true;
}

export interface TranscriptFinding {
  dimension: string;
  text: string;
  afterTurn: number | null;
  at: number | null;
}

/** Bounds. A long interview produces tens of these, not thousands. */
const MAX_EVENTS = 2_000;
const MAX_FINDINGS = 500;
const MAX_TEXT = 2_000;

/** The product's scale: 1-5, and 0/absent means "no evidence yet". */
function coerceScore(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  if (!isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.min(5, n));
}

function coerceInt(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export function normaliseScoreEvents(raw: unknown): ScoreEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: ScoreEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const dimension = typeof e.dimension === "string" ? e.dimension.slice(0, 20) : "";
    const to = coerceScore(e.to);
    if (!dimension || to === null) continue;
    out.push({
      dimension,
      from: coerceScore(e.from),
      to,
      afterTurn: coerceInt(e.afterTurn) ?? 0,
      at: coerceInt(e.at),
      ...(e.derived === true ? { derived: true as const } : {}),
    });
    if (out.length >= MAX_EVENTS) break;
  }
  return out;
}

export function normaliseFindings(raw: unknown): TranscriptFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const dimension = typeof f.dimension === "string" ? f.dimension.slice(0, 20) : "";
    const text = typeof f.text === "string" ? f.text.slice(0, MAX_TEXT) : "";
    if (!text.trim()) continue;
    out.push({
      dimension,
      text,
      afterTurn: coerceInt(f.afterTurn),
      at: coerceInt(f.at),
    });
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

/**
 * Rebuild the score trajectory from the raw model messages.
 *
 * WHY THIS EXISTS. The browser journals movements as they happen, which is the
 * accurate path. But a deploy does not reach a browser that already has the
 * page open, and an interview in progress finishes on whatever code it started
 * with — so for a window after every release, completions arrive with no
 * journal. Those interviews would have a transcript with no trajectory, for a
 * reason that has nothing to do with the interview.
 *
 * The raw material is already there: the interviewer model appends a
 * <<<SCORES>>> block to every one of its turns, and the text path stores those
 * assistant messages verbatim in `messages`. Same information, reconstructed.
 *
 * TWO HONEST LIMITS, which is why these events are flagged `derived`:
 *
 *  · Position is approximate. `messages` and `displayMessages` are different
 *    arrays that grow roughly in step, so the turn anchor is the index in
 *    `messages` and can be off by one against the rendered transcript.
 *  · The realtime voice path never writes `messages` at all — it scores in a
 *    separate pass — so nothing can be reconstructed for a spoken interview.
 *    A spoken interview completed on old code simply has no trajectory, and the
 *    UI says that rather than showing an empty panel.
 */
export function deriveScoreEventsFromMessages(raw: unknown): ScoreEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: ScoreEvent[] = [];
  const current: Record<string, number> = {};

  raw.forEach((item, idx) => {
    if (out.length >= MAX_EVENTS) return;
    if (!item || typeof item !== "object") return;
    const m = item as Record<string, unknown>;
    if (m.role !== "assistant" || typeof m.content !== "string") return;

    const block = /<<<SCORES>>>([\s\S]*?)<<<END_SCORES>>>/.exec(m.content);
    if (!block) return;

    let parsed: unknown;
    // A malformed block is exactly what v5.32.23 found the browser swallowing.
    // Here it is genuinely nothing to worry about — the turn contributed no
    // scores at the time either, so there is no movement to reconstruct.
    try { parsed = JSON.parse(block[1]); } catch { return; }
    const scores = (parsed as { scores?: unknown })?.scores;
    if (!scores || typeof scores !== "object") return;

    for (const [dim, rawScore] of Object.entries(scores as Record<string, unknown>)) {
      const to = coerceScore(rawScore);
      // Only a CHANGE is an event. The model restates all seven dimensions
      // every turn, so recording each reported score would bury the handful of
      // real movements under hundreds of restatements.
      if (to === null || current[dim] === to) continue;
      out.push({
        dimension: dim.slice(0, 20),
        from: dim in current ? current[dim] : null,
        to,
        afterTurn: idx + 1,
        at: null,
        derived: true,
      });
      current[dim] = to;
    }
  });

  return out;
}

/**
 * What to store on the transcript row, given a completed session.
 *
 * Prefers the browser's journal and falls back to reconstruction, so the caller
 * does not have to know which path ran.
 */
export function transcriptEvidenceFor(session: Record<string, unknown>): {
  findings: TranscriptFinding[];
  scoreEvents: ScoreEvent[];
} {
  const journalled = normaliseScoreEvents(session.scoreEvents);
  const scoreEvents = journalled.length
    ? journalled
    : deriveScoreEventsFromMessages(session.messages);

  // findingEvents carries the conversation position; `findings` is the same set
  // without it, and is what every pre-v5.32.66 session has. Prefer the anchored
  // one, fall back to the flat one rather than showing nothing.
  const anchored = normaliseFindings(session.findingEvents);
  const findings = anchored.length ? anchored : normaliseFindings(session.findings);

  return { findings, scoreEvents };
}
