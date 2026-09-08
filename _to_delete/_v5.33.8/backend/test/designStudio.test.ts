/**
 * v5.32.18 — the Solution Design Studio was two things at once: a module with
 * no way to reach it (a Hub card but no rail entry), and a much thinner build
 * than the one that actually existed. This release replaces it with the full
 * studio — portfolio, five-question intake, deterministic pattern router,
 * ten-part design brief, drillable SVG architecture and workflow diagrams,
 * governance/MLOps/runbook packages — and, more importantly, connects it to
 * the Roadmap Builder.
 *
 * The connection is the part worth guarding. The roadmap persisted only
 * `{ucId: true}` — ids and nothing else, with every name and description
 * living in a JS literal inside roadmap.html. No other page could turn a saved
 * selection back into readable use cases, which is why the standalone studio
 * imported them by asking the consultant to download a JSON file and upload it
 * again. roadmap.html now publishes ucMeta alongside the selection, and the
 * studio reads it directly. If either half of that contract regresses the
 * symptom is silent and ugly: a portfolio of raw ids, or an empty studio that
 * looks like the client simply has no use cases.
 *
 * Static source-text regression guard — there is no frontend test runner in
 * this repo (static HTML+JS, no bundler), same pattern as
 * industryDropdownConsistency.test.ts / deckAndFindingsCapsRemoved.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dirname, "..", "..", "frontend");
const BACKEND_SRC = join(__dirname, "..", "src");

const read = (p: string) => readFileSync(join(FRONTEND, p), "utf8");
const readSrc = (p: string) => readFileSync(join(BACKEND_SRC, p), "utf8");

describe("navigation — Design Studio is reachable, Hub is 'The Hub' (v5.32.18)", () => {
  it("the left rail has a Solution Design Studio entry", () => {
    const rail = read("vyne-rail.js");
    expect(rail).toContain('{ href: "solution_design.html",icon: "📐", label: "Design Studio" }');
  });

  it("the rail's Hub entry is labelled 'The Hub'", () => {
    const rail = read("vyne-rail.js");
    expect(rail).toContain('{ href: "index.html",          icon: "⌂",  label: "The Hub" }');
    expect(rail).not.toContain('label: "Hub" }');
  });

  it("every module's home button says 'The Hub' too, not the old 'VYNE Hub'", () => {
    ["interview_agent.html", "pre_engagement.html", "roadmap.html", "synthesis.html"].forEach((f) => {
      const src = read(f);
      expect(src, f).not.toContain("</span> VYNE Hub");
      expect(src, f).toContain("</span> The Hub");
    });
  });

  it("the Hub page titles itself 'The Hub'", () => {
    const idx = read("index.html");
    expect(idx).toContain("VYNE™ Framework™ — The Hub");
    expect(idx).not.toContain("Platform Hub");
  });
});

describe("roadmap.html — publishes use-case metadata for cross-module reads (v5.32.18)", () => {
  it("builds a metadata map for the selected use cases", () => {
    const src = read("roadmap.html");
    expect(src).toContain("function buildSelectedUcMeta(){");
    // The fields the Design Studio actually consumes.
    ["name:", "desc:", "dept:", "impact:", "complexity:", "value:", "phase:"].forEach((f) => {
      expect(src).toContain(f);
    });
    // Effective (override-aware) values, not raw catalog defaults.
    expect(src).toContain("(typeof effImpact==='function')     ? effImpact(u.id)     : (u.impact||'')");
    expect(src).toContain("(typeof effComplexity==='function') ? effComplexity(u.id) : (u.complexity||'')");
  });

  it("savePersistentState persists ucMeta, industryLabel and maturityScores next to the selection", () => {
    const src = read("roadmap.html");
    const fn = src.match(/function savePersistentState\(\)\{([\s\S]*?)\n\}/);
    expect(fn, "expected to find savePersistentState()").toBeTruthy();
    const body = fn![1];
    expect(body).toContain("ucMeta: ucMeta,");
    expect(body).toContain("industryLabel: indLabel,");
    expect(body).toContain("maturityScores: maturityScores,");
    expect(body).toContain("selected: selected,");
  });

  it("a failed metadata build preserves the previous map instead of publishing an empty one", () => {
    // Otherwise a save during early boot (catalog not loaded yet) would wipe
    // the map and the Design Studio would show a portfolio of raw ids.
    const src = read("roadmap.html");
    expect(src).toContain("var ucMeta = prevEntry.ucMeta || {};");
    expect(src).toContain("if(Object.keys(fresh).length || !Object.keys(selected||{}).length) ucMeta = fresh;");
  });
});

describe("solution_design.html — reads the roadmap selection directly (v5.32.18)", () => {
  it("resolves the engagement partition the same way roadmap.html writes it", () => {
    const src = read("solution_design.html");
    expect(src).toContain("function roadmapEngKey(norm){");
    /* v5.32.97: the code lookup moved into engagementCodeFor(), so the literal
     * this used to match is gone while the invariant it protects — that this
     * module and roadmap.html resolve the SAME partition — is unchanged. Both
     * now return 'eng_<CODE>' whenever the client has a code, which since
     * v5.32.96 is every client. Matched as behaviour, not as a source string. */
    expect(src).toContain("function engagementCodeFor(norm){");
    expect(src).toMatch(/return code \? \('eng_'\+code\)/);
    /* The client_<norm> fallback is still READ — roadmap.html may have written
     * it before v5.32.97 and the server migrates lazily — it is just no longer
     * a separate return statement. */
    expect(src).toMatch(/: \('client_'\+norm\)/);
    expect(src).toContain("vynora_engagement_index");
  });

  it("reads vynora_roadmap_state rather than importing an uploaded snapshot file", () => {
    const src = read("solution_design.html");
    expect(src).toContain("function readRoadmapSelection(){");
    expect(src).toContain("st=JSON.parse(vyneStore.getItem('vynora_roadmap_state')||'{}')");
    expect(src).toContain("var mine=(st.byEng||{})[out.engKey]||{};");
    // The file-upload snapshot path is gone entirely.
    expect(src).not.toContain("function loadSnapshot(");
    expect(src).not.toContain("function addSnapUseCase(");
    expect(src).not.toContain('id="snap-input"');
  });

  it("carries real descriptions and diagnostics into each imported use case", () => {
    const src = read("solution_design.html");
    expect(src).toContain("function roadmapItemFor(u){");
    expect(src).toContain("maturityScores:rm.maturity||null");
    // The standalone build hardcoded this placeholder, which starved every prompt.
    expect(src).not.toContain("var desc='(from VYNE snapshot)';");
  });

  it("auto-populates on a client's first visit but never merges behind the consultant's back afterwards", () => {
    const src = read("solution_design.html");
    expect(src).toContain("if(_saved === null){");
    expect(src).toContain("var _n = syncFromRoadmap(true);");
    expect(src).toContain("function pendingRoadmapUseCases(){");
    expect(src).toContain("function updateRoadmapBanner(){");
    // Sync is additive: it appends what's missing and never removes.
    const sync = src.match(/function syncFromRoadmap\(silent\)\{([\s\S]*?)\n\}/);
    expect(sync, "expected to find syncFromRoadmap()").toBeTruthy();
    expect(sync![1]).toContain("pending.forEach(function(u){ state.items.push(roadmapItemFor(u)); });");
    expect(sync![1]).not.toContain("state.items=[]");
  });

  it("a Reset is persisted, so the next open doesn't silently re-import the roadmap", () => {
    const src = read("solution_design.html");
    const reset = src.match(/function resetIntake\(\)\{([\s\S]*?)\n\}/);
    expect(reset, "expected to find resetIntake()").toBeTruthy();
    expect(reset![1]).toContain("autosave();");
  });

  it("degrades honestly for selections saved before metadata publishing existed", () => {
    const src = read("solution_design.html");
    expect(src).toContain("resolved:!!m");
    expect(src).toContain("nm.textContent=u.ucId;");
  });
});

describe("solution_design.html — platform integration (v5.32.18)", () => {
  it("loads the platform bridge and declares its module + task", () => {
    const src = read("solution_design.html");
    expect(src).toContain('window.VYNE_MODULE="solution_design"');
    expect(src).toContain('window.VYNE_TASK_DEFAULT="design_studio"');
    expect(src).toContain('<script src="vyne-client.js"></script>');
    expect(src).toContain('<script src="vyne-rail.js"></script>');
  });

  it("redirects interviewees, matching every other consultant-only module", () => {
    const src = read("solution_design.html");
    expect(src).toContain('if (s && s.role === "interviewee") window.location.href = "interview_agent.html";');
  });

  it("makes no direct provider calls and keeps no API key in the browser", () => {
    const src = read("solution_design.html");
    expect(src).not.toContain("api.anthropic.com");
    expect(src).not.toContain("anthropic-dangerous-direct-browser-access");
    expect(src).not.toContain("localStorage.setItem('vynora_api_key'");
    expect(src).not.toContain("localStorage.getItem('vynora_api_key')");
    // ...and the URL-fragment key handoff is deleted, not merely disabled.
    expect(src).not.toContain("adoptKeyFromUrl");
    expect(src).not.toContain("function submitInlineKey(");
  });

  it("routes all six generators through the metered gateway with distinct task names", () => {
    const src = read("solution_design.html");
    ["design_intake", "design_brief", "design_l3", "design_governance", "design_artifact", "design_tools"].forEach(
      (task) => expect(src, task).toContain("}, '" + task + "')")
    );
    expect((src.match(/await vyneLLM\(/g) || []).length).toBe(6);
  });

  it("persists per client through vyneStore, not one shared localStorage blob", () => {
    const src = read("solution_design.html");
    // v5.32.25: the ||'none' fallback made every client-less session share one
    // key, and 'none' is not a client norm so the server dropped it anyway.
    // Full statement, not the bare fragment — the fix's own comment mentions
    // the old expression in prose while explaining what was wrong with it.
    expect(src).not.toContain("function designStudioKey(){ return 'vynora_design_studio_'+normClient(activeClientName()||'none'); }");
    /* The ||'none' shared-key bug must stay fixed: no client, no key. */
    expect(src).toMatch(/function designStudioKey\(\)\{[\s\S]{0,200}?if\(!n\) return null;/);
    /* v5.32.97: and the key is the engagement CODE when there is one. Keyed by
     * name, a rename stranded the entire portfolio under the old norm and the
     * studio opened empty — indistinguishable from "first visit", which then
     * re-populated it from the roadmap over the consultant's own work. */
    expect(src).toContain("'vynora_design_studio_'+code");
    expect(src).toContain("if(!k){ console.warn('[DesignStudio] no active client — not saving to a shared key'); return; }");
    expect(src).not.toContain("DESIGN_AUTOSAVE_KEY");
    expect(src).not.toContain("localStorage.setItem(");
  });
});

describe("the Caterpillar-specific built-in library is gone (v5.32.18)", () => {
  it("drops UC_LIBRARY / UC_NAME_MAP so one firm's data isn't shipped to every tenant", () => {
    const src = read("solution_design.html");
    expect(src).not.toContain("const UC_LIBRARY = [");
    expect(src).not.toContain("const UC_NAME_MAP = {");
    // Match the DATA, not the prose: the comment that replaced these tables
    // names "Cat Product Link" and "19 branches" while explaining why they had
    // to go, so a bare phrase check would false-fail against its own rationale.
    // These entries only ever existed inside the deleted literals.
    [
      '{name:"Parts demand forecasting"',
      '{name:"SLOB inventory identification"',
      '{name:"Counter parts-lookup assistant"',
      '"sv9":"CSA renewal targeting"',
    ].forEach((s) => expect(src, s).not.toContain(s));
  });

  it("the source picker offers the Roadmap and a one-off, not a built-in catalog", () => {
    const src = read("solution_design.html");
    expect(src).toContain("['roadmap','custom'].forEach(function(k){");
    expect(src).toContain('id="src-roadmap"');
    expect(src).not.toContain('id="src-builtin"');
    expect(src).not.toContain('id="src-snapshot"');
  });
});

describe("solution_design.html — light Foundry theme, matching the rest of the app (v5.32.18)", () => {
  it("uses the same light palette and font stack as roadmap.html", () => {
    const src = read("solution_design.html");
    expect(src).toContain("--navy:#F3F1EB;--navy-mid:#FAF8F3;");
    expect(src).toContain("--white:#132433;--mid-gray:#46535F;");
    expect(src).toContain("family=Inter:wght@300;400;500;600;700;800&family=Space+Grotesk");
    expect(src).not.toContain("DM+Sans");
    expect(src).not.toContain("'DM Sans'");
  });

  it("defines --mid, which the original referenced ~10 times but never declared", () => {
    const src = read("solution_design.html");
    expect(src).toContain("--mid:#5E6B77;");
  });

  it("no dark-surface literals survive in CSS or in the JS-generated SVG", () => {
    const src = read("solution_design.html");
    // #F0EDE8 was the SVG box-label fill — invisible on paper.
    expect(src).not.toContain('fill="#F0EDE8"');
    expect(src).not.toMatch(/rgba\(255,\s*255,\s*255,/);
    expect(src).toContain("var SVG_INK = {");
    expect(src).toContain("page:'#FFFFFF'");
  });

  it("exported SVG and rasterised PNG use the light page colour, not navy", () => {
    const src = read("solution_design.html");
    expect(src).not.toContain("'<svg style=\"background:#0D1F3C\" '");
    expect(src).toContain("svg.replace('<svg ','<svg style=\"background:'+SVG_INK.page+'\" ')");
    expect(src).toContain("ctx.fillStyle=SVG_INK.page;");
  });
});

describe("build/buy/partner artifact is kept as brief Part 10 (v5.32.18)", () => {
  it("renders a tenth brief part backed by the existing server route", () => {
    const src = read("solution_design.html");
    expect(src).toContain("briefPart('10','Build / Buy / Partner &amp; delivery plan'");
    expect(src).toContain("vyneAuth.api('/api/solution-design/generate'");
    expect(src).toContain("vyneAuth.api('/api/solution-design',{method:'PUT'");
  });

  it("keys the design doc on the roadmap's own use-case id so the modules join up", () => {
    const src = read("solution_design.html");
    expect(src).toContain("function sourcingUseCaseId(it){");
    expect(src).toContain("if(it.snapData && it.snapData.ucId) return it.snapData.ucId;");
  });

  it("saving sends the whole document, since the server validates every field", () => {
    const src = read("solution_design.html");
    const fn = src.match(/async function saveSourcing\(\)\{([\s\S]*?)\n\}/);
    expect(fn, "expected to find saveSourcing()").toBeTruthy();
    // v5.32.21 renamed the source binding to d0 so provenance can be carried
    // through the edit; the deep copy of the whole document is unchanged.
    expect(fn![1]).toContain("var doc=JSON.parse(JSON.stringify(d0));");
    expect(fn![1]).toContain("doc.successMetrics=doc.successMetrics||[];");
  });

  it("the printed brief includes Part 10, and no longer prints 'Parked' over a real shortlist", () => {
    const src = read("solution_design.html");
    expect(src).toContain("10 &middot; Build / Buy / Partner &amp; delivery plan");
    expect(src).not.toContain("Parked — candidate technologies will be sourced in a later release");
    expect(src).toContain("var r=resolveSlotTools(it, st);");
  });
});

describe("backend — the new tasks and store key are registered (v5.32.18)", () => {
  it("Design Studio tasks are consultant-only on the shared LLM endpoint", () => {
    const src = readSrc("routes/llm.ts");
    ["design_studio", "design_intake", "design_brief", "design_l3", "design_governance", "design_artifact", "design_tools"].forEach(
      (t) => expect(src, t).toContain('"' + t + '"')
    );
    // solution_design stays server-only — it has its own dedicated route.
    expect(src).toContain('const SERVER_ONLY_TASKS = new Set(["solution_design", "transcribe", "tts"]);');
  });

  it("client-facing Design Studio artifacts get the premium chain in both policies", () => {
    const src = readSrc("llm/router.ts");
    ["design_brief", "design_governance", "design_artifact"].forEach((t) => {
      expect(src).toContain(t + ': ["anthropic-vertex", "gemini-vertex", "gemini-aistudio"]');
      expect(src).toContain(t + ': ["gemini-vertex", "anthropic-vertex"]');
    });
    // The consultant-facing scaffolding deliberately rides the default chain.
    expect(src).not.toContain("design_intake:");
    expect(src).not.toContain("design_tools:");
  });

  it("the portfolio key prefix is client-scoped server-side, or restricted consultants lose their work", () => {
    const src = readSrc("auth/clients.ts");
    expect(src).toContain('"vynora_design_studio_",');
  });
});

describe("unresolvable use-case ids are repaired, not shown raw (v5.32.19)", () => {
  it("roadmap.html backfills published metadata when an engagement is opened", () => {
    // savePersistentState() only fires on a CHANGE, so a client whose selection
    // predates v5.32.18 kept a metadata-less record until they happened to
    // toggle something — and the studio rendered raw ids like gxautomotive_0_0.
    const src = read("roadmap.html");
    expect(src).toContain("function publishUcMeta(){");
    expect(src).toContain("    publishUcMeta();");
    // Opening a client is not an edit: the backfill must not mark the session dirty.
    const fn = src.match(/function publishUcMeta\(\)\{([\s\S]*?)\n\}/);
    expect(fn, "expected to find publishUcMeta()").toBeTruthy();
    expect(fn![1]).not.toContain("markDirty()");
    // ...and must not invent an entry for a client that has never saved.
    expect(fn![1]).toContain("if(!entry) return;");
  });

  it("the studio resolves AI-generated catalog ids on its own, without a roadmap visit", () => {
    const src = read("solution_design.html");
    expect(src).toContain("function catalogUcIndex(){");
    expect(src).toContain("if(k.indexOf('vynora_industry_catalog_') !== 0) return;");
    // The index is consulted only when the roadmap record has no metadata.
    expect(src).toContain("if(!m){                                   // fall back to the generated catalogs");
    // An explicit Refresh must re-read the catalogs rather than a stale index.
    expect(src).toContain("_catalogIndex=null;");
  });

  it("a portfolio already saved with raw ids as names is repaired in place", () => {
    const src = read("solution_design.html");
    expect(src).toContain("function repairUnresolvedItems(){");
    expect(src).toContain("var _repaired = repairUnresolvedItems();");
    // Persist the repair so it runs once, not on every open.
    expect(src).toContain("  autosave();                             // persist the repair so it happens once, not every open");
  });

  it("the repair never overwrites a name or description the consultant edited", () => {
    const src = read("solution_design.html");
    const fn = src.match(/function repairUnresolvedItems\(\)\{([\s\S]*?)\n\}\n/);
    expect(fn, "expected to find repairUnresolvedItems()").toBeTruthy();
    // Only items whose name is still literally the id are touched.
    expect(fn![1]).toContain("if(String(it.name||'').trim() !== id) return;");
    expect(fn![1]).toContain("if(!it.desc) it.desc =");
  });
});

describe("placeholder chips annotate instead of erasing (v5.32.24)", () => {
  it("keeps the placeholder's text rather than replacing it with the word 'set'", () => {
    const src = read("solution_design.html");
    // The old implementation was
    //   esc(s).replace(/(\[[^\]]*\]|placeholder|to be set|TBD)/gi, '<span class="flag-set">set</span>')
    // which threw away the only useful part: "[set with compliance]" became
    // "set", "[Client Functional Safety Manager]" became "set", and an Open
    // Decisions entry written entirely in brackets collapsed to a bare chip —
    // so the section whose whole job is to say what still needs deciding
    // rendered as a column of identical meaningless words.
    expect(src).not.toContain(`'<span class="flag-set">set</span>'`);
    expect(src).toContain("function artFlag(s){");
    expect(src).toContain("if(!label) label = 'to be set';");
    // Anything that isn't already phrased as an instruction gets a verb.
    // v5.32.25 narrowed the guard: only labels that read as an INSTRUCTION are
    // chipped at all, so "corroborated by [CDO, CTO]" stays a factual attribution.
    expect(src).toContain("if(!INSTRUCTION.test(label)) return m;");
    expect(src).toContain("label = 'set: ' + label;");
  });

  it("govFlag is no longer a byte-identical copy free to drift", () => {
    const src = read("solution_design.html");
    expect(src).toContain("function govFlag(s){ return artFlag(s); }");
    expect((src.match(/function (?:art|gov)Flag\(s\)\{ return esc\(s\)/g) || []).length).toBe(0);
  });

  it("the prompts ask for placeholders that name the decision, not bare markers", () => {
    const src = read("solution_design.html");
    expect(src).toContain("write a bracketed placeholder that NAMES what they have to decide");
    expect(src).not.toContain("Mark client-set values as bracketed placeholders like [set with compliance].");
    // Open decisions must never be a bare marker — that section IS the question.
    // All three artifact prompts (governance, MLOps, runbook) carry it.
    expect((src.match(/full sentence naming the decision and who should make it/g) || []).length).toBe(3);
  });

  it("the banner explains what a chip means now that it carries content", () => {
    const src = read("solution_design.html");
    expect(src).toContain("the chip says what it is");
    expect(src).not.toContain('Values marked <span class="flag-set">set</span> are placeholders');
  });
});
