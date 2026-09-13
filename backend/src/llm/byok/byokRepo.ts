/**
 * Which credential pays for THIS client's work. (v5.34.53)
 *
 * ── Three states, not two ───────────────────────────────────────────────────
 *
 * For any (client, provider) pair:
 *
 *   · an ACTIVE key      — the client's own credential pays, and the charge
 *                          lands on their Google or Anthropic bill directly;
 *   · no row, or not active — the platform credential pays, the call is
 *                          metered to this client in usage_events, and it goes
 *                          on the invoice the firm sends them;
 *   · pending / failed   — a key was started or has stopped working. Treated
 *                          exactly as "no row": the interview must not fail
 *                          because a client's key expired.
 *
 * The second state is the realistic one. Supplying a key means a Google Cloud
 * account with billing enabled, and a client running a free pilot is not
 * opening one. BYOK is for the enterprise that insists its data runs on its own
 * tenancy; cost recovery through usage_events is for everyone else, and that
 * path already works — every row carries client_norm and cost_est_usd, and
 * /api/billing/statement totals per client.
 *
 * ── Per provider, because a client can mix vendors ──────────────────────────
 *
 * "Gemini for the voice interviews, Claude for the strategy deck" is a
 * reasonable ask, and those are different vendors with different credentials.
 * So a client may bring a Google key and not an Anthropic one; the Anthropic
 * work then runs on the platform key and goes on their invoice. Nothing here
 * assumes a client is all-in or all-out.
 */
import { withTenant } from "../../db/pool.js";
import { normClient } from "../../auth/clients.js";
import type { KeyProbe } from "./verifyKey.js";

export type ByokProvider = "gemini-aistudio" | "anthropic-api";
export type ByokStatus = "pending" | "active" | "disabled" | "failed";

export interface ByokKeyRow {
  clientNorm: string;
  clientName: string;
  provider: ByokProvider;
  status: ByokStatus;
  secretName: string | null;
  keyHint: string | null;
  verifiedAt: string | null;
  paidTierAttested: boolean;
  attestedByEmail: string | null;
  attestedAt: string | null;
  probe: KeyProbe | null;
  /**
   * Why the last attempt to USE this key failed, if it did (v5.34.61).
   *
   * Separate from `status` on purpose. `status` is administrative — a key was
   * supplied and attested. This is operational — did it work when we last
   * reached for it. On 2026-09-13 those two disagreed for several minutes and
   * only the first was on screen; see migration 033.
   */
  lastError: string | null;
  lastErrorAt: string | null;
}

type Row = {
  client_norm: string; client_name: string; provider: ByokProvider; status: ByokStatus;
  secret_name: string | null; key_hint: string | null; verified_at: Date | null;
  paid_tier_attested: boolean; attested_by_email: string | null; attested_at: Date | null;
  probe: KeyProbe | null; last_error: string | null; last_error_at: Date | null;
};

const SELECT = `SELECT client_norm, client_name, provider, status, secret_name, key_hint,
                       verified_at, paid_tier_attested, attested_by_email, attested_at, probe,
                       last_error, last_error_at
                  FROM byok_keys`;

const shape = (r: Row): ByokKeyRow => ({
  clientNorm: r.client_norm,
  clientName: r.client_name,
  provider: r.provider,
  status: r.status,
  secretName: r.secret_name,
  keyHint: r.key_hint,
  verifiedAt: r.verified_at ? r.verified_at.toISOString() : null,
  paidTierAttested: r.paid_tier_attested,
  attestedByEmail: r.attested_by_email,
  attestedAt: r.attested_at ? r.attested_at.toISOString() : null,
  probe: r.probe,
  lastError: r.last_error,
  lastErrorAt: r.last_error_at ? r.last_error_at.toISOString() : null,
});

/**
 * The credential that should serve this client for this provider, or null to
 * mean "use the platform's and put it on their invoice".
 *
 * Only an ACTIVE row counts. A pending, failed or disabled key falls back
 * rather than failing the call — a client whose key lapsed should still be
 * interviewable, and the firm eats that cost until someone fixes it, which is
 * the right way round.
 */
export async function activeKeyFor(
  tenantId: string,
  clientName: string | undefined,
  provider: ByokProvider
): Promise<ByokKeyRow | null> {
  if (!clientName) return null;                 // unattributed work is the firm's
  const norm = normClient(clientName);
  return withTenant(tenantId, async (c) => {
    const r = await c.query<Row>(
      `${SELECT} WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
                   AND client_norm = $1 AND provider = $2 AND status = 'active'`,
      [norm, provider]
    );
    return r.rows[0] ? shape(r.rows[0]) : null;
  });
}

/**
 * Record that a key on file could not be USED, and why. (v5.34.61)
 *
 * ── Why this writes only on a change of state ───────────────────────────────
 *
 * This is called from the request path, where a database write per generation
 * would be a real cost for bookkeeping. So:
 *
 *   · a failure writes only if the recorded reason has CHANGED — a key that
 *     has been unreadable for an hour writes once, not once per call;
 *   · a success writes only if there was a failure recorded to clear.
 *
 * In the ordinary case — a key that works — this does nothing at all.
 *
 * Never throws. A failure to record a failure must not become a failure of the
 * interview; the log line in server.ts is the backstop.
 */
export async function recordResolveError(
  tenantId: string,
  clientNorm: string,
  provider: ByokProvider,
  reason: string
): Promise<void> {
  try {
    const short = reason.slice(0, 300);
    await withTenant(tenantId, async (c) => {
      await c.query(
        `UPDATE byok_keys
            SET last_error = $3, last_error_at = now(), updated_at = now()
          WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
            AND client_norm = $1 AND provider = $2
            AND last_error IS DISTINCT FROM $3`,
        [clientNorm, provider, short]
      );
    });
  } catch { /* bookkeeping must never break the call it describes */ }
}

/** The key worked. Clear any recorded failure — and only then write. */
export async function clearResolveError(
  tenantId: string,
  clientNorm: string,
  provider: ByokProvider
): Promise<void> {
  try {
    await withTenant(tenantId, async (c) => {
      await c.query(
        `UPDATE byok_keys
            SET last_error = NULL, last_error_at = NULL, updated_at = now()
          WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
            AND client_norm = $1 AND provider = $2
            AND last_error IS NOT NULL`,
        [clientNorm, provider]
      );
    });
  } catch { /* as above */ }
}

/* ── the one-time setup links ─────────────────────────────────────────────── */

export interface ByokInviteRow {
  id: string;
  clientName: string;
  provider: ByokProvider;
  sentToEmail: string | null;
  expiresAt: string;
  createdAt: string;
}

/**
 * Setup links still worth showing: not used, not revoked, not expired.
 *
 * The TOKEN is not here and cannot be — only its hash is stored, which is the
 * point (see migration 031). So this lists what was sent and to whom, never a
 * link that could be re-sent. A lost link is replaced by issuing a new one.
 */
export async function listOpenInvites(tenantId: string): Promise<ByokInviteRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query<{
      id: string; client_name: string; provider: ByokProvider;
      sent_to_email: string | null; expires_at: Date; created_at: Date;
    }>(
      `SELECT id, client_name, provider, sent_to_email, expires_at, created_at
         FROM byok_invites
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 100`
    );
    return r.rows.map((x) => ({
      id: x.id,
      clientName: x.client_name,
      provider: x.provider,
      sentToEmail: x.sent_to_email,
      expiresAt: x.expires_at.toISOString(),
      createdAt: x.created_at.toISOString(),
    }));
  });
}

/**
 * Withdraw a setup link before it is used.
 *
 * Marked rather than deleted: who cancelled which link, and when, is the kind
 * of thing an audit asks about a credential-handling flow. Returns false when
 * the id is not this tenant's, or the link is already used or revoked — so a
 * caller cannot use this to discover that someone else's invite exists.
 */
export async function revokeInvite(
  tenantId: string,
  inviteId: string,
  actorUserId?: string
): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `UPDATE byok_invites
          SET revoked_at = now(), revoked_by = $2
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [inviteId, actorUserId ?? null]
    );
    return (r as { rowCount?: number }).rowCount === 1;
  });
}

/** Everything the firm has on file, for the settings screen. Never the key. */
export async function listKeys(tenantId: string): Promise<ByokKeyRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query<Row>(
      `${SELECT} WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
        ORDER BY client_name, provider`
    );
    return r.rows.map(shape);
  });
}

export interface UpsertArgs {
  tenantId: string;
  clientName: string;
  provider: ByokProvider;
  secretName: string;
  keyHint: string;
  probe: KeyProbe;
  /** The CLIENT's administrator — not the consultant. See the migration. */
  attestedByEmail: string;
  attestationText: string;
  createdBy?: string;
}

/**
 * Record a key the client has just supplied, and activate it.
 *
 * The attestation travels with the key rather than being a separate step,
 * because the database refuses an active key without one
 * (byok_key_active_requires_attestation) — so there is no ordering in which a
 * key is live and unattested, whatever a caller does.
 */
export async function upsertActiveKey(a: UpsertArgs): Promise<ByokKeyRow> {
  const norm = normClient(a.clientName);
  return withTenant(a.tenantId, async (c) => {
    const r = await c.query<Row>(
      `INSERT INTO byok_keys
         (tenant_id, client_norm, client_name, provider, secret_name, key_hint,
          status, probe, verified_at, paid_tier_attested, attested_by_email,
          attested_at, attestation_text, created_by)
       VALUES (current_setting('app.tenant_id', true)::uuid, $1, $2, $3, $4, $5,
               'active', $6, now(), true, $7, now(), $8, $9)
       ON CONFLICT (tenant_id, client_norm, provider) DO UPDATE SET
         client_name = EXCLUDED.client_name,
         secret_name = EXCLUDED.secret_name,
         key_hint = EXCLUDED.key_hint,
         status = 'active',
         probe = EXCLUDED.probe,
         verified_at = now(),
         paid_tier_attested = true,
         attested_by_email = EXCLUDED.attested_by_email,
         attested_at = now(),
         attestation_text = EXCLUDED.attestation_text,
         updated_at = now()
       RETURNING client_norm, client_name, provider, status, secret_name, key_hint,
                 verified_at, paid_tier_attested, attested_by_email, attested_at, probe`,
      [norm, a.clientName, a.provider, a.secretName, a.keyHint, JSON.stringify(a.probe),
       a.attestedByEmail, a.attestationText, a.createdBy ?? null]
    );
    await audit(c, a.tenantId, norm, a.clientName, a.provider, "attached", a.createdBy, {
      keyHint: a.keyHint, attestedByEmail: a.attestedByEmail, probe: a.probe,
      attestationText: a.attestationText,
    });
    return shape(r.rows[0]);
  });
}

/**
 * Stop using a client's key. Work falls back to the platform credential and
 * onto their invoice, which is why this never needs an attestation and must
 * never be blocked by one.
 */
export async function deactivateKey(
  tenantId: string,
  clientName: string,
  provider: ByokProvider,
  reason: "disabled" | "failed",
  actorUserId?: string,
  note?: string
): Promise<void> {
  const norm = normClient(clientName);
  await withTenant(tenantId, async (c) => {
    await c.query(
      `UPDATE byok_keys SET status = $3, updated_at = now()
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND client_norm = $1 AND provider = $2`,
      [norm, provider, reason]
    );
    await audit(c, tenantId, norm, clientName, provider,
                reason === "failed" ? "verify_failed" : "disabled", actorUserId, { note });
  });
}

type PoolClientLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

/** byok_events is INSERT-only for the app role — an editable trail is not one. */
async function audit(
  c: PoolClientLike, tenantId: string, clientNorm: string, clientName: string,
  provider: string, action: string, actorUserId: string | undefined,
  extra: { keyHint?: string; attestedByEmail?: string; probe?: KeyProbe; attestationText?: string; note?: string }
): Promise<void> {
  await c.query(
    `INSERT INTO byok_events
       (tenant_id, client_norm, client_name, actor_user_id, action, provider,
        key_hint, paid_tier_attested, attestation_text, probe, note)
     VALUES (current_setting('app.tenant_id', true)::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [clientNorm, clientName, actorUserId ?? null, action, provider,
     extra.keyHint ?? null, extra.attestedByEmail ? true : null,
     extra.attestationText ?? null, extra.probe ? JSON.stringify(extra.probe) : null,
     extra.note ?? (extra.attestedByEmail ? `attested by ${extra.attestedByEmail}` : null)]
  );
  void tenantId;
}
