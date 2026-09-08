/**
 * Every per-client key family the FRONTEND writes must be known to the
 * SCOPING layer (v5.33.3).
 *
 * ── The bug that keeps coming back ─────────────────────────────────────────
 *
 * auth/clients.ts scopes workspace state with three hand-maintained lists:
 * GLOBAL_KEYS, NORM_SUFFIX and CODE_SUFFIX. resolveKeyClient() is deny-by-
 * default — a key matching none of them resolves to "UNKNOWN", which means
 * filterWorkspaceState() drops it on READ and scopeWorkspaceWrite() drops it
 * on WRITE, for every restricted consultant. The PUT still returns {ok:true}
 * and the page still paints "Saved".
 *
 * So shipping a new `vynora_<thing>_<CODE>` family without adding a line to
 * that list produces one of two failures, depending on the family:
 *
 *   · DATA LOSS. v5.32.25 (one family) and v5.33.0 (five roadmap families —
 *     dim_gaps, gap_credits, gap_plans, measured_base, maturity_targets) both
 *     shipped this way. Every restricted consultant silently lost their gap
 *     analysis and maturity targets on every reload.
 *
 *   · AUTHORIZATION BYPASS. v5.33.3 (vynora_memory_, found by external audit).
 *     For a code-suffixed family the missing registration makes resolveKeyClient
 *     skip the server-authoritative codeToNorm() lookup and fall through to
 *     normClient(value.client) — a field in the REQUEST BODY. A consultant
 *     restricted to client A who knows client B's code could write B's memory
 *     blob by labelling it "A", and the owner's next follow-up on B loads it
 *     into the interview prompt.
 *
 * Three occurrences, one cause: nobody enumerated the writers. Each was fixed
 * by adding the missing lines, which fixes the instance and leaves the class.
 * ENG_KEY_FAMILIES in the same file lists several of them and feeds only the
 * dormant norm→code migration, never the scoping layer — a second list that
 * looks like this check and is not.
 *
 * ── What this does ─────────────────────────────────────────────────────────
 *
 * It reads the FRONTEND, finds every `'vynora_…_' + something` construction —
 * the shape of a per-client key being built — and fails if the family is in
 * none of the three lists. The source of truth becomes the code that writes the
 * keys, not a list somebody has to remember to update.
 *
 * It is deliberately syntactic. A family written entirely through a variable
 * would be missed; the answer to that is that this repo does not do it, and a
 * check that catches the shape used three times running is worth more than one
 * that waits for a data-flow analysis nobody is going to build.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = join(ROOT, "..", "frontend");
const CLIENTS_TS = join(ROOT, "src", "auth", "clients.ts");

/** The three lists, read out of the source so they cannot drift from it. */
function scopingLists(): { global: Set<string>; norm: string[]; code: string[]; handled: string[] } {
  const src = readFileSync(CLIENTS_TS, "utf8");
  const list = (name: string, open: string, close: string): string[] => {
    const at = src.indexOf(name);
    if (at < 0) throw new Error(`${name} not found in auth/clients.ts`);
    const from = src.indexOf(open, at);
    const to = src.indexOf(close, from);
    return [...src.slice(from, to).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  /*
   * Families with a BESPOKE branch in resolveKeyClient() rather than a list
   * entry — today just vynora_session_, which resolves through the
   * sessionToNorm map built from the session blobs' own `client` field. Read
   * out of the function instead of excused in this file, so a branch that is
   * deleted stops counting as coverage on the same commit.
   */
  const fnStart = src.indexOf("export function resolveKeyClient");
  const fnEnd = src.indexOf("\n}", fnStart);
  const handled = [...src.slice(fnStart, fnEnd).matchAll(/key\.startsWith\("([^"]+)"\)/g)]
    .map((m) => m[1]);

  return {
    global: new Set(list("const GLOBAL_KEYS", "[", "]")),
    norm: list("const NORM_SUFFIX", "[", "];"),
    code: list("const CODE_SUFFIX", "[", "\n];"),
    handled,
  };
}

/**
 * Families the frontend builds a per-client key from.
 *
 * `'vynora_x_' + code` and `` `vynora_x_${code}` `` both count; a bare
 * `'vynora_x'` with no trailing underscore is a whole key, not a family, and is
 * checked against GLOBAL_KEYS instead.
 */
function familiesUsedByFrontend(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const files = readdirSync(FRONTEND).filter((f) => f.endsWith(".html") || f.endsWith(".js"));
  for (const f of files) {
    const src = readFileSync(join(FRONTEND, f), "utf8");
    // 'vynora_foo_' immediately followed by a concatenation, or ${…} in a template.
    for (const m of src.matchAll(/['"](vynora_[a-z0-9_]*_)['"]\s*\+/g)) {
      const list = out.get(m[1]) ?? [];
      if (!list.includes(f)) list.push(f);
      out.set(m[1], list);
    }
    for (const m of src.matchAll(/`(vynora_[a-z0-9_]*_)\$\{/g)) {
      const list = out.get(m[1]) ?? [];
      if (!list.includes(f)) list.push(f);
      out.set(m[1], list);
    }
  }
  return out;
}

/**
 * Families that are genuinely NOT per-client and must not be registered.
 *
 * Each needs a reason. "It was already failing" is not one — that is how a
 * suppression list becomes the bug.
 */
const NOT_PER_CLIENT: Record<string, string> = {
  // Suffixed by INDUSTRY, not by client — one generated catalog is reused
  // across every client in that industry, and GLOBAL_KEYS carries the prefix.
  "vynora_industry_catalog_": "suffixed by industry; shared across clients by design",
};

describe("per-client key families are known to the scoping layer (v5.33.3)", () => {
  const { global, norm, code, handled } = scopingLists();
  const used = familiesUsedByFrontend();

  it("reads the three lists out of auth/clients.ts", () => {
    // A parser that silently returns nothing makes every assertion below
    // vacuous — the precise failure shape this file exists to prevent.
    expect(code.length).toBeGreaterThan(20);
    expect(norm.length).toBeGreaterThan(2);
    expect(global.size).toBeGreaterThan(0);
    // resolveKeyClient's own branches count as coverage; if the parser stops
    // finding them, vynora_session_ would read as unregistered and somebody
    // would "fix" it by adding it to a list where it does not belong.
    expect(handled).toContain("vynora_session_");
  });

  it("finds a realistic number of key families in the frontend", () => {
    expect(used.size).toBeGreaterThan(15);
  });

  it("every family the frontend writes is registered, or explicitly excused", () => {
    const known = new Set([...norm, ...code, ...handled]);
    const missing: string[] = [];
    for (const [family, files] of used) {
      if (known.has(family)) continue;
      if (NOT_PER_CLIENT[family]) continue;
      // A GLOBAL_KEYS entry that is a PREFIX of this family also covers it.
      if ([...global].some((g) => family.startsWith(g))) continue;
      missing.push(`${family}  (written by ${files.join(", ")})`);
    }
    expect(
      missing.join("\n      "),
      "\n\n  A per-client key family the frontend writes is not in NORM_SUFFIX or " +
      "CODE_SUFFIX in auth/clients.ts.\n  resolveKeyClient() is deny-by-default, so for " +
      "every restricted consultant this key is\n  dropped on read AND on write while the " +
      "PUT still returns ok — and if it is\n  code-suffixed, its write authorization falls " +
      "back to a caller-controlled body field.\n  Add it to the right list, or add it to " +
      "NOT_PER_CLIENT with a reason.\n\n      "
    ).toBe("");
  });

  it("the excuse list has no stale entries", () => {
    const stale = Object.keys(NOT_PER_CLIENT).filter((f) => !used.has(f));
    expect(stale, `NOT_PER_CLIENT lists families nothing writes: ${stale.join(", ")}`).toEqual([]);
  });

  it("vynora_memory_ specifically is registered (the audit's MEDIUM)", () => {
    // Named as well as counted: the generic check above would go quiet the
    // moment somebody added this family to NOT_PER_CLIENT to make it pass.
    expect(code).toContain("vynora_memory_");
    expect(NOT_PER_CLIENT["vynora_memory_"]).toBeUndefined();
  });

  it("the five roadmap families from the v5.33.0 data loss are still registered", () => {
    for (const f of ["vynora_dim_gaps_", "vynora_gap_credits_", "vynora_gap_plans_",
                     "vynora_measured_base_", "vynora_maturity_targets_"]) {
      expect(code, `${f} fell out of CODE_SUFFIX`).toContain(f);
    }
  });
});
