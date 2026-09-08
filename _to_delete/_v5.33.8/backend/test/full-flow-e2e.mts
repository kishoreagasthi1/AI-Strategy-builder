/**
 * FULL-FLOW END-TO-END: pre-engagement → interviews → scoring → synthesis →
 * roadmap, driven through the REAL backend, a REAL Postgres, and a REAL
 * browser.
 *
 *   npx tsx test/full-flow-e2e.mts
 *
 * Requires: Postgres with the migrations applied, and Playwright.
 *   RLS_TEST=1 TEST_DATABASE_URL=... RLS_APP_URL=... npx tsx test/full-flow-e2e.mts
 *
 * WHY THIS EXISTS, separately from every other suite in this repo. The other
 * tests each prove one module in isolation: the parity tests prove two
 * implementations of a formula agree, the browser suites prove a page renders,
 * the DB tests prove a route writes what it claims. None of them prove that a
 * consultant can start with nothing, run an engagement end to end, and find
 * their numbers intact at the other end — which is the only claim that
 * actually matters to a client.
 *
 * This walks the whole path once:
 *
 *   1. a firm and a consultant exist
 *   2. the synthetic generator produces a two-round engagement with
 *      transcripts, a follow-up, and a persisted synthesis
 *   3. the Interview Tracker shows every sitting, its round, and its transcript
 *   4. the Synthesis Dashboard loads the engagement and scores it
 *   5. the scores the dashboard shows are the ones the shared formula gives
 *   6. the Roadmap module picks those same scores up from the engagement
 *
 * Step 5 and step 6 are the ones worth having. Until v5.32.59 there were four
 * implementations of that formula and the number a client saw depended on
 * which module had written last; this asserts the whole chain now agrees.
 *
 * The LLM is faked — deliberately. The point is to exercise OUR pipeline
 * deterministically, not to spend money discovering that a model still
 * returns JSON. The fake returns per-persona biased scores that seed a real
 * contradiction, so Synthesis has genuine work to do.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium } from "playwright";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";
import type { ProviderAdapter } from "../src/llm/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, "..", "..", "frontend");
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5433/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:apppw@localhost:5433/vyne";
const UI_PORT = 8801;

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); };

// ── A fake model with opinions ───────────────────────────────────────────────
// Each persona reads the same company differently. The CEO is optimistic about
// data; the CTO is not. That 2-point spread on D1 is what makes the
// contradiction detection, the weighted scoring and the synthesis fingerprint
// do real work rather than agree with themselves.
const BIASED: Record<string, Record<string, number>> = {
  CEO:  { D1: 4.0, D2: 3.5, D3: 4.0, D4: 3.0, D5: 3.5, D6: 2.0, D7: 3.5 },
  COO:  { D1: 3.0, D2: 3.0, D3: 3.0, D4: 2.5, D5: 3.5, D6: 1.5, D7: 3.0 },
  CTO:  { D1: 2.0, D2: 3.5, D3: 2.5, D4: 2.0, D5: 2.5, D6: 1.5, D7: 2.5 },
  CDO:  { D1: 1.5, D2: 2.5, D3: 2.5, D4: 2.0, D5: 2.0, D6: 1.0, D7: 2.0 },
  CHRO: { D1: 2.5, D2: 2.5, D3: 2.5, D4: 1.5, D5: 2.5, D6: 1.5, D7: 2.0 },
};
const DEFAULT_SCORES = { D1: 2.5, D2: 2.5, D3: 2.5, D4: 2.5, D5: 2.5, D6: 1.5, D7: 2.5 };

function fakeInterview(prompt: string): string {
  /* Anchor on the prompt's own "Interviewee: <name>, <ROLE>." line.
   *
   * This was a substring search for ", CEO." and friends, which matched the
   * SEEDED CONTRADICTIONS paragraph the prompt shares with every persona —
   * so all five personas came back with the CEO's numbers, the weighted mean
   * equalled one person's raw scores, and the contradiction the fixture
   * exists to create never appeared. A fixture that quietly agrees with
   * itself is worse than no fixture. */
  const m = /Interviewee:\s*[^,]+,\s*([^\n]+)/.exec(prompt);
  const label = m ? m[1] : "";
  /* The prompt carries the DISPLAY label ("COO / VP Operations"), not the
   * slug — which is itself worth exercising, since roleWeight has to resolve
   * both and got that wrong as recently as v5.32.57. Match the role token
   * anywhere in the label rather than assuming the bare key. */
  const role = Object.keys(BIASED).find((r) => new RegExp("\\b" + r + "\\b").test(label)) ?? "CEO";
  const refresh = prompt.includes("REFRESH interview");
  const base = BIASED[role] ?? DEFAULT_SCORES;
  const scores: Record<string, number> = {};
  for (const [d, v] of Object.entries(base)) {
    // A refresh genuinely improves D2 and D6, per the prompt's own instruction.
    scores[d] = Math.min(5, v + (refresh ? (d === "D2" ? 0.8 : d === "D6" ? 1.0 : 0.1) : 0));
    scores[d] = Math.round(scores[d] * 10) / 10;
  }
  return JSON.stringify({
    scores,
    findings: [
      { dimension: "D1", text: `Reporting for ${role} runs off three separate warehouses with no agreed source of truth.` },
      { dimension: "D2", text: refresh ? "The reporting layer was unified this year; the underlying stores were not." : "Integration between the ERP and the data platform is a nightly batch job." },
      { dimension: "D3", text: "AI initiatives are funded per pilot, with no standing budget line beyond proof of concept." },
      { dimension: "D4", text: "AI-literate staff sit almost entirely inside the technology function." },
      /* D5 deliberately gets a DIFFERENT claim from each role. Five executives
       * do not describe the same problem in the same words, and a fixture in
       * which they do makes every dimension look corroborated — which is
       * exactly the false reading v5.32.59 was written to stop. D1 above stays
       * shared wording, so the run exercises both tiles: real agreement on D1,
       * shared attention without agreement on D5. */
      { dimension: "D5", text: {
        CEO:  "Cycle times are quoted differently by each region, so the board sees a blended number nobody owns.",
        COO:  "Handoffs between shifts are recorded manually and reconciled the following morning.",
        CTO:  "The scheduling system cannot express a dependency, so sequencing lives in spreadsheets beside it.",
        CDO:  "Process events are not instrumented, so there is no measurement to improve against.",
        CHRO: "Supervisors absorb the exceptions personally, which is why the process looks stable from above.",
      }[role] ?? "Process steps are reconciled by hand." },
      { dimension: "D6", text: refresh ? "A governance council now exists and meets monthly, but cannot stop work already in flight." : "No single function owns model risk end to end." },
      { dimension: "D7", text: "Change fatigue is real; two large programmes in three years shape how new initiatives are received." },
    ],
    summary: `${role} presents a ${refresh ? "modestly improved" : "mixed"} picture, confident on infrastructure and markedly less so on ownership.`,
    transcript: [
      { who: "Interviewer", text: "Thanks for the time. Where would you say the organisation genuinely stands on using its own data?" },
      { who: "Interviewee", text: `We have a lot of it. Whether we can act on it is a different question — ${role === "CEO" ? "though I think we are further along than people give us credit for" : "and I would say we are further behind than the board believes"}.` },
      { who: "Interviewer", text: "Is there a single source of truth for the numbers leadership acts on?" },
      { who: "Interviewee", text: "Not really. There are three warehouses and a reporting layer over the top, which makes it look more settled than it is." },
      { who: "Interviewer", text: "Who owns model risk today?" },
      { who: "Interviewee", text: refresh ? "There is a council now. It meets monthly and reviews what has already shipped." : "That is being worked out. Legal has a view, technology has a view, and neither has the authority." },
      { who: "Interviewer", text: "And on people — where is the capability?" },
      { who: "Interviewee", text: "Concentrated in technology. The business consumes the output without much ability to challenge it." },
      { who: "Interviewer", text: "Last one: what would stop this working?" },
      { who: "Interviewee", text: "Fatigue, honestly. We have asked a lot of people recently and the appetite for another transformation is thin." },
    ],
  });
}

const fakeAdapter: ProviderAdapter = {
  name: "gemini-aistudio", model: "fake-e2e", freeTier: true,
  isConfigured: () => true,
  /* ProviderAdapter.generate takes the request as its FIRST and only
   * argument. Writing it as (ctx, req) — the shape the gateway uses — made
   * `prompt` silently empty, so every persona fell through to the default and
   * the fixture produced five identical interviews without complaining. */
  async generate(req: { messages?: { content?: string }[] }) {
    const prompt = req?.messages?.[0]?.content ?? "";
    return { text: fakeInterview(prompt), model: "fake-e2e", usage: { tokensIn: 10, tokensOut: 800, costEstUsd: 0 } };
  },
} as unknown as ProviderAdapter;

class FakeVerifier implements TokenVerifier {
  constructor(private map: Record<string, VerifiedIdentity>) {}
  async verify(t: string): Promise<VerifiedIdentity> {
    const id = this.map[t];
    if (!id) throw new Error("bad token");
    return id;
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
process.env.DEV_AUTH = "1";
await migrate(ADMIN_URL);
const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();

const t = await admin.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('E2E Firm') RETURNING id`);
const tenant = t.rows[0].id;
const u = await admin.query<{ id: string }>(
  `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-e2e', 'e2e@firm.com')
   ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
await admin.query(
  `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')
   ON CONFLICT (user_id, tenant_id) DO NOTHING`, [u.rows[0].id, tenant]);

initPool(APP_URL);
const app = await buildServer({
  config: {
    port: 0, env: "test", databaseUrl: APP_URL,
    gcpProject: undefined, vertexLocation: "us-east5",
    geminiApiKey: undefined, openaiApiKey: undefined, anthropicApiKey: undefined,
    llmDefaultChain: undefined, blockFreeTier: false, geminiPaidTier: false,
  },
  verifier: new FakeVerifier({ "tok-e2e": { uid: "uid-e2e", email: "e2e@firm.com", idpTenantId: undefined } }),
  adapters: [fakeAdapter],
  meter: async () => {},
} as never);
await app.listen({ port: 0, host: "127.0.0.1" });
const apiPort = (app.server.address() as { port: number }).port;

/* A tiny origin that serves the real frontend files and proxies /api to the
 * real backend — so the browser sees exactly the same-origin arrangement
 * Firebase Hosting's rewrite gives it in production. */
const ui = http.createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url.startsWith("/api/")) {
    const p = http.request(
      { host: "127.0.0.1", port: apiPort, path: req.url, method: req.method, headers: req.headers },
      (r) => { res.writeHead(r.statusCode ?? 500, r.headers); r.pipe(res); }
    );
    req.pipe(p);
    p.on("error", () => { res.writeHead(502); res.end(); });
    return;
  }
  try {
    const body = readFileSync(join(FRONTEND, url === "/" ? "index.html" : url));
    res.writeHead(200, { "content-type": url.endsWith(".js") ? "application/javascript" : "text/html" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise<void>((r) => ui.listen(UI_PORT, r));

const CLIENT = "Northwind Components";

// ── 1. Generate the engagement through the real route ────────────────────────
const gen = await app.inject({
  method: "POST", url: "/api/synthetic/engagement",
  headers: { authorization: "Bearer tok-e2e" },
  payload: { clientName: CLIENT, industry: "Industrial Manufacturing", includeRefresh: true },
});
check("the engagement generated end to end", gen.statusCode === 200, gen.body.slice(0, 300));
const code: string = gen.statusCode === 200 ? gen.json().code : "";
check("two rounds and ten interviews", gen.statusCode === 200 && gen.json().rounds === 2 && gen.json().interviews === 10,
  gen.statusCode === 200 ? JSON.stringify(gen.json()) : "");

// ── 2. The tracker ───────────────────────────────────────────────────────────
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext();
/* Browser-side code is passed as STRINGS throughout this file, never as
 * functions. tsx compiles with esbuild's keepNames, which rewrites every
 * function expression to reference a `__name` helper that exists in the
 * bundle and not in the page — so a function-form page.evaluate dies with
 * "ReferenceError: __name is not defined" and tells you nothing about your
 * actual test. Strings are handed to the page verbatim. */
await ctx.addInitScript(`
  try {
    sessionStorage.setItem("vyne_session", JSON.stringify({
      token: "tok-e2e", email: "e2e@firm.com", role: "owner", mode: "dev",
      at: Date.now(), la: Date.now() }));
  } catch (e) {}
`);
const errs: Record<string, string[]> = {};
async function open(page_: string) {
  const p = await ctx.newPage();
  errs[page_] = [];
  p.on("pageerror", (e) => errs[page_].push(String(e)));
  if (process.env.E2E_DEBUG === "1") {
    p.on("response", async (r) => {
      if (!r.url().includes("/api/")) return;
      let body = "";
      try { body = (await r.text()).slice(0, 160); } catch { /* stream */ }
      console.log("  <-", r.status(), r.url().replace(`http://127.0.0.1:${UI_PORT}`, ""), body);
    });
  }
  await p.goto(`http://127.0.0.1:${UI_PORT}/${page_}`);
  await p.waitForTimeout(1800);
  return p;
}

const tracker = await open("interviews.html");
const trackerState = await tracker.evaluate(`(() => {
  const client = ${JSON.stringify(CLIENT)};
  const table = document.getElementById("rows").closest("table");
  const heads = [...table.querySelectorAll("thead th")].map((h) => h.textContent.trim());
  const rows = [...document.getElementById("rows").querySelectorAll("tr")].map((tr) =>
    [...tr.querySelectorAll("td")].map((td) => td.textContent.trim()));
  const mine = rows.filter((r) => r.some((c) => c.includes(client)) || r.some((c) => c.includes("[Synthetic]")));
  const roundCol = heads.indexOf("Round");
  return {
    heads: heads,
    count: mine.length,
    rounds: roundCol >= 0 ? mine.map((r) => r[roundCol]) : [],
    hasTranscriptButton: /Transcript/i.test(document.getElementById("rows").innerHTML)
  };
})()`) as { heads: string[]; count: number; rounds: string[]; hasTranscriptButton: boolean };

check("the tracker lists every sitting, both rounds and the follow-up",
  trackerState.count === 11, `${trackerState.count} rows`);
check("every tracker row shows a round, none blank",
  trackerState.rounds.length > 0 && trackerState.rounds.every((r) => r && r !== "—" && r !== ""),
  JSON.stringify(trackerState.rounds));
check("both round 1 and round 2 are represented",
  trackerState.rounds.some((r) => /1/.test(r)) && trackerState.rounds.some((r) => /2/.test(r)),
  JSON.stringify(trackerState.rounds));
check("the tracker offers a Transcript for the sittings", trackerState.hasTranscriptButton);
check("interviews.html threw nothing", errs["interviews.html"].length === 0, errs["interviews.html"].join(" | "));

// A transcript is really readable through the real route.
const ivList = await app.inject({ method: "GET", url: "/api/interviews", headers: { authorization: "Bearer tok-e2e" } });
const ivs = (ivList.statusCode === 200 ? ivList.json().interviews : []) as
  { id: string; round_number: number; kind: string; parent_interview_id?: string }[];
check("the interviews API returns the generated sittings",
  ivs.length === 11, `${ivList.statusCode}: ${ivs.length} rows — ${ivList.body.slice(0, 200)}`);
/* An INITIAL sitting, not the follow-up: a follow-up is deliberately a short,
 * targeted conversation, so asserting a full-length transcript against it
 * would be asserting the wrong thing. */
const firstInitial = ivs.find((i) => i.kind !== "follow_up") ?? ivs[0];
const tr = firstInitial
  ? await app.inject({ method: "GET", url: `/api/interviews/${firstInitial.id}/transcript`,
      headers: { authorization: "Bearer tok-e2e" } })
  : null;
check("a transcript comes back through the real endpoint", !!tr && tr.statusCode === 200,
  tr ? `${tr.statusCode}: ${tr.body.slice(0, 200)}` : "no interviews to ask about");
const turns = tr && tr.statusCode === 200 ? tr.json().transcripts[0].turns : [];
check("the transcript is a real two-sided conversation",
  turns.length >= 8 && turns.some((x: { who: string }) => x.who === "Interviewer")
    && turns.some((x: { who: string }) => x.who === "Interviewee"),
  `${turns.length} turns`);
const fuRow = ivs.find((i) => i.kind === "follow_up");
const fuTr = fuRow
  ? await app.inject({ method: "GET", url: `/api/interviews/${fuRow.id}/transcript`,
      headers: { authorization: "Bearer tok-e2e" } })
  : null;
check("the follow-up has its own transcript, distinct from the parent's",
  !!fuTr && fuTr.statusCode === 200 && fuTr.json().transcripts[0].turns.length >= 4
    && fuTr.json().transcripts[0].turns[0].text !== turns[0]?.text,
  fuTr ? `${fuTr.statusCode}, ${fuTr.statusCode === 200 ? fuTr.json().transcripts[0].turns.length : 0} turns` : "no follow-up");

check("a follow-up exists with a real parent",
  ivs.some((i) => i.kind === "follow_up" && ivs.some((p) => p.id === i.parent_interview_id)),
  JSON.stringify(ivs.map((i) => ({ k: i.kind, r: i.round_number }))));

// ── 3. Synthesis ─────────────────────────────────────────────────────────────
const synth = await open("synthesis.html");
await synth.evaluate(`(() => {
  document.getElementById("client-input").value = ${JSON.stringify(CLIENT)};
  loadEngagement();
})()`);
await synth.waitForTimeout(2000);

const synthState = await synth.evaluate(`(() => {
  const e = engagement;
  const byNum = (n) => e.rounds.find((r) => r.roundNumber === n);
  const r1 = byNum(1), r2 = byNum(2);
  const expected1 = VyneScoring.computeRoundScores(r1.interviews, { roleWeight: vyneRoleWeight }).scores;
  return {
    code: e.code,
    r1Count: r1.interviews.length, r2Count: r2.interviews.length,
    r1Scores: r1.scores, r2Scores: r2.scores, expected1: expected1,
    overallText: (document.getElementById("overall-stats") ? document.getElementById("overall-stats").textContent : "").replace(/\\s+/g, " ").trim(),
    confirmed: [...document.querySelectorAll("#confirmed-list .synth-sec-hdr")].map((h) => h.textContent.trim()),
    synthesisBox: (document.getElementById("synthesis-box") ? document.getElementById("synthesis-box").textContent : "").slice(0, 400)
  };
})()`) as {
  code: string; r1Count: number; r2Count: number;
  r1Scores: Record<string, number>; r2Scores: Record<string, number>; expected1: Record<string, number>;
  overallText: string; confirmed: string[]; synthesisBox: string;
};

check("Synthesis loaded the generated engagement", synthState.code === code, `${synthState.code} vs ${code}`);
check("both rounds carry their five interviews",
  synthState.r1Count === 5 && synthState.r2Count === 5, `${synthState.r1Count} / ${synthState.r2Count}`);
check("round 1's stored scores are exactly what the shared formula gives",
  JSON.stringify(synthState.r1Scores) === JSON.stringify(synthState.expected1),
  `stored ${JSON.stringify(synthState.r1Scores)} vs formula ${JSON.stringify(synthState.expected1)}`);
check("round 2 is scored and differs from round 1 (the refresh moved something)",
  Object.keys(synthState.r2Scores).length > 0
    && JSON.stringify(synthState.r2Scores) !== JSON.stringify(synthState.r1Scores),
  `r1 ${JSON.stringify(synthState.r1Scores)} / r2 ${JSON.stringify(synthState.r2Scores)}`);
check("D2 improved between rounds, as the refresh described",
  (synthState.r2Scores.D2 ?? 0) > (synthState.r1Scores.D2 ?? 0),
  `D2 ${synthState.r1Scores.D2} → ${synthState.r2Scores.D2}`);
check("the dashboard shows an overall score and a maturity band",
  /\d\.\d/.test(synthState.overallText) && /AI[- ]/.test(synthState.overallText), synthState.overallText.slice(0, 160));
check("corroborated findings rendered", synthState.confirmed.length > 0, synthState.confirmed.join(" || "));
check("agreement and mere attention are shown as different things",
  synthState.confirmed.some((c) => /roles agree/.test(c)) || synthState.confirmed.some((c) => /raised this area/.test(c)),
  synthState.confirmed.join(" || "));
check("the persisted synthesis rendered without a paid AI call",
  synthState.synthesisBox.length > 120, synthState.synthesisBox.slice(0, 160));
check("synthesis.html threw nothing", errs["synthesis.html"].length === 0, errs["synthesis.html"].join(" | "));

// ── 3b. The round pills, and what planning a NEW round does ──────────────────
//
// This is the scenario a consultant actually meets on a Monday: two rounds
// done, a third planned, nothing interviewed for it yet. Before v5.32.59 that
// blanked the client — the pills landed on the empty round, the dashboard
// showed nothing, the portfolio card lost its maturity band, and the roadmap
// generated from a round with no interviews behind it.
const pillsBefore = await synth.evaluate(`(() => ({
  labels: [...document.querySelectorAll("#round-pills .round-pill")].map((b) => b.textContent.trim()),
  active: [...document.querySelectorAll("#round-pills .round-pill.active")].map((b) => b.textContent.trim()),
  visible: (document.getElementById("round-pills-row") || {}).style ? document.getElementById("round-pills-row").style.display !== "none" : false
}))()`) as { labels: string[]; active: string[]; visible: boolean };

check("the round pills are shown for a multi-round engagement", pillsBefore.visible && pillsBefore.labels.length === 2,
  JSON.stringify(pillsBefore.labels));
check("exactly one pill is selected", pillsBefore.active.length === 1, JSON.stringify(pillsBefore.active));
check("the selected pill is the LATEST round, not the first",
  /^R2\b/.test(pillsBefore.active[0] ?? ""), JSON.stringify(pillsBefore.active));

const overallBefore = synthState.overallText;
const scoreBefore = JSON.stringify(synthState.r2Scores);

// Plan round 3 — exactly what pre_engagement writes: a round with a number,
// a label, and no interviews at all.
const engRow = await app.inject({
  method: "GET", url: "/api/module-state/workspace", headers: { authorization: "Bearer tok-e2e" } });
const engBlob = JSON.parse(engRow.json().state["vynora_engagement_" + code]);
engBlob.rounds.push({
  roundId: "round-3-planned", roundNumber: 3, date: new Date().toISOString().slice(0, 10),
  label: "Q1 Refresh (planned)", type: "refresh", status: "active",
  scopeDimensions: [], interviews: [], scores: {},
});
engBlob.currentRoundId = "round-3-planned";
const planned = await app.inject({
  method: "PUT", url: "/api/module-state/workspace", headers: { authorization: "Bearer tok-e2e" },
  payload: { sets: { ["vynora_engagement_" + code]: JSON.stringify(engBlob) }, deletes: [] },
});
check("a third round was planned", planned.statusCode === 200, String(planned.statusCode));

const synth2 = await open("synthesis.html");
await synth2.evaluate(`(() => {
  document.getElementById("client-input").value = ${JSON.stringify(CLIENT)};
  loadEngagement();
})()`);
await synth2.waitForTimeout(2000);

const after = await synth2.evaluate(`(() => {
  const e = engagement;
  const byNum = (n) => e.rounds.find((r) => r.roundNumber === n);
  return {
    labels: [...document.querySelectorAll("#round-pills .round-pill")].map((b) => b.textContent.trim()),
    active: [...document.querySelectorAll("#round-pills .round-pill.active")].map((b) => b.textContent.trim()),
    r2: byNum(2).scores,
    r3: byNum(3).scores,
    overallText: (document.getElementById("overall-stats") ? document.getElementById("overall-stats").textContent : "").replace(/\\s+/g, " ").trim()
  };
})()`) as { labels: string[]; active: string[]; r2: Record<string, number>; r3: Record<string, number>; overallText: string };

check("the planned round appears as a third pill", after.labels.length === 3, JSON.stringify(after.labels));
check("the pills still land on round 2, NOT the empty round 3",
  /^R2\b/.test(after.active[0] ?? ""), JSON.stringify(after.active));
check("the empty planned round was not stamped with round 2's scores",
  Object.keys(after.r3).length === 0, JSON.stringify(after.r3));
check("round 2's own scores are untouched by planning round 3",
  JSON.stringify(after.r2) === scoreBefore, `${JSON.stringify(after.r2)} vs ${scoreBefore}`);
check("the dashboard still shows the same overall score and band",
  after.overallText === overallBefore, `after "${after.overallText}" vs before "${overallBefore}"`);
check("the dashboard did not go blank", /\d\.\d/.test(after.overallText), after.overallText.slice(0, 120));
check("synthesis.html threw nothing on the re-open", errs["synthesis.html"].length === 0, errs["synthesis.html"].join(" | "));

// The portfolio card, through the real /api/scorecard and the real page.
const sc = await open("scorecard.html");
await sc.waitForTimeout(1200);
const card = await sc.evaluate(`(() => {
  const box = document.getElementById("sc-container");
  return { text: (box.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 400), cards: box.querySelectorAll(".sc-card, .sc-grid > *").length };
})()`) as { text: string; cards: number };

check("the portfolio card still lists the client after a round is planned",
  card.text.includes("Northwind"), card.text.slice(0, 200));
check("the portfolio card did NOT fall back to 'no engagements with a scored round'",
  !/No engagements with a scored round/i.test(card.text), card.text.slice(0, 200));
check("the portfolio card still shows a maturity band",
  /AI[- ](Native|Led|Capable|Exploring|Unaware)/.test(card.text), card.text.slice(0, 200));
check("scorecard.html threw nothing", errs["scorecard.html"].length === 0, errs["scorecard.html"].join(" | "));

// And the two kinds of finding tile, stated explicitly.
const tiles = await synth2.evaluate(`(() => {
  const list = document.getElementById("confirmed-list");
  return {
    heads: [...list.querySelectorAll(".synth-sec-hdr")].map((h) => h.textContent.trim()),
    bodies: list.innerHTML
  };
})()`) as { heads: string[]; bodies: string };
/* v5.32.86: "N roles agree" became "N sources agree". Two divisional COOs are
 * two sources and one role, and the old wording made the count read as a
 * contradiction of itself. */
const agreeTiles = tiles.heads.filter((h) => /sources agree/.test(h));
const areaTiles = tiles.heads.filter((h) => /raised this area/.test(h));
check("at least one tile says the sources AGREE", agreeTiles.length > 0, tiles.heads.join(" || "));
check("at least one tile says they merely RAISED THE AREA", areaTiles.length > 0, tiles.heads.join(" || "));
check("the two kinds are not the same tile", agreeTiles.every((h) => !areaTiles.includes(h)));
check("the area tile spells out that it is not agreement",
  /Attention — not agreement|not agreement/i.test(tiles.bodies));

// The Recommended Focus tile must surface the thematic dimensions too (v5.32.61)
const focus = await synth2.evaluate(`(() => {
  const el = document.querySelector('.card-title') ? document.body : null;
  const tiles = [...document.querySelectorAll('div')].filter((d) => /Raised by several, agreed by none/.test(d.textContent || ''));
  const host = tiles.length ? tiles[tiles.length - 1].closest('div') : null;
  return {
    hasSection: /Raised by several, agreed by none/.test(document.body.textContent || ''),
    hasContradictions: /Scoring Contradictions/.test(document.body.textContent || ''),
    mentionsD5: /D5/.test(document.body.textContent || ''),
    explains: /which account is the real constraint/i.test(document.body.textContent || '')
  };
})()`) as { hasSection: boolean; hasContradictions: boolean; mentionsD5: boolean; explains: boolean };

check('the focus tile still surfaces scoring contradictions', focus.hasContradictions);
check('the focus tile now also surfaces areas raised without agreement', focus.hasSection);
check('and says what to do about them', focus.explains);

// ── 4. Roadmap — do the scores actually transfer? ─────────────────────────────
const road = await open("roadmap.html");
const roadState = await road.evaluate(`(() => {
  const engCode = ${JSON.stringify("__CODE__")};
  const listed = [...document.querySelectorAll("#eng-load-select option")].map((o) => o.textContent.trim());
  applyEngagementByCode(engCode);
  const dims = ["D1","D2","D3","D4","D5","D6","D7"];
  return {
    listed: listed,
    scores: JSON.parse(JSON.stringify(maturityScores)),
    measured: dims.filter((k) => (typeof isMeasured === "function" ? isMeasured(k) : false))
  };
})()`.replace("__CODE__", code)) as { listed: string[]; scores: Record<string, number>; measured: string[] };

check("the roadmap's engagement picker lists the client",
  roadState.listed.some((l) => l.includes("Northwind")), roadState.listed.join(" | "));
check("the picker does NOT mark it '(no scores)'",
  !roadState.listed.some((l) => l.includes("Northwind") && l.includes("no scores")), roadState.listed.join(" | "));
check("applying the engagement transferred all seven dimensions",
  ["D1", "D2", "D3", "D4", "D5", "D6", "D7"].every((d) => roadState.scores[d] > 0), JSON.stringify(roadState.scores));
check("the roadmap knows those dimensions were MEASURED, not assumed",
  roadState.measured.length === 7, roadState.measured.join(","));
check("the roadmap's scores match the latest scored round from Synthesis",
  ["D1", "D2", "D3", "D4", "D5", "D6", "D7"].every(
    (d) => Math.abs((roadState.scores[d] ?? -1) - (synthState.r2Scores[d] ?? -2)) < 0.001),
  `roadmap ${JSON.stringify(roadState.scores)} vs round 2 ${JSON.stringify(synthState.r2Scores)}`);
check("roadmap.html threw nothing", errs["roadmap.html"].length === 0, errs["roadmap.html"].join(" | "));

// ── Teardown ─────────────────────────────────────────────────────────────────
await browser.close();
ui.close();
await app.close();
await closePool();
await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
await admin.end();

console.log("\n=== FULL FLOW: pre-engagement → interviews → scoring → synthesis → roadmap ===\n");
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : `\n        ${r.detail}`}`);
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
