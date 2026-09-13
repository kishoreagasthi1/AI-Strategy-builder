/**
 * A client's stated model preference, applied inside the firm's policy.
 * (v5.34.63 — BYOK slice 3)
 *
 * ── The rule, in one line ───────────────────────────────────────────────────
 *
 * A preference REORDERS the vendors the firm's chain already contains. It never
 * adds one the firm excluded, never removes the fallback, and never changes
 * what happens for a client who has expressed no preference.
 *
 * ── Why not simply let the client choose ────────────────────────────────────
 *
 * Because the firm's name is on the deliverable. PROD_POLICY exists so that a
 * strategy deck is produced by a model the firm has actually looked at the
 * output of; a client moving that onto an unqualified provider would shift the
 * consequence without shifting the accountability. Reordering inside the
 * allowed set gives the client a real say — "we would rather our analysis ran
 * on Claude" is honoured wherever Claude is already an option — while the
 * boundary stays with whoever answers for the result.
 *
 * ── Why voice is absent ─────────────────────────────────────────────────────
 *
 * Live audio runs on Gemini because Gemini is the only provider here that does
 * bidiGenerateContent at all. "Claude for voice" is not a preference this
 * product can decline to honour; it is one it cannot implement. Offering it
 * would be a lie in a dropdown, so the preference covers only the tasks where a
 * choice genuinely exists.
 */
import { withTenant } from "../../db/pool.js";
import { normClient } from "../../auth/clients.js";
import { VENDOR_OF_ADAPTER } from "./resolve.js";
import type { ByokProvider } from "./byokRepo.js";

export interface ClientRouting {
  clientNorm: string;
  clientName: string;
  /** The vendor this client would rather have where a choice exists. */
  textVendor: ByokProvider;
  note: string | null;
  updatedAt: string;
}

type Row = {
  client_norm: string; client_name: string; text_vendor: ByokProvider;
  note: string | null; updated_at: Date;
};

const shape = (r: Row): ClientRouting => ({
  clientNorm: r.client_norm,
  clientName: r.client_name,
  textVendor: r.text_vendor,
  note: r.note,
  updatedAt: r.updated_at.toISOString(),
});

/** The preference for one client, or null when they have not stated one. */
export async function routingFor(
  tenantId: string,
  clientName: string | undefined
): Promise<ClientRouting | null> {
  if (!clientName) return null;          // unattributed work follows firm policy
  const norm = normClient(clientName);
  return withTenant(tenantId, async (c) => {
    const r = await c.query<Row>(
      `SELECT client_norm, client_name, text_vendor, note, updated_at
         FROM client_routing
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND client_norm = $1`,
      [norm]
    );
    return r.rows[0] ? shape(r.rows[0]) : null;
  });
}

/** Every preference on file, for the settings screen. */
export async function listRouting(tenantId: string): Promise<ClientRouting[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query<Row>(
      `SELECT client_norm, client_name, text_vendor, note, updated_at
         FROM client_routing
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
        ORDER BY client_name`
    );
    return r.rows.map(shape);
  });
}

/** Record (or change) what a client asked for. */
export async function setRouting(a: {
  tenantId: string; clientName: string; textVendor: ByokProvider;
  note?: string; setBy?: string;
}): Promise<ClientRouting> {
  const norm = normClient(a.clientName);
  return withTenant(a.tenantId, async (c) => {
    const r = await c.query<Row>(
      `INSERT INTO client_routing (tenant_id, client_norm, client_name, text_vendor, note, set_by)
       VALUES (current_setting('app.tenant_id', true)::uuid, $1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, client_norm) DO UPDATE SET
         client_name = EXCLUDED.client_name,
         text_vendor = EXCLUDED.text_vendor,
         note = EXCLUDED.note,
         set_by = EXCLUDED.set_by,
         updated_at = now()
       RETURNING client_norm, client_name, text_vendor, note, updated_at`,
      [norm, a.clientName, a.textVendor, a.note ?? null, a.setBy ?? null]
    );
    return shape(r.rows[0]);
  });
}

/** Remove a preference — the client goes back to the firm's own policy. */
export async function clearRouting(tenantId: string, clientName: string): Promise<boolean> {
  const norm = normClient(clientName);
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `DELETE FROM client_routing
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid AND client_norm = $1`,
      [norm]
    );
    return (r as { rowCount?: number }).rowCount === 1;
  });
}

/**
 * Reorder a chain so the preferred vendor's adapters come first — WITHOUT
 * adding or removing anything.
 *
 * A stable partition, not a sort: adapters for the preferred vendor keep their
 * relative order and move ahead of everything else, which keeps each vendor's
 * own fallback sequence intact (gemini-aistudio before gemini-aistudio-2, and
 * so on). Adapters with no vendor — `openai` — stay where the firm put them,
 * behind both, because a preference between Gemini and Claude says nothing
 * about them.
 *
 * The output is always a permutation of the input. That is the property that
 * makes this safe to apply to any chain: whatever the firm allowed is still
 * allowed, and nothing else ever becomes reachable.
 */
export function applyClientVendorPreference(
  chain: readonly string[],
  prefer: ByokProvider | null | undefined
): string[] {
  if (!prefer) return [...chain];
  const preferred: string[] = [];
  const rest: string[] = [];
  for (const name of chain) {
    (VENDOR_OF_ADAPTER[name] === prefer ? preferred : rest).push(name);
  }
  // Nothing for that vendor in this chain → the preference simply does not
  // apply to this task, and the firm's order stands untouched.
  return preferred.length ? [...preferred, ...rest] : [...chain];
}
