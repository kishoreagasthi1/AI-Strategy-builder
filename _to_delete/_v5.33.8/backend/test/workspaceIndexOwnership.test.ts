/**
 * Who is allowed to bind an engagement code to a client (audit V2-H4).
 *
 * v5.32.64. `vynora_engagement_index` maps {clientNorm: CODE}, and downstream
 * the CODE is the authorisation token: buildWorkspaceMaps turns the index into
 * codeToNorm[CODE] = norm, and every `vynora_*_<CODE>` key is then handed to
 * whoever codeToNorm names. v5.32.29 closed the case where the code already
 * belongs to a client the caller cannot see:
 *
 *   if (owner && !normSetHas(allowed, owner)) continue;
 *
 * The `owner &&` is the hole. When the code has no resolvable owner — an
 * orphan whose record was deleted, or a code invented by the caller — the
 * condition is false and control falls through to accepting the binding. An
 * authorisation guard that stops checking when it cannot identify the subject
 * is failing open.
 *
 * The audit also reported that the twin `vynora_code_index` has no ownership
 * check at all. The last test here exists to settle that rather than assume it:
 * that index is keyed by CODE, so an unknown code resolves to "UNKNOWN" and is
 * already refused by the norm check every entry passes through. It is guarded,
 * differently. Worth pinning either way, since "the twin was missed" is a real
 * pattern in this repo and the next person to read the guard will wonder.
 */
import { describe, it, expect } from "vitest";
import { scopeWorkspaceWrite } from "../src/auth/clients.js";

const ALLOWED = new Set(["myclient"]);

/** A server workspace where OTHERCO already owns OTHER-1. */
const CURRENT: Record<string, string> = {
  vynora_engagement_index: JSON.stringify({ otherco: "OTHER-1", myclient: "MINE-1" }),
  "vynora_engagement_OTHER-1": JSON.stringify({ code: "OTHER-1", client: "Other Co" }),
  "vynora_engagement_MINE-1": JSON.stringify({ code: "MINE-1", client: "My Client" }),
};

function write(sets: Record<string, string>) {
  return scopeWorkspaceWrite(sets, [], CURRENT, ALLOWED);
}

describe("engagement-index binding is deny-by-default (V2-H4)", () => {
  it("refuses binding a code that belongs to a client the caller cannot see", () => {
    // The v5.32.29 case, still closed.
    const out = write({ vynora_engagement_index: JSON.stringify({ myclient: "OTHER-1" }) });
    const idx = JSON.parse(out.sets.vynora_engagement_index);
    expect(idx.myclient).not.toBe("OTHER-1");
    expect(idx.otherco).toBe("OTHER-1");   // the server's entry is preserved
  });

  it("refuses binding a code with NO resolvable owner", () => {
    /* The hole. GHOST-9 exists nowhere: not in the server index, not as an
     * engagement record, and not in this payload. Before the fix `owner` was
     * undefined, the guard's `owner &&` short-circuited to false, and the
     * binding was written — pre-claiming a code the caller has shown no right
     * to, so that whatever later appears under it resolves to their client. */
    const out = write({ vynora_engagement_index: JSON.stringify({ myclient: "GHOST-9" }) });
    const idx = JSON.parse(out.sets.vynora_engagement_index);
    expect(idx.myclient).toBe("MINE-1");   // the caller's real binding survives
    expect(Object.values(idx)).not.toContain("GHOST-9");
  });

  it("STILL allows creating a new engagement when the record comes with it", () => {
    /* This is why the guard cannot simply refuse every unowned code: creating
     * an engagement writes the index entry and the record together, and the
     * record's own `client` field is what makes the code owned. Refusing this
     * would break engagement creation outright, which is a worse outcome than
     * the bug. */
    const out = write({
      vynora_engagement_index: JSON.stringify({ myclient: "NEW-7" }),
      "vynora_engagement_NEW-7": JSON.stringify({ code: "NEW-7", client: "My Client" }),
    });
    const idx = JSON.parse(out.sets.vynora_engagement_index);
    expect(idx.myclient).toBe("NEW-7");
    expect(out.sets["vynora_engagement_NEW-7"]).toBeTruthy();
  });

  it("refuses a new code whose accompanying record names ANOTHER client", () => {
    // The obvious way around the previous rule: bring a record, but claim it
    // for someone else. The record asserts the owner, so this must be refused.
    const out = write({
      vynora_engagement_index: JSON.stringify({ myclient: "NEW-8" }),
      "vynora_engagement_NEW-8": JSON.stringify({ code: "NEW-8", client: "Other Co" }),
    });
    const idx = JSON.parse(out.sets.vynora_engagement_index);
    expect(idx.myclient).not.toBe("NEW-8");
  });

  it("leaves other clients' index entries untouched throughout", () => {
    const out = write({ vynora_engagement_index: JSON.stringify({ myclient: "GHOST-9" }) });
    const idx = JSON.parse(out.sets.vynora_engagement_index);
    expect(idx.otherco).toBe("OTHER-1");
  });
});

describe("the vynora_code_index twin — settling what the audit reported", () => {
  it("already refuses an unknown code, via the norm check every entry passes", () => {
    /* Reported as "no ownership check at all". It is checked, differently:
     * this index is keyed by CODE, so the entry's norm is resolved from
     * codeToNorm/sessionToNorm and an unknown code resolves to "UNKNOWN",
     * which is never in `allowed`. Fail-closed already. */
    const out = scopeWorkspaceWrite(
      { vynora_code_index: JSON.stringify({ "GHOST-9": "sess-1" }) },
      [], CURRENT, ALLOWED
    );
    const idx = JSON.parse(out.sets.vynora_code_index ?? "{}");
    expect(idx["GHOST-9"]).toBeUndefined();
  });

  it("refuses a code belonging to a client the caller cannot see", () => {
    const out = scopeWorkspaceWrite(
      { vynora_code_index: JSON.stringify({ "OTHER-1": "sess-1" }) },
      [], CURRENT, ALLOWED
    );
    const idx = JSON.parse(out.sets.vynora_code_index ?? "{}");
    expect(idx["OTHER-1"]).toBeUndefined();
  });

  it("accepts a code the caller does own", () => {
    const out = scopeWorkspaceWrite(
      { vynora_code_index: JSON.stringify({ "MINE-1": "sess-9" }) },
      [], CURRENT, ALLOWED
    );
    const idx = JSON.parse(out.sets.vynora_code_index ?? "{}");
    expect(idx["MINE-1"]).toBe("sess-9");
  });
});
