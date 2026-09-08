/**
 * Every innerHTML sink in the frontend, ratcheted.
 *
 * v5.32.64 (audit H1). Prior rounds fixed the exact sinks each audit cited and
 * added a test naming those three lines. That is instance-fixing: the class
 * survived, and the next audit found more — one of them a line BELOW a
 * neighbour that escaped correctly. A test that names three lines cannot see
 * the fourth.
 *
 * This scans all 300-odd innerHTML / insertAdjacentHTML sites across every
 * frontend file, extracts each interpolated expression, and flags any that is
 * not provably safe. It is a RATCHET, not a clean bill of health: the sites
 * that were already unescaped when this was written are recorded in BASELINE
 * below, and the test fails on anything NEW. Burning the baseline down is
 * ordinary work; letting it grow is not.
 *
 * Deliberately not a general-purpose taint analysis. A precise one needs data
 * flow this repo has no tooling for, and an imprecise one that cries wolf gets
 * switched off. It errs toward flagging: a false positive costs one `esc()`
 * call or one line in the baseline with a reason; a false negative costs an
 * interviewee running script in a consultant's session.
 *
 * WHAT THIS DOES NOT DO. Escaping at the sink stops the payload being written.
 * It does not remove the two conditions that make any surviving sink into
 * account takeover: script-src still allows 'unsafe-inline', and the bearer
 * token still lives in JS-readable sessionStorage. Both are tracked separately
 * and are each their own piece of work; this file is not a substitute for them.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dirname, "..", "..", "frontend");

/**
 * Expressions that cannot carry markup.
 *
 * `esc` escapes & < > " ' (see interviews.html); `escHtml` in roadmap.html
 * escapes & < > only, which is safe in a TEXT position and not in an attribute
 * one — attribute interpolations want escAttr. Accepted here on the same
 * footing as esc because that is how the codebase already treats it, and
 * because the alternative is 30 sites of noise hiding whatever is real.
 */
const SAFE = [
  /^esc\(/,                          // the project's escaper
  /^escAttr\(/,
  /^escHtml\(/,
  /^encodeURIComponent\(/,
  /^railEsc\(/,                      // vyne-rail.js's own escaper
  /*
   * jsArg — `esc(JSON.stringify(String(v==null?'':v)))`, for a value that must
   * survive being a JS string literal inside an on* attribute. It is strictly
   * stronger than esc() alone (JSON.stringify quotes and backslash-escapes
   * first, esc() then neutralises the quote and angle characters), and every
   * one of its nine definitions across the frontend is byte-identical — pinned
   * by "every jsArg definition is the same function" below, so a future weaker
   * copy cannot inherit this exemption silently. Added v5.33.3.
   */
  /^jsArg\(/,
  /^\d+(\.\d+)?$/,                   // numeric literal
  /^(true|false|null|undefined)$/,
  /\.length$/,                       // counts
  /^String\(\s*\d/,
  /\.toFixed\(\s*\d*\s*\)$/,          // a formatted number
  /^[A-Z][A-Z0-9_]*\[/,              // a lookup into an ALL-CAPS constant table
  /\.(map|flatMap)\(\s*(esc|escAttr|escHtml|railEsc)\s*\)$/,  // map(esc)
];


/**
 * Interpolations inside one sink expression — the extractor, rewritten in
 * v5.32.83 so its output is worth acting on.
 *
 * ── What it used to do, and why the number it produced was not a number. ──
 *
 * The old version was two regexes: `\$\{([^}]*)\}` for template holes, and
 * `\+\s*([A-Za-z_$][\w$.[\]()'"]*…)` for concatenation operands. Neither knows
 * what a string literal is, so both matched INSIDE the HTML being assembled.
 * The v5.32.78 note in this file lists what that produced; it was right, and
 * it was worse than it looked. Four separate classes of phantom:
 *
 *  1. CSS fragments. `'font-size:11px;color:#333'` yielded "11px;color" and
 *     "var(--green);font-weight" as "expressions to check".
 *  2. Map-callback source. `items.map(function(i){ return esc(i.name); })` was
 *     reported whole, as one unresolved expression, even though every value
 *     inside is escaped. The v5.32.80 note raised interviews.html's baseline
 *     from 8 to 10 for exactly this and said so.
 *  3. Truncated operands. The operand character class contained `(` and `'`,
 *     so `dims.join(', ')` came out as the fragment "dims.join('".
 *  4. Split ternaries. `?:` binds looser than `+`, so splitting on `+` first
 *     tore `cond ? '<a>'+x+'</a>' : '<b>'` into "cond ? §", "x", "§ : §".
 *
 * ── What it does now. ──
 *
 * The statement is normalised first: string literals collapse to `§`, comments
 * and regex literals disappear, and `${…}` contents are re-emitted as code in
 * parentheses. Nothing inside a string is ever read as an expression, which
 * removes classes 1 and 3 outright. The result is then walked in JS precedence
 * order — ternary, then `||`/`??`, then `+` — which removes class 4. A term
 * that turns out to be a call with a callback is judged on what the callback
 * RETURNS rather than on its source, which removes class 2.
 *
 * ── What that is worth, stated exactly. ──
 *
 * 93 sites → 76. That is 17 sites the scanner was wrong about, not 17 sinks
 * fixed: not one line of frontend code changed with it. The remaining 76 are
 * sites the scanner cannot CONFIRM — overwhelmingly now real expressions
 * (`rows`, `head`, `docDeleteBtnHtml(key)`, `bits.join('')`) whose values are
 * built elsewhere, rather than fragments of CSS. That is the point of the
 * exercise: the number is now a list of things to go and read, and short
 * enough that reading them is a day's work rather than a project.
 *
 * It is still not a proof of safety, and it is still not a taint analysis. It
 * errs toward flagging, deliberately: a false positive costs one esc() call or
 * one baselined line with a reason; a false negative costs an interviewee
 * running script in a consultant's session.
 */
const CALLBACK_METHODS = /\.(map|flatMap|filter|forEach|reduce|sort|find)\s*\($/;


/**
 * Is the `/` at `i` the start of a REGEX LITERAL rather than division?
 *
 * The standard heuristic: a regex can only begin where a value is expected, so
 * look back at the last non-space character. Worth doing properly, because
 * `label.replace(/ \(custom\)$/, '')` contains escaped parens — counted as
 * bracket depth by anything that does not know it is inside a regex, which
 * leaves the depth permanently unbalanced and lets the statement scanner run
 * hundreds of lines past the end of the statement. Four of the sites this
 * scanner reported were that, not a sink.
 */
function isRegexStart(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const c = src[j];
  if ("(,=:[!&|?{};+-*%~^<>".includes(c)) return true;
  return /\b(return|typeof|case|in|of|new|delete|void|do|else)$/.test(src.slice(Math.max(0, j - 9), j + 1));
}

/** Index just past a regex literal starting at `i`, or -1. */
function skipRegex(src: string, i: number): number {
  let inClass = false;
  for (let k = i + 1; k < src.length; k++) {
    const c = src[k];
    if (c === "\\") { k++; continue; }
    if (c === "\n") return -1;
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "/") {
      let e = k + 1;
      while (e < src.length && /[a-z]/.test(src[e])) e++;
      return e;
    }
  }
  return -1;
}

/** Replace every string literal with §, inlining `${...}` as code. */
function normalise(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch; i++; out += "§";
      while (i < s.length) {
        if (s[i] === "\\") { i += 2; continue; }
        if (s[i] === quote) { i++; break; }
        if (quote === "`" && s[i] === "$" && s[i + 1] === "{") {
          let d = 1, j = i + 2, expr = "";
          while (j < s.length && d > 0) {
            if (s[j] === "{") d++;
            else if (s[j] === "}") { d--; if (!d) break; }
            expr += s[j]; j++;
          }
          out += "+(" + normalise(expr) + ")+§";
          i = j + 1; continue;
        }
        i++;
      }
      continue;
    }
    if (ch === "/" && s[i + 1] !== "/" && s[i + 1] !== "*" && isRegexStart(s, i)) {
      const e = skipRegex(s, i);
      if (e > 0) { out += "§"; i = e; continue; }
    }
    if (ch === "/" && s[i + 1] === "/") {           // line comment
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {           // block comment
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2; continue;
    }
    out += ch; i++;
  }
  return out;
}

function splitTop(code: string, isSep: (c: string, i: number) => number): string[] {
  const parts: string[] = []; let depth = 0, last = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0) {
      const n = isSep(code, i);
      if (n) { parts.push(code.slice(last, i)); i += n - 1; last = i + 1; }
    }
  }
  parts.push(code.slice(last));
  return parts;
}
const plusSep = (c: string, i: number): number =>
  c[i] === "+" && c[i - 1] !== "+" && c[i + 1] !== "+" && c[i + 1] !== "=" ? 1 : 0;
const orSep = (c: string, i: number): number =>
  (c.startsWith("||", i) ? 2 : c.startsWith("??", i) ? 2 : 0);

function topIndex(code: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === ch) return i;
  }
  return -1;
}
function balanced(t: string): boolean {
  let d = 0;
  for (const c of t) {
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") { d--; if (d < 0) return false; }
  }
  return d === 0;
}

/**
 * The expressions a callback CONTRIBUTES, or null if this is not a callback.
 *
 * Returning the callback's own source text as "an expression" is the single
 * largest source of noise in the old extractor: `items.map(function(i){...})`
 * was reported as an unescaped interpolation even when every value inside the
 * body was esc()-wrapped. What reaches the output is the body's return values,
 * so those are what get judged.
 */
function callbackBodies(args: string): string[] | null {
  const arrow = args.indexOf("=>");
  let rest: string;
  if (arrow >= 0) rest = args.slice(arrow + 2).trim();
  else if (/^\s*function\b/.test(args)) {
    const b = args.indexOf("{", args.indexOf(")"));
    if (b < 0) return null;
    rest = args.slice(b).trim();
  } else return null;

  if (!rest.startsWith("{")) return [rest];          // concise arrow body

  let d = 0, end = -1;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === "{") d++;
    else if (c === "}") { d--; if (!d) { end = i; break; } }
  }
  const body = end >= 0 ? rest.slice(1, end) : rest.slice(1);
  const stmts = splitTop(body, (c, i) => (c[i] === ";" ? 1 : 0));
  const returns: string[] = [];
  for (const st of stmts) {
    const m = st.match(/(^|[^\w$])return\b([\s\S]*)$/);
    if (m) returns.push(m[2]);
  }
  return returns.length ? returns : [];
}

/**
 * The `(` that pairs with the FINAL `)`, so the callee of the outermost call
 * can be read. `term.indexOf("(")` finds the wrong one whenever the receiver
 * is itself parenthesised — `(d.findings || []).map(function(f){…})` gave a
 * callee of `(`, so the callback was never recognised and its whole source was
 * reported as an unresolved expression.
 */
function lastCallOpen(term: string): number {
  if (!term.endsWith(")")) return -1;
  let d = 0;
  for (let i = term.length - 1; i >= 0; i--) {
    const c = term[i];
    if (c === ")") d++;
    else if (c === "(") { d--; if (!d) return i; }
  }
  return -1;
}

function judge(term: string, out: string[], depth = 0): void {
  if (depth > 8) return;
  term = term.trim();
  while (term.startsWith("(") && term.endsWith(")") && balanced(term.slice(1, -1))) {
    term = term.slice(1, -1).trim();
  }
  // Only string literals, separators and whitespace: nothing reaches the sink
  // that the page did not write itself.
  if (!term || /^[§,\s]*$/.test(term)) return;

  /*
   * Precedence order, and it matters. `?:` binds LOOSER than `+`, so a
   * statement of the form
   *
   *     el.innerHTML = cond ? '<a>' + x + '</a>' : '<b>' + y + '</b>'
   *
   * is one ternary, not a concatenation. Splitting on `+` first tore it into
   * `cond ? §`, `x`, `§ : §`, `y` — three of which are fragments of nothing
   * and were reported as unresolved expressions. Ternary, then `||`, then `+`.
   */
  const q = topIndex(term, "?");
  if (q >= 0) {
    const rest = term.slice(q + 1);
    const c = topIndex(rest, ":");
    if (c >= 0) { judge(rest.slice(0, c), out, depth + 1); judge(rest.slice(c + 1), out, depth + 1); return; }
  }

  const alts = splitTop(term, orSep);
  if (alts.length > 1) { for (const a of alts) judge(a, out, depth + 1); return; }

  const plus = splitTop(term, plusSep);
  if (plus.length > 1) { for (const p of plus) judge(p, out, depth + 1); return; }

  if (SAFE.some((r) => r.test(term))) return;

  // A transparent tail call — `.join('')` on a mapped array contributes
  // nothing of its own. Stripped FIRST, or the callback match below would take
  // the final `)` of `.join('')` as the end of `.map(`'s argument list.
  const chain = term.match(/^([\s\S]+\))\s*\.(join|concat|trim|toString|slice|reverse)\s*\([^()]*\)$/);
  if (chain) { judge(chain[1], out, depth + 1); return; }

  const open = lastCallOpen(term);
  if (open > 0 && balanced(term)) {
    const callee = term.slice(0, open + 1);
    const args = term.slice(open + 1, -1);
    if (CALLBACK_METHODS.test(callee)) {
      const bodies = callbackBodies(args);
      if (bodies) { for (const b of bodies) judge(b, out, depth + 1); return; }
    }
  }

  out.push(term);
}

export function interpolations(segment: string): string[] {
  const out: string[] = [];
  const code = normalise(segment);
  // Out of scope when nothing is interpolated at all: `el.innerHTML = html` is
  // an INDIRECT sink and belongs to indirectHtmlSinks.test.ts, which follows
  // the variable to where it is built. Flagging it here would double-count it
  // against a ratchet that cannot resolve it.
  if (splitTop(code, plusSep).length === 1) return out;
  judge(code, out);
  return out;
}

/**
 * The text of the statement beginning at `start`, to the `;` that ends it.
 *
 * EXPORTED (v5.33.3) so htmlAccumulatorSinks.test.ts walks statements with
 * this exact function rather than a copy. The first draft of that file carried
 * a simplified copy without the comment and regex handling below, and an
 * apostrophe inside a /* *\/ comment ("JSON.stringify's") opened a string that
 * never closed — the walker ran to its 4000-char cap and reported the tail of
 * a map callback as an unresolved expression. A second copy of a subtle
 * tokenizer is a second set of blind spots.
 */
export function statementAfter(src: string, start: number): string {
  const max = Math.min(src.length, start + 4000);
  let quote = null, depth = 0;
  for (let i = start; i < max; i++) {
    const ch = src[i];
    if (quote) { if (ch === "\\") { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "/" && src[i + 1] === "/") { while (i < max && src[i] !== "\n") i++; continue; }
    if (ch === "/" && src[i + 1] === "*") { i += 2; while (i < max && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    if (ch === "/" && isRegexStart(src, i)) {
      const e = skipRegex(src, i);
      if (e > 0) { i = e - 1; continue; }
    }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth--; if (depth < 0) return src.slice(start, i); continue; }
    if (ch === ";" && depth === 0) return src.slice(start, i);
  }
  return src.slice(start, max);
}


interface Site { file: string; line: number; exprs: string[] }

function scan(): Site[] {
  const files = readdirSync(FRONTEND).filter((f) => f.endsWith(".html") || f.endsWith(".js"));
  const sites: Site[] = [];
  for (const f of files.sort()) {
    const src = readFileSync(join(FRONTEND, f), "utf8");
    for (const m of src.matchAll(/(\.innerHTML\s*=|insertAdjacentHTML\s*\()/g)) {
      const start = m.index! + m[0].length;
      const segment = statementAfter(src, start);
      const bad = interpolations(segment).filter((e) => !SAFE.some((r) => r.test(e.trim())));
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
 * Sites the scanner cannot confirm, by file and count. A ratchet, not a clean
 * bill of health: it fails when a count goes UP, and is expected to be lowered
 * as sites are drained.
 *
 * Counts rather than line numbers on purpose: line numbers churn on every edit
 * and would make this fail for reasons that have nothing to do with safety.
 *
 * ── History, because this number has meant three different things. ──
 *
 * v5.32.64 — 51 sites, each traced by hand. Eleven carried genuinely
 * attacker-influenceable text and were fixed rather than baselined: the
 * interviewee's own answer replayed into the Clarify modal, archived client and
 * stakeholder names in the interview-recovery picker (which had no escaping at
 * all and reaches a CONSULTANT's browser), model-extracted briefing fields, six
 * sites rendering raw Anthropic JSON, and the signed-in email and role in
 * vyne-rail.js, rendered on every page in the product.
 *
 * v5.32.77 — 47 → 93. A rise in VISIBILITY, not a regression: the statement
 * tokenizer became string-aware and could finally see past a leading HTML
 * entity or a `style="a:b;c:d"` attribute. One newly visible site was a live
 * stored XSS — synthesis.html's push toast rendering an unescaped client name —
 * found by the external audit. The other 45 were never individually reviewed,
 * and that note said so: 93 was a ceiling, not a measurement.
 *
 * v5.32.83 — 93 → 76, and the number now means something. The extractor was
 * rewritten (see interpolations() above) to stop reading CSS inside string
 * literals, map-callback source, truncated operands and split ternaries as
 * expressions. NOT ONE LINE OF FRONTEND CODE CHANGED with this drop. It is 17
 * sites the scanner was wrong about, and saying so is the whole point:
 * "17 fewer XSS sinks" would be a falsehood that reads like progress, and this
 * file has already been misread once in that direction.
 *
 * What the 76 are: sites whose interpolated value the scanner cannot resolve.
 * Nearly all are now indirection rather than noise — `rows`, `head`, `body`,
 * `docDeleteBtnHtml(key)`, `bits.join('')` — values assembled elsewhere, often
 * with escaping applied there. Confirming them means following each variable to
 * where it is built. That is ordinary work, and the list is now short enough to
 * finish. Until it is finished this is a list of UNKNOWNS: not a list of
 * vulnerabilities, and not a claim of safety.
 *
 * WHAT THIS DOES NOT DO, unchanged: escaping at the sink stops the payload
 * being written. It does not remove the two conditions that turn any surviving
 * sink into account takeover — script-src still allows 'unsafe-inline', and the
 * bearer token still lives in JS-readable sessionStorage. Both are tracked
 * separately and neither is substituted for by this file.
 */
const BASELINE: Record<string, number> = {
  "about.html": 1,
  "account.html": 1,
  "admin.html": 1,
  "billing.html": 2,
  "index.html": 1,
  "interview_agent.html": 11,
  "interviews.html": 6,
  "live-check.html": 1,
  "pre_engagement.html": 10,
  "roadmap.html": 30,
  "scorecard.html": 1,
  "solution_design.html": 1,
  "synthesis.html": 8,
  "vyne-client.js": 1,
  "vyne-rail.js": 1,
};

describe("innerHTML sinks — ratchet over the whole frontend (audit H1)", () => {
  const sites = scan();

  it("scans a realistic number of sinks (a scanner that finds nothing is broken)", () => {
    const total = readdirSync(FRONTEND)
      .filter((f) => f.endsWith(".html") || f.endsWith(".js"))
      .reduce((n, f) => {
        const src = readFileSync(join(FRONTEND, f), "utf8");
        return n + (src.match(/(\.innerHTML\s*=|insertAdjacentHTML\s*\()/g) ?? []).length;
      }, 0);
    // If this ever collapses toward zero, the regexes stopped matching and
    // every assertion below became vacuously true.
    expect(total).toBeGreaterThan(200);
  });

  it("no file has MORE unescaped sinks than its baseline", () => {
    const byFile: Record<string, number> = {};
    for (const s of sites) byFile[s.file] = (byFile[s.file] ?? 0) + 1;

    const regressions: string[] = [];
    for (const [file, count] of Object.entries(byFile)) {
      const allowed = BASELINE[file] ?? 0;
      if (count > allowed) {
        const examples = sites
          .filter((s) => s.file === file)
          .slice(-(count - allowed))
          .map((s) => `${s.file}:${s.line} → ${s.exprs.join(", ")}`);
        regressions.push(
          `${file}: ${count} unescaped sinks, baseline ${allowed}.\n      ` +
          `Wrap the interpolated value in esc(), or — if it genuinely cannot ` +
          `carry markup — raise the baseline WITH a reason.\n      ` +
          examples.join("\n      ")
        );
      }
    }
    expect(regressions.join("\n\n")).toBe("");
  });

  it("the baseline does not list files that no longer have unescaped sinks", () => {
    // Keeps the ratchet honest in the other direction: a stale baseline quietly
    // re-opens room for new sinks in a file that had been cleaned up.
    const byFile = new Set(sites.map((s) => s.file));
    const stale = Object.keys(BASELINE).filter((f) => !byFile.has(f));
    expect(stale, `baseline lists files with no findings — lower them to 0: ${stale.join(", ")}`)
      .toEqual([]);
  });

  it("the sinks fixed for this audit stay fixed", () => {
    // Named explicitly because these are the ones a reviewer will look for,
    // and because a count-based ratchet alone would let one be un-escaped as
    // long as another was escaped in the same file.
    const syn = readFileSync(join(FRONTEND, "synthesis.html"), "utf8");
    expect(syn).toContain("esc(roleNames.join(', ')||'—')");

    const road = readFileSync(join(FRONTEND, "roadmap.html"), "utf8");
    expect(road).toContain("esc(d.detailedDescription||uc.desc)");
    expect(road).toContain("'<div class=\"sub-desc\">'+esc(sub.desc)+'</div>'");
    expect(road).toContain("'<div class=\"gap-card-name\">'+esc(uc.name)");

    const agent = readFileSync(join(FRONTEND, "interview_agent.html"), "utf8");
    expect(agent).toContain("${esc(sess.stakeholderName||'Anonymous')}");
  });

  /**
   * The eleven fixed in v5.32.69, named individually.
   *
   * The count ratchet above cannot protect these. It counts SITES, and several
   * of them live inside a statement that is already flagged for a different
   * expression — so removing an esc() from one of them leaves the count
   * unchanged and the ratchet silent. Verified: reverting the vyne-rail.js fix
   * kept all four assertions above green.
   *
   * Each of these carried text an interviewee, a client document or a model
   * could influence, into a page a CONSULTANT opens.
   */
  it("the eleven tainted sinks traced in v5.32.69 stay escaped", () => {
    const agent = readFileSync(join(FRONTEND, "interview_agent.html"), "utf8");
    const road = readFileSync(join(FRONTEND, "roadmap.html"), "utf8");
    const rail = readFileSync(join(FRONTEND, "vyne-rail.js"), "utf8");

    // 1. The interviewee's own answer, replayed into the Clarify modal — and
    //    into a consultant's browser on resume or archive replay.
    expect(agent).toContain("${esc(original.length>200?original.substring(0,200)+'...':original)}");
    // 2. Archived client / stakeholder names in the recovery picker. This one
    //    had no escaping whatsoever.
    expect(agent).toContain("esc((r.client||'?')+' · '+(r.stakeholderName||r.stakeholderRole||'?')+' · '+when)");
    // 3. Briefing fields a model extracted from client documents.
    expect(agent).toContain("esc(br.industry||'')");
    expect(agent).toContain("esc(br.revenue||'')");
    // 4. Model-generated use-case and department names on the stage cards.
    expect(road).toContain("+esc(uc.name)+totalChip+'</div>'");
    expect(road).toContain("esc(dept?dept.name:'')");
    // 5. The AI use-case preview: requires keys/values, sub names, value line.
    expect(road).toContain("+esc(e[0])+' &ge;'+esc(e[1])+");
    expect(road).toContain("return esc(s.name);");
    expect(road).toContain("'<div class=\"ai-preview-val\">'+esc(uc.value||'')+'</div>'");
    // 6. Department icon and name in the matrix header.
    expect(road).toContain("'<span class=\"d-icon\">'+esc(dept.icon)+'</span>'");
    expect(road).toContain("'<span class=\"d-name\">'+esc(dept.name)+'</span>'");
    // 7. Industry label — model-generated for a custom catalog.
    expect(road).toContain("+esc(e[1].label)+'</option>'");
    expect(road).toContain("+esc(indLabel)+");
    // 8. An unvalidated dimension key from a generated use case.
    expect(road).toContain("'\">'+esc(dim)+'</span>'");
    // 9. The signed-in identity, on every page in the product.
    expect(rail).toContain('railEsc(s.email || "")');
    expect(rail).toContain('railEsc(s.role)');
  });

  it("every jsArg definition is the same function (the SAFE exemption depends on it)", () => {
    /* jsArg is exempted in SAFE above. That exemption is only sound while every
     * copy is the strong one. Nine files declare their own; a tenth file, or a
     * hand-edit of one, that dropped the JSON.stringify or the esc would
     * silently inherit "provably safe" from this list. */
    const CANON = `function jsArg(v){ return esc(JSON.stringify(String(v==null?'':v))); }`;
    const defs: string[] = [];
    for (const f of readdirSync(FRONTEND).filter((x) => x.endsWith(".html") || x.endsWith(".js"))) {
      const src = readFileSync(join(FRONTEND, f), "utf8");
      for (const m of src.matchAll(/function\s+jsArg\s*\([\s\S]*?\n/g)) {
        defs.push(`${f}: ${m[0].trim()}`);
      }
    }
    expect(defs.length).toBeGreaterThan(5);
    const wrong = defs.filter((d) => !d.endsWith(CANON));
    expect(wrong, `a jsArg that is not the canonical one: ${wrong.join(" | ")}`).toEqual([]);
  });

  it("the scanner can see parenthesised interpolations", () => {
    // The blind spot that hid three of the eleven: `+ (expr)` was skipped
    // entirely because the pattern required an identifier first. A scanner
    // with a shape it cannot see produces a baseline that reads as a complete
    // inventory and is not one.
    expect(interpolations("'a' + (foo.bar||'') + 'b'")).toContain("foo.bar");
    // And only the BRANCHES of a ternary, never the condition — judging the
    // condition produced eight false positives on the first attempt.
    const t = interpolations("'a' + (x.cond ? esc(a) : b) + 'c'");
    expect(t).not.toContain("x.cond");
    expect(t).toContain("b");
  });

  /**
   * The four phantom classes the v5.32.83 rewrite removed, each pinned.
   *
   * These are the tests that were missing while the baseline read 93. Nothing
   * stopped the extractor reporting a CSS fragment as an expression, so nothing
   * noticed that a third of that list was fiction — and the one live sink in it
   * sat unremarked among the noise for two versions.
   *
   * Each case below fails against the old two-regex extractor. That is the bar:
   * a test for a scanner has to distinguish the scanner from its predecessor,
   * or it only asserts that the code runs.
   */
  it("does not read CSS inside a string literal as an expression", () => {
    expect(interpolations(`'<div style="font-size:11px;color:#333">' + esc(x) + '</div>'`)).toEqual([]);
    // Specifically the shapes that were sitting in the old baseline.
    expect(interpolations(`'<b style="line-height:1.45;margin-top:2px">' + esc(a) + '</b>'`)).toEqual([]);
    expect(interpolations(`'<i style="color:var(--green);font-weight:600">' + esc(a) + '</i>'`)).toEqual([]);
  });

  it("judges a map callback on what it returns, not on its source", () => {
    expect(interpolations(
      `'<ul>' + items.map(function (i) { return '<li>' + esc(i.name) + '</li>'; }).join('') + '</ul>'`
    )).toEqual([]);
    // And it must still SEE an unescaped value inside that callback. A
    // recursion that returns nothing is as useless as one that returns source.
    expect(interpolations(
      `'<ul>' + items.map(function (i) { return '<li>' + i.name + '</li>'; }).join('') + '</ul>'`
    )).toContain("i.name");
  });

  it("does not truncate an operand at a quote or a paren", () => {
    // The old operand character class swallowed `(` and `'`, so this came out
    // as the fragment "dims.join('" — an expression that does not exist.
    const out = interpolations(`'<p>' + dims.join(', ') + '</p>'`);
    expect(out).toEqual(["dims.join(§)"]);
    expect(out.join()).not.toContain("'");
  });

  it("treats a top-level ternary as one expression, not as three fragments", () => {
    // `?:` binds looser than `+`. Splitting on `+` first produced "cond ? §",
    // "x" and "§ : §", two of which are fragments of nothing.
    const out = interpolations(`cond ? '<a>' + esc(x) + '</a>' : '<b>' + y + '</b>'`);
    expect(out).toEqual(["y"]);
    expect(out.some((e) => e.includes("?") || e.includes(":"))).toBe(false);
  });

  it("does not lose the end of a statement to a regex literal", () => {
    // `label.replace(/ \(custom\)$/, '')` carries ESCAPED parens. Anything
    // counting bracket depth without knowing it is inside a regex ends up
    // permanently unbalanced and runs on into the next function — four
    // reported sites were that, and their real interpolations went unread.
    expect(interpolations(`'<b>' + label.replace(/ \\(custom\\)$/, '') + '</b>' + tail`))
      .toContain("tail");
  });

  it("still reports a genuinely unescaped interpolation", () => {
    // The counterweight to everything above. An extractor tuned only for quiet
    // is worse than a noisy one, because quiet reads as safe.
    expect(interpolations(`'<div>' + user.name + '</div>'`)).toContain("user.name");
    expect(interpolations("`<div>${user.name}</div>`")).toContain("user.name");
    expect(interpolations(`'<div>' + (a || b.c) + '</div>'`)).toContain("b.c");
  });

});
