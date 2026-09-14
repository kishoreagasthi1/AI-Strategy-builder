/**
 * THE WHOLE CHAIN, EXECUTED: Pre-Engagement → Interview → Deck. (v5.34.97)
 *
 * ── The two ends that were still asserted as text ───────────────────────────
 *
 * pipelineRegression.test.ts runs the middle of the product for real, but it
 * starts from a hand-written tiering and stops at the engagement record. The
 * two ends were still pinned by grep:
 *
 *   FRONT  Does a consultant's tiering in Pre-Engagement actually become the
 *          tiering the interview runs under? pipelineRegression assumed it, by
 *          constructing the dimTiers itself. If pre_engagement.html wrote that
 *          field under a different key, or interview_agent.html read a
 *          different briefing, every test still passed.
 *
 *   BACK   Does the deck show the same numbers? roadmap.html rebuilds each
 *          interview into a fresh persona object and computes its own cover
 *          aggregate. A field dropped in that mapping — which has happened —
 *          silently reverts the deck to an unweighted mean, and the deck is the
 *          one artefact a client actually reads.
 *
 * Both are now executed. One localStorage, four real pages, one engagement,
 * from the consultant setting tiers to the numbers the deck would print.
 *
 * ── What a failure here means ───────────────────────────────────────────────
 *
 * That the product's ends have come apart, which is the only failure mode that
 * has ever cost this codebase anything. Every individual piece can be correct
 * and this test still fails — that is the point of it.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadPage, loadInterviewAgent, type MemStore, type PageContext } from "./support/pageContext.js";
import { dimensionWeights, overallOf } from "../src/tenant/scoring.js";

const CLIENT = "Meridian Manufacturing";
const ROLES = ["CTO", "CFO", "CHRO"] as const;

const ANSWERS: Record<string, Record<string, number>> = {
  CTO:  { D1: 4.0, D2: 3.5, D3: 2.5, D4: 2.0, D6: 1.5, D7: 2.0 },
  CFO:  { D1: 2.0, D2: 2.0, D3: 3.0, D4: 2.5, D5: 3.0, D6: 2.0, D7: 2.0 },
  CHRO: { D3: 2.0, D4: 4.0, D5: 2.5, D7: 3.5 },
};

/** Same golden set as pipelineRegression — reached here through the real pages. */
const GOLDEN = {
  scores: { D1: 3.3, D2: 3.2, D3: 2.6, D4: 3.2, D5: 2.8, D6: 1.7, D7: 2.8 },
  overall: 2.7,
  plainOverall: 2.8,
} as const;

/** A fresh in-memory localStorage shared by every page in one chain. */
function sharedStore(): MemStore {
  const m: Record<string, string> = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    key: (i) => Object.keys(m)[i] ?? null,
    get length() { return Object.keys(m).length; },
    _raw: m,
  };
}

/**
 * STEP 1 — the consultant sets up the engagement in Pre-Engagement.
 *
 * Uses that page's OWN getRoleTiers() and writeBriefing(), so the briefing is
 * shaped and addressed exactly as the product shapes and addresses it. Building
 * the blob by hand here would test this file's idea of a briefing.
 */
function preEngagement(store: MemStore) {
  const pe = loadPage("pre_engagement.html", { store });
  const catalog = pe.evalIn<any[]>("ROLE_CATALOG");
  const roleCatalog = ROLES.map((value) => {
    const entry = catalog.find((r) => r.value === value);
    expect(entry, `ROLE_CATALOG has no ${value} — the catalog changed`).toBeTruthy();
    return {
      value,
      display: entry.display,
      priorityDims: entry.priorityDims || [],
      dimTiers: pe.call<Record<string, string>>("getRoleTiers", entry),
      seq: entry.seq,
    };
  });
  const briefing = {
    client: CLIENT,
    industry: "Manufacturing",
    generatedAt: new Date().toISOString(),
    selectedRoles: [...ROLES],
    roleCatalog,
    scopeDimensions: ["D1", "D2", "D3", "D4", "D5", "D6", "D7"],
  };
  pe.call("writeBriefing", CLIENT, JSON.stringify(briefing));
  return { pe, roleCatalog };
}

/** STEP 2+3 — the interviews run, and land in the engagement record. */
function runInterviews(store: MemStore) {
  const ia = loadInterviewAgent(store);
  const tiersSeen: Record<string, Record<string, string>> = {};
  for (const role of ROLES) {
    const S = ia.S;
    S.client = CLIENT;
    S.stakeholderRole = role;
    S.stakeholderName = `${role} person`;
    S.industry = "Manufacturing";
    S.sessionId = `s-${role}`;
    S.sessionCode = `VYNE-${role}-0001`;
    S.scores = { ...ANSWERS[role] };
    S.findings = [];
    S.isRefreshMode = false;
    /*
     * Deliberately NOT set: S.dimTiers. The whole point is that the tiering
     * comes from the briefing Pre-Engagement wrote, through the page's own
     * dimensionTierMap(). Seeding it here would be the assumption this test
     * exists to remove.
     */
    delete S.dimTiers;
    tiersSeen[role] = ia.call<Record<string, string>>("dimensionTierMap");
    ia.call("writeInterviewToEngagement");
  }
  /*
   * Find the engagement by scanning, not by rebuilding its index key.
   *
   * The first version derived `normClient(CLIENT)` and read
   * vynora_engagement_index — which works only on the path where
   * writeInterviewToEngagement CREATES the engagement and writes that index
   * entry. With a briefing already in the store, resolveEngagementCode() hands
   * back a code from the briefing and the index is never touched, so the lookup
   * found nothing while the record sat there under a code the test had not
   * guessed. Reproducing a key-derivation rule in a test is a second
   * implementation of it; scanning asserts on what is actually stored.
   */
  const keys = Object.keys(store._raw).filter((k) => k.startsWith("vynora_engagement_")
    && k !== "vynora_engagement_index");
  const found = keys
    .map((k) => ({ k, v: JSON.parse(store.getItem(k)!) }))
    .filter((x) => x.v && x.v.client === CLIENT && (x.v.rounds || []).length);
  expect(found.length, `no engagement record was written (keys: ${keys.join(", ") || "none"})`).toBe(1);
  return { ia, tiersSeen, code: found[0].v.code, eng: found[0].v };
}

describe("FULL CHAIN — front: Pre-Engagement's tiering is what the interview runs", () => {
  const store = sharedStore();
  let roleCatalog: any[];
  let tiersSeen: Record<string, Record<string, string>>;

  beforeAll(() => {
    roleCatalog = preEngagement(store).roleCatalog;
    tiersSeen = runInterviews(store).tiersSeen;
  });

  it("the interview page reads back exactly the tiering Pre-Engagement wrote", () => {
    /*
     * THE front-end assertion. Two pages, two files, one localStorage key, and
     * until now nothing checked that the value written by one is the value read
     * by the other — pipelineRegression constructed the tiering itself, so a
     * key mismatch or a shape change would not have failed anything.
     */
    for (const role of ROLES) {
      const written = roleCatalog.find((r) => r.value === role)!.dimTiers;
      const read = tiersSeen[role];
      // dimensionTierMap fills every dimension; absent from dimTiers = 'out'.
      for (const d of ["D1", "D2", "D3", "D4", "D5", "D6", "D7"]) {
        expect(read[d], `${role}/${d}: the interview is not running Pre-Engagement's tiering`)
          .toBe(written[d] ?? "out");
      }
    }
  });

  it("a tier the consultant CHANGES follows through to the interview", () => {
    /*
     * The static case above passes if both sides happen to fall back to the
     * same defaults. This one proves the briefing is actually consulted: demote
     * a CTO's D6 from lead to light in Pre-Engagement, and the interview must
     * see light.
     */
    const s2 = sharedStore();
    const pe = loadPage("pre_engagement.html", { store: s2 });
    const catalog = pe.evalIn<any[]>("ROLE_CATALOG");
    const cto = catalog.find((r) => r.value === "CTO");
    pe.call("getRoleTiers", cto);                       // seed from defaults
    pe.call("setRoleDimTier", "CTO", "D6", "light");    // the consultant's edit
    expect(cto.dimTiers.D6, "setRoleDimTier did not take").toBe("light");

    pe.call("writeBriefing", CLIENT, JSON.stringify({
      client: CLIENT, industry: "Manufacturing",
      selectedRoles: ["CTO"],
      roleCatalog: [{ value: "CTO", display: cto.display, priorityDims: cto.priorityDims || [], dimTiers: cto.dimTiers }],
      scopeDimensions: ["D1", "D2", "D3", "D4", "D5", "D6", "D7"],
    }));

    const ia = loadInterviewAgent(s2);
    ia.S.client = CLIENT;
    ia.S.stakeholderRole = "CTO";
    const seen = ia.call<Record<string, string>>("dimensionTierMap");
    expect(seen.D6, "the consultant's re-tiering never reached the interview").toBe("light");
  });

  it("a dimension the consultant switches OFF is excluded, not merely demoted", () => {
    const s3 = sharedStore();
    const pe = loadPage("pre_engagement.html", { store: s3 });
    const cto = pe.evalIn<any[]>("ROLE_CATALOG").find((r) => r.value === "CTO");
    pe.call("getRoleTiers", cto);
    pe.call("setRoleDimTier", "CTO", "D7", "off");
    expect(cto.dimTiers.D7, "'off' must REMOVE the dimension, not store a tier name")
      .toBeUndefined();

    pe.call("writeBriefing", CLIENT, JSON.stringify({
      client: CLIENT, industry: "Manufacturing", selectedRoles: ["CTO"],
      roleCatalog: [{ value: "CTO", display: cto.display, priorityDims: [], dimTiers: cto.dimTiers }],
      scopeDimensions: ["D1", "D2", "D3", "D4", "D5", "D6", "D7"],
    }));

    const ia = loadInterviewAgent(s3);
    ia.S.client = CLIENT;
    ia.S.stakeholderRole = "CTO";
    expect(ia.call<Record<string, string>>("dimensionTierMap").D7).toBe("out");
  });

  it("the three default tier tables agree", () => {
    /*
     * pre_engagement.html DEFAULT_ROLE_TIERS, and interview_agent.html's
     * getRolePriorityData — the same thirteen roles, in two files, with no test
     * comparing them. They agree today. A drift would mean the tiering a
     * consultant is SHOWN and the tiering the interview RUNS are different,
     * which is unfalsifiable from either page alone.
     */
    const pe = loadPage("pre_engagement.html", { store: sharedStore() });
    const ia = loadInterviewAgent(sharedStore());
    const defaults = pe.evalIn<Record<string, any>>("DEFAULT_ROLE_TIERS");
    for (const role of Object.keys(defaults)) {
      const fromAgent = ia.call<any>("getRolePriorityData", role);
      expect(fromAgent.lead.slice().sort(), `${role} lead`).toEqual(defaults[role].lead.slice().sort());
      expect(fromAgent.cover.slice().sort(), `${role} cover`).toEqual(defaults[role].cover.slice().sort());
      expect(fromAgent.light.slice().sort(), `${role} light`).toEqual(defaults[role].light.slice().sort());
    }
  });
});

describe("FULL CHAIN — middle: the engagement record and its numbers", () => {
  const store = sharedStore();
  let eng: any;

  beforeAll(() => {
    preEngagement(store);
    eng = runInterviews(store).eng;
  });

  it("reaches the golden scores having started from Pre-Engagement", () => {
    expect(eng.rounds[0].scores).toEqual(GOLDEN.scores);
  });

  it("and the golden WEIGHTED overall, not the plain mean", () => {
    const w = dimensionWeights(eng.rounds[0].interviews as never);
    expect(w, "no weights — the briefing's tiering did not survive to the record").not.toBeNull();
    expect(overallOf(eng.rounds[0].scores, w)).toBe(GOLDEN.overall);
    expect(overallOf(eng.rounds[0].scores)).toBe(GOLDEN.plainOverall);
  });
});

describe("FULL CHAIN — back: the deck prints the same numbers", () => {
  const store = sharedStore();
  let deck: PageContext;
  let personas: any;

  beforeAll(() => {
    preEngagement(store);
    runInterviews(store);
    deck = loadPage("roadmap.html", { store });
    personas = deck.call<any>("deckLoadPersonaScores");
  });

  it("the deck finds the engagement the interviews wrote", () => {
    expect(personas, "deckLoadPersonaScores returned nothing — the deck would print no personas")
      .toBeTruthy();
    expect(personas.interviews.map((i: any) => i.role).sort()).toEqual([...ROLES].sort());
  });

  it("each persona's overall is WEIGHTED by that role's own tiering", () => {
    /*
     * roadmap.html rebuilds each interview into a fresh object, and a field
     * dropped in that mapping silently reverts the deck to an unweighted mean.
     * Asserted against the shared formula rather than a literal, so the check
     * survives a deliberate scoring change and fails on an accidental one.
     */
    for (const p of personas.interviews) {
      expect(p.dimTiers, `${p.role} lost its tiering in the deck mapping`).toBeTruthy();
      const scored = Object.fromEntries(
        Object.entries(p.scores).filter(([, v]) => typeof v === "number" && (v as number) > 0),
      );
      const expected = overallOf(scored as never, dimensionWeights([{ dimTiers: p.dimTiers }] as never));
      expect(p.overall, `${p.role}'s deck overall is not the weighted one`).toBe(expected);
    }
  });

  it("a persona's deck overall differs from its unweighted mean", () => {
    /*
     * Otherwise the assertion above is satisfied by a weighting that does
     * nothing. The CTO answered six dimensions across all three tiers, so the
     * two must differ.
     */
    const cto = personas.interviews.find((p: any) => p.role === "CTO");
    const scored = Object.fromEntries(
      Object.entries(cto.scores).filter(([, v]) => typeof v === "number" && (v as number) > 0),
    );
    expect(cto.overall).not.toBe(overallOf(scored as never));
  });

  it("the deck's per-dimension numbers are the engagement's, unrounded away", () => {
    const cto = personas.interviews.find((p: any) => p.role === "CTO");
    for (const [d, v] of Object.entries(ANSWERS.CTO)) {
      expect(cto.scores[d], `deck ${d}`).toBe(v);
    }
    // Dimensions with no evidence are null in the deck, never 0.
    expect(cto.scores.D5, "an unasked dimension must be null, not a zero the deck can average")
      .toBeNull();
  });

  it("the round label reaches the deck", () => {
    expect(personas.roundLabel).toBeTruthy();
  });
});
