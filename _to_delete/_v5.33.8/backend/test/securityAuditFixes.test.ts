/**
 * v5.32.29 — fixes for the adversarial security audit of v5.32.28.
 *
 * Every case below was an EXECUTED exploit before the fix, not a theory. The
 * tests re-run the exploit and assert it now fails, rather than asserting that
 * some string appears in the source — because three of these bugs lived
 * underneath code whose comments said the opposite of what it did, and a
 * string match would have passed against every one of them.
 *
 * Two of the highest-severity findings (H-1, H-2) were controls I shipped in
 * v5.32.26 and documented as safe. That is the reason for the executable
 * bias here.
 */
import { describe, it, expect } from "vitest";
import { sanitizeEngagementForInterviewee } from "../src/routes/interviews.js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  normClient, legacyNormClient, normSetHas, clientAllowed,
  filterWorkspaceState, scopeWorkspaceWrite, purgeClientKeys, migrateLegacyNormKeys,
  resolveKeyClient,
} from "../src/auth/clients.js";
import { mergeSessionIntoEngagement, sanitizeIntervieweeSession } from "../src/tenant/engagementMerge.js";
import { redactProviderDetail } from "../src/llm/gateway.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BE = (p: string) => readFileSync(join(__dirname, "..", "src", p), "utf8");
const FE = (p: string) => readFileSync(join(__dirname, "..", "..", "frontend", p), "utf8");
const ROOT = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

/* ── CR-1 ─────────────────────────────────────────────────────────────────*/

describe("CR-1 — engagement-code takeover via the index (v5.32.29)", () => {
  /** No vynora_engagement_<CODE> payload: the precondition the exploit needs. */
  const serverState = () => ({
    "vynora_engagement_index": JSON.stringify({ victimcorp: "VICT-0001", acmeltd: "ACME-9999" }),
    "vynora_synthesis_full_VICT-0001": JSON.stringify({ synthesis: { secret: "victim synthesis" } }),
    "vynora_interview_archive_VICT-0001": JSON.stringify([{ role: "CFO", transcript: "VICTIM CFO TRANSCRIPT" }]),
  });
  const attacker = new Set(["acmeltd"]);

  it("binding another client's code to your own norm is refused", () => {
    const state = serverState();
    const { sets } = scopeWorkspaceWrite(
      { "vynora_engagement_index": JSON.stringify({ acmeltd: "VICT-0001" }) }, [], state, attacker);
    const merged = JSON.parse(sets["vynora_engagement_index"]);
    // The victim's binding survives and the attacker's hijack does not.
    expect(merged.victimcorp).toBe("VICT-0001");
    expect(merged.acmeltd).not.toBe("VICT-0001");
  });

  it("and the victim's keys stay invisible afterwards", () => {
    const state = serverState();
    const { sets } = scopeWorkspaceWrite(
      { "vynora_engagement_index": JSON.stringify({ acmeltd: "VICT-0001" }) }, [], state, attacker);
    const after = { ...state, ...sets };
    const visible = Object.keys(filterWorkspaceState(after, attacker));
    expect(visible).not.toContain("vynora_synthesis_full_VICT-0001");
    expect(visible).not.toContain("vynora_interview_archive_VICT-0001");
  });

  it("the rightful consultant is not locked out by the attempt", () => {
    // The original exploit removed the victim's own index entry in the same
    // request — denial of service on top of the disclosure.
    const state = serverState();
    const { sets } = scopeWorkspaceWrite(
      { "vynora_engagement_index": JSON.stringify({ acmeltd: "VICT-0001" }) }, [], state, attacker);
    const after = { ...state, ...sets };
    const victimSees = Object.keys(filterWorkspaceState(after, new Set(["victimcorp"])));
    expect(victimSees).toContain("vynora_synthesis_full_VICT-0001");
  });

  it("a genuinely NEW code is still writable when its record comes with it", () => {
    /* v5.32.64 (audit V2-H4) tightened this. It used to pass with the index
     * entry ALONE, which is the fail-open the audit found: a code nobody owns
     * could be bound purely on the caller's say-so, because ownership was
     * being resolved from a map that already had the caller's own index entry
     * merged into it — the guard was checking the assertion against itself.
     *
     * Creating an engagement writes the record and the index entry together,
     * and the record's `client` field is what makes the code owned, so the
     * legitimate path is unaffected. An index entry pointing at an engagement
     * that does not exist is not meaningful state in the first place, and if
     * the two writes ever do land separately, resolveEngagementCode's
     * scan-and-heal (v5.32.59) rebuilds the index from the records. */
    const state = serverState();
    const { sets } = scopeWorkspaceWrite(
      {
        "vynora_engagement_index": JSON.stringify({ acmeltd: "ACME-NEW1" }),
        "vynora_engagement_ACME-NEW1": JSON.stringify({ code: "ACME-NEW1", client: "Acme Ltd" }),
      }, [], state, attacker);
    expect(JSON.parse(sets["vynora_engagement_index"]).acmeltd).toBe("ACME-NEW1");
  });

  it("a NEW code with no record is refused — ownership cannot be self-asserted", () => {
    const state = serverState();
    const { sets } = scopeWorkspaceWrite(
      { "vynora_engagement_index": JSON.stringify({ acmeltd: "ACME-NEW1" }) }, [], state, attacker);
    expect(JSON.parse(sets["vynora_engagement_index"]).acmeltd).not.toBe("ACME-NEW1");
  });

  it("vynora_roadmap_index entries for an unseen client cannot be clobbered", () => {
    const state = {
      "vynora_engagement_index": JSON.stringify({ victimcorp: "VICT-0001" }),
      "vynora_engagement_VICT-0001": JSON.stringify({ code: "VICT-0001", client: "Victim Corp" }),
      "vynora_roadmap_index": JSON.stringify({ "VICT-0001": { clientName: "Victim Corp", notes: "real" } }),
    };
    const { sets } = scopeWorkspaceWrite(
      { "vynora_roadmap_index": JSON.stringify({ "VICT-0001": { clientName: "Acme Ltd", notes: "CLOBBERED" } }) },
      [], state, attacker);
    expect(JSON.parse(sets["vynora_roadmap_index"])["VICT-0001"].notes).toBe("real");
  });
});

/* ── CR-2 ─────────────────────────────────────────────────────────────────*/

describe("CR-2 — the interviewee can no longer impersonate a colleague (v5.32.29)", () => {
  const engagement = () => ({
    client: "Acme", code: "ACME-1", currentRoundId: "r1",
    rounds: [{
      roundId: "r1", roundNumber: 1, status: "active",
      interviews: [{
        role: "CEO", interviewee: "Victoria Hale", name: "Victoria Hale",
        scores: { D1: 2.0 }, findings: [{ dimension: "D1", text: "real CEO finding" }],
      }],
      scores: {},
    }],
  });

  it("an empty name no longer matches on role alone", () => {
    // The exploit: {"stakeholderRole":"CEO","stakeholderName":""} replaced the
    // real CEO outright — verified before the fix, scores 2.0 -> 5.0.
    const out = mergeSessionIntoEngagement(engagement() as never, "ACME-1", {
      client: "Acme", stakeholderRole: "CEO", stakeholderName: "",
      scores: { D1: 5.0 }, findings: [{ dimension: "D1", text: "ATTACKER TEXT" }],
    } as never, { sourceInterviewId: "iv-attacker", kind: "initial" });

    const ivs = out.rounds![0].interviews as Record<string, unknown>[];
    expect(ivs).toHaveLength(2);                       // kept, not replaced
    expect(ivs[0].interviewee).toBe("Victoria Hale");
    expect((ivs[0].findings as { text: string }[])[0].text).toBe("real CEO finding");
  });

  it("the session sanitizer pins role and name to the invite row", () => {
    const s = sanitizeIntervieweeSession(
      { client: "Beta", stakeholderRole: "CEO", stakeholderName: "Not Me", scores: { D1: 5 } } as never,
      { client: "Acme", role: "CFO", name: "Real Person" }
    );
    expect(s.client).toBe("Acme");
    expect(s.stakeholderRole).toBe("CFO");
    expect(s.stakeholderName).toBe("Real Person");
    expect(s.scores).toEqual({ D1: 5 });               // their own answers survive
  });

  it("an interviewee cannot fabricate a round or move currentRoundId", () => {
    // Verified before the fix: rounds [1] became [1, 7] and currentRoundId
    // moved onto the invented round.
    const clean = sanitizeIntervieweeSession(
      { client: "Acme", isRefresh: true, refreshRound: 7, refreshScope: ["D1"],
        eventDriven: true, eventContext: "made up", scores: { D1: 5 } } as never,
      { client: "Acme", role: "CEO", name: "Victoria Hale" }
    );
    const out = mergeSessionIntoEngagement(engagement() as never, "ACME-1", clean,
      { sourceInterviewId: "iv-x", kind: "initial" });
    expect(out.rounds!.map((r) => r.roundNumber)).toEqual([1]);
    expect(clean.isRefresh).toBe(false);
    expect(clean.refreshRound).toBeNull();
    expect(clean.eventDriven).toBe(false);
  });

  it("the route pins all three from the interview row, not the blob", () => {
    const src = BE("routes/interviews.ts");
    expect(src).toContain("interviewee_role, interviewee_name");
    expect(src).toContain("const session2 = sanitizeIntervieweeSession(session, {");
    expect(src).toContain("mergeSessionIntoEngagement(eng, code, session2, {");
  });
});

/* ── CR-3 ─────────────────────────────────────────────────────────────────*/

describe("CR-3 — the spend cap actually exists now (v5.32.29)", () => {
  const migration = BE("db/migrations/012_spend_caps.sql");

  it("the limit is set at provisioning, on plan change, and by default", () => {
    expect(BE("tenant/provisioning.ts")).toContain("monthly_token_limit");
    // Three, not two, since v5.32.65 (audit V2-L1): checkout, subscription
    // created/updated, and — the one that was missing — cancellation, which
    // used to move subscription_status and leave a cancelled firm holding its
    // paid tier's token allowance for good.
    expect((BE("billing/subscriptions.ts").match(/monthly_token_limit = COALESCE/g) || []).length).toBe(3);
    expect(migration).toContain("ALTER COLUMN monthly_token_limit SET DEFAULT");
  });

  it("a NULL limit no longer means unlimited", () => {
    const src = BE("llm/metering.ts");
    expect(src).not.toContain("if (!row || row.monthly_token_limit === null) return { allowed: true };");
    expect(src).toContain("row.monthly_token_limit === null ? 3_000_000 : Number(row.monthly_token_limit)");
  });

  it("there is a per-user daily ceiling as well as a tenant monthly one", () => {
    expect(BE("llm/metering.ts")).toContain("daily_user_token_limit_exceeded");
    expect(migration).toContain("daily_user_token_limit");
    // The gateway has to pass the user through for it to be enforceable.
    expect(BE("llm/gateway.ts")).toContain("await this.checkLimit(ctx.tenantId, ctx.userId);");
  });

  it("the rate limiter covers every protected route, not four of forty", () => {
    const src = BE("server.ts");
    const generic = src.indexOf("await protectedScope.register(rateLimit, {");
    expect(generic, "no baseline limiter on protectedScope").toBeGreaterThan(-1);
    // The two expensive fan-out endpoints carry a tighter PER-ROUTE ceiling.
    // They are deliberately NOT in their own scope: an encapsulated scope also
    // swept in the solution-design read/save routes, which would have throttled
    // ordinary Design Studio editing at six requests a minute.
    expect(BE("routes/solutionDesign.ts")).toContain('config: { rateLimit: { max: 6, timeWindow: "1 minute" } },');
    /*
     * v5.32.83. This counted /max: 6/ with no boundary, so it also matched
     * `max: 60` — and would have matched `max: 6000`. A check written to assert
     * that the expensive routes are capped at SIX accepted a route capped at
     * sixty without comment: it was measuring the digit, not the limit.
     * Anchored on the trailing comma now, and the chunked route's own ceiling
     * is asserted as a stated fact rather than left to fall through a loose
     * pattern.
     */
    const synthSrc = BE("routes/synthetic.ts");
    expect((synthSrc.match(/config: \{ rateLimit: \{ max: 6, /g) || []).length).toBe(2);
    // /api/synthetic/persona IS the fan-out /engagement used to do in-process —
    // one call per persona per round — so a 6/min ceiling would stall the run
    // it exists to make possible. Cost is bounded by the spend caps, not here.
    expect((synthSrc.match(/config: \{ rateLimit: \{ max: 60, /g) || []).length).toBe(1);
    expect(src).not.toContain("heavyScope");
    // ...and the baseline is registered BEFORE the routes it must cover.
    expect(generic).toBeLessThan(src.indexOf("await moduleStateRoutes(protectedScope);"));
  });

  it("the prompt array is bounded", () => {
    expect(BE("routes/llm.ts")).toContain(".max(50)");
  });
});

/* ── H-1 ─────────────────────────────────────────────────────────────────*/

describe("H-1 — the 30-char prefix wildcard is gone (v5.32.29)", () => {
  const victim = "Meridian Capital Partners Group Holdings LLC";
  const attacker = "Meridian Capital Partners Grou-p Ho";

  it("a naturally-30-char client cannot reach the longer client it prefixes", () => {
    expect(normClient(attacker)).toHaveLength(30);
    expect(normClient(attacker)).toBe(legacyNormClient(attacker));   // never truncated
    expect(clientAllowed(new Set([normClient(attacker)]), victim)).toBe(false);
    expect(clientAllowed(new Set([normClient(victim)]), attacker)).toBe(false);
  });

  it("nor read their workspace keys", () => {
    const out = filterWorkspaceState({
      ["vynora_briefing_" + normClient(victim)]: JSON.stringify({ clientProblem: "SECRET" }),
      ["vynora_solution_design_" + normClient(victim)]: "{}",
    }, new Set([normClient(attacker)]));
    expect(Object.keys(out)).toEqual([]);
  });

  it("nor delete the longer client's index entry on a routine autosave", () => {
    const state = {
      "vynora_engagement_index": JSON.stringify({
        [normClient(victim)]: "MERI-VICT", [normClient(attacker)]: "MERI-AAAA",
      }),
    };
    const { sets } = scopeWorkspaceWrite(
      { "vynora_engagement_index": JSON.stringify({ [normClient(attacker)]: "MERI-AAAA" }) },
      [], state, new Set([normClient(attacker)]));
    expect(JSON.parse(sets["vynora_engagement_index"])[normClient(victim)]).toBe("MERI-VICT");
  });

  it("compatibility is preserved by expanding each row's OWN name", () => {
    const src = BE("auth/clients.ts");
    expect(src).not.toContain("export function normMatches");
    expect(src).toContain("out.add(normClient(row.client_name));");
    expect(src).toContain("out.add(legacyNormClient(row.client_name));");
    // Both norms in one set — the compatibility the wildcard was for.
    const both = new Set([legacyNormClient(victim), normClient(victim)]);
    expect(normSetHas(both, normClient(victim))).toBe(true);
    expect(normSetHas(both, legacyNormClient(victim))).toBe(true);
  });
});

/* ── H-2 ─────────────────────────────────────────────────────────────────*/

describe("H-2 — the norm migration cannot be steered or triggered by a consultant (v5.32.29)", () => {
  const victim = "Meridian Capital Partners Group Holdings LLC";
  const LEG = legacyNormClient(victim);

  const attackedState = () => ({
    // A key the attacker fully owns, whose VALUE names a client of their choosing.
    "vynora_briefing_acmeltd": JSON.stringify({ client: "Meridian Capital Partners Group Hostile Takeover Unit" }),
    ["vynora_briefing_" + LEG]: JSON.stringify({ x: "VICTIM BRIEFING" }),
    ["vynora_solution_design_" + LEG]: JSON.stringify({ uc1: "victim design doc" }),
  });

  it("an invented client name drives no rename", () => {
    // Known names come from client_assignments + engagements — tables no
    // consultant can put an arbitrary row into. The attacker's value names a
    // client that does not exist, so it cannot be a rename target; with the
    // real client known, the keys migrate to the REAL client's norm instead.
    const plan = migrateLegacyNormKeys(attackedState(), ["Acme Ltd", victim]);
    const hostile = normClient("Meridian Capital Partners Group Hostile Takeover Unit");
    expect(plan.pairs.map((p) => p.to)).not.toContain(hostile);
    expect(Object.keys(plan.sets).join(" ")).not.toContain(hostile);
    expect(plan.pairs.map((p) => p.to)).toEqual([normClient(victim)]);
  });

  it("with only the attacker's own client known, nothing of the victim's moves", () => {
    const plan = migrateLegacyNormKeys(attackedState(), ["Acme Ltd"]);
    expect(plan.pairs).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });

  it("a legitimate rename toward a KNOWN client still works", () => {
    const plan = migrateLegacyNormKeys(attackedState(), [victim]);
    expect(plan.pairs).toEqual([{ from: LEG, to: normClient(victim), clientName: victim }]);
    expect(plan.sets).toHaveProperty("vynora_briefing_" + normClient(victim));
  });

  it("with no known names at all, nothing moves", () => {
    const plan = migrateLegacyNormKeys(attackedState(), []);
    expect(plan.pairs).toEqual([]);
    expect(plan.sets).toEqual({});
  });

  it("it runs for owners only and never writes client_assignments", () => {
    const src = BE("routes/moduleState.ts");
    expect(src).toContain("// Owners only (audit H-2). allowed === null IS the owner check.");
    expect(src).not.toContain("UPDATE client_assignments SET client_norm");
    expect(src).toContain("SELECT client_name FROM client_assignments");
  });
});

/* ── M-4, M-6, M-5 ───────────────────────────────────────────────────────*/

describe("M-4 — erasure reaches legacy-norm data (v5.32.29)", () => {
  const name = "Meridian Capital Partners Group Holdings LLC";
  const L = legacyNormClient(name), N = normClient(name);

  it("purge deletes both the widened and the legacy copies", () => {
    const state = {
      ["vynora_briefing_" + N]: "{}", ["vynora_briefing_" + L]: "{}",
      ["vynora_solution_design_" + L]: "{}", ["vynora_mandatory_" + N]: "{}",
      "vynora_briefing_unrelatedclient": "{}",
    };
    const { deletes } = purgeClientKeys(state, N, [L]);
    expect(deletes.sort()).toEqual([
      "vynora_briefing_" + L, "vynora_briefing_" + N,
      "vynora_mandatory_" + N, "vynora_solution_design_" + L,
    ].sort());
    expect(deletes).not.toContain("vynora_briefing_unrelatedclient");
  });

  it("the route passes both norms, for keys and for assignment rows", () => {
    const src = BE("routes/assignments.ts");
    expect(src).toContain("purgeClientKeys(state, norm, [legacy]);");
    expect(src).toContain("DELETE FROM client_assignments WHERE client_norm = ANY($1::text[])");
  });
});

describe("M-6 — the firm's LLM key is owner-only (v5.32.29)", () => {
  it("a restricted consultant can neither read nor write it", () => {
    const state = { "vynora_api_key": "sk-firm-secret", "vynora_deck_mode": "client" };
    const allowed = new Set(["acmeltd"]);
    expect(Object.keys(filterWorkspaceState(state, allowed))).toEqual(["vynora_deck_mode"]);
    const { sets } = scopeWorkspaceWrite({ "vynora_api_key": "sk-attacker" }, [], state, allowed);
    expect(sets["vynora_api_key"]).toBeUndefined();
  });

  it("it resolves to a sentinel no assignment set can contain", () => {
    expect(resolveKeyClient("vynora_api_key", "sk", { codeToNorm: new Map(), sessionToNorm: new Map() } as never))
      .toBe("OWNER");
    expect(normSetHas(new Set(["OWNER"]), "OWNER")).toBe(true); // only if literally granted
  });
});

describe("M-5 — provider error detail is redacted before logging (v5.32.29)", () => {
  it("prose is dropped and identifiers survive", () => {
    const out = redactProviderDetail(
      "RESOURCE_EXHAUSTED quota=tokens model=claude-sonnet-4-5 " +
      "the interviewee said the CFO is blocking the data investment entirely");
    expect(out).toContain("RESOURCE_EXHAUSTED");
    expect(out).toContain("model=claude-sonnet-4-5");
    expect(out).not.toContain("CFO is blocking");
    expect(out).toContain("[redacted-text]");
  });

  it("undefined stays undefined, and length is bounded", () => {
    expect(redactProviderDetail(undefined)).toBeUndefined();
    expect((redactProviderDetail("x".repeat(5000)) ?? "").length).toBeLessThanOrEqual(300);
  });
});

/* ── H-3 / M-1 / M-2, H-4, H-5, M-8 and the Low items ───────────────────*/

describe("H-3 / M-1 / M-2 — the XSS cluster (v5.32.29)", () => {
  const FILES = ["synthesis.html", "roadmap.html", "interviews.html", "pre_engagement.html",
                 "interview_agent.html", "billing.html", "scorecard.html", "account.html"];

  it("every escaper handles both quote characters", () => {
    for (const f of FILES) {
      const src = FE(f);
      expect(src, f).toContain("'\"':'&quot;'");
      expect(src, f).toContain("\"'\":'&#39;'");
      // The text-only idiom is gone everywhere.
      expect(src, f).not.toContain("d.textContent=t==null?'':String(t); return d.innerHTML;");
    }
  });

  it("the interviewee-controlled role is escaped at the conflict sinks", () => {
    const src = FE("synthesis.html");
    /*
     * v5.32.86: these were literal matches on `${esc(c.high.role)}`, and the
     * conflict sinks now render `${esc(c.high.label||c.high.role)}` — the
     * label carries the PERSON where one role is held by several, so
     * "the COO scored 4.5 vs the COO scored 2.1" becomes usable.
     *
     * Matched on the property rather than the exact expression. The old form
     * would have to be edited on any change to what is interpolated, and an
     * assertion that has to be edited whenever the line changes teaches the
     * next person to edit it rather than to check it. The person's name is
     * interviewee-supplied exactly as the role is — a distributed interviewee
     * types both into the setup form — so it must be inside the same esc().
     */
    /* v5.33.7: COMMENTS ARE STRIPPED BEFORE SCANNING.
     *
     * This scanner used to read the raw file, and it failed on a comment — a
     * v5.33.7 note in synthesis.html quoting the defective line it had just
     * replaced, `${high.role} scored D5 … than ${low.role}`, as the explanation
     * for why it was replaced. The comment is prose about a sink that no longer
     * exists; the scanner reported it as the sink.
     *
     * That is not a nuisance, it is a failure mode with a direction. A security
     * ratchet that flags documentation trains the next person to delete the
     * documentation, and it will be silenced by an edit that changes nothing
     * about the code it is meant to be guarding. auditLows.test.ts hit exactly
     * this and strips comments for exactly this reason.
     *
     * The vacuity guard below is what makes the stripping safe: if it ever
     * removes the real sinks along with the prose, the count drops and the test
     * fails loudly rather than passing on an empty list. */
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/^\s*\*.*$/gm, "");          // continuation lines of a block comment
    const conflictSinks = code.split("\n").filter((l) => /c\.(high|low)\.(role|label)|(^|[^.])\b(high|low)\.role/.test(l));
    expect(conflictSinks.length, "the conflict sinks vanished — this test is now vacuous").toBeGreaterThan(1);
    for (const line of conflictSinks) {
      // Every interpolation of a role or a person on these lines is wrapped.
      expect(line, line.trim().slice(0, 140)).not.toMatch(/\$\{\s*(c\.)?(high|low)\.(role|label|person)/);
      expect(line, line.trim().slice(0, 140)).not.toMatch(/\+\s*(c\.)?(high|low)\.(role|label|person)\s*\+/);
    }
    expect(code).toContain("esc(c.high.label||c.high.role)");
    expect(code).toContain("esc(c.low.label||c.low.role)");
    expect(code).toContain("${esc(high.role)}");
    expect(code).not.toContain("${c.high.role}:");
    expect(code).not.toContain("${high.role} scored this dimension");

    /* v5.33.7 added conflictWho(), which composes the role WITH the person when
     * both ends of a contradiction hold the same title. It is a new path from
     * interviewee-supplied text to the DOM, so it belongs under the same rule:
     * it must return a plain string that the caller escapes, and must not build
     * markup of its own. */
    const who = code.slice(code.indexOf("function conflictWho"), code.indexOf("function openConflictDrillDown"));
    expect(who.length, "conflictWho vanished — this assertion is now vacuous").toBeGreaterThan(80);
    expect(who, "conflictWho must not emit markup — the caller escapes it").not.toMatch(/[<>]|innerHTML|&\w+;/);
    expect(code, "both ends of the contradiction header go through esc()")
      .toContain("${esc(conflictWho(high,low))}");
    expect(code).toContain("${esc(conflictWho(low,high))}");
  });

  it("the nav rail escapes the client name in the text node too", () => {
    const src = FE("vyne-rail.js");
    expect(src).toContain("'\">' + railEsc(cName) + '</div>'");
    expect(src).not.toContain("+ '\">' + cName + '</div>'");
  });

  it("LLM output is escaped where the roadmap renders it", () => {
    const src = FE("roadmap.html");
    for (const f of ["result.criticalPath", "con.summary", "rec.title", "inv.detail", "ph.label"]) {
      expect(src, f).toContain("esc(" + f + ")");
    }
    expect(src).toContain("escAttr(cs.url)");   // href is an attribute context
  });

  it("inline handler arguments go through jsArg, which a backslash cannot defeat", () => {
    for (const f of ["synthesis.html", "roadmap.html", "billing.html", "interviews.html",
                     "pre_engagement.html", "interview_agent.html"]) {
      const src = FE(f);
      expect(src, f).toContain("function jsArg(");
      // The defeatable idiom is gone from live code (comments explain it).
      const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
      expect(code, f).not.toContain('.replace(/\'/g,"\\\\\'")');
    }
  });

  it("jsArg neutralises BOTH the attribute and the JS-string layer", () => {
    const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
    const jsArg = (v: string) => esc(JSON.stringify(String(v)));
    // The payload that defeated the old escaping.
    const attr = jsArg(String.raw`X\'); alert(document.domain);//`);
    expect(attr).not.toMatch(/(^|[^&#\w])'/);           // no raw quote to close the attribute
    expect(attr).not.toContain('"');                      // nor to close a double-quoted one
    expect(JSON.parse(attr.replace(/&quot;/g, '"').replace(/&#39;/g, "'")))
      .toBe(String.raw`X\'); alert(document.domain);//`); // and it round-trips as DATA
  });
});

describe("H-4 / H-5 / M-8 / M-9 and the deployment items (v5.32.29)", () => {
  it("CORS fails closed in production instead of reflecting any origin", () => {
    expect(BE("server.ts")).toContain('if (config.env === "production" && !config.appBaseUrl)');
    expect(ROOT("deploy/deploy.sh")).toContain("APP_BASE_URL=${APP_BASE_URL}");
  });

  it("the DB app password is generated, stored and rotatable — not a shipped default", () => {
    const sh = ROOT("deploy/deploy.sh");
    expect(sh).toContain("openssl rand -base64 33");
    expect(sh).toContain("vyne-db-app-password");
    expect(sh).toContain("rotate-db-password");
    // And the runbook proves the placeholder is dead.
    expect(sh).toContain("PGPASSWORD=change-me-via-ops");
  });

  it("the runtime service account no longer holds project-wide secret access", () => {
    const sh = ROOT("deploy/deploy.sh");
    expect(sh).toContain("gcloud secrets add-iam-policy-binding vyne-database-url");
    expect(sh).not.toContain(
      'gcloud projects add-iam-policy-binding "$PROJECT_ID" \\\n    --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"');
  });

  it("the CSV export neutralises spreadsheet formulas", () => {
    expect(FE("billing.html")).toContain('if (/^[=+\\-@\\t\\r]/.test(s)) s = "\'" + s;');
  });

  it("CDN scripts are version-pinned with integrity hashes", () => {
    expect(FE("roadmap.html")).toContain('integrity="sha384-');
    expect(FE("roadmap.html")).not.toContain("cdn.jsdelivr.net/gh/");
    expect(FE("index.html")).toContain('s.integrity = "sha384-');
  });

  it("outbound and inbound requests are both bounded", () => {
    for (const f of ["llm/adapters/openai.ts", "llm/adapters/anthropicVertex.ts",
                     "llm/adapters/geminiVertex.ts", "llm/adapters/geminiAiStudio.ts", "llm/tts.ts"]) {
      expect(BE(f), f).toContain("signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)");
    }
    expect(BE("server.ts")).toContain("requestTimeout: 180_000");
  });

  it("the operator key is compared in constant time and rate-limited", () => {
    expect(BE("routes/firms.ts")).toContain("timingSafeEqual");
    expect(BE("server.ts")).toContain("await operatorScope.register(rateLimit, {");
  });

  it("deploy uploads and hosting publishes exclude dotfiles and env files", () => {
    expect(ROOT(".gcloudignore")).toContain(".env");
    expect(ROOT("frontend/firebase.json")).toContain("**/.*");
  });
});

/* ── M-3, M-7 ────────────────────────────────────────────────────────────*/

describe("M-3 / M-7 — the interviewee's read and write surface (v5.32.29)", () => {
  /**
   * v5.32.54: this used to assert on SOURCE TEXT —
   *   expect(src).toContain('const settled = r.status !== "active";')
   * — which pinned the exact line that turned out to be the vulnerability.
   * `status` is set to "complete" by mergeSessionIntoEngagement after the FIRST
   * interviewee finishes, so "not active" meant "one colleague has finished",
   * not "this round is over": every later interviewee in the round received the
   * earlier ones' verbatim findings. The test passed throughout, because it was
   * checking that a particular string existed rather than that a particular
   * thing was true. Now it calls the function and reads the output.
   */
  it("the ACTIVE round's peer findings and scores are withheld", () => {
    const eng = JSON.stringify({
      code: "C", client: "Acme", currentRoundId: "r2",
      rounds: [
        { roundId: "r1", roundNumber: 1, status: "complete", scores: { D1: 3 },
          interviews: [{ findings: [{ dimension: "D1", text: "PRIOR ROUND" }] }] },
        // status "complete" is what a round looks like the moment ONE person
        // has finished it — colleagues are still to be interviewed.
        { roundId: "r2", roundNumber: 2, status: "complete", scores: { D6: 1 },
          interviews: [{ findings: [{ dimension: "D6", text: "PEER SAID THIS" }] }] },
      ],
    });
    // round_number NULL — migration 016's "whatever round is current", which
    // is what an invite with no round set means. See V2-H3 below for the
    // interviewee whose round is set and is NOT the current one.
    const out = JSON.parse(sanitizeEngagementForInterviewee(eng, null));
    const active = out.rounds.find((r: { roundId: string }) => r.roundId === "r2");
    expect(active.scores).toBeUndefined();
    expect(active.findingsByDimension).toEqual({});
    expect(JSON.stringify(out)).not.toContain("PEER SAID THIS");
    // The prior round is still delivered — that is the feature, not a leak.
    expect(JSON.stringify(out)).toContain("PRIOR ROUND");
  });

  it("their state writes are bounded in key count and key length", () => {
    const src = BE("routes/interviews.ts");
    expect(src).toContain("Object.keys(b.sets).length <= 200");
    expect(src).toContain("k.length <= 512");
  });
});

/* ── v5.32.30: the migration-012 RLS defect ──────────────────────────────*/

describe("no migration may enable RLS on tenants (v5.32.30)", () => {
  /**
   * `tenants` is the table the tenant context is RESOLVED from — the auth
   * hook's membership query joins it before app.tenant_id exists. It has
   * deliberately never been an RLS table and no policy is defined for it
   * anywhere.
   *
   * v5.32.29's migration 012 copied 011's disable//enable pattern by rote and
   * so flipped `tenants` from "no RLS" to "RLS FORCED with zero policies",
   * which in Postgres denies everything. Verified against Postgres 16: every
   * authenticated request 403'd, firm creation failed, and the Stripe
   * webhook's tenant lookup returned nothing — 65 tests failed across 11
   * files. CI missed it because the migration user in the postgres:16 image
   * is a superuser, and superusers bypass RLS regardless of FORCE.
   *
   * This asserts the shape rather than the behaviour so it fails in CI on any
   * machine, with or without a database.
   */
  it("no migration turns RLS on for tenants", () => {
    const dir = join(__dirname, "..", "src", "db", "migrations");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
      const sql = readFileSync(join(dir, f), "utf8")
        .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      expect(sql, f).not.toMatch(/ALTER TABLE tenants\s+ENABLE ROW LEVEL SECURITY/i);
      expect(sql, f).not.toMatch(/ALTER TABLE tenants\s+FORCE\s+ROW LEVEL SECURITY/i);
      expect(sql, f).not.toMatch(/CREATE POLICY[\s\S]{0,80}ON tenants/i);
    }
  });

  it("012 still does the work it was written for", () => {
    const sql = readFileSync(
      join(__dirname, "..", "src", "db", "migrations", "012_spend_caps.sql"), "utf8");
    expect(sql).toContain("ALTER COLUMN monthly_token_limit SET DEFAULT");
    expect(sql).toContain("daily_user_token_limit");
    expect(sql).toContain("UPDATE tenants t");
  });
});

describe("the operator key is compared in constant time EVERYWHERE (v5.32.59, L1)", () => {
  it("the rate-limit allowList uses the shared comparison, not ===", async () => {
    const src = readFileSync(join(__dirname, "..", "src", "server.ts"), "utf8");
    // The allowList runs on every request to the operator scope, including the
    // ones requireOperator later rejects — a `===` there leaks how much of the
    // key is right just as surely as one inside the gate.
    expect(src).toContain("operatorKeyMatches(req.headers[\"x-signup-key\"])");
    expect(src).not.toMatch(/presented === gate/);
  });

  it("operatorKeyMatches accepts the right key and rejects everything else", async () => {
    const { operatorKeyMatches } = await import("../src/routes/firms.js");
    const prior = process.env.SIGNUP_ACCESS_KEY;
    try {
      process.env.SIGNUP_ACCESS_KEY = "s3cr3t-operator-key";
      expect(operatorKeyMatches("s3cr3t-operator-key")).toBe(true);
      expect(operatorKeyMatches("s3cr3t-operator-keX")).toBe(false);
      expect(operatorKeyMatches("s3cr3t")).toBe(false);          // prefix
      expect(operatorKeyMatches("")).toBe(false);
      expect(operatorKeyMatches(undefined)).toBe(false);
      expect(operatorKeyMatches(["s3cr3t-operator-key"])).toBe(false);
      // Fails CLOSED when the key is not configured at all.
      delete process.env.SIGNUP_ACCESS_KEY;
      expect(operatorKeyMatches("anything")).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.SIGNUP_ACCESS_KEY;
      else process.env.SIGNUP_ACCESS_KEY = prior;
    }
  });
});
