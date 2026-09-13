/**
 * Prints the ACTUAL context each v5.32.88 change produces, from the shipped
 * code paths. Not a test — a demonstration, so the change can be read rather
 * than described.
 *
 *   npx tsx test/contextExamples.mts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { probeFor, neutralAgendaProbe } from "../src/routes/interviews.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function loadWeb(file: string): any {
  const sandbox: any = { module: { exports: {} }, console };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.resolve(here, "../../frontend/" + file), "utf8"), sandbox, { filename: file });
  return sandbox.module.exports;
}
const M = loadWeb("vyne-memory.js");

const hr = (t: string) => console.log("\n" + "═".repeat(78) + "\n " + t + "\n" + "═".repeat(78));
const sub = (t: string) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 72 - t.length)));

/* A three-round engagement with two divisional COOs and a CFO. */
const ENG = {
  code: "ACME01", client: "Acme Industrial",
  rounds: [
    { roundId: "r3", roundNumber: 3, interviews: [
      { role: "COO", interviewee: "Cara Diaz", sourceInterviewId: "iv-c3",
        scores: { D5: 4 }, coverageByDim: { D5: 0.9 },
        findings: [{ dimension: "D5", text: "Shift handoffs are now logged in the MES, though the night shift still phones them through" }] },
      { role: "COO", interviewee: "Dev Rao", sourceInterviewId: "iv-d3",
        scores: { D1: 3 }, coverageByDim: { D1: 0.4 },
        findings: [{ dimension: "D1", text: "Reporting is consolidated but a month behind" }] },
    ] },
    { roundId: "r1", roundNumber: 1, interviews: [
      { role: "COO", interviewee: "Cara Diaz", sourceInterviewId: "iv-c1",
        scores: { D5: 2 }, coverageByDim: { D5: 0.4 },
        findings: [{ dimension: "D5", text: "Handoffs between shifts are manual and undocumented" }] },
      { role: "COO", interviewee: "Dev Rao", sourceInterviewId: "iv-d1",
        scores: { D5: 4, D6: 2 },
        findings: [{ dimension: "D5", text: "The plant floor is largely automated" },
                   { dimension: "D6", text: "Nobody signs off model changes before they reach customers" }] },
      { role: "CFO", interviewee: "Priya Sharma", sourceInterviewId: "iv-p1",
        scores: { D1: 3 }, findings: [{ dimension: "D1", text: "Lineage is undocumented across finance systems" }] },
    ] },
  ],
};

const mem = M.build(ENG);

/* ── 1. Coverage and last-measured, fed forward ─────────────────────────── */
hr("EXAMPLE 1 — coverage and last-measured fed forward (the scoring fix)");
console.log(`
Dev Rao scored D5 at 4/5 in ROUND 1 and was interviewed again in round 3
without D5 being revisited. Cara was re-asked in round 3.

Before: the prompt said "you assessed this around 4/5" for both, with no way
to tell a fresh measurement from one carried forward for two rounds.

After — what the prompt now contains for Dev:`);
const selfDev = M.selfView(mem, "COO||Dev Rao");
const rankedDev = M.rankDimensions(selfDev, ["D5"], 5);
sub("prompt fragment");
console.log(rankedDev.map((d: string) => {
  const D = selfDev.dimensions[d];
  let b = "• " + d + ": ";
  b += D.score !== null ? `you assessed this around ${D.score}/5 in round ${D.lastMeasuredRound}` : "you have not scored this";
  if (D.trajectory.length > 1) b += ` (was ${D.trajectory[0].score}/5 in round ${D.trajectory[0].round})`;
  if (D.stale) b += " — NOT revisited since, so treat it as unconfirmed and re-establish the evidence rather than accepting the number back";
  else if (D.coverage !== null && D.coverage < 0.5) b += " — only lightly evidenced last time, so probe it properly";
  if (D.text) b += `\n    You said: "${D.text}"`;
  return b;
}).join("\n"));
sub("and the same for Cara, who WAS re-asked");
const selfCara = M.selfView(mem, "COO||Cara Diaz");
console.log(M.rankDimensions(selfCara, ["D5"], 5).map((d: string) => {
  const D = selfCara.dimensions[d];
  let b = "• " + d + ": " + `you assessed this around ${D.score}/5 in round ${D.lastMeasuredRound}`;
  if (D.trajectory.length > 1) b += ` (was ${D.trajectory[0].score}/5 in round ${D.trajectory[0].round})`;
  if (D.stale) b += " — NOT revisited since…";
  if (D.text) b += `\n    You said: "${D.text}"`;
  return b;
}).join("\n"));
console.log(`
The difference is the whole point: Dev's 4/5 is flagged as unconfirmed, Cara's
3-round trajectory is shown as movement. Neither was previously expressible.`);

/* ── 2. The follow-up probe ─────────────────────────────────────────────── */
hr("EXAMPLE 2 — the follow-up probe (the tracker's Request follow-up)");
console.log(`
Cara's own last words on D5 came from round 3. The probe is what SHE reads.

BEFORE — identical for every engagement in the product:`);
sub("text");
console.log("  " + neutralAgendaProbe("D5"));
console.log(`
AFTER — her own sentence, so nothing is disclosed:`);
sub("text");
console.log("  " + probeFor("D5", { text: ENG.rounds[0].interviews[0].findings[0].text, round: 3 }, ""));
console.log(`
AFTER, with the consultant naming a dimension nobody has spoken about and
adding their own direction:`);
sub("text");
console.log("  " + probeFor("D4", null, "whether the reskilling budget was ever approved"));
console.log(`
And the colleagues' verbatim findings still ride along as consultant-only
'evidence', stripped by projectAgendaForInterviewee before the bootstrap.`);

/* ── 3. The memory, with provenance ─────────────────────────────────────── */
hr("EXAMPLE 3 — the memory artifact, with provenance and recency");
sub("Cara's D5, across three rounds");
console.log(JSON.stringify(mem.byPerson["COO||Cara Diaz"].byDimension.D5, null, 2));
console.log(`
Note: round 1's TEXT is null — only the newest round is carried verbatim — but
round 1's SCORE survives in the trajectory, because the movement is the point.
Every entry names the round and the interview it came from, so a line in a
prompt can be traced to the interview that produced it.`);

/* ── 4. The projections ─────────────────────────────────────────────────── */
hr("EXAMPLE 4 — the three projections, from that one artifact");
sub("selfView(Dev) — quotable verbatim, it is his own material");
console.log(JSON.stringify(M.selfView(mem, "COO||Dev Rao", ["D5", "D6"]), null, 2));
sub("ambientView(Dev, [D5]) — what the engagement holds, with every identity removed");
console.log(JSON.stringify(M.ambientView(mem, "COO||Dev Rao", ["D5"]), null, 2));
console.log(`
No name, no role, no count-by-role — on a five-person executive team a role is
frequently identifying on its own. And his own line is absent: he does not need
to be told what he said in a projection about what OTHERS said.`);
sub("consultantView — everything, attributed");
console.log("byPerson keys: " + Object.keys(mem.byPerson).join(", "));
console.log("byDimension D5 contributors: " + JSON.stringify(mem.byDimension.D5.contributors));

hr("Recency, as rounds accumulate");
console.log(`
fromRounds:  ${JSON.stringify(mem.fromRounds)}
newestRound: ${mem.newestRound}

  · newest round verbatim, older rounds as trajectory only
  · rankDimensions puts today's agenda first, then stale, then their own
    words, then thin coverage — capped, because a prompt with everything in
    it scores worse
  · roundsSinceMeasured makes "this is two rounds old" explicit rather than
    leaving the model to infer it from a number with no date on it
`);
