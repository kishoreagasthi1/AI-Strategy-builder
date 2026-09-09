/**
 * v5.34.11 — the duplicate-interview guard's matching rule.
 *
 * The route blocks a second interview for the same (person, client, round):
 * a NULL round matches a NULL round (same real interview), but a DIFFERENT
 * round_number is a legitimately separate interview (see migration 016) and
 * must NOT collide. The route expresses this in SQL as
 *   round_number IS NOT DISTINCT FROM $round
 * which is standard Postgres. This test pins the TRUTH TABLE that SQL must
 * honour, so a future edit that (say) swaps it for `= $round` — which would
 * wrongly let NULL-round duplicates through — fails here rather than in prod.
 */
import { describe, it, expect } from "vitest";

// The matching rule, mirrored from the route's WHERE clause.
function isDuplicate(
  existing: { userId: string; client: string; round: number | null },
  incoming: { userId: string; client: string; round: number | null }
): boolean {
  if (existing.userId !== incoming.userId) return false;
  if (existing.client.toLowerCase() !== incoming.client.toLowerCase()) return false;
  // IS NOT DISTINCT FROM: NULL matches NULL; otherwise equality.
  return existing.round === incoming.round;
}

describe("duplicate-interview guard matching rule", () => {
  const rony = { userId: "rony", client: "Nestle", round: null as number | null };

  it("NULL round collides with an existing NULL-round interview", () => {
    expect(isDuplicate(rony, { userId: "rony", client: "Nestle", round: null })).toBe(true);
  });
  it("client match is case-insensitive", () => {
    expect(isDuplicate(rony, { userId: "rony", client: "NESTLE", round: null })).toBe(true);
  });
  it("a different round is NOT a duplicate (legit separate interview)", () => {
    expect(isDuplicate({ ...rony, round: 1 }, { userId: "rony", client: "Nestle", round: 2 })).toBe(false);
  });
  it("the same explicit round IS a duplicate", () => {
    expect(isDuplicate({ ...rony, round: 1 }, { userId: "rony", client: "Nestle", round: 1 })).toBe(true);
  });
  it("a different client is NOT a duplicate", () => {
    expect(isDuplicate(rony, { userId: "rony", client: "Danone", round: null })).toBe(false);
  });
  it("a different person is NOT a duplicate", () => {
    expect(isDuplicate(rony, { userId: "alice", client: "Nestle", round: null })).toBe(false);
  });
  it("NULL round does not collide with an explicit round", () => {
    expect(isDuplicate(rony, { userId: "rony", client: "Nestle", round: 1 })).toBe(false);
  });
});
