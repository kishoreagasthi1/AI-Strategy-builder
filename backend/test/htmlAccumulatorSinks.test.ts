/**
 * HTML ACCUMULATOR sinks — the class BOTH existing ratchets are blind to
 * (v5.33.3, from the external audit's HIGH).
 *
 * WHAT HAPPENED. roadmap.html's use-case detail modal renders model-generated
 * ROI figures:
 *
 *     html += '<div …>' + item[0] + '</div>'
 *          +  '<div …>' + item[1] + '</div>';     // item[1] = d.typicalROI.*
 *
 * Raw model output into a CONSULTANT's page. Every sibling field in the same
 * builder is escaped — esc(uc.value) twenty lines up, esc(cap) eight, esc(cs.
 * outcome) below — so this is the escaped-most-fields-missed-one shape that
 * innerHtmlSinks.test.ts was written for. It sat there through two audits.
 *
 * WHY NEITHER RATCHET SAW IT.
 *
 *   · innerHtmlSinks.test.ts matches `.innerHTML =` / `insertAdjacentHTML(`.
 *     The tainted line assigns to a LOCAL VARIABLE. There is no sink token on
 *     it, so the scanner never extracted an expression from it, and it was
 *     never baselined — it was not "an accepted risk", it was invisible.
 *
 *   · indirectHtmlSinks.test.ts DOES see the eventual `bodyEl.innerHTML = html`
 *     and counts it among roadmap.html's six documented indirect sinks. 6 == 6,
 *     green. But that file can only enumerate builders and require a human note
 *     per sink; it cannot read the builder. The note for this modal listed the
 *     gap-analysis and stage-card blocks and never mentioned the ROI grid.
 *
 * So the residual proxy after two ratchets was "trust the note". This file
 * removes that proxy for the specific shape that defeated them: it runs the
 * SAME expression extractor the direct ratchet uses, at the accumulation site
 * rather than at the assignment, so `html += taint` is judged exactly as
 * `el.innerHTML = taint` already is.
 *
 * WHAT IT STILL DOES NOT DO. It is not a taint analysis and it does not follow
 * a value across functions. And escaping every sink does not remove the two
 * conditions that turn a missed one into account takeover — script-src still
 * allows 'unsafe-inline' (server.ts, firebase.json) and the bearer token still
 * lives in JS-readable sessionStorage (vyne-client.js). Those are the backstop;
 * this is one more layer of the thing the backstop exists to survive.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { interpolations, statementAfter } from "./innerHtmlSinks.test.js";

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");

/**
 * `something += …` where the right-hand side opens an HTML tag.
 *
 * The `'<` / `"<` / `` `< `` requirement is what keeps this from flagging every
 * numeric accumulator and every `msg += ' and '` in the product. A builder that
 * assembles markup always writes a tag somewhere in the statement; one that
 * does not is not building HTML and cannot carry a payload into innerHTML.
 */
const ACCUM = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\+=\s*(?=[^;\n]*['"`]\s*<)/g;

interface Site { file: string; line: number; exprs: string[] }

function scan(): Site[] {
  const files = readdirSync(FRONTEND).filter((f) => f.endsWith(".html") || f.endsWith(".js"));
  const sites: Site[] = [];
  for (const f of files.sort()) {
    const src = readFileSync(join(FRONTEND, f), "utf8");
    for (const m of src.matchAll(ACCUM)) {
      const start = m.index! + m[0].length;
      const bad = interpolations(statementAfter(src, start));
      if (bad.length) {
        sites.push({
          file: f,
          line: src.slice(0, m.index!).split("\n").length,
          exprs: [...new Set(bad)].sort(),
        });
      }
    }
  }
  return sites;
}

/**
 * Accumulator sites the scanner cannot confirm, by file.
 *
 * A RATCHET, on the same terms as its two siblings: it fails when a count goes
 * UP, and the numbers are expected to be drained. It is emphatically NOT a
 * clean bill of health — these are expressions the scanner could not resolve,
 * which is a list of things to go and read.
 *
 * Established at v5.33.3, AFTER escaping the ROI grid this file was written
 * for. Anyone lowering one of these should say what they read.
 */
const BASELINE: Record<string, number> = {
  // TRIAGED at v5.33.3, every site read. Three live sinks came out of this and
  // were escaped rather than baselined (roadmap's roadmap-export cards, and
  // synthesis's round label and model benchmark figures — see the named tests
  // below). What remains is what the SCANNER cannot resolve, not what a human
  // could not:
  //
  //   interviews.html      g[1] from a literal pair-array; `lines` and
  //                        `trailing.join('')` are assembled from esc()'d parts
  //                        and a five-way literal switch.
  //   pre_engagement.html  parseFloat().toFixed() numbers, and ternaries over
  //                        literal colour/arrow strings.
  //   roadmap.html         counts and percentages; `nameArg` = jsArg+','+jsArg;
  //                        `stLabel`/`cls`/`icon` are literal branches;
  //                        `id` is already escAttr()'d one line up; PHASES is a
  //                        module constant; confirmBtnHtml/stageRowHtml escape
  //                        internally.
  //   solution_design.html the largest block and the least interesting: static
  //                        PATTERNS / WORKFLOW_PRIMITIVES / ARCH_COLORS tables,
  //                        SVG geometry, and ~85 sites behind escHtmlP/escSvg/
  //                        escSpec/govFlag/artFlag — escapers this scanner does
  //                        not know by name. Every model-generated field in the
  //                        file already goes through one of them.
  //   synthesis.html       static DIMENSIONS / ROLE_COLORS / CONFLICT_
  //                        EXPLANATIONS lookups and finite() numbers — plus SIX
  //                        sites inside a vendored sax-style XML parser
  //                        (`parser.script += "</" + parser.tagName`), which is
  //                        parser state and never reaches the DOM at all.
  //
  // These numbers are a list of things a scanner could not prove, and lowering
  // one is ordinary work. They are NOT a statement that 173 sites are safe —
  // that distinction is the entire subject of this file's header.
  "interviews.html": 3,
  "pre_engagement.html": 2,
  "roadmap.html": 17,
  "solution_design.html": 130,
  "synthesis.html": 21,
};

describe("HTML accumulator sinks — the `html += taint` class (v5.33.3)", () => {
  const sites = scan();

  it("finds a realistic number of accumulator statements (a blind scanner is worse than none)", () => {
    const total = readdirSync(FRONTEND)
      .filter((f) => f.endsWith(".html") || f.endsWith(".js"))
      .reduce((n, f) => n + (readFileSync(join(FRONTEND, f), "utf8").match(ACCUM) ?? []).length, 0);
    // The whole failure this file addresses was a scanner reporting green
    // because it could not see the shape. If this collapses, so has the file.
    expect(total).toBeGreaterThan(100);
  });

  it("no file has MORE unescaped accumulator sinks than its baseline", () => {
    const byFile: Record<string, number> = {};
    for (const s of sites) byFile[s.file] = (byFile[s.file] ?? 0) + 1;

    const regressions: string[] = [];
    for (const [file, count] of Object.entries(byFile)) {
      const allowed = BASELINE[file] ?? 0;
      if (count > allowed) {
        const examples = sites
          .filter((s) => s.file === file)
          .slice(0, count - allowed)
          .map((s) => `${s.file}:${s.line} → ${s.exprs.join(", ")}`);
        regressions.push(
          `${file}: ${count} unescaped HTML accumulations, baseline ${allowed}.\n      ` +
          `Wrap the interpolated value in esc(), or — if it genuinely cannot ` +
          `carry markup — raise the baseline WITH a reason.\n      ` +
          examples.join("\n      ")
        );
      }
    }
    expect(regressions.join("\n\n")).toBe("");
  });

  it("the baseline does not list files that no longer have findings", () => {
    const byFile = new Set(sites.map((s) => s.file));
    const stale = Object.keys(BASELINE).filter((f) => !byFile.has(f));
    expect(stale, `stale baseline entries — lower to 0: ${stale.join(", ")}`).toEqual([]);
  });

  /**
   * The audit's HIGH, named. The count ratchet alone cannot protect it: the
   * moment any OTHER accumulator in roadmap.html gets baselined, un-escaping
   * this one again would leave the count unchanged and this file silent. That
   * is the exact mechanism by which the indirect ratchet stayed green over it.
   */
  it("roadmap's typicalROI values stay escaped (audit HIGH, v5.33.3)", () => {
    const road = readFileSync(join(FRONTEND, "roadmap.html"), "utf8");
    expect(road).toContain(
      `'<div style="font-size:12px;font-weight:500;color:var(--white)">'+esc(item[1])+'</div></div>'`
    );
    expect(road).not.toContain(
      `'<div style="font-size:12px;font-weight:500;color:var(--white)">'+item[1]+'</div></div>'`
    );
  });

  it("the error-message sink in the same modal stays escaped (audit LOW, v5.33.3)", () => {
    const road = readFileSync(join(FRONTEND, "roadmap.html"), "utf8");
    expect(road).toContain(`font-size:11px">'+esc(errMsg)+'</div>'`);
  });

  /**
   * The three the SCANNER found — the ones no human had reported.
   *
   * The audit's HIGH was one line. Writing a scanner for its shape and running
   * it over the frontend turned up three more of exactly the same kind, in two
   * files, none of which appeared in either audit. That is the argument for
   * this file over another one-line fix: the reviewers were reading, and the
   * class still had four members.
   */
  it("the roadmap export cards escape their model-generated fields (v5.33.3)", () => {
    const road = readFileSync(join(FRONTEND, "roadmap.html"), "utf8");
    // uc.name / uc.value / uc.deptName / s.name all come from a generated
    // industry catalog or a custom use case built from consultant text.
    expect(road).toContain(`'<div class="rm-dept">'+esc(uc.deptName)+'</div>'`);
    expect(road).toContain(`'<div class="rm-name">'+esc(uc.name)+'</div>'`);
    expect(road).toContain(`'<div class="rm-val">'+esc(uc.value)+'</div>'`);
    expect(road).toContain(`'<div class="rm-sub-item">'+esc(s.name)+'</div>'`);
    // and the id in the onclick goes through jsArg, not esc: it sits inside a
    // JS string inside an attribute, so it needs the quoting too.
    expect(road).toContain(`onclick="removeUc('+jsArg(uc.id)+')"`);
  });

  it("synthesis escapes the consultant-typed round label (v5.33.3)", () => {
    const syn = readFileSync(join(FRONTEND, "synthesis.html"), "utf8");
    expect(syn).toContain(`color:var(--mid-gray)">'+esc(r.label)+'</span></th>'`);
  });

  it("synthesis escapes the raw model benchmark figures (v5.33.3)", () => {
    const syn = readFileSync(join(FRONTEND, "synthesis.html"), "utf8");
    expect(syn).toContain(`'<span class="comp-bench">Avg '+esc(bench.avg)+' | Best '+esc(bench.best)+'</span>'`);
  });

  /* ── The scanner itself ────────────────────────────────────────────────
   *
   * A ratchet is only worth its baseline if the extractor behind it can be
   * shown to see the shape it claims to. These four run against the same
   * `interpolations()` the direct ratchet uses, through THIS file's statement
   * walker, so a regression in either surfaces here. */

  it("sees an unescaped value in an accumulator — the shape that got through", () => {
    const stmt = statementAfter(
      `html += '<div class="x">' + d.typicalROI.metric + '</div>';`,
      "html +=".length
    );
    expect(interpolations(stmt)).toContain("d.typicalROI.metric");
  });

  it("accepts the escaped form of the same line", () => {
    const stmt = statementAfter(
      `html += '<div class="x">' + esc(d.typicalROI.metric) + '</div>';`,
      "html +=".length
    );
    expect(interpolations(stmt)).toEqual([]);
  });

  it("does not flag a non-HTML accumulator", () => {
    // `msg += ' and ' + name` builds a sentence, not markup. Flagging it would
    // fill the baseline with noise, and a noisy ratchet gets switched off.
    expect([...`msg += ' and ' + name;`.matchAll(ACCUM)]).toEqual([]);
    expect([...`total += row.count;`.matchAll(ACCUM)]).toEqual([]);
  });

  it("does see a template-literal accumulator", () => {
    const src = "out += `<li>${row.name}</li>`;";
    const m = [...src.matchAll(ACCUM)];
    expect(m.length).toBe(1);
    expect(interpolations(statementAfter(src, m[0].index! + m[0][0].length))).toContain("row.name");
  });
});
