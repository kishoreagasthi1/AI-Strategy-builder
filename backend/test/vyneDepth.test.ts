/**
 * frontend/vyne-depth.js — the one definition of interview length (v5.33.8).
 *
 * ── What this file is actually protecting ──────────────────────────────────
 *
 * Migration 028 adds `interviews.depth NOT NULL DEFAULT 'deep'` and backfills
 * every existing row to 'deep'. That is only safe because 'deep' reproduces,
 * exactly, what the product did when depth was not a stored field at all:
 *
 *   · initial   → 50 questions            (the old
 *                 `S.depth==='quick'?25:S.depth==='deep'?50:35`)
 *   · follow-up → 3 per agenda item, floored at 6, capped at 30, with
 *                 mandatory questions added on top
 *                 (the old computeRefreshQuestionBudget, verbatim)
 *
 * If somebody later tidies the tables in vyne-depth.js and moves `deep`, every
 * interview already in flight silently changes length and nothing else in the
 * repo would notice. The two "pins the pre-028 behaviour" blocks below are the
 * whole reason this file exists; the rest is ordinary coverage.
 *
 * Loaded with createRequire, the same way roleCanon.test.ts loads its module —
 * these are plain UMD files, there is no bundler in this repo, and the point is
 * to test the file the browser actually gets rather than a copy of it.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const VyneDepth = require(path.join(repoRoot, "frontend/vyne-depth.js"));

/** The pre-v5.33.8 implementations, copied here so the pins compare against
 *  the real thing rather than against a restatement of the new one. */
const OLD_INITIAL = (d: string) => (d === "quick" ? 25 : d === "deep" ? 50 : 35);
const OLD_REFRESH = (items: number, mandatoryCount: number) => {
  const base = Math.min(30, Math.max(6, items * 3));
  const mq = typeof mandatoryCount === "number" && mandatoryCount > 0 ? mandatoryCount : 0;
  return { low: base, high: base + mq, items, mandatory: mq };
};

describe("028 is a no-op for every interview already in flight", () => {
  it("initial: deep is still 50 — the module default it replaces", () => {
    expect(VyneDepth.initialBudget("deep")).toBe(OLD_INITIAL("deep"));
    expect(VyneDepth.initialBudget("deep")).toBe(50);
  });

  it("follow-up: deep reproduces computeRefreshQuestionBudget exactly", () => {
    // Across the whole interesting range: below the floor, through the linear
    // middle, past the cap, and with and without mandatory questions.
    for (const items of [0, 1, 2, 3, 5, 9, 10, 11, 20, 50]) {
      for (const mq of [0, 1, 4]) {
        expect(
          VyneDepth.followUpBudget("deep", items, mq),
          `items=${items} mandatory=${mq}`
        ).toEqual(OLD_REFRESH(items, mq));
      }
    }
  });

  it("...and a row with NO depth at all resolves to deep, not to undefined", () => {
    // The failure this prevents is a NaN progress denominator on any row that
    // reaches the browser without the column — an older cached bootstrap, a
    // test fixture, a hand-inserted row.
    for (const bad of [undefined, null, "", "  ", "DEEP?", 7, {}]) {
      expect(VyneDepth.normalize(bad as never)).toBe("deep");
    }
    expect(VyneDepth.initialBudget(undefined as never)).toBe(50);
  });
});

describe("the three depths are ordered and distinct", () => {
  it("a quick screen is shorter than standard, which is shorter than deep", () => {
    const q = VyneDepth.initialBudget("quick");
    const s = VyneDepth.initialBudget("standard");
    const d = VyneDepth.initialBudget("deep");
    expect(q).toBeLessThan(s);
    expect(s).toBeLessThan(d);
  });

  it("the same holds for a follow-up with a realistic agenda", () => {
    const at = (depth: string) => VyneDepth.followUpBudget(depth, 6, 0).high;
    expect(at("quick")).toBeLessThan(at("standard"));
    expect(at("standard")).toBeLessThan(at("deep"));
  });

  it("case and whitespace do not create a fourth depth", () => {
    expect(VyneDepth.normalize(" Quick ")).toBe("quick");
    expect(VyneDepth.normalize("STANDARD")).toBe("standard");
  });
});

describe("a follow-up stays short because it is narrow, not because it is quick", () => {
  /* The design point of the agenda-derived budget, and the reason depth scales
   * it rather than replacing it: a one-item follow-up must not become a 50
   * question interview merely because the parent was a deep dive. */
  it("one agenda item is a short conversation at EVERY depth", () => {
    for (const d of ["quick", "standard", "deep"]) {
      expect(VyneDepth.followUpBudget(d, 1, 0).high, d).toBeLessThanOrEqual(8);
    }
  });

  it("even a deep follow-up is capped well below a deep initial interview", () => {
    expect(VyneDepth.followUpBudget("deep", 100, 0).high)
      .toBeLessThan(VyneDepth.initialBudget("deep"));
  });

  it("mandatory questions are added ON TOP, never counted against the agenda", () => {
    const without = VyneDepth.followUpBudget("standard", 4, 0);
    const with3 = VyneDepth.followUpBudget("standard", 4, 3);
    expect(with3.low).toBe(without.low);          // the agenda part is unchanged
    expect(with3.high).toBe(without.high + 3);    // the obligation is extra
    expect(with3.mandatory).toBe(3);
  });

  it("a cap does not swallow mandatory questions either", () => {
    // 100 items pins the base at the cap; the mandatory questions must still
    // be visible above it, or an interview could be told to ask fewer
    // obligatory questions than exist.
    const b = VyneDepth.followUpBudget("deep", 100, 5);
    expect(b.high).toBe(b.low + 5);
  });
});

describe("the module is a usable source for the three UIs that read it", () => {
  it("all() offers the depths in the order the controls show them, deep first", () => {
    const all = VyneDepth.all();
    expect(all.map((d: { value: string }) => d.value)).toEqual(["deep", "standard", "quick"]);
    expect(all[0].value).toBe(VyneDepth.DEFAULT);
  });

  it("every depth has a label and a human range for the preview sheet", () => {
    for (const d of VyneDepth.all()) {
      expect(d.label, d.value).toMatch(/\S/);
      expect(d.range, d.value).toMatch(/\d+.*\d+ questions/);
    }
  });

  it("the model instruction quotes a range consistent with the budget", () => {
    /* The preview sheet tells an executive "40–50 questions" and the prompt
     * tells the model "40-50 questions". If those two ever drift, the product
     * promises one interview and conducts another — which is precisely the
     * class of defect this module was extracted to prevent. */
    for (const key of VyneDepth.ORDER) {
      const upper = Number((VyneDepth.prompt(key).match(/(\d+)-(\d+) questions/) || [])[2]);
      expect(upper, key).toBe(VyneDepth.initialBudget(key));
      const rangeUpper = Number((VyneDepth.range(key).match(/(\d+)[–-](\d+)/) || [])[2]);
      expect(rangeUpper, key).toBe(VyneDepth.initialBudget(key));
    }
  });

  /*
   * v5.34.111 — the VOICE interviewer's copy of the same promise.
   *
   * `range` is prose for the consultant, `prompt` is prose for the text model,
   * and `target` is the integer pair for the live model (integers because they
   * land above the persona's data fence). Three renderings of one number, and
   * the defect this whole module exists to prevent is exactly them drifting —
   * so all three are pinned to each other, not just to themselves.
   */
  it("the voice target agrees with the range and the budget", () => {
    for (const key of VyneDepth.ORDER) {
      const t = VyneDepth.target(key);
      const m = VyneDepth.range(key).match(/(\d+)[–-](\d+)/) || [];
      expect(t.low, key).toBe(Number(m[1]));
      expect(t.high, key).toBe(Number(m[2]));
      expect(t.high, key).toBe(VyneDepth.initialBudget(key));
      expect(t.low, key).toBeLessThan(t.high);
    }
  });

  it("target falls back to the default for anything unrecognised", () => {
    // Same normalisation as every other accessor — an old row or a typo must
    // not produce an undefined budget that silently disables the size rule.
    for (const bad of [undefined, null, "", "DEEP-ish", 7]) {
      expect(VyneDepth.target(bad as never)).toEqual(VyneDepth.target("deep"));
    }
  });

  it("a deeper interview is never booked shorter than a shallower one", () => {
    const q = VyneDepth.target("quick");
    const s = VyneDepth.target("standard");
    const d = VyneDepth.target("deep");
    expect(q.high).toBeLessThan(s.high);
    expect(s.high).toBeLessThan(d.high);
    expect(q.low).toBeLessThan(s.low);
    expect(s.low).toBeLessThan(d.low);
  });
});
