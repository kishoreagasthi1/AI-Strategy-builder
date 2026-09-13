/**
 * Voice endpoints — the natural-speech upgrade for the Interview Agent.
 *
 *   POST /api/voice/tts         { text, voice? } → { audioBase64, mime }
 *   POST /api/voice/transcribe  { audioBase64, mimeType, module? } → { text }
 *
 * Both are authenticated (all roles — interviewees are the primary users)
 * and metered into usage_events like every other AI call. Transcription
 * rides the normal gateway (Gemini reads audio natively), so fallback
 * chains and free-tier policy apply automatically.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LlmGateway } from "../llm/gateway.js";
import { GatewayError, redactProviderDetail } from "../llm/gateway.js";
import type { Tts } from "../llm/tts.js";
import type { Meter } from "../llm/gateway.js";
import { resolveBillingClient } from "../llm/attribution.js";
import { randomUUID } from "node:crypto";
import { estimateCost } from "../llm/types.js";
import { admitLiveSession } from "../llm/metering.js";
import { withTenant } from "../db/pool.js";
import {
  reconcileSession, findOpenHold, MAX_SESSION_SECONDS, DEFAULT_SESSION_SECONDS,
  TASK_HOLD, TASK_HOLD_RELEASE, VOICES,
  type LiveSession,
} from "../llm/liveSession.js";
import { buildInterviewerInstruction, MAX_CONTEXT_CHARS } from "../llm/interviewerPersona.js";
import { isCredentialRejection } from "../llm/byok/resolve.js";
import type { ByokLiveBinding } from "../llm/byok/resolveLive.js";
import type { Payer } from "../llm/gateway.js";

/**
 * One user should not hold many live grants at once — see route.
 *
 * v5.32.42: env-tunable, because this is a NUISANCE guard and it locked a real
 * user out of their own product. The actual spend control is the reservation
 * (llm/liveSession.ts), which is charged up front and is unaffected by this
 * number. Treat this as "stop a runaway tab", not as the budget.
 */
export const MAX_CONCURRENT_SESSIONS_PER_USER =
  Number(process.env.VYNE_LIVE_MAX_CONCURRENT || 3);

/**
 * How far back an unrefunded reservation still counts as an "open" session.
 *
 * This was MAX_SESSION_SECONDS (45 minutes), which is wrong in practice. A
 * reservation goes unrefunded whenever a session fails to close cleanly — a
 * crashed tab, a network drop, or (as observed) a close call that 401s because
 * the browser session expired mid-test. Each of those then blocked the user for
 * a further 45 minutes, and during testing they accumulate until the product is
 * unusable. That is exactly what happened.
 *
 * Ten minutes still stops a runaway tab opening sessions in a loop, and any
 * genuinely stranded reservation clears itself quickly. Spend is unaffected:
 * the reservation is already charged, so a shorter window can only ever affect
 * how many sessions may be STARTED, never how much they can cost.
 */
export const OPEN_SESSION_WINDOW_SECONDS =
  Number(process.env.VYNE_LIVE_OPEN_WINDOW_SECONDS || 600);

/*
 * countRecentGrants() used to live here: it counted a user's open grants in
 * its own transaction, and the route then called checkLimit and reserveSession
 * in two more. v5.32.65 (audit V2-H2) folded all three into
 * metering.admitLiveSession, which does the count, the caps check and the
 * reservation write in ONE transaction under ONE advisory lock. It is deleted
 * rather than left unused: a spare copy of the counting query is precisely the
 * thing someone reintroduces the race with.
 *
 * OPEN_SESSION_WINDOW_SECONDS above is still the window it counted over, and
 * is now passed to admitLiveSession.
 */

const LiveSessionBody = z.object({
  module: z.string().max(80).default("interview_agent"),
  clientName: z.string().min(1).max(200).optional(),
  maxSeconds: z.number().int().min(60).max(MAX_SESSION_SECONDS).optional(),
  // Engagement context for the interviewer. NOT an instruction channel — the
  // persona is composed server-side and this is fenced as data inside it, since
  // during an interview this request comes from the interviewee's browser.
  context: z.string().max(MAX_CONTEXT_CHARS).optional(),
  intervieweeName: z.string().max(200).optional(),
  intervieweeRole: z.string().max(200).optional(),
  industry: z.string().max(200).optional(),
  /** Validated against the allowlist in liveSession.ts, never forwarded raw. */
  voice: z.string().max(40).optional(),
  /** What the interviewer calls itself. Spoken aloud, so it is bounded and
   *  stripped of anything that would be read out as punctuation noise. */
  interviewerName: z.string().max(40).optional(),
  // v5.34.24: experiment — pin manual turn signalling into the token (the
  // client's own setup frame is not reliably honoured on the constrained
  // endpoint; see liveSession.ts "extras"). Boolean only; nothing else from
  // the browser reaches the setup.
  manualVad: z.boolean().optional(),
  // v5.34.29: a sessionResumption handle from the PREVIOUS connection, so the
  // renewed session keeps the conversation. Opaque server-issued string; only
  // its length is bounded here — it goes into the token, never into a prompt.
  resumeHandle: z.string().max(2048).optional(),
  /**
   * v5.34.33: the sessionId this grant continues (a ~10-minute Live handover
   * inside one interview). Verified against the caller's OWN recent holds in
   * admitLiveSession; exempts the continuation from the concurrency guard
   * only, never from spend caps. See that function for why.
   */
  renewalOf: z.string().max(200).optional(),
});

const LiveCloseBody = z.object({
  sessionId: z.string().max(64),
  module: z.string().max(80).default("interview_agent"),
  clientName: z.string().min(1).max(200).optional(),
  maxSeconds: z.number().int().min(0).max(MAX_SESSION_SECONDS),
  tokensIn: z.number().int().min(0).max(50_000_000),
  tokensOut: z.number().int().min(0).max(50_000_000),
  seconds: z.number().int().min(0).max(MAX_SESSION_SECONDS),
});

const TtsBody = z.object({
  text: z.string().min(1).max(5_000),
  voice: z.string().max(40).optional(),
  module: z.string().max(80).default("interview_agent"),
  // Client cost-recovery billing (v5.27) — see routes/billing.ts.
  clientName: z.string().min(1).max(200).optional(),
});

const TranscribeBody = z.object({
  audioBase64: z.string().max(30_000_000), // ~22MB — several minutes of webm/opus
  mimeType: z.string().max(60),
  module: z.string().max(80).default("interview_agent"),
  clientName: z.string().min(1).max(200).optional(),
});

export async function voiceRoutes(
  app: FastifyInstance,
  gateway: LlmGateway,
  tts: Tts,
  meter: Meter,
  /** Optional: when absent, the realtime routes are not registered at all and
   *  the client falls back to the existing text + TTS path. */
  live?: LiveSession,
  /**
   * BYOK for realtime voice (v5.34.59).
   *
   * `forClient` returns the live session a CLIENT's own Google key should mint,
   * or null for "use the platform's". `onRejected` is called when that key is
   * refused by Google, so the Owner's screen stops claiming it works.
   *
   * Optional: without it this route behaves exactly as it did before — one
   * credential, payer "platform".
   */
  byokLive?: {
    forClient: (tenantId: string, clientName: string | undefined) => Promise<ByokLiveBinding | null>;
    onRejected?: (info: { tenantId: string; clientName: string; detail: string }) => void;
  }
): Promise<void> {
  app.post("/api/voice/tts", async (req, reply) => {
    const ctx = req.ctx!;
    const parsed = TtsBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_input" });
      return;
    }
    if (!tts.isConfigured()) {
      reply.code(503).send({ error: "tts_not_configured" });
      return;
    }
    // V225-audit CRITICAL fix: TTS used to call the Gemini AI Studio
    // endpoint unconditionally, bypassing both checks every other AI call
    // goes through in gateway.generate() — the free-tier production lockdown
    // and the tenant plan/budget pre-flight. Enforce both here explicitly
    // since TTS doesn't route through generate().
    if (gateway.blockFreeTier && tts.freeTier) {
      reply.code(503).send({
        error: "tts_free_tier_blocked",
        detail: "Text-to-speech is configured on a free-tier key, which is disabled in this environment.",
      });
      return;
    }
    try {
      // v5.32.30: userId included so the per-user daily token ceiling covers
      // TTS too. Without it, voice was the one metered path a single account
      // could drive without hitting its own budget.
      await gateway.checkLimit(ctx.tenantId, ctx.userId);
    } catch (err) {
      if (err instanceof GatewayError) {
        // V225-audit MEDIUM fix: don't relay raw provider error text to the
        // client — see gateway.ts's GatewayError.detail doc comment.
        if (err.detail) req.log.error({ detail: redactProviderDetail(err.detail) }, "gateway error detail");
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      throw err;
    }
    const ttsBillTo = await resolveBillingClient(ctx, parsed.data.clientName);
    const started = Date.now();
    try {
      const out = await tts.synthesize(parsed.data.text, parsed.data.voice);
      await meter({
        tenantId: ctx.tenantId, userId: ctx.userId, module: parsed.data.module,
        clientName: ttsBillTo,
        task: "tts", provider: "gemini-tts", model: out.model,
        // v5.32.65 (audit V2-L5). Was `text.length / 4` in, nothing out, and
        // $0.00 — a guess at the cheap half of the call and silence about the
        // expensive half. Now the provider's own token counts, priced through
        // the one table every other path uses.
        tokensIn: out.usage.tokensIn, tokensOut: out.usage.tokensOut,
        costEstUsd: estimateCost(out.model, out.usage.tokensIn, out.usage.tokensOut),
        latencyMs: Date.now() - started, ok: true,
      }).catch(() => {});
      return { audioBase64: out.audioBase64, mime: out.mime, voice: out.voice };
    } catch (err) {
      await meter({
        tenantId: ctx.tenantId, userId: ctx.userId, module: parsed.data.module,
        clientName: ttsBillTo,
        task: "tts", provider: "gemini-tts", model: tts.model,
        tokensIn: 0, tokensOut: 0, costEstUsd: 0,
        latencyMs: Date.now() - started, ok: false,
      }).catch(() => {});
      req.log.warn({ err }, "tts failed");
      reply.code(502).send({ error: "tts_failed" });
    }
  });

  // ── Realtime voice session (v5.32.32) ────────────────────────────────────
  //
  // Hands the browser a short-lived, single-use, model-pinned token so it can
  // hold a duplex connection to Gemini Live DIRECTLY. See llm/liveSession.ts
  // for why the audio deliberately does NOT cross this server, and why the
  // token is treated as a budgeted grant rather than as a credential.
  //
  // The ORDER of the checks below is the security design, not ceremony:
  // configuration → free-tier policy → concurrency → budget → RESERVE → mint.
  // The reservation is written before the token exists, so a caller can never
  // hold a usable token whose cost has not already been charged.
  if (live) {
    app.post("/api/voice/live-session", async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = LiveSessionBody.safeParse(req.body);
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }

      if (!live.isConfigured()) { reply.code(503).send({ error: "live_not_configured" }); return; }

      /*
       * Whose credential mints this session (v5.34.59, BYOK slice 2).
       *
       * Resolved BEFORE the free-tier gate on purpose. The gate below asks
       * whether THE KEY THAT WILL BE USED may run confidential work, and once a
       * client has supplied their own attested, billed key that is a different
       * key from the platform's. Leaving the gate above this would refuse a
       * client's paid session because the firm's own fallback key happens to be
       * free-tier — the client would have handed over a credential that is
       * never used, and kept paying the firm for it.
       *
       * A null binding is the ordinary case and means "the platform pays".
       */
      const billTo = await resolveBillingClient(ctx, parsed.data.clientName);
      const byokBinding = byokLive ? await byokLive.forClient(ctx.tenantId, billTo) : null;
      const effectiveLive: LiveSession = byokBinding?.live ?? live;
      const payer: Payer = byokBinding ? "client_key" : "platform";

      // Same free-tier lockdown as TTS: a free-tier key may be training-eligible,
      // and an interview transcript is the most confidential thing here.
      if (gateway.blockFreeTier && effectiveLive.freeTier) {
        reply.code(503).send({
          error: "live_free_tier_blocked",
          detail: "Realtime voice is configured on a free-tier key, which is disabled in this environment.",
        });
        return;
      }

      // Concurrency cap. Budget alone cannot bound this: ten sessions opened in
      // the same second each pass a budget check that none of them has spent
      // against yet. Reserving at mint time closes most of that, but a cap on
      // simultaneous grants per user is the cheaper, blunter guard and it also
      // bounds how much of a firm's month one account can commit at once.
      /* Subscription gate first. This is about whether the tenant may spend at
       * all — a different question from how much is left — and it is the one
       * check that is not part of the race below. */
      try {
        await gateway.checkLimit(ctx.tenantId, ctx.userId);
      } catch (err) {
        if (err instanceof GatewayError) {
          if (err.detail) req.log.error({ detail: redactProviderDetail(err.detail) }, "gateway error detail");
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        throw err;
      }

      // billTo was resolved above, with the credential decision that depends on it.
      const sessionId = randomUUID();
      const maxSeconds = Math.min(parsed.data.maxSeconds ?? DEFAULT_SESSION_SECONDS, MAX_SESSION_SECONDS);

      /* v5.32.65 (audit V2-H2). Concurrency count, spend caps and the
       * reservation now happen in ONE transaction under ONE advisory lock.
       *
       * They used to be three separate transactions, and the reservation — the
       * write that makes a new session visible to the next counter — committed
       * after the lock from the check had already been released. Two opens
       * fired together both counted the pre-existing state, both passed, and
       * both reserved; the old comment conceded the lock "narrows, not closes"
       * it. Reserving inside the lock is what closes it.
       *
       * Still reserved BEFORE minting: if the mint then fails we have
       * over-charged for a session nobody got, which is the direction to fail
       * in, and the refund below corrects it immediately. */
      const admit = await admitLiveSession({
        tenantId: ctx.tenantId, userId: ctx.userId, module: parsed.data.module,
        model: effectiveLive.model, clientName: billTo, sessionId, maxSeconds,
        maxConcurrent: MAX_CONCURRENT_SESSIONS_PER_USER,
        openWindowSeconds: OPEN_SESSION_WINDOW_SECONDS,
        renewalOf: parsed.data.renewalOf,
        // The hold carries the payer its release and its actual-usage row will
        // later have to match — see admitLiveSession's own note.
        payer, payerKeyHint: byokBinding?.keyHint,
      });
      if (!admit.allowed) {
        reply.code(admit.reason === "too_many_live_sessions" ? 429 : 402)
             .send({ error: admit.reason ?? "limit_exceeded" });
        return;
      }

      try {
        // The persona is composed HERE and pinned into the token. The browser
        // supplies only engagement context, which buildInterviewerInstruction
        // fences as data — see llm/interviewerPersona.ts for why that matters
        // when the browser belongs to the interviewee.
        const instruction = buildInterviewerInstruction({
          interviewerName: (parsed.data.interviewerName || "").replace(/[^\p{L}\p{N} '\-]/gu, "").trim() || undefined,
          clientName: billTo ?? parsed.data.clientName,
          industry: parsed.data.industry,
          intervieweeName: parsed.data.intervieweeName,
          intervieweeRole: parsed.data.intervieweeRole,
          context: parsed.data.context,
        });
        const grant = await effectiveLive.mint(sessionId, maxSeconds, instruction, parsed.data.voice,
          { manualVad: !!parsed.data.manualVad, resumeHandle: parsed.data.resumeHandle });
        if (!grant.pinned) {
          // Degraded but functional. The persona could not be frozen into the
          // token, so the browser has to send it — which means an interviewee
          // could in principle alter it. Logged rather than silently accepted,
          // because the whole point of pinning was that they cannot.
          req.log.warn({ sessionId },
            "live session: constraints unsupported by the auth_tokens API — persona sent client-side, NOT pinned");
        }
        return {
          token: grant.token, model: grant.model, voice: grant.voice,
          maxSeconds: grant.maxSeconds, expiresAt: grant.expiresAt, sessionId: grant.sessionId,
          pinned: grant.pinned,
          // v5.34.22: present only when a thinking budget was pinned, so the
          // browser trace ("grant minted") shows what the session runs with.
          thinkingBudget: grant.thinkingBudget,
          pinnedExtras: grant.pinnedExtras,
          // Only sent when we could not pin it — never round-tripped otherwise.
          instruction: grant.pinned ? undefined : instruction,
          /*
           * Whose account this session bills to (v5.34.59). Echoed so the
           * consultant's trace — and deploy/voice-record.mjs — can prove a
           * client's key is actually in use rather than inferring it from a
           * database row. It says WHICH account, never anything about the key.
           */
          payer,
        };
      } catch (err) {
        // Give the whole reservation back — the session never existed. The
        // payer must match the hold, or the release cancels nothing and the
        // reservation stays on the statement forever.
        await reconcileSession(meter, {
          tenantId: ctx.tenantId, userId: ctx.userId, module: parsed.data.module,
          model: effectiveLive.model, clientName: billTo, sessionId, maxSeconds,
          actualTokensIn: 0, actualTokensOut: 0, actualSeconds: 0,
          payer, payerKeyHint: byokBinding?.keyHint,
        }).catch(() => {});

        /*
         * The CLIENT's key was refused — wrong, revoked, or its project lost
         * Live API access. Their interview must still happen.
         *
         * One retry on the platform credential, with a FRESH sessionId. Fresh
         * because the first session's hold has just been released and migration
         * 015's unique index allows one release per session: reusing the id
         * would make the second hold unreleasable, stranding the whole
         * reservation — the $6.62-of-phantom-charges failure v5.34.48 fixed.
         *
         * Only on a credential rejection. A 429 or a 503 is Google being busy,
         * and retrying that on the firm's key would quietly migrate a client's
         * costs onto the firm every time Google had a bad minute.
         */
        const message = (err as Error)?.message ?? "";
        if (byokBinding && isCredentialRejection(message)) {
          try {
            byokLive?.onRejected?.({
              tenantId: ctx.tenantId, clientName: byokBinding.clientName, detail: message,
            });
          } catch { /* bookkeeping must not escalate */ }
          req.log.warn({ clientName: byokBinding.clientName },
            "live session: client's own key was refused — falling back to the platform credential");

          const retryId = randomUUID();
          const retryAdmit = await admitLiveSession({
            tenantId: ctx.tenantId, userId: ctx.userId, module: parsed.data.module,
            model: live.model, clientName: billTo, sessionId: retryId, maxSeconds,
            maxConcurrent: MAX_CONCURRENT_SESSIONS_PER_USER,
            openWindowSeconds: OPEN_SESSION_WINDOW_SECONDS,
            // The released session counts as the one being continued, so the
            // concurrency guard does not refuse the retry on the strength of a
            // hold it has just cancelled.
            renewalOf: sessionId,
            payer: "platform",
          });
          if (retryAdmit.allowed) {
            try {
              if (gateway.blockFreeTier && live.freeTier) {
                throw new Error("platform live key is free-tier and blocked in this environment");
              }
              const instruction2 = buildInterviewerInstruction({
                interviewerName: (parsed.data.interviewerName || "").replace(/[^\p{L}\p{N} '\-]/gu, "").trim() || undefined,
                clientName: billTo ?? parsed.data.clientName,
                industry: parsed.data.industry,
                intervieweeName: parsed.data.intervieweeName,
                intervieweeRole: parsed.data.intervieweeRole,
                context: parsed.data.context,
              });
              const grant2 = await live.mint(retryId, maxSeconds, instruction2, parsed.data.voice,
                { manualVad: !!parsed.data.manualVad, resumeHandle: parsed.data.resumeHandle });
              return {
                token: grant2.token, model: grant2.model, voice: grant2.voice,
                maxSeconds: grant2.maxSeconds, expiresAt: grant2.expiresAt,
                sessionId: grant2.sessionId, pinned: grant2.pinned,
                thinkingBudget: grant2.thinkingBudget, pinnedExtras: grant2.pinnedExtras,
                instruction: grant2.pinned ? undefined : instruction2,
                payer: "platform",
              };
            } catch (err2) {
              await reconcileSession(meter, {
                tenantId: ctx.tenantId, userId: ctx.userId, module: parsed.data.module,
                model: live.model, clientName: billTo, sessionId: retryId, maxSeconds,
                actualTokensIn: 0, actualTokensOut: 0, actualSeconds: 0,
                payer: "platform",
              }).catch(() => {});
              req.log.warn({ err: err2 }, "live session mint failed on the platform fallback too");
            }
          }
        }

        req.log.warn({ err }, "live session mint failed");
        reply.code(502).send({ error: "live_session_failed" });
      }
    });

    // The voice catalog, so the picker cannot drift from what the server will
    // actually accept. A hard-coded list in the page would silently offer
    // voices the allowlist refuses.
    app.get("/api/voice/voices", async () => ({ voices: VOICES }));

    // Reconciliation. The client reports what it actually used when the session
    // ends; we refund the unused part of the reservation.
    //
    // This endpoint is deliberately incapable of INCREASING spend — see
    // reconcileSession, which clamps to the reservation. That is what makes it
    // safe to accept numbers from a browser at all: the worst a hostile client
    // can do by lying is refuse its own refund.
    app.post("/api/voice/live-session/close", async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = LiveCloseBody.safeParse(req.body);
      if (!parsed.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      if (!live) { reply.code(503).send({ error: "live_not_configured" }); return; }

      /*
       * v5.32.54 SECURITY (CRITICAL). Everything below used to come from the
       * request body — including `maxSeconds`, which decided the SIZE of the
       * compensating negative usage row this endpoint writes. Nothing checked
       * that a session had ever been opened. An interviewee could POST here in
       * a loop, having never started a session, and each call subtracted
       * maxSeconds*25 tokens in each direction from the firm's usage total:
       * roughly -8.1M tokens a minute at the route's rate limit.
       *
       * Both spend caps and the concurrent-session guard read sums over
       * usage_events, so that one primitive disabled the monthly tenant cap,
       * the per-user daily cap, and the concurrency limit — for every user in
       * the firm, on every metered path — while leaving invoices untouched,
       * because billing correctly excludes non-billable hold rows. Silent.
       *
       * The hold is now looked up in the ledger by (tenant, user, session), and
       * the release is sized from THAT ROW. A caller who never opened a
       * session, or who is trying to release someone else's, or who has already
       * released this one, gets a 404 and writes nothing. Migration 015's
       * unique index is the backstop against two concurrent closes.
       */
      const held = await findOpenHold(ctx.tenantId, ctx.userId, parsed.data.sessionId);
      if (!held) {
        // Deliberately indistinguishable between "no such session", "not
        // yours" and "already closed": a caller who owns a session already
        // knows which it is, and an attacker learns nothing about the ledger.
        req.log.info({ sessionId: parsed.data.sessionId, userId: ctx.userId },
          "live session close: no open hold — ignored");
        reply.code(404).send({ error: "no_open_session" });
        return;
      }

      const billTo = await resolveBillingClient(ctx, parsed.data.clientName);
      await reconcileSession(meter, {
        tenantId: ctx.tenantId, userId: ctx.userId, module: parsed.data.module,
        model: live.model, clientName: billTo,
        sessionId: parsed.data.sessionId,
        maxSeconds: Math.min(parsed.data.maxSeconds, MAX_SESSION_SECONDS),
        // The ledger's numbers, not the browser's. This is the fix.
        reservedOverride: held,
        /*
         * And the ledger's PAYER (v5.34.59), for exactly the same reason. The
         * browser never gets a say in whose account a session lands on: if it
         * did, an interviewee's laptop could move the cost of their own
         * interview between their employer and the consulting firm.
         */
        payer: held.payer,
        payerKeyHint: held.payerKeyHint,
        actualTokensIn: parsed.data.tokensIn,
        actualTokensOut: parsed.data.tokensOut,
        actualSeconds: parsed.data.seconds,
      }).catch((err) => { req.log.warn({ err }, "live session reconcile failed"); });
      return { ok: true };
    });
  }

  app.post("/api/voice/transcribe", async (req, reply) => {
    const ctx = req.ctx!;
    const parsed = TranscribeBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_input" });
      return;
    }
    // v5.32.26: validated, not trusted — see llm/attribution.ts.
    const txBillTo = await resolveBillingClient(ctx, parsed.data.clientName);
    try {
      const result = await gateway.generate(
        { tenantId: ctx.tenantId, userId: ctx.userId, module: parsed.data.module, clientName: txBillTo },
        {
          task: "transcribe",
          maxTokens: 8192,
          // Slightly above 0: greedy decoding on quiet audio produces
          // degenerate repetition loops ("the the the…").
          temperature: 0.3,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "audio",
                  source: {
                    type: "base64",
                    media_type: parsed.data.mimeType,
                    data: parsed.data.audioBase64,
                  },
                },
                {
                  type: "text",
                  text:
                    "Transcribe this audio recording exactly as spoken, in the original language. " +
                    "Return ONLY the transcript text — no commentary, no timestamps, no speaker labels. " +
                    "Never output the same word repeated many times. " +
                    "If the audio is silent, unclear, or contains no discernible speech, return exactly: [no speech detected]",
                },
              ],
            },
          ],
        }
      );
      return { text: result.text.trim(), provider: result.provider };
    } catch (err) {
      if (err instanceof GatewayError) {
        // V225-audit MEDIUM fix: don't relay raw provider error text to the
        // client — see gateway.ts's GatewayError.detail doc comment.
        if (err.detail) req.log.error({ detail: redactProviderDetail(err.detail) }, "gateway error detail");
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      req.log.error({ err }, "transcribe failed");
      reply.code(500).send({ error: "transcribe_failed" });
    }
  });
}
