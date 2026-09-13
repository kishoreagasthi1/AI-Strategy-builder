/**
 * A client's model preference, and the boundary it cannot cross. (v5.34.63)
 *
 * The chosen rule: a preference REORDERS the vendors the firm's chain already
 * contains. It cannot introduce one the firm excluded, cannot remove the
 * fallback, and changes nothing for a client who has not expressed one.
 *
 * The property worth testing hardest is the boundary, because the failure is
 * silent: a preference that quietly widened the allowed set would route a
 * client deliverable through a model the firm never qualified, and the only
 * symptom would be output that reads a bit differently.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import {
  applyClientVendorPreference, routingFor, setRouting, listRouting, clearRouting,
} from "../src/llm/byok/clientRouting.js";
import { applyByokToChain } from "../src/llm/byok/resolve.js";
import { PROD_POLICY, DEV_POLICY, chainForTask } from "../src/llm/router.js";
import { LlmGateway, type MeterEvent } from "../src/llm/gateway.js";
import type { ProviderAdapter, GenerateRequest } from "../src/llm/types.js";

const REQ: GenerateRequest = { task: "strategy_deck", messages: [{ role: "user", content: "x" }] };

function adapter(name: string): ProviderAdapter {
  return {
    name, model: `${name}-model`, freeTier: false, isConfigured: () => true,
    async generate() {
      return { text: name, model: `${name}-model`, usage: { tokensIn: 1, tokensOut: 1, costEstUsd: 0 } };
    },
  };
}

describe("applyClientVendorPreference", () => {
  it("moves the preferred vendor to the front of the firm's chain", () => {
    const out = applyClientVendorPreference(["gemini-vertex", "anthropic-vertex"], "anthropic-api");
    expect(out).toEqual(["anthropic-vertex", "gemini-vertex"]);
  });

  it("leaves the chain alone when no preference is stated", () => {
    const chain = ["gemini-vertex", "anthropic-vertex"];
    expect(applyClientVendorPreference(chain, null)).toEqual(chain);
    expect(applyClientVendorPreference(chain, undefined)).toEqual(chain);
  });

  it("does nothing when the preferred vendor is not in this chain at all", () => {
    /*
     * The boundary. A client preferring Claude on a task the firm routes only
     * to Gemini gets the firm's chain unchanged — not Claude appended, which
     * would be the firm's policy quietly widened by a client's request.
     */
    const out = applyClientVendorPreference(["gemini-vertex"], "anthropic-api");
    expect(out).toEqual(["gemini-vertex"]);
  });

  it("keeps each vendor's own fallback order intact", () => {
    // gemini-aistudio before gemini-aistudio-2 is deliberate (separate quota
    // pool, different model). A preference must not scramble that.
    const out = applyClientVendorPreference(
      ["anthropic-vertex", "gemini-aistudio", "gemini-aistudio-2"], "gemini-aistudio");
    expect(out).toEqual(["gemini-aistudio", "gemini-aistudio-2", "anthropic-vertex"]);
  });

  it("is ALWAYS a permutation — never adds, never drops", () => {
    /*
     * The one guarantee the whole design rests on: whatever the firm allowed is
     * still allowed, nothing else becomes reachable, nothing silently
     * disappears. A handful of hand-picked chains would only ever check the
     * ones I thought of, so this enumerates EVERY non-empty subset of the
     * adapter names against both preferences — 126 cases, exhaustive and
     * deterministic.
     *
     * Done with plain arithmetic rather than a property-testing library on
     * purpose: adding a dependency for one test is what broke a consultant's
     * checkout at v5.34.58, and at this size exhaustive beats random anyway.
     */
    const names = ["gemini-vertex", "anthropic-vertex", "gemini-aistudio",
                   "gemini-aistudio-2", "anthropic-api", "openai"];
    const prefs = ["gemini-aistudio", "anthropic-api"] as const;
    let checked = 0;
    for (let mask = 1; mask < (1 << names.length); mask++) {
      const chain = names.filter((_, i) => mask & (1 << i));
      for (const prefer of prefs) {
        const out = applyClientVendorPreference(chain, prefer);
        expect([...out].sort(), `chain ${chain.join(",")} preferring ${prefer}`)
          .toEqual([...chain].sort());
        checked++;
      }
    }
    expect(checked).toBe(126);
  });

  it("never promotes openai, which no preference speaks for", () => {
    const out = applyClientVendorPreference(["gemini-vertex", "openai"], "anthropic-api");
    expect(out).toEqual(["gemini-vertex", "openai"]);
  });
});

describe("preference and BYOK compose in the right order", () => {
  it("preference picks the vendor; the key decides who pays", () => {
    /*
     * A client who prefers Claude AND brought an Anthropic key, on the
     * production chain. Expected: Claude first because they asked, their own
     * credential ahead of the firm's because they supplied one, and the firm's
     * Gemini still behind as the fallback the policy provides.
     */
    const firm = chainForTask(PROD_POLICY, "strategy_deck");
    const preferred = applyClientVendorPreference(firm, "anthropic-api");
    const final = applyByokToChain(preferred, new Set(["anthropic-api"]));
    expect(final).toEqual(["anthropic-api", "anthropic-vertex", "gemini-vertex"]);
  });

  it("a preference alone never moves work onto the client's account", () => {
    // No key supplied: the vendor changes, the payer does not.
    const final = applyByokToChain(
      applyClientVendorPreference(chainForTask(PROD_POLICY, "synthesis"), "anthropic-api"),
      new Set()
    );
    expect(final).toEqual(["anthropic-vertex", "gemini-vertex"]);
  });

  it("a key alone never changes which vendor is preferred", () => {
    const final = applyByokToChain(
      applyClientVendorPreference(chainForTask(PROD_POLICY, "synthesis"), null),
      new Set(["gemini-aistudio", "gemini-aistudio-2"])
    );
    expect(final[0]).toBe("gemini-aistudio");
    expect(final).toContain("anthropic-vertex");
  });

  it("works on the dev policy too, where Claude already leads", () => {
    const firm = chainForTask(DEV_POLICY, "synthesis");
    expect(firm[0]).toBe("anthropic-vertex");
    // Preferring Gemini reorders; preferring Claude is a no-op.
    expect(applyClientVendorPreference(firm, "gemini-aistudio")[0]).toBe("gemini-vertex");
    expect(applyClientVendorPreference(firm, "anthropic-api")).toEqual(firm);
  });
});

describe("the gateway honours a stated preference", () => {
  it("routes a deck to Claude for a client who asked for it", async () => {
    const events: MeterEvent[] = [];
    const gw = new LlmGateway({
      adapters: [adapter("gemini-vertex"), adapter("anthropic-vertex")],
      policy: PROD_POLICY,
      meter: async (e) => { events.push(e); },
      blockFreeTier: true,
      clientRouting: async ({ clientName }) => (clientName === "Nestle" ? "anthropic-api" : null),
    });

    const asked = await gw.generate({ tenantId: "t", userId: "u", module: "m", clientName: "Nestle" }, REQ);
    expect(asked.provider).toBe("anthropic-vertex");

    const notAsked = await gw.generate({ tenantId: "t", userId: "u", module: "m", clientName: "Humana" }, REQ);
    expect(notAsked.provider).toBe("gemini-vertex");   // firm policy, untouched
  });

  it("serves the call on firm policy when the preference lookup fails", async () => {
    const gw = new LlmGateway({
      adapters: [adapter("gemini-vertex"), adapter("anthropic-vertex")],
      policy: PROD_POLICY,
      meter: async () => {},
      blockFreeTier: true,
      clientRouting: async () => { throw new Error("database unavailable"); },
    });
    const res = await gw.generate({ tenantId: "t", userId: "u", module: "m", clientName: "Nestle" }, REQ);
    expect(res.provider).toBe("gemini-vertex");
  });

  it("behaves exactly as before when nothing is wired", async () => {
    const gw = new LlmGateway({
      adapters: [adapter("gemini-vertex"), adapter("anthropic-vertex")],
      policy: PROD_POLICY, meter: async () => {}, blockFreeTier: true,
    });
    const res = await gw.generate({ tenantId: "t", userId: "u", module: "m", clientName: "Nestle" }, REQ);
    expect(res.provider).toBe("gemini-vertex");
  });
});

/* ── storage ──────────────────────────────────────────────────────────────── */

const ENABLED = process.env.RLS_TEST === "1";
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5432/vyne";

describe.skipIf(!ENABLED)("client_routing storage", () => {
  let db: pg.Client;
  let tenant: string;
  let other: string;

  beforeAll(async () => {
    await migrate(ADMIN_URL);
    initPool(ADMIN_URL);
    db = new pg.Client({ connectionString: ADMIN_URL });
    await db.connect();
    tenant = (await db.query(`INSERT INTO tenants (name) VALUES ('Routing Firm') RETURNING id`)).rows[0].id;
    other = (await db.query(`INSERT INTO tenants (name) VALUES ('Other Routing Firm') RETURNING id`)).rows[0].id;
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant]);
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM client_routing WHERE tenant_id = ANY($1::uuid[])`, [[tenant, other]]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM client_routing WHERE tenant_id = ANY($1::uuid[])`, [[tenant, other]]);
    await db.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [[tenant, other]]);
    await db.end();
    await closePool();
  });

  it("a client with no preference resolves to null", async () => {
    expect(await routingFor(tenant, "Nestle")).toBeNull();
  });

  it("unattributed work never carries a preference", async () => {
    await setRouting({ tenantId: tenant, clientName: "Nestle", textVendor: "anthropic-api" });
    expect(await routingFor(tenant, undefined)).toBeNull();
  });

  it("stores, updates in place, and clears", async () => {
    await setRouting({ tenantId: tenant, clientName: "Nestlé", textVendor: "anthropic-api", note: "their CTO asked" });
    expect((await routingFor(tenant, "Nestlé"))?.textVendor).toBe("anthropic-api");

    await setRouting({ tenantId: tenant, clientName: "Nestlé", textVendor: "gemini-aistudio" });
    expect((await routingFor(tenant, "Nestlé"))?.textVendor).toBe("gemini-aistudio");
    expect(await listRouting(tenant)).toHaveLength(1);          // updated, not duplicated

    expect(await clearRouting(tenant, "Nestlé")).toBe(true);
    expect(await routingFor(tenant, "Nestlé")).toBeNull();
  });

  it("matches the same client whatever the case and spacing", async () => {
    // client_norm, the grain every other per-client fact uses.
    await setRouting({ tenantId: tenant, clientName: "Acme Corp", textVendor: "anthropic-api" });
    for (const typed of ["ACME CORP", "acme corp", "  AcmeCorp  ", "Acme-Corp"]) {
      expect((await routingFor(tenant, typed))?.textVendor, typed).toBe("anthropic-api");
    }
  });

  it("an ACCENT makes it a different client — product-wide, and worth knowing", async () => {
    /*
     * normClient strips everything outside [a-z0-9], so "Nestlé" normalises to
     * "nestl" and "Nestle" to "nestle". They are different clients here, and
     * equally different in usage_events, byok_keys and client_assignments —
     * this is not a property of routing, it is the grain the whole product
     * uses.
     *
     * Pinned rather than fixed: changing the normalisation would reshuffle
     * every client_norm already stored. Recorded so the next person to be
     * surprised by it finds the answer instead of the surprise.
     */
    await setRouting({ tenantId: tenant, clientName: "Nestlé", textVendor: "anthropic-api" });
    expect(await routingFor(tenant, "Nestle")).toBeNull();
    expect((await routingFor(tenant, "nestlé"))?.textVendor).toBe("anthropic-api");
  });

  it("the database refuses a vendor the router does not know", async () => {
    await expect(setRouting({
      tenantId: tenant, clientName: "Nestle", textVendor: "openai" as never,
    })).rejects.toThrow();
  });

  it("one firm's preference is invisible to another", async () => {
    await setRouting({ tenantId: other, clientName: "Nestle", textVendor: "anthropic-api" });
    expect(await routingFor(tenant, "Nestle")).toBeNull();
    expect(await listRouting(tenant)).toHaveLength(0);
  });
});
