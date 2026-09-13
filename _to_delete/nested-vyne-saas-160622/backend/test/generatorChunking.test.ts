/**
 * v5.32.27 — the two generators that ask for more than one response can hold.
 *
 * vyneFit (v5.32.23) solved the INPUT side: a prompt too big for the context
 * window gets summarised rather than truncated. It cannot help these two,
 * because their prompts are three paragraphs — it is the OUTPUT that does not
 * fit. The industry catalog asks for up to ~10 functions x ~10 use cases x 4
 * sub-use-cases against a 24000-token ceiling; the Gantt asks for one row per
 * selected initiative against an effective 8192, and its own error copy used
 * to say "Try fewer initiatives". The only fix for an output that does not fit
 * is more calls.
 *
 * These are NOT string-match tests. The functions are extracted from
 * roadmap.html and vyne-client.js and EXECUTED against a stubbed gateway, with
 * the failure modes that matter injected: a whole chunk failing, a chunk
 * returning fewer items than it was asked for, and a model paraphrasing a name
 * or an id it was told to reuse verbatim. What is asserted is the property the
 * split has to preserve — nothing the first pass identified may go missing —
 * because a chunked generator that silently drops a chunk is strictly worse
 * than the truncation it replaced.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FE = (p: string) => readFileSync(join(__dirname, "..", "..", "frontend", p), "utf8");

const ROADMAP = FE("roadmap.html");
const CLIENT = FE("vyne-client.js");

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ctx = Record<string, any>;

/** Pull a top-level function out of roadmap.html by its exact header. */
function grab(src: string, header: string): string {
  const i = src.indexOf(header);
  if (i < 0) throw new Error("not found in source: " + header);
  const j = src.indexOf("\n}\n", i);
  if (j < 0) throw new Error("unterminated: " + header);
  return src.slice(i, j + 3);
}

/** vynePool lives inside vyne-client.js's IIFE, so it is indented. */
function grabPool(): string {
  const i = CLIENT.indexOf("function vynePool(items, limit, fn, onProgress) {");
  const j = CLIENT.indexOf("\n  window.vynePool = vynePool;");
  expect(i, "vynePool not found").toBeGreaterThan(-1);
  expect(j, "vynePool export not found").toBeGreaterThan(-1);
  return CLIENT.slice(i, j).replace(/^ {2}/gm, "");
}

function constant(name: string): string {
  const m = new RegExp("var " + name + " = (\\d+);").exec(ROADMAP);
  expect(m, name + " not declared in roadmap.html").not.toBeNull();
  return m![1];
}

/**
 * Build a sandbox holding the real generator code and stubs for everything it
 * touches in the page. Deliberately minimal: if a generator starts depending
 * on more of the page, this throws rather than quietly testing a mock.
 */
function sandbox(): Ctx {
  const pieces = [
    grabPool(),
    grab(ROADMAP, "function catalogNameKey(n){"),
    grab(ROADMAP, "async function llmJsonCall(prompt, maxTokens){"),
    grab(ROADMAP, "function buildCatalogSkeletonPrompt(label){"),
    grab(ROADMAP, "function buildCatalogDetailPrompt(label, dept){"),
    grab(ROADMAP, "async function generateIndustryCatalog(label){"),
    grab(ROADMAP, "function ganttRowId(prefix, name, i){"),
    grab(ROADMAP, "function ganttPlanInputs(synthesisResult, ctx){"),
    grab(ROADMAP, "function buildGanttFramePrompt(synthesisResult, ctx, plan){"),
    grab(ROADMAP, "function buildGanttBatchPrompt(synthesisResult, ctx, plan, batch, scheduled, batchNo, batchTotal){"),
    grab(ROADMAP, "function ganttNormaliseRow(raw, id, name, type, total){"),
    grab(ROADMAP, "async function doGanttGeneration(apiKey, btn, status, output){"),
  ].join("\n");

  const guideMatch = /var GANTT_DURATION_GUIDE = '([\s\S]*?)';\n/.exec(ROADMAP);
  expect(guideMatch, "GANTT_DURATION_GUIDE not declared").not.toBeNull();

  const consts = `
    var CATALOG_DETAIL_CONCURRENCY = ${constant("CATALOG_DETAIL_CONCURRENCY")};
    var GANTT_BATCH_SIZE = ${constant("GANTT_BATCH_SIZE")};
    var GANTT_DURATION_GUIDE = ${JSON.stringify(guideMatch![1])};
  `;

  const stubs = `
    var saved = {}, toasts = [], statusLog = [], warnings = [];
    var currentClientName='', lastAppliedEngCode='', currentIndustry='';
    var vyneStore = { getItem:function(k){return saved[k]||null;}, setItem:function(k,v){saved[k]=v;} };
    function customCatalogKey(l){ return 'cat_'+l; }
    function registerCustomIndustry(){ return 'key'; }
    function showToast(m){ toasts.push(m); }
    function normIndustry(l){ return String(l||'').toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,40); }
    function ucSlug(name, di, ui){
      return String(name||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,40) || ('d'+di+'u'+ui);
    }
    function populateIndustrySelect(){} function updateUI(){} function renderMatrix(){}
    function renderMaturitySliders(){} function applyEngagementByCode(){} function removeCatalogPanel(){}
    var _els = {
      'gen-cat-btn': { disabled:false, textContent:'' },
      'gen-cat-status': { set textContent(v){ statusLog.push(v); }, get textContent(){ return statusLog[statusLog.length-1]||''; } }
    };
    var document = { getElementById:function(id){ return _els[id]||null; } };
    function parseJsonRobust(text){
      try { return JSON.parse(String(text||'').trim()); }
      catch(e){ throw new Error('Response could not be parsed'); }
    }
    var synthesisResult=null, ganttData=null, depEdges={}, _ctx=null;
    function buildSynthesisContext(){ return _ctx; }
    function selectedUcs(){ return []; }
    function depResolveStatus(){ return 'none'; }
    function getUc(){ return null; }
    function enforceConfirmedDepsOnGantt(){}
    function savePersistentState(){}
    function renderGantt(){}
  `;

  const ctx: Ctx = {
    Promise, JSON, Math, Date, Array, Object, String, Number, parseInt, isNaN, setTimeout,
    console: { warn: (...a: unknown[]) => ctx.warnings.push(a.join(" ")), info: () => {}, error: () => {} },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(consts + stubs + pieces, ctx);
  return ctx;
}

/** Shape a stubbed gateway response the way vyneLLM does. */
function reply(text: string) {
  return { ok: true, status: 200, truncated: false, json: async () => ({ content: [{ type: "text", text }] }) };
}

/* ── vynePool ──────────────────────────────────────────────────────────────*/

describe("vynePool — the chunk runner (v5.32.27)", () => {
  it("honours the concurrency limit and preserves input order", async () => {
    const ctx = sandbox();
    let live = 0, peak = 0;
    const out = await ctx.vynePool([1, 2, 3, 4, 5, 6, 7, 8], 3, async (x: number, i: number) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5 + (i % 3) * 5));
      live--;
      return x * 10;
    });
    expect(peak).toBe(3);
    expect(out.map((e: Ctx) => e.value)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it("isolates a failure instead of rejecting the whole batch", async () => {
    // A chunked generator that loses nine good chunks because the tenth timed
    // out is worse than the truncation it replaced.
    const ctx = sandbox();
    const out = await ctx.vynePool([1, 2, 3], 2, async (x: number) => {
      if (x === 2) throw new Error("boom");
      return x;
    });
    expect(out.map((e: Ctx) => e.ok)).toEqual([true, false, true]);
    expect(out[1].error.message).toBe("boom");
  });

  it("reports progress and handles the empty and limit>length cases", async () => {
    const ctx = sandbox();
    const seen: number[] = [];
    await ctx.vynePool([1, 2, 3], 9, async (x: number) => x, (d: number) => seen.push(d));
    expect(seen).toEqual([1, 2, 3]);
    expect(await ctx.vynePool([], 3, async () => 1)).toEqual([]);
  });
});

/* ── the industry catalog ──────────────────────────────────────────────────*/

/** 8 functions x 9 use cases = 72 named in pass 1. */
function skeletonDepts() {
  return Array.from({ length: 8 }, (_, d) => ({
    name: "Function " + (d + 1), icon: "⚙️", scope: "scope " + (d + 1),
    ucNames: Array.from({ length: 9 }, (_, u) => "UC " + (d + 1) + "." + (u + 1)),
  }));
}

/**
 * @param failFns functions whose detail call fails outright (both attempts)
 * @param shortFn a function that returns only its first four use cases
 * @param driftFn a function that renames its first use case (punctuation)
 */
function catalogGateway(ctx: Ctx, depts: Ctx[], failFns: number[], shortFn?: number, driftFn?: number) {
  const stats = { skeleton: 0, detail: 0 };
  ctx.vyneLLM = async (opts: Ctx) => {
    const prompt = JSON.parse(opts.body).messages[0].content as string;
    if (prompt.includes("PASS 1 of 2")) {
      stats.skeleton++;
      return reply(JSON.stringify({ label: "Widget Rental", depts }));
    }
    stats.detail++;
    const d = Number(/ONE function only: "Function (\d+)"/.exec(prompt)![1]);
    if (failFns.includes(d)) throw new Error("network blip");
    const names: string[] = depts[d - 1].ucNames;
    const emit = (d === shortFn ? names.slice(0, 4) : names).map((n, i) => ({
      name: d === driftFn && i === 0 ? n.replace("UC ", "UC. ") : n,
      desc: "d", impact: "high", complexity: "low", value: "v", phase: "p1",
      subUcs: [{ name: "s1", desc: "x", data: "y", tech: "z", phase: "p1" }],
    }));
    return reply(JSON.stringify({ uc: emit }));
  };
  return stats;
}

describe("generateIndustryCatalog — skeleton then per-function detail (v5.32.27)", () => {
  it("splits into one skeleton call plus one call per function", async () => {
    const ctx = sandbox();
    const depts = skeletonDepts();
    const stats = catalogGateway(ctx, depts, []);
    await ctx.generateIndustryCatalog("Widget Rental");
    expect(stats.skeleton).toBe(1);
    expect(stats.detail).toBe(8);
    const cat = JSON.parse(ctx.saved["cat_Widget Rental"]);
    expect(cat.depts).toHaveLength(8);
    expect(cat.depts.flatMap((d: Ctx) => d.uc)).toHaveLength(72);
  });

  it("NOTHING the skeleton named is lost when detail calls fail or come back short", async () => {
    // This is the whole point of the rewrite. Two functions fail outright (18
    // use cases), one returns 4 of its 9 (5 more) — 23 backfilled, 72 kept.
    const ctx = sandbox();
    const depts = skeletonDepts();
    catalogGateway(ctx, depts, [3, 6], 5);
    await ctx.generateIndustryCatalog("Widget Rental");

    const cat = JSON.parse(ctx.saved["cat_Widget Rental"]);
    const all = cat.depts.flatMap((d: Ctx) => d.uc);
    expect(cat.depts).toHaveLength(8);
    expect(all).toHaveLength(72);
    expect(all.map((u: Ctx) => u.name).sort())
      .toEqual(depts.flatMap((d) => d.ucNames).sort());
    expect(all.filter((u: Ctx) => u.subUcs.length === 0)).toHaveLength(23);
  });

  it("retries a failed function once before giving up on its detail", async () => {
    const ctx = sandbox();
    const stats = catalogGateway(ctx, skeletonDepts(), [3, 6]);
    await ctx.generateIndustryCatalog("Widget Rental");
    expect(stats.detail).toBe(10); // 8 functions + one retry each for 3 and 6
  });

  it("matches a use case back even when the model drifts its punctuation", async () => {
    const ctx = sandbox();
    catalogGateway(ctx, skeletonDepts(), [], undefined, 5);
    await ctx.generateIndustryCatalog("Widget Rental");
    const all = JSON.parse(ctx.saved["cat_Widget Rental"]).depts.flatMap((d: Ctx) => d.uc);
    const drifted = all.find((u: Ctx) => u.name === "UC 5.1");
    expect(drifted.subUcs, "renamed entry was treated as missing").toHaveLength(1);
  });

  it("says so, out loud, when anything came back name-only", async () => {
    // A silently thinner catalog is exactly the failure this replaces: the old
    // toast reported the salvaged count as if it were the answer.
    const ctx = sandbox();
    catalogGateway(ctx, skeletonDepts(), [3, 6], 5);
    await ctx.generateIndustryCatalog("Widget Rental");
    expect(ctx.toasts[0]).toContain("72 use cases");
    expect(ctx.toasts[0]).toContain("23 use cases saved by name only");
    expect(ctx.toasts[0]).toContain("nothing was dropped");
    expect(ctx.toasts[0]).toContain("Function 3");
  });

  it("a clean run says nothing about backfill", async () => {
    const ctx = sandbox();
    catalogGateway(ctx, skeletonDepts(), []);
    await ctx.generateIndustryCatalog("Widget Rental");
    expect(ctx.toasts[0]).not.toContain("name only");
  });

  it("gives every use case a unique id and drops duplicate names catalog-wide", async () => {
    // ids are derived from names (ucSlug, v5.32.25), so a duplicated name
    // would collapse two use cases onto one id and silently rebind overrides.
    const ctx = sandbox();
    const depts = skeletonDepts();
    depts[1].ucNames[0] = depts[0].ucNames[0];      // exact duplicate
    depts[2].ucNames[0] = depts[0].ucNames[1] + "!"; // duplicate after normalisation
    catalogGateway(ctx, depts, []);
    await ctx.generateIndustryCatalog("Widget Rental");
    const all = JSON.parse(ctx.saved["cat_Widget Rental"]).depts.flatMap((d: Ctx) => d.uc);
    expect(all).toHaveLength(70);
    expect(new Set(all.map((u: Ctx) => u.id)).size).toBe(70);
  });

  it("pass 1 asks for names only, and pass 2 is told the names are fixed", async () => {
    const ctx = sandbox();
    const skel = ctx.buildCatalogSkeletonPrompt("Widget Rental");
    expect(skel).toContain("PASS 1 of 2 and it is NAMES ONLY");
    // The v5.32.17 anti-cap guidance has to survive the restructure.
    expect(skel).toContain("typically 6-10 functions for a real industry, but let the value chain decide, not a fixed count");
    expect(skel).toContain("typically 5-10, but do not pad to hit a number and do not omit a real one to stay under an old cap");

    const detail = ctx.buildCatalogDetailPrompt("Widget Rental", { name: "Ops", scope: "s", ucNames: ["A", "B"] });
    expect(detail).toContain("Return exactly 2 entries");
    expect(detail).toContain("reusing each name VERBATIM");
    expect(detail).toContain("Provide 2-4 subUcs per use case.");
    expect(detail).toContain("1. A");
  });
});

/* ── the Gantt ─────────────────────────────────────────────────────────────*/

function ganttFixture(ctx: Ctx, n: number, confirmedDurationAt?: number) {
  ctx._ctx = {
    industry: "Widget Rental",
    initiatives: Array.from({ length: n }, (_, i) => ({
      id: "uc" + i, name: "Initiative " + (i + 1), dept: "Ops", impact: "high",
      readiness: 60, blockingDimCount: 1, depSummary: {},
      confirmedDurationMonths: i === confirmedDurationAt ? 7 : null,
    })),
  };
  ctx.synthesisResult = {
    phases: [{ timeframe: "0-12mo", unlockedInitiatives: ["Initiative 1"], investments: ["Data platform"] }],
    sharedInvestments: [
      { name: "Data platform", phase: "p1", effort: "high", constraintType: "capex", unlocks: ["Initiative 1"] },
      { name: "ML platform", phase: "p1", effort: "med", constraintType: "tech", unlocks: [] },
    ],
  };
}

/** @param failCall the 1-based CALL number (frame is 1) to fail outright */
function ganttGateway(ctx: Ctx, opts: { failCall?: number; shortCall?: number } = {}) {
  const prompts: string[] = [];
  ctx.vyneLLM = async (o: Ctx) => {
    const prompt = JSON.parse(o.body).messages[0].content as string;
    prompts.push(prompt);
    if (prompt.includes("CALL 1 of a multi-call build")) {
      return reply(JSON.stringify({
        foundations: [
          { id: "fnd_data_platform_1", name: "renamed by the model", startMonth: 1, durationMonths: 5, dependsOn: [], milestone: "M5", detail: "d" },
          { id: "fnd_ml_platform_2", name: "ML platform", startMonth: 3, durationMonths: 2, dependsOn: [], milestone: "", detail: "d" },
        ],
        change: [{ id: "chg_enablement", name: "Enablement", startMonth: 1, durationMonths: 36, dependsOn: [], milestone: "", detail: "parallel" }],
      }));
    }
    const callNo = Number(/^This is CALL (\d+) of (\d+)\./m.exec(prompt)![1]);
    if (callNo === opts.failCall) throw new Error("gateway 502");
    const ids = [...prompt.matchAll(/^id:(ai_[a-z0-9_]+) \|/gm)].map((x) => x[1]);
    const emit = (callNo === opts.shortCall ? ids.slice(0, -2) : ids).map((id, i) => ({
      id, name: "the model paraphrased this", startMonth: 6 + i, durationMonths: 40,
      dependsOn: [], milestone: "", detail: "d",
    }));
    return reply(JSON.stringify({ rows: emit }));
  };
  return prompts;
}

async function runGantt(ctx: Ctx) {
  const status = { _v: "", get textContent() { return this._v; }, set textContent(v: string) { this._v = v; } };
  await ctx.doGanttGeneration("k", { disabled: false, innerHTML: "" }, status, { innerHTML: "" });
  const rows = Object.fromEntries(ctx.ganttData.workstreams.map((w: Ctx) => [w.id, w.rows]));
  return { status, rows, ai: rows.ai_initiatives as Ctx[] };
}

describe("doGanttGeneration — frame then batched initiatives (v5.32.27)", () => {
  it("splits into one frame call plus ceil(n / GANTT_BATCH_SIZE) batches", async () => {
    const ctx = sandbox();
    ganttFixture(ctx, 47);
    const prompts = ganttGateway(ctx);
    const { rows, ai } = await runGantt(ctx);
    expect(prompts).toHaveLength(1 + Math.ceil(47 / Number(constant("GANTT_BATCH_SIZE"))));
    expect(rows.foundations).toHaveLength(2);
    expect(rows.change_mgmt).toHaveLength(1);
    expect(ai).toHaveLength(47);
  });

  it("EVERY selected initiative gets a row, even when a whole batch fails", async () => {
    const ctx = sandbox();
    ganttFixture(ctx, 47);
    ganttGateway(ctx, { failCall: 3, shortCall: 4 });
    const { ai, status } = await runGantt(ctx);
    expect(ai).toHaveLength(47);
    expect(ai.map((r) => r.name).sort()).toEqual(ctx._ctx.initiatives.map((i: Ctx) => i.name).sort());
    expect(ai.filter((r) => /Timing not generated/.test(r.detail))).toHaveLength(17); // 15 + 2
    expect(status.textContent).toContain("nothing was dropped");
  });

  it("pre-assigned ids and names win over whatever the model echoes back", async () => {
    // enforceConfirmedDepsOnGantt matches rows to use cases BY NAME. A
    // paraphrased title silently stops every confirmed dependency from being
    // enforced on that row — no error, just a plan that ignores the
    // consultant's sequencing.
    const ctx = sandbox();
    ganttFixture(ctx, 20);
    ganttGateway(ctx);
    const { ai, rows } = await runGantt(ctx);
    expect(ai.some((r) => /paraphrased/.test(r.name))).toBe(false);
    expect(rows.foundations[0].name).toBe("Data platform");
    expect(new Set(ai.map((r) => r.id)).size).toBe(20);
  });

  it("clamps a row that would run past the 36-month timeline", async () => {
    const ctx = sandbox();
    ganttFixture(ctx, 20);
    ganttGateway(ctx); // the stub returns durationMonths:40 for every row
    const { ai } = await runGantt(ctx);
    expect(ai.every((r) => r.startMonth >= 1 && r.startMonth + r.durationMonths - 1 <= 36)).toBe(true);
  });

  it("a later batch is sequenced against what earlier calls actually scheduled", async () => {
    const ctx = sandbox();
    ganttFixture(ctx, 47);
    const prompts = ganttGateway(ctx, { failCall: 3 });
    const { ai } = await runGantt(ctx);
    const last = prompts[prompts.length - 1];
    const carry = last.split("ALREADY SCHEDULED")[1].split("INITIATIVES TO SCHEDULE (use")[0];
    const lines = carry.split("\n").filter((l) => l.startsWith("id:"));
    // 2 foundations + 30 initiatives from batches 1-2. Batch 3 failed, so it
    // contributes nothing to the carry-forward...
    expect(lines).toHaveLength(32);
    expect(carry).toContain("id:fnd_data_platform_1 | Data platform | months 1-5");
    expect(carry).not.toContain("id:ai_initiative_31_31");
    // ...but its initiatives are still in the finished chart.
    expect(ai.some((r) => r.id === "ai_initiative_31_31")).toBe(true);
  });

  it("backfill uses the consultant's confirmed duration when they gave one", async () => {
    const ctx = sandbox();
    ganttFixture(ctx, 47, 31);       // Initiative 32, inside the batch that fails
    ganttGateway(ctx, { failCall: 3 });
    const { ai } = await runGantt(ctx);
    expect(ai.find((r) => r.name === "Initiative 32")!.durationMonths).toBe(7);
    expect(ai.find((r) => r.name === "Initiative 33")!.durationMonths).toBe(4); // default
  });

  it("the batch prompt forbids restating already-scheduled rows", async () => {
    const ctx = sandbox();
    ganttFixture(ctx, 47);
    const prompts = ganttGateway(ctx);
    await runGantt(ctx);
    const batch = prompts[2];
    expect(batch).toContain("Everything already scheduled is FIXED");
    expect(batch).toContain("use the given id VERBATIM");
    expect(batch).toContain("exactly one row each, no more, no fewer");
  });
});

describe("the single-call shapes are gone (v5.32.27)", () => {
  it("the catalog no longer asks for the whole thing in one 24000-token call", () => {
    expect(ROADMAP).not.toContain("model:'claude-sonnet-4-5',max_tokens:24000,messages:[{role:'user',content:prompt}]})});");
    expect(ROADMAP).toContain("var CATALOG_DETAIL_CONCURRENCY =");
  });

  it("the Gantt no longer builds one prompt for every row", () => {
    expect(ROADMAP).not.toContain("function buildGanttPrompt(synthesisResult, ctx){");
    expect(ROADMAP).toContain("function buildGanttFramePrompt(");
    expect(ROADMAP).toContain("function buildGanttBatchPrompt(");
  });

  it("every chunked call asks for a budget one response can actually hold", () => {
    // The old ceilings were 24000 (catalog) and 6000 (Gantt) for the WHOLE
    // artefact. Each call now covers a bounded slice, so 8000 is genuinely
    // generous rather than a number chosen to postpone the problem.
    const calls = [...ROADMAP.matchAll(/llmJsonCall\([\s\S]{0,200}?, (\d+)\)/g)].map((m) => Number(m[1]));
    expect(calls.length, "no llmJsonCall sites found").toBeGreaterThanOrEqual(4);
    expect(calls.every((n) => n <= 8000)).toBe(true);
    expect(Number(constant("GANTT_BATCH_SIZE"))).toBeLessThanOrEqual(20);
    expect(Number(constant("CATALOG_DETAIL_CONCURRENCY"))).toBeLessThanOrEqual(6);
  });
});
