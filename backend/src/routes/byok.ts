/**
 * Bring-your-own-key: the HTTP surface. (v5.34.55)
 *
 * Two scopes, deliberately separated, because the two halves of this flow have
 * completely different trust models.
 *
 *   byokRoutes(protectedScope)  — the CONSULTANT's side. Create a setup link,
 *                                 see status, turn a key off. Authenticated,
 *                                 owner-only, tenant-scoped by the usual hook.
 *
 *   byokPublicRoutes(app)       — the CLIENT's side. Their administrator has no
 *                                 account here and never will: the whole point
 *                                 of the link is that supplying a key must not
 *                                 require onboarding a person into someone
 *                                 else's consulting platform.
 *
 * ── Why the key never travels by email ──────────────────────────────────────
 *
 * Because a key pasted into a message lands in two inboxes, a mail server,
 * someone's phone and quite possibly a CRM — and it is the CLIENT's credential,
 * not the consultant's to route. The Owner sends a link; the client's admin
 * pastes the key into a form that posts straight here. The Owner sees the last
 * four characters and whether the checks passed, and never the value.
 *
 * ── What guards the public half ─────────────────────────────────────────────
 *
 * The token is 32 random bytes, stored only as a SHA-256 hash, single-use, and
 * expires. A database reader cannot mint a working link. The redemption route
 * looks the row up by hash BEFORE any tenant is known — which is exactly why
 * byok_invites is the one table not under row-level security, and why this
 * route must set the tenant from the ROW it found and never from anything the
 * caller sent.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { withTenant } from "../db/pool.js";
import { normClient } from "../auth/clients.js";
import { probeKey, keyIsUsable, type KeyProbe } from "../llm/byok/verifyKey.js";
import { putTenantKey, type SecretStoreOptions } from "../llm/byok/secretStore.js";
import {
  upsertActiveKey, listKeys, deactivateKey, reactivateKey, listOpenInvites, revokeInvite,
  type ByokProvider,
} from "../llm/byok/byokRepo.js";
import { listRouting, setRouting, clearRouting } from "../llm/byok/clientRouting.js";
import {
  listFallbackGrants, grantFallback, revokeFallback,
} from "../llm/byok/fallbackGrant.js";
import { auditLog } from "../audit/log.js";
import { engagementIdFor, byokClients } from "../llm/byok/engagementBinding.js";

const PROVIDERS = ["gemini-aistudio", "anthropic-api"] as const;
const INVITE_TTL_HOURS = 72;

/**
 * The client must EXIST before anything is attached to them. (v5.34.67)
 *
 * Every one of these forms used to take free text. The owner typed a client
 * name into the setup-link form, a consultant typed one into Pre-Engagement,
 * and the two were joined only by normClient() — so "Newell Brands" and
 * "Newell Brands Inc" produced a key that was stored, shown as active, and
 * never used, while the work quietly ran on the firm's credential.
 *
 * Requiring the engagement first is also the correct ORDER: the client comes
 * into existence once, server-side, with a minted code (migration 025), and a
 * credential attaches to that rather than to a string someone retypes.
 */
async function requireKnownClient(
  tenantId: string, clientName: string, reply: any
): Promise<boolean> {
  const id = await engagementIdFor(tenantId, clientName);
  if (id) return true;

  /*
   * v5.34.67, second pass. An engagement is not the only thing that makes a
   * client real here.
   *
   * The first version of this guard required one, full stop — and live testing
   * found what that costs within a minute: "ZZ BYOK Test" had an active key and
   * a fallback grant and no engagement row, so its key kept working while every
   * way to manage it disappeared. Refusing to let someone re-issue a grant for
   * a client who demonstrably already has one is a worse failure than the typo
   * this guard exists to catch, and the typo risk does not apply to a name that
   * is already on file.
   *
   * A brand-new unknown name is still refused, which is the whole point.
   */
  const known = (await byokClients(tenantId))
    .some((x) => normClient(x.clientName) === normClient(clientName));
  if (known) return true;

  reply.code(409).send({
    error: "no_such_client",
    detail:
      `There is no client called "${clientName}" yet. Create them first — ` +
      `Pre-Engagement, or assign the client to a consultant who will — then attach the key. ` +
      `Attaching to a name that does not exist yet produces a key that is stored, ` +
      `shows as active, and is never used.`,
  });
  return false;
}

/**
 * Vendor names as a consultant would say them (v5.34.64).
 *
 * The wire values leak into error messages otherwise, and "anthropic-api" in a
 * sentence explaining a billing consequence is the wrong register for the
 * person reading it — they are deciding who pays, not debugging a chain.
 */
const VENDOR_LABEL: Record<ByokProvider, string> = {
  "gemini-aistudio": "Google (Gemini)",
  "anthropic-api": "Anthropic (Claude)",
};

/**
 * The words the client's administrator agrees to.
 *
 * Deliberately says what is and is NOT checked. The probe cannot tell a billed
 * key from an unbilled one — measured, see verifyKey.ts — so this is the only
 * honest form: an attestation, described as one, by the person who actually
 * knows.
 */
export const ATTESTATION_TEXT: Record<ByokProvider, string> = {
  /*
   * v5.34.62: "the interview content" became "the content sent to it".
   *
   * The narrower wording was written when a client's Gemini key was expected to
   * serve voice interviews and little else. It now serves synthesis, strategy
   * decks, solution designs, the Design Studio artifacts and ordinary text —
   * because every production chain tries Gemini first. An attestation that
   * understates what the key will be used for is the one kind of inaccuracy
   * that matters here: it is the sentence the client's administrator agrees to,
   * and it is stored verbatim as the record of what they were told.
   */
  "gemini-aistudio":
    "I confirm this API key belongs to a Google Cloud project with billing enabled. " +
    "I understand this key will be used for our voice interviews and for the analysis, " +
    "documents and presentations generated from them, that this cannot be verified " +
    "automatically, and that on an unbilled (free tier) key Google may use the content " +
    "sent to it to improve its products.",
  "anthropic-api":
    "I confirm this API key belongs to our organisation's Anthropic account and " +
    "that we accept the usage charges it incurs.",
};

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

const CreateInvite = z.object({
  clientName: z.string().min(1).max(200),
  provider: z.enum(PROVIDERS),
  sentToEmail: z.string().email().max(320).optional(),
});

const Redeem = z.object({
  apiKey: z.string().min(8).max(500),
  attestedByEmail: z.string().email().max(320),
  paidTierAttested: z.literal(true),
});

export interface ByokDeps {
  secretStore: SecretStoreOptions;
  /** Overridable so tests never touch Google. */
  probe?: typeof probeKey;
  putKey?: typeof putTenantKey;
  appBaseUrl?: string;
}

/* ── the consultant's side ────────────────────────────────────────────────── */

export async function byokRoutes(app: FastifyInstance, deps: ByokDeps): Promise<void> {
  /** Only the Owner manages client credentials. */
  const ownerOnly = (req: any, reply: any): boolean => {
    if (req.ctx?.role !== "owner") { reply.code(403).send({ error: "forbidden" }); return false; }
    return true;
  };

  /**
   * The clients the key screens may act on (v5.34.67).
   *
   * Not /api/engagements: that lists only registered clients, and the three
   * pickers must also be able to reach a client who already has a key or a
   * grant without one — otherwise tightening what may be attached strands what
   * already is. See byokClients().
   */
  app.get("/api/byok/clients", async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    return { clients: await byokClients(req.ctx!.tenantId) };
  });

  app.get("/api/byok/keys", async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    return { keys: await listKeys(req.ctx!.tenantId) };
  });

  app.post("/api/byok/invites", async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const parsed = CreateInvite.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    const { clientName, provider, sentToEmail } = parsed.data;
    if (!(await requireKnownClient(req.ctx!.tenantId, clientName, reply))) return;

    // The token is returned ONCE, here, and never stored in a readable form.
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000);

    await withTenant(req.ctx!.tenantId, async (c) => {
      await c.query(
        `INSERT INTO byok_invites
           (tenant_id, client_norm, client_name, provider, token_hash, created_by,
            sent_to_email, expires_at)
         VALUES (current_setting('app.tenant_id', true)::uuid, $1, $2, $3, $4, $5, $6, $7)`,
        [normClient(clientName), clientName, provider, hashToken(token),
         req.ctx!.userId ?? null, sentToEmail ?? null, expires]
      );
    });

    const base = deps.appBaseUrl ?? "";
    return {
      url: `${base}/byok.html?t=${token}`,
      expiresAt: expires.toISOString(),
      clientName,
      provider,
      attestationText: ATTESTATION_TEXT[provider],
    };
  });

  /**
   * Setup links that are still live. (v5.34.61)
   *
   * There was no way to see these, which is also why there was no way to
   * withdraw one: a link sent to the wrong address stayed usable for 72 hours
   * and the Owner had nothing to act on. The TOKEN is never here — only its
   * hash is stored — so this shows what was issued and to whom, never
   * something that could be re-sent.
   */
  app.get("/api/byok/invites", async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    return { invites: await listOpenInvites(req.ctx!.tenantId) };
  });

  app.post("/api/byok/invites/revoke", async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const parsed = z.object({ id: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    const ok = await revokeInvite(req.ctx!.tenantId, parsed.data.id, req.ctx!.userId);
    if (!ok) {
      /*
       * Already used, already revoked, expired, or another firm's — one answer
       * for all of them, so this cannot be used to learn that someone else's
       * invite exists. Same reasoning as findInvite below.
       */
      reply.code(404).send({ error: "invite_not_open" });
      return;
    }
    return { ok: true };
  });

  /* ── a client's model preference (v5.34.63, BYOK slice 3) ───────────────── */

  app.get("/api/client-routing", async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    return { routing: await listRouting(req.ctx!.tenantId) };
  });

  app.post("/api/client-routing", async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const parsed = z.object({
      clientName: z.string().min(1).max(200),
      // Same two names as BYOK — one vocabulary from the screen to the router.
      textVendor: z.enum(PROVIDERS),
      note: z.string().max(500).optional(),
    }).safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }

    /*
     * v5.34.64. A client who supplies a key may only prefer a vendor they have
     * actually keyed.
     *
     * Without this check, `ZZ BYOK Test` — holding a GOOGLE key — could be set
     * to prefer Anthropic, and every document, deck and synthesis for them
     * moved onto the FIRM's Anthropic account while the panel stated in plain
     * words that a preference "never changes who pays". The confinement in
     * gateway.ts means such a preference can no longer move the money; it would
     * instead silently do nothing, which is its own kind of lie on a screen
     * that says the client's wish was saved. So it is refused here, with the
     * reason, at the moment someone tries to set it.
     *
     * A client with NO key is unaffected: they are on the firm's account by
     * arrangement, every vendor in the firm's policy is payable, and a
     * preference among them is exactly the feature v5.34.63 shipped.
     */
    const tenantId = req.ctx!.tenantId;
    if (!(await requireKnownClient(tenantId, parsed.data.clientName, reply))) return;
    const norm = normClient(parsed.data.clientName);
    const theirKeys = (await listKeys(tenantId))
      .filter((k) => k.clientNorm === norm && k.status === "active");
    if (theirKeys.length && !theirKeys.some((k) => k.provider === parsed.data.textVendor)) {
      const held = [...new Set(theirKeys.map((k) => VENDOR_LABEL[k.provider] ?? k.provider))];
      const want = VENDOR_LABEL[parsed.data.textVendor];
      /*
       * v5.34.66. This message used to end "…or grant fallback for this client
       * first", which was a remedy that does not exist: the check above looks
       * only at which keys are on file, and a grant changes nothing about it.
       * Verified in production on 2026-09-13 — granted fallback for ZZ BYOK
       * Test, retried the preference, got the identical refusal telling me to
       * grant fallback. A dead end that reads like a next step is worse than a
       * flat no, because someone will spend time on it.
       *
       * The grant and the preference answer different questions on purpose: a
       * grant says who pays when a key FAILS; a preference says which vendor
       * runs the work. Offering one as the way around the other conflated them
       * in the one sentence most likely to be read carefully.
       */
      reply.code(409).send({
        error: "vendor_not_keyed",
        detail:
          `${parsed.data.clientName} supplies their own ${held.join(" and ")} key, so their work runs on ` +
          `${held.length > 1 ? "those providers" : "that provider"} and is billed to them. ` +
          `Preferring ${want} would mean running their work on your account instead. ` +
          `To move them to ${want}, ask them for ${/^[AEIOU]/.test(want) ? "an" : "a"} ${want} key — ` +
          `a fallback grant does not change this, it only covers them when their own key fails.`,
      });
      return;
    }

    return {
      routing: await setRouting({
        tenantId,
        clientName: parsed.data.clientName,
        textVendor: parsed.data.textVendor,
        note: parsed.data.note,
        setBy: req.ctx!.userId,
        checkedAgainstKeys: true,
      }),
    };
  });

  /*
   * ── Fallback grant (v5.34.64) ─────────────────────────────────────────────
   *
   * Permission for the firm's credential to cover ONE client when that client's
   * own key cannot be spent. Off for everyone until turned on here. See
   * migration 036 for why this is per-client rather than a single switch.
   */
  app.get("/api/byok/fallback-grants", async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    return { grants: await listFallbackGrants(req.ctx!.tenantId) };
  });

  app.post("/api/byok/fallback-grants", async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const parsed = z.object({
      clientName: z.string().min(1).max(200),
      reason: z.string().max(500).optional(),
    }).safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    if (!(await requireKnownClient(req.ctx!.tenantId, parsed.data.clientName, reply))) return;
    const grant = await grantFallback({
      tenantId: req.ctx!.tenantId,
      clientName: parsed.data.clientName,
      reason: parsed.data.reason,
      grantedBy: req.ctx!.userId,
    });
    // Auditable: this is the firm agreeing to absorb a client's costs, which is
    // exactly the kind of decision someone will later need to account for.
    void auditLog(req.ctx!.tenantId, req.ctx!.userId, "byok_fallback_granted", {
      clientName: parsed.data.clientName, reason: parsed.data.reason ?? null,
    });
    return { grant };
  });

  app.post("/api/byok/fallback-grants/revoke", async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const parsed = z.object({ clientName: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    await revokeFallback(req.ctx!.tenantId, parsed.data.clientName);
    void auditLog(req.ctx!.tenantId, req.ctx!.userId, "byok_fallback_revoked", {
      clientName: parsed.data.clientName,
    });
    return { ok: true };
  });

  app.post("/api/client-routing/clear", async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const parsed = z.object({ clientName: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    // Absent is the same answer as "there was nothing to clear": the client
    // simply follows the firm's policy either way.
    await clearRouting(req.ctx!.tenantId, parsed.data.clientName);
    return { ok: true };
  });

  app.post("/api/byok/keys/enable", async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const parsed = z.object({
      clientName: z.string().min(1).max(200),
      provider: z.enum(PROVIDERS),
    }).safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    const out = await reactivateKey(req.ctx!.tenantId, parsed.data.clientName,
                                    parsed.data.provider, req.ctx!.userId);
    if (out === "not_disabled") {
      reply.code(409).send({
        error: "not_disabled",
        detail:
          `${parsed.data.clientName}'s key is not switched off. A key the provider REFUSED ` +
          `cannot be turned back on — it has to be replaced, with a new setup link, because ` +
          `re-enabling it would show "active" for a credential that fails on the next call.`,
      });
      return;
    }
    if (out === "no_secret") {
      reply.code(409).send({
        error: "no_secret",
        detail:
          `${parsed.data.clientName}'s key was never stored, so there is nothing to turn back on. ` +
          `Send them a new setup link.`,
      });
      return;
    }
    return { ok: true };
  });

  app.post("/api/byok/keys/disable", async (req, reply) => {
    if (!ownerOnly(req, reply)) return;
    const parsed = z.object({
      clientName: z.string().min(1).max(200),
      provider: z.enum(PROVIDERS),
    }).safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    await deactivateKey(req.ctx!.tenantId, parsed.data.clientName, parsed.data.provider,
                        "disabled", req.ctx!.userId, "disabled by the firm");
    return { ok: true };
  });
}

/* ── the client's side, unauthenticated ───────────────────────────────────── */

type InviteRow = {
  id: string; tenant_id: string; client_norm: string; client_name: string;
  provider: ByokProvider; expires_at: Date; used_at: Date | null; revoked_at: Date | null;
};

/**
 * Look an invite up by its token.
 *
 * Returns null for every failure — expired, already used, unknown — with the
 * SAME shape, so the endpoint cannot be used to learn which tokens exist.
 */
async function findInvite(app: FastifyInstance, token: string): Promise<InviteRow | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const hash = hashToken(token);
  // Not withTenant: no tenant is known yet — that is the whole point of the
  // link. byok_invites is not RLS-scoped for exactly this lookup, and nothing
  // else may be read on this connection before the tenant is set from the row.
  const pool = (app as any).pg ?? null;
  void pool;
  const { getPool } = await import("../db/pool.js");
  const r = await getPool().query<InviteRow>(
    `SELECT id, tenant_id, client_norm, client_name, provider, expires_at, used_at, revoked_at
       FROM byok_invites WHERE token_hash = $1`, [hash]);
  const row = r.rows[0];
  if (!row) return null;
  if (row.used_at) return null;
  // v5.34.61 — withdrawn by the firm. Same null as every other refusal, so the
  // holder of a cancelled link cannot tell it was cancelled rather than fake.
  if (row.revoked_at) return null;
  if (row.expires_at.getTime() < Date.now()) return null;
  // Constant-time compare on the hash, so a timing signal cannot be used to
  // walk a token byte by byte. Belt and braces over a SHA-256 lookup.
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(hashToken(token), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return row;
}

export async function byokPublicRoutes(app: FastifyInstance, deps: ByokDeps): Promise<void> {
  const probe = deps.probe ?? probeKey;
  const putKey = deps.putKey ?? putTenantKey;

  /** What the client's administrator sees before typing anything. */
  app.get("/api/byok/redeem/:token", async (req, reply) => {
    const invite = await findInvite(app, (req.params as any).token);
    if (!invite) { reply.code(404).send({ error: "invite_not_found_or_expired" }); return; }
    return {
      clientName: invite.client_name,
      provider: invite.provider,
      attestationText: ATTESTATION_TEXT[invite.provider],
      expiresAt: invite.expires_at.toISOString(),
    };
  });

  app.post("/api/byok/redeem/:token", async (req, reply) => {
    const invite = await findInvite(app, (req.params as any).token);
    if (!invite) { reply.code(404).send({ error: "invite_not_found_or_expired" }); return; }

    const parsed = Redeem.safeParse(req.body);
    if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    const { apiKey, attestedByEmail } = parsed.data;

    /*
     * Probe BEFORE storing — but ONLY a Google key, and only against Google.
     *
     * v5.34.57, from an external audit. This called probe() unconditionally,
     * above the provider check, and probeKey() sends the value to
     * generativelanguage.googleapis.com as `x-goog-api-key`. So every Anthropic
     * redemption transmitted the client's ANTHROPIC key to Google — a
     * third-party disclosure of the exact secret this feature exists to
     * protect — and then discarded the result.
     *
     * Worse than the bug: the comment below it asserted "Anthropic keys are not
     * probed by the Gemini prober", describing an intent the code did not
     * implement. A false comment stops the next reader from checking.
     *
     * The probe is a capability check and explicitly NOT a tier check — nothing
     * here can tell a billed key from an unbilled one.
     */
    let evidence: KeyProbe = {
      checkedAt: new Date().toISOString(),
      canGenerate: false, canMintLiveToken: false, modelCount: 0, hasNativeAudio: false,
      status: { generate: 0, models: 0, authTokens: 0 },
      error: "not probed — this provider has no pre-flight check",
    };

    if (invite.provider === "gemini-aistudio") {
      evidence = await probe(apiKey, {});
      const usable = keyIsUsable(evidence);
      if (!usable.usable) {
        /*
         * The reason, not the evidence. Echoing the full probe back gave the
         * invite holder a bounded oracle over a Google key's capabilities —
         * small, but free to remove.
         */
        reply.code(400).send({ error: "key_unusable", detail: usable.reason });
        return;
      }
    } else if (apiKey.length < 20) {
      reply.code(400).send({ error: "key_unusable", detail: "that does not look like an Anthropic key" });
      return;
    }

    /*
     * Storing is where this failed in production on 2026-09-13, and the way it
     * failed is the reason for this try/catch (v5.34.60).
     *
     * The service account could READ one secret and create none — so putKey
     * threw `byok: could not create the secret (HTTP 403)`, the error escaped
     * to the generic handler, and the client's administrator saw "Something
     * went wrong (500). Please try again" while the only description of the
     * actual cause sat in a Cloud Run log they have no access to. They retried,
     * correctly, and it failed again, because nothing about it was transient.
     *
     * Two things are wrong with that and both are fixed here. A person who has
     * just handed over a credential is owed an accurate account of what
     * happened to it — above all that it was NOT stored, so they know the state
     * they are in. And the FIRM is owed the technical reason, which is why the
     * detail is logged with the client's name attached rather than discarded.
     *
     * 502, not 500: the failure is downstream of this service, and the status
     * should say so.
     */
    let stored: { secretName: string; keyHint: string };
    try {
      // Per (tenant, client, provider) — see secretIdFor's header for what a
      // tenant-only secret id did to cross-client isolation.
      stored = await putKey(deps.secretStore, {
        tenantId: invite.tenant_id,
        clientNorm: invite.client_norm,
        provider: invite.provider,
      }, apiKey);
    } catch (err) {
      req.log.error(
        { err, clientName: invite.client_name, provider: invite.provider },
        "byok: the key passed verification but could NOT be stored — the client saw a failure and nothing was saved"
      );
      reply.code(502).send({
        error: "key_not_stored",
        detail:
          "Your key checked out, but we could not store it securely just now, so it has NOT been saved. " +
          "Nothing was kept and this link still works. Please tell your VYNE contact — this is a fault on our side, not with your key.",
      });
      return;
    }

    try {
      await upsertActiveKey({
        tenantId: invite.tenant_id,
        clientName: invite.client_name,
        provider: invite.provider,
        secretName: stored.secretName,
        keyHint: stored.keyHint,
        probe: evidence,
        attestedByEmail,
        attestationText: ATTESTATION_TEXT[invite.provider],
      });
    } catch (err) {
      /*
       * The secret IS stored but the row that points at it is not, so nothing
       * will ever read it. Say so rather than reporting success: a client told
       * "that's done" would reasonably believe their account is now paying.
       */
      req.log.error(
        { err, clientName: invite.client_name, provider: invite.provider },
        "byok: key stored in Secret Manager but the byok_keys row failed — the key is orphaned and unused"
      );
      reply.code(502).send({
        error: "key_not_activated",
        detail:
          "Your key was received but could not be activated, so it is not in use. " +
          "Please tell your VYNE contact before sending another one.",
      });
      return;
    }

    // Single use. Marked only after the key is safely stored, so a failure
    // part-way through leaves the link usable rather than stranding the client.
    await withTenant(invite.tenant_id, async (c) => {
      await c.query(`UPDATE byok_invites SET used_at = now() WHERE id = $1`, [invite.id]);
    });

    // Never echo the key, not even the hint the Owner sees.
    return { ok: true, clientName: invite.client_name, provider: invite.provider };
  });
}
