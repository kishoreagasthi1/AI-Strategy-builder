/**
 * Render the SHIPPED interviewer instruction, for the voice harness. (v5.34.74)
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * deploy/voice-record.mjs calls itself a recording of "the actual shipped
 * frontend ... run unmodified", and for vyne-live.js and vyne-live-interview.js
 * that is true. For the INTERVIEWER it was not. It pinned its own prompt:
 *
 *   "You are <name>, conducting an AI-readiness interview. Ask ONE short
 *    question at a time and then wait for the answer. Never summarise the
 *    conversation unless asked. Keep every reply under three sentences."
 *
 * Three sentences, no agenda, no closing rules, no engagement context. So every
 * judgement ever made from a recording — question quality, coverage, when the
 * interview wrapped up, whether it repeated itself — was a judgement about
 * THAT prompt, not about the product. On 2026-09-13 a 30-minute run was read as
 * evidence that the product's interviewer had no dimension agenda. The product
 * genuinely did not (interviewerPersona.ts carried no dimensions until
 * v5.34.73), but the recording could not have shown it either way, because the
 * persona was never in the session.
 *
 * That is the same trap the harness's own header warns about — "a broken rig
 * and a broken product look identical in the output" — one level up from where
 * it was looking. The rig was not broken. It was measuring something else and
 * labelling it the product.
 *
 * ── Why a separate script rather than an import ─────────────────────────────
 *
 * buildInterviewerInstruction lives in TypeScript, in the backend package, and
 * is security-relevant: it is what fences interviewee-supplied context away
 * from the rules. Re-implementing it in the harness would create exactly the
 * drift this fixes, and loosening it to plain JS would drop the types off the
 * one function that most needs them. So the harness stays plain Node and this
 * runs under the backend's own tsx, printing the real instruction to stdout.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   cd backend
 *   npx tsx ../deploy/interviewer-instruction.ts [fixture.json] > instruction.txt
 *
 * The fixture describes the interview the way a browser would. Without one, the
 * defaults below stand in — a representative engagement, clearly fictional.
 */
import { readFileSync } from "node:fs";
import {
  buildInterviewerInstruction, DIM_CODES, type Dim,
} from "../backend/src/llm/interviewerPersona.js";

export interface Fixture {
  interviewerName?: string;
  clientName?: string;
  industry?: string;
  intervieweeName?: string;
  intervieweeRole?: string;
  context?: string;
  agenda?: { lead?: string[]; cover?: string[]; light?: string[]; evidenced?: string[] };
  mandatoryCount?: number;
  /** How many questions have already been asked AND answered. See renderInstruction. */
  askedCount?: number;
}

/**
 * The stand-in engagement, in deploy/interviewer-fixture.json. (v5.34.79)
 *
 * Shaped like what buildLiveContext() sends — a briefing with benchmarks,
 * document intelligence and prior-round material — because the SIZE and SHAPE
 * of the context is part of what a recording measures. A one-line context and
 * a real briefing are different interviews.
 *
 * Deliberately fictional, and deliberately not a real client's data: this is
 * committed, and a harness fixture is not a place for anyone's briefing.
 *
 * It lives in JSON rather than in this file because deploy/voice-record.mjs
 * needs it too, and plain Node importing this TypeScript module under the tsx
 * loader produced a require(esm) cycle. JSON has no module semantics to get
 * wrong, and one copy cannot drift from another.
 */
export const DEFAULT: Fixture =
  JSON.parse(readFileSync(new URL("./interviewer-fixture.json", import.meta.url), "utf8")) as Fixture;

const isDim = (d: string): d is Dim => (DIM_CODES as readonly string[]).includes(d);
const dims = (a: string[] | undefined): Dim[] => (a ?? []).filter(isDim);

/**
 * Render one instruction from a fixture. (v5.34.79)
 *
 * Exported so deploy/voice-record.mjs can call it AT EVERY MINT rather than
 * reading a file rendered once before the run.
 *
 * That distinction is the whole point of v5.34.79. The product recomputes the
 * live context and the asked/outstanding counts at every mint — which is what
 * stops a fresh session after a ~10-minute handover from re-asking an hour of
 * ground, because that session has no memory of the conversation and learns
 * what was covered only from the context sent with its grant. A harness that
 * pins ONE instruction for the whole run cannot exercise any of that: it hands
 * every session the same "nothing asked yet" snapshot, which is precisely the
 * state the fix exists to prevent. It would have reported a pass on the bug.
 */
export function renderInstruction(fx: Fixture): string {
  return buildInterviewerInstruction({
    interviewerName: fx.interviewerName,
    clientName: fx.clientName,
    industry: fx.industry,
    intervieweeName: fx.intervieweeName,
    intervieweeRole: fx.intervieweeRole,
    context: fx.context,
    mandatoryCount: fx.mandatoryCount,
    askedCount: fx.askedCount,
    agenda: fx.agenda && {
      lead: dims(fx.agenda.lead),
      cover: dims(fx.agenda.cover),
      light: dims(fx.agenda.light),
      evidenced: dims(fx.agenda.evidenced),
    },
  });
}

/*
 * The CLI path below runs only when this file is executed directly, so an
 * import from the harness does not read argv or write to stdout.
 */
const RUN_AS_CLI = process.argv[1] ? /interviewer-instruction\.(ts|js|mjs)$/.test(process.argv[1]) : false;

if (RUN_AS_CLI) {
const path = process.argv[2];
let fx: Fixture = DEFAULT;
if (path) {
  try {
    fx = { ...DEFAULT, ...(JSON.parse(readFileSync(path, "utf8")) as Fixture) };
  } catch (e) {
    console.error(`could not read fixture ${path}: ${(e as Error).message}`);
    process.exit(2);
  }
}

process.stdout.write(renderInstruction(fx));
}
