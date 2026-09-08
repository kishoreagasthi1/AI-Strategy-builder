/**
 * v5.32.25 — fixes for the adversarial audit. Each block names the bug it
 * guards, because the failure modes here are all silent: nothing crashed, the
 * UI said "Saved", and the wrong number was presented as a measurement.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveKeyClient } from "../src/auth/clients.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FE = (p: string) => readFileSync(join(__dirname, "..", "..", "frontend", p), "utf8");
const BE = (p: string) => readFileSync(join(__dirname, "..", "src", p), "utf8");

const maps = {
  codeToNorm: new Map([["ACME-1234", "acmeindustrial"]]),
  sessionToNorm: new Map(),
} as never;

describe("SECURITY — the interviewee write path (v5.32.25)", () => {
  it("completion routes by the interview row's client, not the interviewee's own payload", () => {
    const src = BE("routes/interviews.ts");
    // Was: if (!session.client) session.client = client_name; normClient(session.client)
    // — the interviewee's private state chose which client got written, and
    // mergeSessionIntoEngagement upserts BY ROLE, so they could replace another
    // client's real CEO interview.
    expect(src).toContain("session.client = client_name;");
    expect(src).toContain("const norm = normClient(client_name);");
    // Code form, not the bare phrase — the fix's own comment quotes the old
    // line while explaining the exploit it enabled.
    expect(src).not.toMatch(/^\s{10}if \(!session\.client\) session\.client = client_name;$/m);
  });

  it("an unapproved follow-up can no longer be self-completed", () => {
    const src = BE("routes/interviews.ts");
    expect((src.match(/kind = 'initial' OR agenda_status = 'approved'/g) || []).length).toBe(3);
  });

  it("the interviewee-controlled role is escaped before it reaches innerHTML", () => {
    const src = FE("synthesis.html");
    expect(src).toContain("esc(hi.role.replace('_',' '))");
    expect(src).toContain("esc(lo.role.replace('_',' '))");
    expect(src).not.toMatch(/\+hi\.role\.replace\('_',' '\)\+/);
  });

  it("pre_engagement.html has escaping at all now", () => {
    const src = FE("pre_engagement.html");
    // v5.32.29 (audit H-3/M-2): every file's esc() was replaced with one that
    // also escapes " and ', because these values reach attributes and inline
    // handlers, not just text nodes. The property being guarded is unchanged —
    // pre_engagement escapes at all — so the assertion follows the new form.
    expect(src).toContain("function esc(s){");
    expect(src).toContain("'\"':'&quot;'");
    expect(src).toContain("${esc(h)}");
    expect(src).toContain("esc(eng.client)");
  });
});

describe("DATA LOSS — keys that silently never persisted (v5.32.25)", () => {
  it("getEngKey()-shaped suffixes resolve to a real client norm", () => {
    // These three families are suffixed with 'eng_<CODE>' / 'client_<norm>'.
    // The old parser took suffix.split("_")[0] and got the literal "eng" or
    // "client" — not a client norm — so the server dropped them on read AND
    // write while still returning {ok:true} and the UI painted "Saved".
    expect(resolveKeyClient("vynora_dim_notes_eng_ACME-1234", undefined, maps)).toBe("acmeindustrial");
    expect(resolveKeyClient("vynora_uc_requirements_eng_ACME-1234", undefined, maps)).toBe("acmeindustrial");
    expect(resolveKeyClient("vynora_uc_dismissed_gaps_client_acmeindustrial", undefined, maps)).toBe("acmeindustrial");
  });

  /*
   * v5.33.0. The v5.32.25 fix registered vynora_dim_notes_,
   * vynora_uc_requirements_ and vynora_uc_dismissed_gaps_ — the three families
   * the report named. Five MORE families are written by roadmap.html under the
   * same getEngKey() suffix and were never added, so they kept failing in
   * exactly the way the fix was written to stop: dropped on read and on write
   * for every restricted consultant, with the PUT still returning ok.
   *
   * Asserted as a set rather than one example, because the failure mode here is
   * a family being added to the page and not to CODE_SUFFIX. Anything suffixed
   * by getEngKey() belongs in this list.
   */
  it("every getEngKey()-suffixed roadmap family resolves to its client, not UNKNOWN", () => {
    for (const fam of [
      "vynora_dim_notes_", "vynora_uc_requirements_", "vynora_uc_dismissed_gaps_",
      "vynora_dim_gaps_", "vynora_gap_credits_", "vynora_gap_plans_",
      "vynora_measured_base_", "vynora_maturity_targets_",
      "vynora_uc_stages_", "vynora_uc_overrides_", "vynora_roadmap_snapsig_",
    ]) {
      expect(resolveKeyClient(fam + "eng_ACME-1234", undefined, maps),
        `${fam} under an engagement code`).toBe("acmeindustrial");
      expect(resolveKeyClient(fam + "client_acmeindustrial", undefined, maps),
        `${fam} under a client norm`).toBe("acmeindustrial");
    }
  });

  it("genuinely unowned partitions still deny rather than inventing an owner", () => {
    expect(resolveKeyClient("vynora_dim_notes_unassigned", undefined, maps)).toBe("UNKNOWN");
    expect(resolveKeyClient("vynora_design_studio_none", undefined, maps)).toBe("UNKNOWN");
  });

  it("the existing families still resolve exactly as before", () => {
    expect(resolveKeyClient("vynora_uc_stages_acmeindustrial", undefined, maps)).toBe("acmeindustrial");
    expect(resolveKeyClient("vynora_engagement_ACME-1234", undefined, maps)).toBe("acmeindustrial");
    expect(resolveKeyClient("vynora_engagement_index", undefined, maps)).toBe("GLOBAL");
  });

  it("a failed hydration blocks writes instead of overwriting good data", () => {
    const src = FE("vyne-client.js");
    // fetchStateSync returns null on any 500/502/timeout; that used to collapse
    // to {} and the first read-modify-write wiped the firm's roadmap state.
    expect(src).toContain("var HYDRATED = false;");
    expect(src).toContain("HYDRATED = hydratedState !== null;");
    expect(src).toContain("refusing to save '");
    expect(src).toContain("function showHydrationFailureBanner()");
  });

  it("Clear Engagement is scoped to the active client and says what it deletes", () => {
    const src = FE("roadmap.html");
    // Same reason: the replacement comment quotes the old copy verbatim.
    expect(src).not.toContain("+ 'This wipes engagement data, maturity scores, selections, and notes stored locally in THIS browser only. '");
    expect(src).toContain("from the VYNE platform");
    expect(src).toContain("Other clients are not affected.");
    // Two confirmations for the most destructive control in the module.
    expect(src).toContain("Last check — permanently delete all saved data for");
  });

  it("the Design Studio no longer shares one key across client-less sessions", () => {
    const src = FE("solution_design.html");
    /* v5.32.97: the key is now code-addressed, so the exact expression changed.
     * What this test exists to prevent is the ||'none' shared key — assert THAT,
     * not the spelling of the line that replaced it. */
    expect(src).toMatch(/function designStudioKey\(\)\{[\s\S]{0,200}?if\(!n\) return null;/);
    /* NOT a bare `not.toContain("activeClientName()||'none'")` — the fix's own
     * comment quotes the old expression while explaining what was wrong with
     * it, so that assertion fails on the prose describing the fix. The original
     * version of this test made exactly that point and matched the FULL old
     * statement; keep doing that. */
    expect(src).not.toContain("function designStudioKey(){ return 'vynora_design_studio_'+normClient(activeClientName()||'none'); }");
  });
});

describe("WRONG NUMBERS — things that reached client deliverables (v5.32.25)", () => {
  it("maturity scores reset per engagement instead of leaking between clients", () => {
    const src = FE("roadmap.html");
    expect(src).toContain("function resetMaturityScores(){");
    expect(src).toContain("resetMaturityScores();     // never inherit the previous client's dimensions");
  });

  it("parseFloat(null) can no longer put NaN on the deck cover", () => {
    const src = FE("roadmap.html");
    expect(src).toContain("scores[d]!==undefined && scores[d]!==null && !isNaN(parseFloat(scores[d]))");
  });

  it("the deck averages measured dimensions rather than dividing by 7 over defaults", () => {
    const src = FE("roadmap.html");
    expect(src).not.toContain("var overall=dimKeys.reduce(function(a,k){return a+(ms[k]||0);},0)/7;");
    expect(src).toContain("var _scored=dimKeys.filter(");
  });

  it("interview count reports distinct people, not sittings summed across rounds", () => {
    const src = BE("tenant/engagementLookup.ts");
    expect(src).toContain("ev.interviewCount = people.size;");
    expect(src).not.toContain("ev.interviewCount = n;");
  });

  it("two people in the same role no longer overwrite each other", () => {
    const src = BE("tenant/engagementMerge.ts");
    // v5.32.29 tightened this further: the v5.32.25 form let an EMPTY name on
    // either side fall through and match on role alone, which is how an
    // interviewee could overwrite the real CEO (audit CR-2). Identity is now
    // positive — see clientNormWidening/securityAuditFixes for the executed
    // proof. The original property still holds: two named people in one role
    // are two interviews.
    expect(src).toContain("if (!a || !b) return false;");
    expect(src).toContain("if (a !== b) return false;");
  });
});

describe("MY OWN REGRESSIONS from v5.32.16-24 (v5.32.25)", () => {
  it("the provenance backstop is no longer bypassed by a briefing sentence", () => {
    const src = BE("tenant/engagementLookup.ts");
    // clientProblem/peContext are the client's framing of the problem; they
    // establish nothing about how the client works today.
    expect(src).toContain("ev.scores || ev.confirmedFindings.length || ev.thematicFindings.length || ev.criticalGaps.length || ev.strengths.length");
    expect(src).not.toContain("ev.scores || ev.clientProblem || ev.peContext ||");
  });

  it("vyneFit honours a hard ceiling even for its guaranteed-verbatim items", () => {
    const src = FE("vyne-client.js");
    expect(src).toContain("var hardCeiling = budget * 2;");
    expect(src).toContain("if (used + len > hardCeiling) break;");
  });

  it("a renderFn failure is visible rather than silently dropping the item", () => {
    const src = FE("vyne-client.js");
    expect(src).toContain("renderFailures++;");
    expect(src).toContain("[an item could not be rendered for this prompt]");
  });

  it("catalog use-case ids derive from the name, so regeneration cannot rebind them", () => {
    const src = FE("roadmap.html");
    expect(src).toContain("function ucSlug(name, di, ui){");
    expect(src).toContain("u.id=base+'_'+ucSlug(u.name, di, ui);");
    expect(src).not.toContain("u.id=base+'_'+di+'_'+ui;");
  });

  it("artFlag chips only real placeholders and never nests its own spans", () => {
    const src = FE("solution_design.html");
    expect(src).toContain("var INSTRUCTION =");
    expect(src).toContain("if(!INSTRUCTION.test(label)) return m;");
    // The negative lookahead is what stops the bare-word pass re-wrapping the
    // HTML the bracket pass just produced.
    expect(src).toContain("(?![^<]*<\\/span>)");
  });

  it("the JSON parser finds the real document start and prefers the fuller result", () => {
    const src = FE("vyne-client.js");
    expect(src).toContain("function repairTruncated(body)");
    expect(src).toContain("if (bLen > aLen) {");
    expect(src).not.toContain("if (openArr >= 0 && (openCh < 0 || openArr < openCh)) openCh = openArr;");
  });
});

describe("HONEST CLAIMS (v5.32.25)", () => {
  it("the billing statement no longer calls estimates the provider's actual cost", () => {
    const src = FE("billing.html");
    expect(src).not.toContain("figures reflect the AI provider's actual metered cost");
    expect(src).toContain("Figures are ESTIMATES");
  });

  it("the two dead controls are documented rather than silently present", () => {
    expect(FE("roadmap.html")).toContain("notesMic.style.display='none';");
    expect(FE("pre_engagement.html")).toContain("was removed from the markup");
  });
});
