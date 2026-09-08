/**
 * findings.ts — what it takes for a finding to count as corroborated.
 *
 * v5.32.59 (F13). Three places computed "confirmed findings" and all three
 * grouped by DIMENSION:
 *
 *   engagementLookup.deriveConfirmedFindings   roles who mentioned the dim >= 2
 *   synthesis.html's Confirmed Findings panel  same rule, rendered
 *   roadmap.html's deckDeriveFindings          2+ interviews SCORED the dim
 *
 * So a CFO saying "we cannot get a straight answer on data lineage" and a CHRO
 * saying "nobody in the business trusts the reporting team" were reported as
 * one corroborated finding about Data & Data Management. They are two separate
 * observations that happen to share a category. The consultant's deck then
 * presented that as established fact with two named sources behind it, and
 * loadClientEvidence fed the same claim into the model that writes the client
 * document — where "confirmed by CFO and CHRO" is exactly the kind of sentence
 * a client repeats back to their board.
 *
 * Corroboration has to be about the CLAIM. This module clusters findings by
 * what they actually say, within a dimension, and only calls a cluster
 * corroborated when two or more DIFFERENT roles made substantially the same
 * point.
 *
 * It deliberately errs toward under-claiming. Findings that share a dimension
 * but not a claim are still returned — as `thematic`, which the callers label
 * as "multiple stakeholders raised this area" rather than as agreement. That
 * keeps the signal a consultant wants while removing the assertion nobody
 * could support.
 *
 * frontend/vyne-findings.js is the browser counterpart;
 * test/findingsParity.test.ts executes both and fails on any divergence.
 */

export interface RawFinding {
  dimension?: string;
  text?: string;
  role?: string;
  interviewee?: string;
}

export interface FindingCluster {
  dimension: string;
  /** The longest text in the cluster — the fullest statement of the claim. */
  text: string;
  /** Every distinct wording, longest first, capped. */
  texts: string[];
  /**
   * Distinct SOURCES that made this point, as attribution labels — the role
   * alone, or "Role (Person)" where one role is held by several people
   * (v5.32.86). Named `roles` because every caller renders it as attribution
   * and the string is what they print.
   */
  roles: string[];
  /** True when >= 2 distinct sources made substantially the same point. */
  corroborated: boolean;
}

export interface CorroborationResult {
  /** Same claim, two or more roles. Safe to present as agreement. */
  corroborated: FindingCluster[];
  /**
   * Two or more roles raised the same DIMENSION but made different points.
   * Real signal, not agreement — callers must not label these as confirmed.
   */
  thematic: { dimension: string; roles: string[]; clusters: FindingCluster[] }[];
  /** Everything else: a single role's single observation. */
  single: FindingCluster[];
}

/* Deliberately short. A long stopword list starts deleting the words that
 * carry the claim ("no", "not", "own") and makes opposite statements cluster
 * together, which is worse than missing a match. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this",
  "that", "these", "those", "there", "their", "they", "we", "our", "us",
  "as", "at", "by", "from", "has", "have", "had", "do", "does", "did",
  "will", "would", "can", "could", "should", "may", "might", "than", "then",
  "so", "if", "into", "about", "over", "very", "much", "more", "most",
]);

/**
 * Content tokens of a finding. Lowercased, punctuation stripped, stopwords
 * removed, trailing plural "s" trimmed so "systems" and "system" match.
 *
 * No stemmer beyond that on purpose: an aggressive stemmer collapses
 * "governance" and "governing" onto "govern" — fine — but also "policies" and
 * "police", and a wrong merge here manufactures agreement that does not exist,
 * which is the exact failure this module was written to stop.
 */
export function contentTokens(text: string): string[] {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    const t = w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
    if (out.indexOf(t) === -1) out.push(t);
  }
  return out;
}

/**
 * Overlap coefficient: shared tokens over the SHORTER token set.
 *
 * Not Jaccard. A one-line finding and a three-line one that make the same
 * point score badly under Jaccard purely because of length, and consultants
 * write findings at wildly different lengths.
 */
export function claimSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const t of a) if (setB.has(t)) shared++;
  return shared / Math.min(a.length, b.length);
}

/** Minimum overlap for two findings to be "the same point". */
export const SIMILARITY_THRESHOLD = 0.5;
/** ...and they must share at least this many content words.
 *
 *  Without this, two four-word findings sharing the single word "data" score
 *  1.0 after stopword removal and merge. Two shared content words is the
 *  smallest bar that stops the category noun alone from doing it. */
export const MIN_SHARED_TOKENS = 2;

function sameClaim(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  /* Identical content is identical regardless of how few words it is. Without
   * this, MIN_SHARED_TOKENS blocks two roles who said the SAME short sentence
   * from ever corroborating each other — the one case where corroboration is
   * beyond argument. */
  if (a.length === b.length && a.every((t, i) => t === b[i])) return true;
  const setB = new Set(b);
  let shared = 0;
  for (const t of a) if (setB.has(t)) shared++;
  if (shared < MIN_SHARED_TOKENS) return false;
  return shared / Math.min(a.length, b.length) >= SIMILARITY_THRESHOLD;
}

interface WorkingCluster {
  dimension: string;
  entries: { text: string; role: string; label: string; tokens: string[] }[];
}

/**
 * Flatten an engagement round's interviews into findings tagged with a role
 * AND the person who gave them.
 *
 * v5.32.86: the person used to be dropped here. One role can be held by
 * several people — a client with divisional COOs has three of them — and every
 * consumer downstream then treated "COO" as an identity. See
 * corroborateFindings for what that cost.
 */
export function findingsOf(
  interviews: {
    role?: string; findings?: RawFinding[] | null;
    interviewee?: string; name?: string;
  }[] | null | undefined
): RawFinding[] {
  const out: RawFinding[] = [];
  for (const iv of Array.isArray(interviews) ? interviews : []) {
    if (!iv) continue;
    const role = String(iv.role ?? "").trim();
    const person = String(iv.interviewee ?? iv.name ?? "").trim();
    for (const f of Array.isArray(iv.findings) ? iv.findings : []) {
      if (!f) continue;
      out.push({
        dimension: String(f.dimension ?? "").trim(),
        text: String(f.text ?? "").trim(),
        role: role || String(f.role ?? "").trim(),
        interviewee: person || String(f.interviewee ?? "").trim(),
      });
    }
  }
  return out;
}

/**
 * Attribution labels: the role alone, or the role plus the person when the
 * role alone cannot say who spoke.
 *
 * v5.32.86. `roles` on a cluster is what every caller renders and counts —
 * "[CFO, CTO]" in the prompt builder, "2 sources agree" in the dashboard — and
 * it was a list of ROLE STRINGS deduped against each other. So two divisional
 * COOs who independently made the same point collapsed to ["COO"], length 1,
 * and `corroborated` came out FALSE. Two genuinely independent sources, filed
 * as one unsupported observation, in a module whose entire purpose is deciding
 * what may be presented as agreed.
 *
 * The labels are only widened where they have to be. A role held by one person
 * stays "CFO", because "CFO (Dana Reed)" everywhere would be noise and would
 * churn every existing string. A role held by several becomes
 * "COO (Marcus Webb)" — which is also what a consultant reading a conflict tile
 * needs, since "the COO scored 4.5 and the COO scored 2.1" is not a sentence.
 *
 * An UNNAMED interview keeps the bare role even when the role is contested.
 * That is deliberate and conservative: with no name there is nothing to tell
 * two holders apart, so two unnamed COOs still do not corroborate each other.
 * Inventing an identity per interview row would manufacture agreement, which is
 * the failure this module exists to prevent.
 */
export function attributionLabels(findings: RawFinding[] | null | undefined): (f: RawFinding) => string {
  const peopleByRole = new Map<string, Set<string>>();
  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f) continue;
    const role = String(f.role ?? "").trim();
    const person = String(f.interviewee ?? "").trim();
    if (!role || !person) continue;
    if (!peopleByRole.has(role)) peopleByRole.set(role, new Set());
    peopleByRole.get(role)!.add(person);
  }
  return (f: RawFinding): string => {
    const role = String(f?.role ?? "").trim();
    const person = String(f?.interviewee ?? "").trim();
    if (!role) return person;
    if (!person) return role;
    return (peopleByRole.get(role)?.size ?? 0) > 1 ? `${role} (${person})` : role;
  };
}

/** Cap on distinct wordings kept per cluster — this ends up in a prompt. */
const MAX_TEXTS_PER_CLUSTER = 4;

export function corroborateFindings(findings: RawFinding[] | null | undefined): CorroborationResult {
  const byDim = new Map<string, WorkingCluster[]>();
  const dimOrder: string[] = [];
  // Computed over the WHOLE list before clustering: whether a role needs the
  // person's name to identify the speaker is a property of the engagement, not
  // of one cluster.
  const labelFor = attributionLabels(findings);

  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f) continue;
    const dim = String(f.dimension ?? "").trim();
    const text = String(f.text ?? "").trim();
    const role = String(f.role ?? "").trim();
    // A finding with no dimension, no text or no attributable role cannot be
    // corroborated by anything — silently dropping it is better than letting
    // an empty role look like a second source.
    if (!dim || !text || !role) continue;
    const tokens = contentTokens(text);
    if (!tokens.length) continue;

    if (!byDim.has(dim)) { byDim.set(dim, []); dimOrder.push(dim); }
    const clusters = byDim.get(dim)!;

    /* Greedy assignment to the BEST-matching cluster, not the first match.
     * First-match makes the result depend on interview completion order, so
     * the same engagement clustered differently depending on who finished
     * first — and a consultant re-opening Synthesis saw the finding list
     * reshuffle for no visible reason. */
    let best: WorkingCluster | null = null;
    let bestScore = 0;
    for (const c of clusters) {
      let s = 0;
      for (const e of c.entries) {
        if (!sameClaim(tokens, e.tokens)) continue;
        const v = claimSimilarity(tokens, e.tokens);
        if (v > s) s = v;
      }
      if (s > bestScore) { bestScore = s; best = c; }
    }
    const label = labelFor(f) || role;
    if (best) best.entries.push({ text, role, label, tokens });
    else clusters.push({ dimension: dim, entries: [{ text, role, label, tokens }] });
  }

  const finish = (c: WorkingCluster): FindingCluster => {
    // Deduped on the ATTRIBUTION LABEL, so two holders of one role count as
    // two sources and one person's two findings still count as one.
    const roles: string[] = [];
    for (const e of c.entries) if (roles.indexOf(e.label) === -1) roles.push(e.label);
    const texts: string[] = [];
    for (const e of [...c.entries].sort((a, b) => b.text.length - a.text.length)) {
      if (texts.indexOf(e.text) === -1) texts.push(e.text);
    }
    return {
      dimension: c.dimension,
      text: texts[0] ?? "",
      texts: texts.slice(0, MAX_TEXTS_PER_CLUSTER),
      roles,
      corroborated: roles.length >= 2,
    };
  };

  const corroborated: FindingCluster[] = [];
  const single: FindingCluster[] = [];
  const thematic: CorroborationResult["thematic"] = [];

  for (const dim of dimOrder) {
    const clusters = byDim.get(dim)!.map(finish);
    const conf = clusters.filter((c) => c.corroborated);
    const rest = clusters.filter((c) => !c.corroborated);
    corroborated.push(...conf);

    /* Thematic: several roles engaged with this dimension but on different
     * points. Only the un-corroborated remainder counts — if a claim is
     * already corroborated, saying "and separately the area came up" adds
     * nothing and would double-count the same roles. */
    const restRoles: string[] = [];
    for (const c of rest) for (const r of c.roles) if (restRoles.indexOf(r) === -1) restRoles.push(r);
    if (restRoles.length >= 2) thematic.push({ dimension: dim, roles: restRoles, clusters: rest });
    else single.push(...rest);
  }

  // Most-corroborated first, then dimension order, so the strongest evidence
  // leads whichever list a caller renders.
  corroborated.sort((a, b) => (b.roles.length - a.roles.length) || a.dimension.localeCompare(b.dimension));
  thematic.sort((a, b) => (b.roles.length - a.roles.length) || a.dimension.localeCompare(b.dimension));
  single.sort((a, b) => a.dimension.localeCompare(b.dimension));

  return { corroborated, thematic, single };
}
