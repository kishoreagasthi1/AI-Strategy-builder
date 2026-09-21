/**
 * Types for dedupe-lib.mjs. (v5.34.122)
 *
 * The library is plain ESM so the migration script can run under bare node on
 * the deploy machine with no build step. Its test is TypeScript, and
 * `tsc -p tsconfig.test.json` is a gate in deploy.sh — the one added in
 * v5.34.69 after ~140 test files turned out never to have been typechecked by
 * anything. Without this file that gate fails on TS7016, which is the gate
 * doing its job.
 */
export declare const MIN_BLOCK: number;
export declare const MAX_PASSES: number;

/** role + NUL + trimmed text; the identity two copies of a message share. */
export declare function key(m: unknown): string;

/** Largest p >= MIN_BLOCK where items[0..p) equals items[p..2p); 0 if none. */
export declare function doubledPrefix(items: unknown[]): number;

export declare function dedupe<T>(items: T[]): {
  items: T[];
  removed: Array<{ from: number; to: number }>;
  passes: number;
};

/** oldIndex -> newIndex; a removed index resolves to its surviving twin. */
export declare function indexMap(
  original: unknown[],
  removed: Array<{ from: number; to: number }>,
): Map<number, number>;

/** Moves one `afterTurn` anchor; anything that is not a usable number is returned as-is. */
export declare function shiftAnchor<T>(afterTurn: T, map: Map<number, number>): T | number;

export declare function anchorsAtRisk(
  record: unknown,
  firstRemovedAt: number,
): Array<{ list: string; afterTurn: number }>;

/** Rewrites every `afterTurn` in one evidence list; non-arrays pass through. */
export declare function remapEvidence<T>(arr: T, map: Map<number, number>): T;

/** Is `b` still the transcript `a` was computed from? Compared on role+text. */
export declare function sameTranscript(a: unknown, b: unknown): boolean;

/** May this backed-up record be written over the row as it stands now? */
export declare function applyDecision(
  record: unknown,
  current: unknown,
): { write: boolean; reason: "gone" | "changed" | null };

export interface VerifiedAnchor {
  list: string;
  index: number;
  from: unknown;
  to: unknown;
  status: "same" | "same-line" | "moved" | "unverifiable";
  was: string | null;
  now: string | null;
}
export interface VerifiedRecord {
  client: string | null;
  stakeholder: string | null;
  where: string | null;
  before: number;
  after: number;
  doublings: number;
  collapsed: number;
  anchorsAtRisk: number;
  evidenceMissing: boolean;
  seam: Array<{ n: number; text: string }>;
  anchors: VerifiedAnchor[];
}
/** Replays the repair from a backup file; opens nothing and writes nothing. */
export declare function verifyBackup(
  backup: unknown,
  width?: number,
): { records: VerifiedRecord[]; checked: number; mismatches: number; evidenceMissing: number };

/** May this backup be applied? Re-runs verifyBackup as a precondition. */
export declare function applyPreflight(
  backup: unknown,
  remap: boolean,
): {
  ok: boolean;
  reason: "unreadable" | "empty" | "idx-gaps" | "evidence-missing" | "anchors-move" | null;
  report: ReturnType<typeof verifyBackup> | null;
};

/** The tables a backup's repair will write to, derived from its records. */
export declare function tablesToWrite(affected: unknown): string[];

export interface AccessRow {
  table: string;
  owner?: string;
  rls_enabled?: boolean;
  rls_forced?: boolean;
  can_select: boolean;
  can_update: boolean;
}
/** Can this role actually perform the repair? Reads a privilege report. */
export declare function accessVerdict(
  rows: unknown,
  needed: string[],
): { ok: boolean; problems: Array<{ table: string; missing: string }> };

/** Swaps the role in a DSN, keeping host, port and database. */
export declare function withOwner(
  dsn: string | undefined,
  user: string | undefined,
  password?: string,
): { dsn: string | undefined; swapped: boolean; was?: string; now?: string };

/** Turns a verified backup into a migration in the shape 026 established. */
export declare function emitMigration(
  backup: unknown,
  opts?: { number?: string; name?: string; remap?: boolean },
): {
  ok: boolean;
  reason: string | null;
  sql: string | null;
  report: ReturnType<typeof verifyBackup> | null;
  tables?: string[];
};

/** The turn an anchor attaches to on the review page: by idx, else by position. */
export interface StoredTurn { text?: string; idx?: number | null; [k: string]: unknown }
export declare function pageTurn(turns: unknown, afterTurn: unknown): StoredTurn | undefined;
/** Sets idx to position on turns that carry one; leaves others alone. */
export declare function renumberIdx<T>(fixed: T): T;
/** True when every turn's idx (where present) equals its position. */
export declare function idxMatchesPosition(turns: unknown): boolean;
/** The transcript exactly as the repair will write it. */
export declare function fixedForWrite(a: unknown): unknown[];

/** Is A the frozen first-fragment copy of B (same speaker, prefix, timed then untimed)? */
export declare function isFrozenFragment(A: unknown, B: unknown): boolean;
export declare function collapseFragments<T>(items: T[]): {
  items: T[]; removed: Array<{ from: number; to: number; kind: "fragment" }>; collapsed: number;
};
/** Resume doubling first, then fragment copies — the order the defects compose. */
export declare function repair<T>(items: T[]): {
  items: T[]; removed: Array<{ from: number; to: number; kind?: string }>; passes: number; collapsed: number;
};
export declare function anchorsThatMove(record: unknown, map: Map<number, number>): Array<{ list: string; afterTurn: number }>;
export declare function nextMigrationNumber(files: unknown): string;

/** Rewrites a unix-socket DSN to point at the local cloud-sql-proxy. */
export declare function resolveDsn(
  raw: string | undefined,
  proxyPort?: number,
): { dsn: string | undefined; rewritten: boolean; was?: string };

/** The DSN with its password masked, safe to print. */
export declare function redactDsn(dsn: string): string;
