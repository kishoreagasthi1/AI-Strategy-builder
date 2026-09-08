/**
 * INDIRECT innerHTML sinks — the class the v5.32.69 ratchet cannot see
 * (v5.32.76, found while draining the audit's grandfathered baseline).
 *
 * WHAT HAPPENED. The v5.32.74 audit called the sink ratchet "the structural
 * remedy, adopted", and asked for the ~33 grandfathered sinks to be drained —
 * naming pre_engagement.html's LLM-summary sinks for manual confirmation. That
 * confirmation found two live ones:
 *
 *   pre_engagement.html  trends.map(t => '<div class="trend-pill">' + t + '</div>')
 *   pre_engagement.html  '<b>Benchmark basis:</b> ' + basis + ' · Confidence: ' + confidence
 *
 * Both render raw model output. Neither was in the baseline, because the ratchet
 * had never flagged them at all — its ten flagged sites in that file are ten
 * different lines. Escaping them did not move the count by one.
 *
 * THE BLIND SPOT. The ratchet inspects the expression assigned to `.innerHTML`.
 * When HTML is assembled in one function and assigned in another, the assignment
 * it sees is `bd.innerHTML = basisHtml` — a bare identifier, structurally
 * indistinguishable from a safe constant. All the taint is at the caller, which
 * the scanner never reads.
 *
 * So a clean ratchet run meant "no unescaped interpolation at the point of
 * assignment", and was being read as "no unescaped interpolation". Seventeen
 * assignments in the product take that shape.
 *
 * WHAT THIS FILE DOES. It cannot decide whether a builder is safe — that needs a
 * human reading the function. What it can do is refuse to let the SET grow
 * silently: every indirect sink is enumerated here with a note on what feeds it,
 * and a new one fails CI until somebody writes that note. The number can fall
 * and never rise, exactly like its sibling.
 *
 * That is a weaker guarantee than the direct ratchet and is stated as such. It
 * converts an invisible class into a visible, bounded one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");

/** `x.innerHTML = someIdentifier;` — HTML built somewhere else. */
const INDIRECT = /\.innerHTML\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;/g;

/**
 * Every known indirect sink, and what has been checked about its builder.
 * Adding an entry is a claim that somebody read the function that builds it.
 */
const KNOWN: Record<string, number> = {
  // renderRecoveryPicker — builder escapes stakeholder names (v5.32.69).
  "interview_agent.html": 1,
  // ivRenderPager builds its buttons into `out` then assigns (v5.32.80). Every
  // interpolation in that builder is esc()-wrapped and the only values are page
  // numbers and row counts, both computed here rather than received.
  //
  // + refreshSourceHint (v5.32.91). Four static message bodies selected by
  // branch; the ONLY interpolated value in any of them is the chosen client
  // name, esc()-wrapped at the single site that uses it. That name arrives
  // from /api/my-clients — the tenant's own engagements / assignments /
  // interviews rows, i.e. consultant-typed text, which is precisely the
  // category this ratchet exists to keep escaped. The anchors are literal
  // hrefs to pre_engagement.html, not built from data.
  "interviews.html": 2,
  // renderPriorRoundsSummary (label/date now escaped, v5.32.76),
  // setBenchBasisNote (model `basis`/`confidence` now escaped, v5.32.76),
  // and the export preview.
  "pre_engagement.html": 3,
  // Gap analysis, stage cards, dependency tree, matrix, requirements, targets.
  "roadmap.html": 6,
  // Portfolio, intake and brief panels.
  "solution_design.html": 3,
  // Synthesis body and two modal bodies.
  "synthesis.html": 3,
  // Recommendation banner.
  "vyne-client.js": 1,
};

function scanIndirect(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of readdirSync(FRONTEND)) {
    if (!f.endsWith(".html") && !f.endsWith(".js")) continue;
    const src = readFileSync(join(FRONTEND, f), "utf8");
    const n = (src.match(INDIRECT) ?? []).length;
    if (n > 0) out[f] = n;
  }
  return out;
}

describe("indirect innerHTML sinks stay enumerated (v5.32.76)", () => {
  const found = scanIndirect();

  it("the scanner still matches something — a zero result means the regex broke", () => {
    const total = Object.values(found).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(10);
  });

  it("no file has MORE indirect sinks than are documented above", () => {
    const grown = Object.entries(found)
      .filter(([f, n]) => n > (KNOWN[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} (documented ${KNOWN[f] ?? 0})`);
    expect(grown, [
      "A new `el.innerHTML = someVariable` appeared.",
      "The direct ratchet CANNOT see whether that variable is escaped — all the",
      "interpolation lives in whatever builds it. Read the builder, escape every",
      "value that is model output, engagement-record text or anything a user",
      "typed, then raise the count here with a note saying what you checked.",
    ].join(" ")).toEqual([]);
  });

  it("the documented set does not outlive the sinks it describes", () => {
    // A stale entry is a licence to add one back without review.
    const stale = Object.keys(KNOWN).filter((f) => (found[f] ?? 0) < KNOWN[f]);
    expect(stale, "These files now have FEWER indirect sinks than documented — "
      + "lower the numbers so the floor actually holds.").toEqual([]);
  });

  it("pre_engagement's model-output builders are escaped (the two the audit found)", () => {
    // Named individually, because a count cannot tell these two from any other
    // three sinks in the same file. Both render raw LLM output.
    const src = readFileSync(join(FRONTEND, "pre_engagement.html"), "utf8");
    expect(src).toContain(`'<div class="trend-pill">'+esc(t)+'</div>'`);
    expect(src).toContain("'<b>Benchmark basis:</b> '+esc(basis)");
    expect(src).toContain("' · Confidence: <b>'+esc(confidence)+'</b>'");
    // And the engagement-record text in the prior-rounds table.
    expect(src).toContain("+esc(r.label)+");
    expect(src).toContain("'<td>'+esc(r.date)+'</td>'");
  });
});
