/**
 * v5.32.26 — the client-identity norm was widened from 30 to 100 characters,
 * and the two remaining trust-the-body holes from the v5.32.25 audit were
 * closed (billing attribution, shared-roadmap write clobbering).
 *
 * The widening is the risky one. A norm is not a display value: it is the
 * partition key for every workspace row, the primary key of an assignment,
 * and the GROUP BY of the billing statement. Change the rule and every one of
 * those either follows or is orphaned. What is guarded here is that the new
 * rule is applied EVERYWHERE at once (browser and server derive the same
 * string), that data written under the old rule is migrated rather than
 * stranded, and that authorization keeps working in the window in between.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  NORM_MAX, LEGACY_NORM_MAX, normClient, legacyNormClient, normSetHas, clientAllowed,
  migrateLegacyNormKeys, filterWorkspaceState, scopeWorkspaceWrite,
} from "../src/auth/clients.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FE = (p: string) => readFileSync(join(__dirname, "..", "..", "frontend", p), "utf8");
const BE = (p: string) => readFileSync(join(__dirname, "..", "src", p), "utf8");

/** Two real-shaped names that agree for the first 32 alphanumeric characters. */
const A = "Mitsubishi Heavy Industries Thermal Systems Ltd";
const B = "Mitsubishi Heavy Industries Thermal Power Systems Ltd";

describe("the norm itself (v5.32.26)", () => {
  it("truncates at 100, not 30", () => {
    expect(NORM_MAX).toBe(100);
    expect(LEGACY_NORM_MAX).toBe(30);
    expect(normClient("x".repeat(200))).toHaveLength(100);
    expect(legacyNormClient("x".repeat(200))).toHaveLength(30);
  });

  it("two names that collided at 30 are now distinct identities", () => {
    expect(legacyNormClient(A)).toBe(legacyNormClient(B)); // the old bug
    expect(normClient(A)).not.toBe(normClient(B));
  });

  it("normalisation is otherwise unchanged — lower, alphanumerics only", () => {
    expect(normClient("Acme Industrial, Inc.")).toBe("acmeindustrialinc");
    expect(normClient("")).toBe("");
    expect(normClient(undefined as unknown as string)).toBe("");
  });

  it("a name at or under 30 alphanumerics produces one identical string", () => {
    expect(normClient("Acme Industrial")).toBe(legacyNormClient("Acme Industrial"));
  });
});

describe("norm membership is EXACT — the v5.32.26 wildcard is gone (v5.32.29)", () => {
  // The prefix tolerance shipped in v5.32.26 treated any norm of exactly 30
  // characters as matching every longer norm it prefixed, in both directions.
  // It was documented as length-pinned and safe; it was neither, because a
  // truncated 30-char norm and a naturally 30-char one are the same string.
  // See the audit's H-1. Compatibility now comes from allowedClientNorms()
  // expanding each assignment row into exact strings.
  const victim = "Meridian Capital Partners Group Holdings LLC";
  const attacker = "Meridian Capital Partners Grou-p Ho";

  it("the attacker's shape is a real one: a 30-char norm that was never truncated", () => {
    expect(normClient(attacker)).toHaveLength(LEGACY_NORM_MAX);
    expect(normClient(attacker)).toBe(legacyNormClient(attacker));
    expect(normClient(victim).startsWith(normClient(attacker))).toBe(true);
  });

  it("a 30-char norm no longer reaches the longer client it prefixes", () => {
    expect(normSetHas(new Set([normClient(attacker)]), normClient(victim))).toBe(false);
    expect(clientAllowed(new Set([normClient(attacker)]), victim)).toBe(false);
  });

  it("nor does the long side reach the short one", () => {
    expect(clientAllowed(new Set([normClient(victim)]), attacker)).toBe(false);
  });

  it("membership is plain set membership, with UNKNOWN and empty denied", () => {
    expect(normSetHas(new Set(["acme"]), "acme")).toBe(true);
    expect(normSetHas(new Set(["acme"]), "acmeholdings")).toBe(false);
    expect(normSetHas(new Set(["acme"]), "")).toBe(false);
    expect(normSetHas(new Set(["acme"]), "UNKNOWN")).toBe(false);
  });

  it("compatibility comes from the assignment row's OWN name, not a wildcard", () => {
    // allowedClientNorms expands each row into the stored norm, the widened
    // norm and the legacy norm — all computed from that row's client_name, so
    // no expansion can name a client the row does not already name.
    const src = BE("auth/clients.ts");
    expect(src).toContain("SELECT client_norm, client_name FROM client_assignments WHERE user_id = $1");
    expect(src).toContain("out.add(normClient(row.client_name));");
    expect(src).toContain("out.add(legacyNormClient(row.client_name));");
    expect(src).not.toContain("export function normMatches");
  });

  it("a client straddling the widening is still reachable under both norms", () => {
    // What the wildcard was for, done exactly: both strings come from ONE row.
    const allowed = new Set([legacyNormClient(victim), normClient(victim)]);
    expect(normSetHas(allowed, normClient(victim))).toBe(true);
    expect(normSetHas(allowed, legacyNormClient(victim))).toBe(true);
    // ...and it reaches nothing else.
    expect(normSetHas(allowed, "someotherclient")).toBe(false);
    expect(normSetHas(allowed, normClient(victim) + "extra")).toBe(false);
  });

  it("the residue that CANNOT be fixed is named, not papered over", () => {
    // The attacker's 30-char norm is byte-identical to the victim's LEGACY
    // norm — that is the pre-v5.32.26 collision itself, and no matching rule
    // can un-merge data already written under one shared identity. What the
    // fix guarantees is that it stops there: the victim's WIDENED keys, and
    // every key written from v5.32.26 onward, are out of reach.
    expect(normClient(attacker)).toBe(legacyNormClient(victim));
    expect(normSetHas(new Set([normClient(attacker)]), normClient(victim))).toBe(false);
  });
});

/* ── the lazy key migration ────────────────────────────────────────────────*/

const LEG = legacyNormClient(A);
const NEW = normClient(A);

function legacyState(): Record<string, string> {
  return {
    // key IS the identity — must move
    ["vynora_briefing_" + LEG]: JSON.stringify({ client: A, summary: "…" }),
    ["vynora_mandatory_" + LEG]: JSON.stringify({ questions: [] }),
    ["vynora_solution_design_" + LEG]: JSON.stringify({ docs: {} }),
    ["vynora_design_studio_" + LEG]: JSON.stringify({ portfolio: [] }),
    // getEngKey()-shaped: the norm is the SECOND segment
    ["vynora_uc_stages_client_" + LEG]: JSON.stringify({ a: 1 }),
    ["vynora_dim_notes_client_" + LEG]: JSON.stringify({ D1: "note" }),
    // code-keyed: key stays put, the name lives in the value
    "vynora_engagement_MHI-1001": JSON.stringify({ client: A, code: "MHI-1001" }),
    "vynora_engagement_index": JSON.stringify({ [LEG]: "MHI-1001" }),
    "vynora_last_briefing": JSON.stringify({ client: A, normKey: LEG }),
    "vynora_roadmap_state": JSON.stringify({
      byEng: { ["client_" + LEG]: { picked: 2 }, "eng_MHI-1001": { picked: 3 } },
      assumptions: {}, dependencies: {}, generated: {},
      synthesis: "the owner's firm-wide synthesis",
    }),
    // untouched
    "vynora_deck_mode": "client",
    "vynora_industry_catalog_automotive": "[]",
  };
}

describe("migrateLegacyNormKeys (v5.32.26)", () => {
  it("moves every key whose client segment was truncated", () => {
    const plan = migrateLegacyNormKeys(legacyState(), [A, "Acme Industrial"]);
    expect(plan.pairs).toEqual([{ from: LEG, to: NEW, clientName: A }]);
    for (const p of [
      "vynora_briefing_", "vynora_mandatory_", "vynora_solution_design_", "vynora_design_studio_",
    ]) {
      expect(plan.sets, p).toHaveProperty(p + NEW);
      expect(plan.deletes, p).toContain(p + LEG);
    }
  });

  it("handles the getEngKey() 'client_<norm>' families, where the norm is second", () => {
    const plan = migrateLegacyNormKeys(legacyState(), [A, "Acme Industrial"]);
    // These three cost a firm its dimension notes in v5.32.25 for a different
    // reason; getting the segment position wrong here would do it again.
    expect(plan.sets).toHaveProperty("vynora_uc_stages_client_" + NEW);
    expect(plan.sets).toHaveProperty("vynora_dim_notes_client_" + NEW);
    expect(plan.deletes).toContain("vynora_uc_stages_client_" + LEG);
  });

  it("leaves code-keyed keys and global keys exactly where they are", () => {
    const plan = migrateLegacyNormKeys(legacyState(), [A, "Acme Industrial"]);
    const touched = new Set([...Object.keys(plan.sets), ...plan.deletes]);
    expect(touched.has("vynora_engagement_MHI-1001")).toBe(false);
    expect(touched.has("vynora_deck_mode")).toBe(false);
    expect(touched.has("vynora_industry_catalog_automotive")).toBe(false);
  });

  it("rewrites the shared index/pointer keys entry-wise", () => {
    const plan = migrateLegacyNormKeys(legacyState(), [A, "Acme Industrial"]);
    expect(JSON.parse(plan.sets["vynora_engagement_index"])).toEqual({ [NEW]: "MHI-1001" });
    expect(JSON.parse(plan.sets["vynora_last_briefing"]).normKey).toBe(NEW);
    const rs = JSON.parse(plan.sets["vynora_roadmap_state"]);
    expect(rs.byEng).toHaveProperty("client_" + NEW);
    expect(rs.byEng).not.toHaveProperty("client_" + LEG);
    expect(rs.byEng["eng_MHI-1001"]).toEqual({ picked: 3 });
    expect(rs.synthesis).toBe("the owner's firm-wide synthesis"); // untouched
  });

  it("is a no-op on state that has already been migrated", () => {
    const first = migrateLegacyNormKeys(legacyState(), [A, "Acme Industrial"]);
    const after = { ...legacyState(), ...first.sets };
    for (const k of first.deletes) delete after[k];
    const second = migrateLegacyNormKeys(after, [A, "Acme Industrial"]);
    expect(second.pairs).toEqual([]);
    expect(second.sets).toEqual({});
    expect(second.deletes).toEqual([]);
  });

  it("is a no-op when every client name fits inside 30 characters", () => {
    const plan = migrateLegacyNormKeys({
      "vynora_briefing_acmeindustrial": JSON.stringify({ client: "Acme Industrial" }),
      "vynora_engagement_index": JSON.stringify({ acmeindustrial: "ACME-1" }),
    }, [A, "Acme Industrial"]);
    expect(plan.pairs).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });

  it("refuses to guess when one legacy norm covers two different names", () => {
    // This IS the collision the release exists to prevent. Splitting data
    // already merged under one identity is a judgement call about whose record
    // is whose — not something to decide inside a read handler.
    //
    // v5.32.29 (audit H-2): the candidate list is now the firm's OWN client
    // names rather than names scraped from workspace values, so the collision
    // is detected from the server's roster — A and B agree for 32 characters.
    const plan = migrateLegacyNormKeys({
      ["vynora_briefing_" + LEG]: JSON.stringify({ client: A }),
      "vynora_engagement_M1": JSON.stringify({ client: A }),
      "vynora_engagement_M2": JSON.stringify({ client: B }),
    }, [A, B, "Acme Industrial"]);
    expect(plan.pairs).toEqual([]);
    expect(plan.ambiguous).toEqual([LEG]);
    expect(plan.deletes).toEqual([]);
  });

  it("never overwrites a key that already exists in the widened form", () => {
    const st = legacyState();
    st["vynora_briefing_" + NEW] = JSON.stringify({ client: A, summary: "newer" });
    const plan = migrateLegacyNormKeys(st, [A, "Acme Industrial"]);
    expect(plan.sets["vynora_briefing_" + NEW]).toBeUndefined();
    expect(plan.deletes).not.toContain("vynora_briefing_" + LEG);
  });
});

describe("authorization survives the in-between window (v5.32.29)", () => {
  // allowedClientNorms() puts BOTH norms in the set for one assignment row,
  // so neither direction needs a prefix rule. This models that set.
  const both = () => new Set([LEG, NEW]);

  it("a not-yet-migrated assignment row still sees widened keys", () => {
    const out = filterWorkspaceState(
      { ["vynora_briefing_" + NEW]: "{}", "vynora_briefing_someoneelse": "{}" },
      both()
    );
    expect(Object.keys(out)).toEqual(["vynora_briefing_" + NEW]);
  });

  it("a migrated assignment row still sees not-yet-migrated keys", () => {
    const out = filterWorkspaceState(
      { ["vynora_briefing_" + LEG]: "{}", "vynora_briefing_someoneelse": "{}" },
      both()
    );
    expect(Object.keys(out)).toEqual(["vynora_briefing_" + LEG]);
  });

  it("the tolerance does not hand a short-named client someone else's data", () => {
    const out = filterWorkspaceState(
      { "vynora_briefing_acmeholdings": "{}" },
      new Set(["acme"])
    );
    expect(Object.keys(out)).toEqual([]);
  });
});

describe("SECURITY — a restricted consultant can no longer clobber the shared roadmap (v5.32.26)", () => {
  const server = {
    "vynora_roadmap_state": JSON.stringify({
      byEng: { "client_acme": { keep: true } },
      assumptions: {}, dependencies: {}, generated: {},
      notes: { d1: "owner's note" },
      synthesis: "the owner's firm-wide synthesis",
      gantt: { workstreams: [{ name: "owner's plan" }] },
    }),
  };

  function write(body: unknown): Record<string, unknown> {
    const { sets } = scopeWorkspaceWrite(
      { "vynora_roadmap_state": JSON.stringify(body) }, [], server, new Set(["acme"])
    );
    return JSON.parse(sets["vynora_roadmap_state"]) as Record<string, unknown>;
  }

  it("a hand-crafted PUT cannot replace synthesis, gantt or notes", () => {
    const merged = write({
      byEng: { "client_acme": { keep: true } },
      notes: { d1: "planted" },
      synthesis: "planted",
      gantt: { workstreams: [] },
    });
    expect(merged.synthesis).toBe("the owner's firm-wide synthesis");
    expect(merged.gantt).toEqual({ workstreams: [{ name: "owner's plan" }] });
    expect(merged.notes).toEqual({ d1: "owner's note" });
  });

  it("an ordinary autosave from a filtered browser copy cannot erase them either", () => {
    // This is the shape roadmap.html's savePersistentState ACTUALLY writes:
    // the three legacy flat fields are always present in the body, and for a
    // restricted consultant filterRoadmapState dropped them on read, so their
    // in-page values are null. Every autosave therefore used to overwrite the
    // owner's firm-wide synthesis and Gantt with null — no crafted request
    // needed, just a restricted consultant opening the Roadmap Builder.
    const merged = write({
      assumptions: {}, dependencies: {}, generated: {},
      byEng: { "client_acme": { keep: true } },
      notes: null, synthesis: null, gantt: null,
      savedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(merged.synthesis).toBe("the owner's firm-wide synthesis");
    expect(merged.gantt).toEqual({ workstreams: [{ name: "owner's plan" }] });
    expect(merged.notes).toEqual({ d1: "owner's note" });
    expect(merged.savedAt).toBe("2026-08-09T00:00:00.000Z"); // still tracked
  });

  it("the consultant's own per-client byEng slot still saves", () => {
    const merged = write({ byEng: { "client_acme": { keep: false, edited: 1 } } });
    expect((merged.byEng as Record<string, unknown>)["client_acme"]).toEqual({ keep: false, edited: 1 });
  });

  it("an owner (allowed === null) is untouched by any of this", () => {
    const body = JSON.stringify({ synthesis: "owner rewrite" });
    const { sets } = scopeWorkspaceWrite({ "vynora_roadmap_state": body }, [], server, null);
    expect(sets["vynora_roadmap_state"]).toBe(body);
  });
});

describe("SECURITY — billing attribution is derived, not accepted (v5.32.26)", () => {
  it("the LLM endpoint resolves the billable client instead of forwarding the body", () => {
    const src = BE("routes/llm.ts");
    expect(src).toContain("const billTo = await resolveBillingClient(ctx, clientName);");
    expect(src).toContain("clientName: billTo");
    // The old form passed the parsed body value straight into the gateway.
    expect(src).not.toContain("{ tenantId: ctx.tenantId, userId: ctx.userId, module, clientName },");
  });

  it("both voice endpoints go through the same resolver", () => {
    const src = BE("routes/voice.ts");
    expect(src).toContain("resolveBillingClient");
    expect(src).not.toContain("clientName: parsed.data.clientName");
  });

  it("an interviewee's attribution comes from their interview row, never the body", () => {
    const src = BE("llm/attribution.ts");
    expect(src).toContain('if (ctx.role === "interviewee") return await ownInterviewClient(ctx);');
    expect(src).toContain("WHERE interviewee_user_id = $1");
  });

  it("a rejected attribution degrades to unattributed rather than failing the call", () => {
    const src = BE("llm/attribution.ts");
    expect(src).toContain("return clientAllowed(allowed, requested) ? requested : undefined;");
    expect(BE("routes/llm.ts")).not.toContain('reply.code(403).send({ error: "client_not_assigned" })');
  });

  it("the billing statement still shows rows written under the legacy norm", () => {
    expect(BE("routes/billing.ts")).toContain("normSetHas(allowed, e.clientNorm)");
  });
});

describe("browser and server derive the same norm (v5.32.26)", () => {
  it("no frontend file still truncates a client norm at 30", () => {
    for (const f of [
      "vyne-client.js", "roadmap.html", "synthesis.html", "solution_design.html",
      "pre_engagement.html", "interviews.html", "interview_agent.html",
    ]) {
      expect(FE(f), f).not.toContain(".replace(/[^a-z0-9]/g,'').substring(0,30)");
    }
  });

  /**
   * v5.32.56: was an exact COUNT per file, which made adding a legitimate new
   * derivation a test failure — and the fix for a failing count is to bump a
   * number, which teaches nobody anything and eventually gets bumped past a
   * real regression. The property that matters is that EVERY derivation
   * truncates at 100, and that no derivation truncates anywhere else. A minimum
   * keeps the "these files must each derive a norm at all" signal.
   */
  it("every client-norm derivation in the browser truncates at 100", () => {
    /*
     * v5.32.97: these floors now go DOWN over time, on purpose.
     *
     * Per-client keys are being re-addressed from normClient(name) to the
     * engagement CODE, so each migrated call site legitimately removes a norm
     * derivation. roadmap.html went 5 → 3 that way. The floor is not a target;
     * it is the "this file still derives a client norm somewhere, so the
     * truncation rule still applies to it" signal. When a file reaches zero,
     * DELETE its entry rather than lowering it to 0 — a file that derives no
     * norm at all has nothing for this test to protect, and leaving a 0 here
     * would keep it looking covered when it is not.
     */
    const atLeast: Record<string, number> = {
      "roadmap.html": 3, "synthesis.html": 6, "solution_design.html": 1,
      "pre_engagement.html": 4, "interviews.html": 3, "interview_agent.html": 9,
    };
    for (const [f, n] of Object.entries(atLeast)) {
      const src = FE(f);
      const good = (src.match(/replace\(\/\[\^a-z0-9\]\/g,\s*''\)\.substring\(0,\s*100\)/g) || []).length;
      expect(good, `${f}: derivations truncating at 100`).toBeGreaterThanOrEqual(n);
      // Deliberately NOT asserting "no other truncation length exists". The
      // first attempt at that flagged roadmap.html's normIndustry(), which
      // truncates at 40 on purpose because it keys a different namespace
      // (vynora_industry_catalog_<norm>) that has nothing to do with client
      // scoping. The genuine historical bug — a CLIENT norm truncated at 30,
      // which made two long client names collide — is caught by the test above
      // this one, which greps for that exact expression.
    }
  });

  it("the two interview_agent helpers that omitted truncation entirely now have it", () => {
    const src = FE("interview_agent.html");
    expect(src).toContain("function mqNormClient(c){ return (c||'').toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,100); }");
    expect(src).toContain("var nk = (S.client||'').toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,100);");
  });

  it("the browser helper produces byte-identical output to normClient()", () => {
    // Not a string-match on the source: the browser function is extracted and
    // EXECUTED against the same inputs. A disagreement here is the exact
    // failure mode that presents to a user as "my work vanished" — the server
    // drops a key whose client segment it cannot match.
    const src = FE("vyne-client.js");
    const m = src.match(/function vyneNormClient\(n\) \{[\s\S]*?\n  \}/);
    expect(m, "vyneNormClient not found in vyne-client.js").not.toBeNull();
    // Substitute the limit the BROWSER actually declares, not the server's —
    // otherwise a drift in that one constant would be papered over here.
    const declared = src.match(/var VYNE_NORM_MAX = (\d+);/);
    expect(declared, "VYNE_NORM_MAX not declared").not.toBeNull();
    const body = m![0]
      .replace("function vyneNormClient", "function")
      .replace("VYNE_NORM_MAX", declared![1]);
    const browserNorm = new Function("return " + body)() as (n: unknown) => string;
    for (const name of [
      A, B, "Acme Industrial, Inc.", "", "  ", "ÜberCorp GmbH & Co. KG", "x".repeat(200),
      "123-456", "A. B. C.", "Société Générale",
    ]) {
      expect(browserNorm(name), JSON.stringify(name)).toBe(normClient(name));
    }
    expect(browserNorm(null)).toBe(normClient(null as unknown as string));
    expect(browserNorm(undefined)).toBe(normClient(undefined as unknown as string));
  });

  it("the shared helper exists and matches the server's limit", () => {
    const src = FE("vyne-client.js");
    expect(src).toContain("var VYNE_NORM_MAX = 100;");
    expect(src).toContain("window.vyneNormClient = vyneNormClient;");
    const m = src.match(/var VYNE_NORM_MAX = (\d+);/);
    expect(Number(m?.[1])).toBe(NORM_MAX);
  });
});

describe("the SQL half of the migration (v5.32.26)", () => {
  const sql = readFileSync(
    join(__dirname, "..", "src", "db", "migrations", "011_client_norm_widen.sql"), "utf8");

  it("recomputes both flat client_norm columns from the client_name beside them", () => {
    expect(sql).toContain("UPDATE client_assignments");
    expect(sql).toContain("UPDATE usage_events");
    expect(sql).toContain("FOR 100");
  });

  it("only rewrites rows whose norm was actually truncated", () => {
    expect((sql.match(/length\(client_norm\) = 30/g) || []).length).toBe(2);
  });

  it("suspends RLS around the updates — the migration connection has no tenant", () => {
    // Both tables are FORCE ROW LEVEL SECURITY against app.tenant_id, which is
    // unset here; without this the UPDATEs match zero rows and say nothing.
    expect((sql.match(/DISABLE ROW LEVEL SECURITY/g) || []).length).toBe(2);
    expect((sql.match(/ENABLE ROW LEVEL SECURITY/g) || []).length).toBe(2);
    expect((sql.match(/FORCE  ROW LEVEL SECURITY/g) || []).length).toBe(2);
  });

  it("the route applies the key half lazily on read", () => {
    const src = BE("routes/moduleState.ts");
    expect(src).toContain("migrateLegacyNormKeys");
    expect(src).toContain("client-norm widening applied");
    // v5.32.29 (audit H-2): owners only, and it no longer writes
    // client_assignments from a read handler — migration 011 owns those.
    expect(src).toContain("// Owners only (audit H-2). allowed === null IS the owner check.");
    expect(src).not.toContain("UPDATE client_assignments SET client_norm");
  });
});
