/**
 * v5.32.21 — grounding the build/buy/partner generator, and making it declare
 * what it could not ground.
 *
 * The generator was producing a client-ready document full of confident
 * specifics — naming a client's source control and requirements tool,
 * asserting how they test today, quoting durations and targets — from a prompt
 * whose only real inputs were a company name and the word "Automotive". None
 * of it was marked as inference, so a first draft read like research.
 *
 * Two fixes, both tested here:
 *
 *   1. The route now loads what the engagement actually established: measured
 *      D1-D7 scores against sector benchmarks, findings corroborated by two or
 *      more interviewees, synthesis gaps and root causes, and the client's
 *      stated problem. "Confirmed findings" is not stored anywhere — the
 *      Synthesis dashboard derives it at render time from the ≥2-distinct-roles
 *      rule — so that rule is re-derived server-side, and the derivation is the
 *      thing most worth pinning: weaken it to one role and a single person's
 *      account of how something works starts being presented as fact.
 *
 *   2. The model must declare provenance, and the server backstops it. A model
 *      marking its own homework is precisely what this feature exists to stop,
 *      so a document generated with no evidence behind it is forced to
 *      "assumed" regardless of what the model claimed about itself.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deriveConfirmedFindings, formatEvidenceForPrompt, type ClientEvidence } from "../src/tenant/engagementLookup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTE = readFileSync(join(__dirname, "..", "src", "routes", "solutionDesign.ts"), "utf8");
const LOOKUP = readFileSync(join(__dirname, "..", "src", "tenant", "engagementLookup.ts"), "utf8");
const STUDIO = readFileSync(join(__dirname, "..", "..", "frontend", "solution_design.html"), "utf8");

const round = (interviews: unknown[]) => ({ interviews }) as never;

describe("deriveConfirmedFindings — corroboration, not repetition (v5.32.21, tightened v5.32.59)", () => {
  it("promotes the SAME point made by two different roles", () => {
    const out = deriveConfirmedFindings([
      round([
        { role: "CTO", findings: [{ dimension: "D2", text: "Test data is fragmented across teams." }] },
        { role: "CDO", findings: [{ dimension: "D2", text: "Our test data is fragmented across the teams." }] },
      ]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].dimension).toBe("D2");
    expect(out[0].roles.sort()).toEqual(["CDO", "CTO"]);
    expect(out[0].dimensionName).toBe("Technology & Infrastructure");
    expect(out[0].texts).toHaveLength(2);
  });

  it("does NOT promote two different points that merely share a dimension (F13)", () => {
    /* This case USED TO PASS as a confirmed finding, and it is why F13 was
     * raised. "Test data is fragmented" and "no single source of truth for
     * test RESULTS" are adjacent observations, not the same claim — and
     * formatEvidenceForPrompt hands confirmed findings to the model under the
     * heading ESTABLISHED FACT, with both executives named. */
    const out = deriveConfirmedFindings([
      round([
        { role: "CTO", findings: [{ dimension: "D2", text: "Test data is fragmented across teams." }] },
        { role: "CDO", findings: [{ dimension: "D2", text: "No single source of truth for release sign-off." }] },
      ]),
    ]);
    expect(out).toEqual([]);
  });

  it("does NOT promote a dimension raised repeatedly by a single role", () => {
    // The whole point: one person's account is not an established fact, no
    // matter how many times they said it or across how many rounds.
    const out = deriveConfirmedFindings([
      round([{ role: "CTO", findings: [{ dimension: "D2", text: "a" }, { dimension: "D2", text: "b" }] }]),
      round([{ role: "CTO", findings: [{ dimension: "D2", text: "c" }] }]),
    ]);
    expect(out).toEqual([]);
  });

  it("counts roles across rounds, not just within one", () => {
    // v5.32.59: the texts used to be "a" and "b". Those carry no content at
    // all, so under the claim-level rule they establish nothing — the test was
    // only ever asserting that two roles had spoken.
    const out = deriveConfirmedFindings([
      round([{ role: "CTO", findings: [{ dimension: "D5", text: "handoffs between shifts are undocumented" }] }]),
      round([{ role: "COO", findings: [{ dimension: "D5", text: "shift handoffs are undocumented" }] }]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].roles.sort()).toEqual(["COO", "CTO"]);
  });

  it("drops findings whose text carries no content words", () => {
    const out = deriveConfirmedFindings([
      round([
        { role: "CTO", findings: [{ dimension: "D5", text: "a" }] },
        { role: "COO", findings: [{ dimension: "D5", text: "b" }] },
      ]),
    ]);
    expect(out).toEqual([]);
  });

  it("ignores findings with no role, no dimension, or no text", () => {
    const out = deriveConfirmedFindings([
      round([
        { role: "", findings: [{ dimension: "D1", text: "orphan" }] },
        { role: "CFO", findings: [{ dimension: "", text: "x" }, { dimension: "D1", text: "" }] },
        { role: "CEO", findings: [{ dimension: "D1", text: "real" }] },
      ]),
    ]);
    expect(out).toEqual([]);
  });

  it("deduplicates identical text and caps how much rides into the prompt", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ dimension: "D3", text: `finding ${i}` }));
    const out = deriveConfirmedFindings([
      round([
        { role: "CEO", findings: [...many, { dimension: "D3", text: "finding 0" }] },
        { role: "CTO", findings: [{ dimension: "D3", text: "finding 0" }] },
      ]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].texts.length).toBeLessThanOrEqual(4);
  });

  it("returns nothing when there are no interviews at all", () => {
    expect(deriveConfirmedFindings([])).toEqual([]);
    expect(deriveConfirmedFindings([round([])])).toEqual([]);
  });
});

describe("formatEvidenceForPrompt — says nothing rather than something empty (v5.32.21)", () => {
  const base = (): ClientEvidence => ({
    code: "ENG-1", hasAny: false, rolesInterviewed: [], interviewCount: 0,
    confirmedFindings: [], thematicFindings: [], criticalGaps: [], strengths: [], blindSpots: [], hasSynthesis: false,
  });

  it("returns null when nothing real is known, so the caller can say so explicitly", () => {
    // An empty EVIDENCE heading reads like an absence of problems rather than
    // an absence of data, which is the opposite of the intent.
    expect(formatEvidenceForPrompt(base())).toBeNull();
  });

  it("renders scores against the sector benchmark when both are present", () => {
    const ev = { ...base(), hasAny: true, scores: { D2: 2.4 }, benchmarks: { D2: { avg: 3.1 } }, overall: 2.4, maturity: "AI Exploring" };
    const out = formatEvidenceForPrompt(ev)!;
    expect(out).toContain("D2 Technology & Infrastructure: 2.4/5 (sector avg 3.1)");
    expect(out).toContain("AI Exploring");
  });

  it("labels corroborated findings as established fact, with the roles that raised them", () => {
    const ev = {
      ...base(), hasAny: true,
      confirmedFindings: [{ dimension: "D2", dimensionName: "Technology & Infrastructure", roles: ["CTO", "CDO"], texts: ["fragmented test data"] }],
    };
    const out = formatEvidenceForPrompt(ev)!;
    expect(out).toContain("ESTABLISHED FACT");
    expect(out).toContain("[CTO, CDO]");
  });

  it("carries the client's own words about the problem", () => {
    const ev = { ...base(), hasAny: true, clientProblem: "Launch delays from late firmware defects." };
    expect(formatEvidenceForPrompt(ev)!).toContain("Launch delays from late firmware defects.");
  });
});

describe("the route grounds the prompt and backstops the model's self-report (v5.32.21)", () => {
  it("loads the client's evidence before generating", () => {
    expect(ROUTE).toContain("evidence = await loadClientEvidence(ctx.tenantId, clientName);");
    expect(ROUTE).toContain("buildPrompt(input, evidence)");
  });

  it("an evidence-load failure degrades to unevidenced instead of failing the request", () => {
    expect(ROUTE).toContain('req.log.warn({ err: e }, "solution design: evidence load failed, generating unevidenced");');
  });

  it("the no-evidence branch forbids asserting current practice or naming systems", () => {
    expect(ROUTE).toContain("There is NO diagnostic data for this client yet");
    expect(ROUTE).toContain("NOT as a statement about this client");
    expect(ROUTE).toContain("Do NOT name specific vendors, products or internal systems as if the client uses them.");
  });

  it("the evidenced branch requires citation and forbids inventing named systems", () => {
    expect(ROUTE).toContain("Do NOT invent specific vendors, tools, systems or org structures the evidence does not name.");
    expect(ROUTE).toContain("A short grounded paragraph beats a long invented one.");
  });

  it("the roadmap's value figure is passed as a target, not as measured evidence", () => {
    // It is itself AI-generated upstream; restating it as a result would launder
    // one model's guess into another model's finding.
    expect(ROUTE).toContain("this is a planning target carried from the roadmap, not a measured result");
  });

  it("forces 'assumed' when nothing was supplied, whatever the model claimed", () => {
    expect(ROUTE).toContain("if (!evidence.hasAny) {");
    expect(ROUTE).toContain('built.currentStateBasis = "assumed";');
    expect(ROUTE).toContain("built.phasedPlan = built.phasedPlan.map((p) => ({ ...p, assumed: true }));");
    expect(ROUTE).toContain("built.successMetrics = built.successMetrics.map((m) => ({ ...m, assumed: true }));");
  });

  it("records what was available at generation time, and a hand-edit does not erase it", () => {
    expect(ROUTE).toContain("evidenceBasis: {");
    expect(ROUTE).toContain("evidenceBasis: existing?.evidenceBasis,");
  });

  it("provenance fields are optional, so documents saved before this release still load", () => {
    expect(ROUTE).toContain('currentStateBasis: z.enum(["evidenced", "assumed", "mixed"]).optional(),');
    expect(ROUTE).toContain("assumptions: z.array(z.string()).optional(),");
    expect(ROUTE).toContain("assumed: z.boolean().optional()");
  });

  it("the unreliable push-artifact score key is deliberately not read", () => {
    // vynora_roadmap_scores_ is written against the firm-wide newest engagement,
    // not the loaded client. The engagement record is the authority.
    expect(LOOKUP).not.toContain("vynora_roadmap_scores_");
    expect(LOOKUP).toContain('"vynora_engagement_" + code');
  });

  it("resolves the engagement code by index, then heals from the records themselves", () => {
    expect(LOOKUP).toContain("vynora_engagement_index");
    expect(LOOKUP).toContain("// Stale or missing index entry: find the record whose client name matches.");
  });
});

describe("the studio shows provenance on screen and in the export (v5.32.21)", () => {
  it("flags the current-state section, which is the one that reads like research", () => {
    expect(STUDIO).toContain("function assumeChip(){");
    expect(STUDIO).toContain("var csFlag=(d.currentStateBasis==='evidenced')?(' '+evidChip()):(d.currentStateBasis?(' '+assumeChip()):'');");
  });

  it("marks invented numbers per row in both the plan and the metrics", () => {
    expect(STUDIO).toContain("<th>Weeks</th><th>Basis</th>");
    expect(STUDIO).toContain("<th>Metric</th><th>Target</th><th>Basis</th>");
    expect(STUDIO).toContain("(ph.assumed?assumeChip():'—')");
    expect(STUDIO).toContain("(x.assumed?assumeChip():'—')");
  });

  it("names the three provenance states distinctly, including 'we recorded nothing'", () => {
    expect(STUDIO).toContain("Nothing below is grounded in this client’s data.");
    expect(STUDIO).toContain("Provenance unknown.");
    expect(STUDIO).toContain("function assumptionsBlock(d){");
    expect(STUDIO).toContain("function evidenceBlock(d){");
  });

  it("a hand-edit preserves provenance instead of quietly laundering the draft", () => {
    expect(STUDIO).toContain("if(d0.currentStateBasis) doc.currentStateBasis=d0.currentStateBasis;");
    expect(STUDIO).toContain("if(d0.assumptions) doc.assumptions=d0.assumptions;");
  });

  it("the printed brief carries the flags — it is the artifact that reaches the client", () => {
    expect(STUDIO).toContain("[ASSUMPTION — CONFIRM WITH CLIENT]");
    expect(STUDIO).toContain("Not grounded in client data.");
    expect(STUDIO).toContain("Assumptions to confirm with the client</h3>");
    expect(STUDIO).toContain("(ph.assumed?'ASSUMPTION':'\\u2014')");
  });
});
