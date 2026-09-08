/**
 * Distributed interviews (Phase 2.5).
 *
 * Consultant/owner:
 *   POST   /api/interviews            create an invite (+ interviewee login)
 *   GET    /api/interviews            tracker: all interviews w/ status
 *   GET    /api/interviews/:id/state  read an interviewee's session state
 *   PATCH  /api/interviews/:id        update status (e.g. reopen)
 *
 * Interviewee:
 *   GET    /api/interviews/mine/bootstrap
 *          their interview + SANITIZED briefing context + own saved state.
 *          Sanitization strips consultant-only material (political
 *          sensitivity flags, field observations) before anything reaches
 *          the interviewee's browser.
 *   PUT    /api/interviews/mine/state   persist own session (auto → in_progress)
 *   POST   /api/interviews/mine/complete
 *
 * Isolation model: interviewees never touch the shared 'workspace'
 * namespace. Each interview has a private module_state namespace
 * (iv_<uuid>); route guards + RLS keep it that way.
 *
 * V225-audit H2 fix: the consultant-facing tracker/state queries below carry
 * their own explicit tenant_id predicate in addition to RLS, as
 * belt-and-braces defense-in-depth — see engagements.ts's doc comment and
 * db/pool.ts's assertRlsEnforceable() for the full rationale.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant, withoutTenant } from "../db/pool.js";
import { requireRole } from "../auth/middleware.js";
import { allowedClientNorms, clientAllowed, filterWorkspaceState, normClient } from "../auth/clients.js";
import { mergeSessionIntoEngagement, pickLatestSession, sanitizeIntervieweeSession, type EngagementRecord } from "../tenant/engagementMerge.js";
import { isKnownVoice } from "../llm/liveSession.js";
import { auditLog } from "../audit/log.js";
import { DIMENSION_NAMES } from "./scorecard.js";
import { transcriptEvidenceFor } from "../tenant/transcriptEvidence.js";
import { sortRounds } from "../tenant/scoring.js";

/**
 * Interviewer identity (v5.32.47) — chosen by the CONSULTANT, per interview.
 *
 * Both are optional and both accept "" to mean "use the firm default", so a
 * consultant can clear a choice as easily as make one. The name is stripped of
 * anything that is not a letter, digit, space, apostrophe or hyphen: it is
 * interpolated into a system instruction that the model reads as authority, so
 * punctuation that could open a new instruction has no business in it.
 *
 * The voice is checked against the live-session allowlist HERE rather than only
 * at mint time. Validating late would accept "Orusss", store it, and then
 * silently substitute the default in every interview that followed.
 */
const InterviewerName = z
  .string().max(200)
  // Strip FIRST, then bound. Bounding first would 400 on a name that is merely
  // long, which is a rude way to treat a cosmetic field; and it would reject
  // injection attempts with an error message rather than quietly defusing them.
  .transform((s) => s.replace(/[^\p{L}\p{N} '\-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40))
  .optional();
const InterviewerVoice = z
  .string().max(40).trim()
  .refine((s) => s === "" || isKnownVoice(s), { message: "unknown_voice" })
  .optional();

/**
 * How long this interview is allowed to be (v5.33.8, migration 028).
 *
 * Optional everywhere rather than defaulted here: the COLUMN defaults to
 * 'deep', so an omitted depth and an explicit 'deep' produce the same row and
 * the default is written down in exactly one place.
 */
const Depth = z.enum(["quick", "standard", "deep"]).optional();

const CreateBody = z.object({
  clientName: z.string().min(1).max(200),
  intervieweeName: z.string().min(1).max(200),
  intervieweeRole: z.string().min(1).max(100),
  /**
   * Question budget: quick ~25, standard ~35, deep ~50 (the depthMap in
   * interview_agent.html). It travels on the invite for the same reason
   * interviewerName and interviewerVoice do — the consultant is the only person
   * who knows how much of this executive's time the firm has been given, and
   * the interviewee's browser has no other channel to learn it from.
   */
  depth: Depth,
  /** Login id for the interviewee: email (Identity Platform) or dev uid. */
  email: z.string().min(3).max(200),
  /** Initial password when running with Identity Platform; ignored in dev. */
  password: z.string().min(10).max(200).optional(),
  interviewerName: InterviewerName,
  interviewerVoice: InterviewerVoice,
  /**
   * Which diagnostic round this interview is for (v5.32.55). Omit for "the
   * current one", which is what every existing invite means.
   */
  roundNumber: z.number().int().min(1).max(50).optional(),
});

/** Strip consultant-only material from a briefing context. */
/**
 * V225-audit MEDIUM fix. This used to be a denylist — delete 4 known-
 * sensitive fields (politicalSensitivityFlags, observations, peContext,
 * peContextSummary), pass everything else through verbatim. Same shape as
 * the bug CRITICAL #2 fixed for engagement records: a denylist means any
 * NEW field added to briefingCtx in frontend/pre_engagement.html leaks to
 * every interviewee by default unless someone remembers to also add it
 * here. Converted to an allowlist of exactly the fields
 * interview_agent.html's briefing consumer (loadBriefingContext() and the
 * system-prompt builder around it) actually reads today — same output as
 * before for all existing data, but a field nobody has reviewed is now
 * excluded by default instead of leaked by default. Deliberately excludes
 * recommendedInterviewOrder (dead/deprecated per pre_engagement.html's own
 * comment), dataRequestOwners, and issueTreeQuestions — none of which
 * interview_agent.html's consumer reads, so dropping them changes nothing
 * observable while shrinking what's exposed.
 */
const BRIEFING_SAFE_FIELDS = [
  "generatedAt", "engagementCode", "client", "industry", "revenue",
  // v5.32.55 SECURITY: "peSponsor" and "engagementLead" removed.
  //
  // Both were sent verbatim into the interviewee's browser and then into the
  // interview prompt as header lines. The persona rules forbid the model from
  // REVEALING firm-side material, which addresses the model — and addresses
  // nothing at all about the payload sitting in the browser's own store, where
  // a client executive can read it with devtools. Naming the private-equity
  // firm behind an engagement to a stakeholder at the portfolio company is a
  // confidentiality failure whatever the model does with it, and the interview
  // does not need either field to be conducted.
  //
  // "clientProblem"/"clientProblemSummary" stay: that is the CLIENT's own
  // stated problem, which they already know, and it is what focuses the
  // questioning.
  "clientProblem", "clientProblemSummary",
  "hypotheses", "industryTrends", "topUseCases", "benchmarkSummary",
  "selectedRoles", "roleCatalog", "priorityRolesPerDim",
  "roundNumber", "roundLabel", "scopeDimensions", "whatChanged", "whatChangedSummary",
  "benchmarks", "benchmarkTrends", "benchmarkDate",
  "documentSummaries", "documentIntelligence", "documentIntelligenceDate", "documentCount",
  // Pre-interview topic preview (v5.26): representative issue-tree questions
  // per dimension, scoped to the interviewee's own role by roleCatalog —
  // these are prep-friendly TOPIC templates the consultant authored, not
  // anyone's answers, so re-adding them to the allowlist (they were
  // deliberately excluded before nothing consumed them) exposes nothing the
  // CRITICAL/MEDIUM fixes above were protecting against.
  "issueTreeQuestions",
];

/**
 * Hypotheses reach the interview for a real reason — the agent probes open ones
 * and checks whether settled ones have reversed — but the stored shape carries
 * more than that job needs.
 *
 * v5.32.55 SECURITY. Each hypothesis is {index, text, status, note}, and `note`
 * is the consultant's private working note, typed into the "Add evidence or
 * notes…" box in Pre-Engagement. Nothing in the Interview Agent reads it; it
 * was travelling to the interviewee's browser purely because the allowlist
 * worked at field level and stopped one level too high. Projected away here.
 *
 * `status` and `text` stay, because the agent's steering genuinely uses them.
 * Being straight about the residual: for the TEXT path the prompt is assembled
 * in the browser, so anything the model must see, a determined interviewee can
 * also read. That is a property of client-side prompt assembly, not of this
 * function, and the fix is to compose that prompt server-side the way the live
 * path already does. Removing what nothing reads is worth doing regardless —
 * it is the difference between a leak and an architectural limit.
 */
function projectHypotheses(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((h) => {
    if (!h || typeof h !== "object") return h;
    const src = h as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof src.text === "string") out.text = src.text;
    if (typeof src.status === "string") out.status = src.status;
    if (typeof src.index === "number") out.index = src.index;
    return out;
  });
}

/**
 * What a follow-up agenda item says to the INTERVIEWEE (v5.32.65, audit V2-M1).
 *
 * The draft below is built from colleagues' findings for the round, and until
 * now it put their sentences into `text` — the field the interviewee's welcome
 * screen renders verbatim and the interview prompt is centred on. Two things
 * are wrong with that. It contradicts the confidentiality rule the rest of the
 * product states plainly (see the courtesy-preview prompt in
 * interview_agent.html: never state or imply that anyone said anything
 * specific, reframe every item as a neutral topic to revisit); and it routes
 * around `sanitizeEngagementForInterviewee` entirely, since the draft reads the
 * LATEST round — the very round that sanitiser withholds because it is the one
 * the interviewee is being interviewed in.
 *
 * The consultant's approval was the control, but approving was one click on a
 * default, so the default is what shipped. The default is now the neutral
 * probe; the colleague's sentence is kept alongside it as consultant-only
 * `evidence` so the consultant can still judge the item — and can still choose
 * to write something specific into `text`, which is then a deliberate human
 * disclosure rather than an accident of the draft.
 */
export function neutralAgendaProbe(dimension: string): string {
  const name = DIMENSION_NAMES[dimension] ?? dimension;
  return `Revisit ${name} — we would like your current view on how this is working in practice, and what has changed since we last spoke.`;
}

/**
 * The probe an interviewee actually reads (v5.32.88).
 *
 * `neutralAgendaProbe` is the floor: a fixed sentence, identical for every
 * engagement in the product, because the only specific material the draft had
 * to work with was other people's and that can never be shown.
 *
 * Their OWN last statement on the dimension can be. Quoting somebody back to
 * themselves discloses nothing, and it turns an interview that opens with
 * "revisit Governance & Risk" into one that opens with the sentence they
 * actually said — which is the difference between a survey and a conversation.
 *
 * The round is named so the interviewee can place it, and the quote is bounded:
 * a finding is a sentence, but nothing guarantees that, and an unbounded quote
 * in a prompt is an unbounded prompt.
 */
export function probeFor(
  dimension: string,
  own: { text: string; round: number } | null,
  consultantNote?: string
): string {
  const name = DIMENSION_NAMES[dimension] ?? dimension;
  const note = (consultantNote ?? "").trim();
  if (!own || !own.text) {
    return note
      ? `${neutralAgendaProbe(dimension)} Specifically: ${note}`
      : neutralAgendaProbe(dimension);
  }
  const quote = own.text.length > 300 ? own.text.slice(0, 297) + "..." : own.text;
  const when = own.round > 0 ? ` in round ${own.round}` : "";
  const base = `Revisit ${name}. Last time${when} you said: "${quote}" — is that still how it works in practice, and what has changed since?`;
  return note ? `${base} Specifically: ${note}` : base;
}

/** The interviewee-facing projection of a stored agenda: no `evidence`. */
export function projectAgendaForInterviewee(agenda: unknown): { dimension: string; text: string }[] {
  if (!Array.isArray(agenda)) return [];
  const out: { dimension: string; text: string }[] = [];
  for (const raw of agenda) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const dimension = typeof a.dimension === "string" ? a.dimension : "";
    const text = typeof a.text === "string" ? a.text : "";
    if (dimension && text) out.push({ dimension, text });
  }
  return out;
}

export function sanitizeBriefing(raw: string): string {
  try {
    const b = JSON.parse(raw) as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    for (const k of BRIEFING_SAFE_FIELDS) if (k in b) safe[k] = b[k];
    if ("hypotheses" in safe) safe.hypotheses = projectHypotheses(safe.hypotheses);
    return JSON.stringify(safe);
  } catch {
    return raw;
  }
}

/**
 * V225-audit CRITICAL fix. The bootstrap handler used to send
 * `vynora_engagement_<code>` to interviewees VERBATIM — the full consultant
 * engagement record, including every OTHER interviewee's `round.interviews[]`
 * entries (role, full summary, per-dimension findings with attribution),
 * plus consultant-only fields (peContext, clientProblem, peSponsor). Every
 * interviewee at a client could read every other named executive's private
 * interview summary just by hitting GET /api/interviews/mine/bootstrap.
 *
 * The fix is a real allowlist projection, not a delete-list: it keeps
 * exactly what interview_agent.html's own loadBriefingContext() legitimately
 * pulls out of a round for round-over-round continuity — scope/benchmarks
 * for the current round, and (for the PRIOR round) scores plus per-dimension
 * finding TEXT with no interviewee/role attribution — and drops everything
 * else, including the raw `interviews` array itself. See the matching
 * frontend change in interview_agent.html's loadBriefingContext(), which now
 * prefers this precomputed `findingsByDimension` over re-deriving it from a
 * raw `interviews` array that interviewees no longer receive.
 */
export function sanitizeEngagementForInterviewee(
  raw: string,
  /**
   * The round THIS interviewee is being interviewed in, from
   * `interviews.round_number`. NULL carries migration 016's meaning — "whatever
   * round is current" — and is the legacy/normal case.
   *
   * Required rather than defaulted, deliberately. A parameter with a default is
   * a parameter a future call site forgets, and the default here would be the
   * insecure one.
   */
  ownRoundNumber: number | null
): string {
  try {
    const eng = JSON.parse(raw) as Record<string, unknown>;
    const rounds = Array.isArray(eng.rounds) ? (eng.rounds as Record<string, unknown>[]) : [];
    // v5.32.54 SECURITY. The gate below used to be `r.status !== "active"`, and
    // that word does not mean what it reads like: mergeSessionIntoEngagement
    // sets `round.status = "complete"` after EVERY completion, so the round
    // flipped to "complete" the moment the FIRST interviewee finished — while
    // four colleagues were still to be interviewed in it. From that moment on,
    // every subsequent interviewee's bootstrap carried the round's aggregate
    // scores and one verbatim finding per dimension from the people already
    // interviewed. That is precisely the leak the v5.32.29 comment below
    // claims to have closed; the fix picked a status word that another module
    // was already overloading for a different purpose.
    //
    // The honest predicate is not a status at all — it is identity. The round
    // an interviewee is being interviewed IN is the one whose contents they
    // must not see. Any OTHER round is genuinely finished with, and prior-round
    // continuity is the feature this projection exists to serve.
    const currentRoundId = typeof eng.currentRoundId === "string" ? eng.currentRoundId : null;
    const safeRounds = rounds.map((r) => {
      const findingsByDimension: Record<string, string> = {};
      const interviews = Array.isArray(r.interviews) ? (r.interviews as Record<string, unknown>[]) : [];
      for (const iv of interviews) {
        const findings = Array.isArray(iv.findings) ? (iv.findings as Record<string, unknown>[]) : [];
        for (const f of findings) {
          const dim = typeof f.dimension === "string" ? f.dimension : null;
          const text = typeof f.text === "string" ? f.text : null;
          if (dim && text && !(dim in findingsByDimension)) findingsByDimension[dim] = text;
        }
      }
      // v5.32.29 SECURITY (audit M-3). The doc comment above has always said
      // this projection carries finding TEXT for the PRIOR round only — the
      // code applied it to every round, including the one still in progress.
      // So an interviewee logging in mid-round read verbatim candid statements
      // from colleagues interviewed hours earlier ("Nobody owns governance;
      // the board has not been told"). Attribution is stripped, but that kind
      // of sentence is frequently self-identifying, and the round's aggregate
      // scores were exposed the same way. Now the contract and the code agree.
      // Not `status`, which another module overloads — see the note above.
      // Belt and braces: a round with no id cannot be proven to be a prior one,
      // so it is treated as current and withheld.
      //
      // v5.32.65 SECURITY (audit V2-H3). Identity was the right idea; the
      // identity used was the wrong one. `currentRoundId` is a property of the
      // ENGAGEMENT, and it moves the moment a consultant plans the next round
      // — which routinely happens while the previous round still has people
      // left to interview. From that moment the round those stragglers are
      // being interviewed in is no longer the "current" one, so it read as
      // settled, and every one of them received their own round's aggregate
      // scores and a verbatim finding per dimension from the colleagues who
      // went first. That is the identical leak v5.32.54 closed, reopened
      // through a different door: the predicate keyed on a fact about the
      // engagement rather than a fact about the interviewee.
      //
      // The round an interviewee must not see is THEIR round. So both are
      // withheld: their own (source: interviews.round_number, which the
      // consultant sets at invite time) and the engagement's current one,
      // which may be mid-collection for somebody else.
      //
      // The test is "strictly BEFORE their round", not merely "not their
      // round". What this projection exists to give them is round-over-round
      // continuity — last time's picture, so this time's questions can build on
      // it — and that is satisfied entirely by earlier rounds. A round LATER
      // than theirs is one they are not part of and is by definition still
      // being collected, so there is nothing there they need and something
      // there they should not have. (Later-than-own is reachable whenever
      // rounds are created out of order, or an invite is issued against an
      // earlier round after a newer one exists.)
      //
      // Fail closed on either side of a comparison being unknowable: a round
      // with no id cannot be proven to be a prior one, and once the
      // interviewee's round number is known, a round carrying no round number
      // cannot be proven to be earlier than it.
      const notCurrent = currentRoundId !== null
        && typeof r.roundId === "string"
        && r.roundId !== currentRoundId;
      const beforeOwn = ownRoundNumber === null
        || (typeof r.roundNumber === "number" && r.roundNumber < ownRoundNumber);
      const settled = notCurrent && beforeOwn;
      return {
        roundId: r.roundId, roundNumber: r.roundNumber, label: r.label, type: r.type,
        date: r.date, status: r.status, scopeDimensions: r.scopeDimensions,
        whatChanged: r.whatChanged, benchmarks: r.benchmarks, benchmarkTrends: r.benchmarkTrends,
        benchmarkBasis: r.benchmarkBasis, benchmarkConfidence: r.benchmarkConfidence,
        scores: settled ? r.scores : undefined,
        findingsByDimension: settled ? findingsByDimension : {},
      };
    });
    return JSON.stringify({
      code: eng.code, client: eng.client, industry: eng.industry,
      currentRoundId: eng.currentRoundId, rounds: safeRounds,
    });
  } catch {
    return "{}";
  }
}

const CONSULTANT_SAFE_PREFIXES = ["vynora_briefing_", "vynora_engagement_", "vynora_engagement_index", "vynora_code_index"];
const BLOCKED_PREFIXES = ["vynora_refresh_agenda_", "vynora_refresh_context_", "vynora_api_key", "vynora_last_briefing"];

export async function interviewRoutes(app: FastifyInstance): Promise<void> {
  // ── Consultant: create invite ─────────────────────────────────────────────
  app.post(
    "/api/interviews",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_input", detail: parsed.error.flatten() });
        return;
      }
      const { clientName, intervieweeName, intervieweeRole, email, password,
              interviewerName, interviewerVoice, roundNumber, depth } = parsed.data;

      // Client scoping: consultants may only invite for clients assigned to them.
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      if (!clientAllowed(allowed, clientName)) {
        reply.code(403).send({ error: "client_not_assigned", detail: `You are not assigned to client "${clientName}". Ask a firm owner to assign you.` });
        return;
      }

      // 1. Interviewee login. Dev mode: a users row keyed by email (signs in
      //    as dev:<email>). Identity Platform mode: a real IdP user in the
      //    firm's tenant pool.
      const devAuth = process.env.DEV_AUTH === "1" && process.env.NODE_ENV !== "production";
      let idpUid = email;
      if (!devAuth) {
        const { getAuth } = await import("firebase-admin/auth");
        const t = await withoutTenant(async (c) => {
          const r = await c.query<{ idp_tenant_id: string | null }>(
            `SELECT idp_tenant_id FROM tenants WHERE id = $1`, [ctx.tenantId]);
          return r.rows[0]?.idp_tenant_id;
        });
        if (!t) { reply.code(500).send({ error: "tenant_missing_idp" }); return; }
        if (!password) { reply.code(400).send({ error: "password_required" }); return; }
        const pool = getAuth().tenantManager().authForTenant(t);
        try {
          const u = await pool.createUser({ email, password, displayName: intervieweeName });
          idpUid = u.uid;
        } catch (e: unknown) {
          // Re-invite after a delete (or a retry): the IdP login may still
          // exist. Reuse it — reset its password/name to this invite's values.
          const code = (e as { errorInfo?: { code?: string }; code?: string });
          if ((code.errorInfo?.code ?? code.code) === "auth/email-already-exists") {
            /*
             * v5.32.57 SECURITY (CRITICAL) — PRIVILEGE ESCALATION.
             *
             * This branch resets the password of an account this request did
             * not create. It exists for a real case (re-inviting someone whose
             * login was deleted), but it never asked WHOSE account it was
             * about to re-credential — and this route is open to every
             * consultant.
             *
             * So a consultant invited an "interviewee" using the firm OWNER's
             * email address, chose the password, and signed in as the owner.
             * The membership upsert below is ON CONFLICT DO NOTHING, so the
             * owner's role was left intact and the takeover was invisible;
             * nothing was written to audit_log either. From there: every
             * client's data, client deletion, billing, the team roster.
             *
             * An interviewee login is the least-privileged thing in the
             * product. It must never be the way to obtain a more privileged
             * one. If the address already belongs to a member of this firm,
             * refuse — and record the refusal, because an attempt is itself
             * worth seeing.
             */
            const holder = await withoutTenant(async (c) => {
              const r = await c.query<{ role: string }>(
                `SELECT m.role
                   FROM users u JOIN memberships m ON m.user_id = u.id
                  WHERE lower(u.email) = lower($1) AND m.tenant_id = $2
                  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'consultant' THEN 1 ELSE 2 END
                  LIMIT 1`,
                [email, ctx.tenantId]
              );
              return r.rows[0]?.role ?? null;
            });
            if (holder === "owner" || holder === "consultant") {
              await auditLog(ctx.tenantId, ctx.userId, "idp_credential_reset_refused",
                { email, existingRole: holder, via: "interview_invite" });
              reply.code(409).send({
                error: "email_belongs_to_a_firm_member",
                detail: `${email} is already a ${holder} of this firm. Interviewees need their own address — `
                  + `inviting an existing member here would reset that member's password.`,
              });
              return;
            }
            const existing = await pool.getUserByEmail(email);
            await pool.updateUser(existing.uid, { password, displayName: intervieweeName });
            idpUid = existing.uid;
            // A credential change is exactly the kind of event an audit trail
            // exists for, even when it is legitimate.
            await auditLog(ctx.tenantId, ctx.userId, "idp_credential_reset",
              { email, via: "interview_invite" });
          } else {
            throw e;
          }
        }
      }

      const result = await withoutTenant(async (c) => {
        await c.query("BEGIN");
        try {
          const u = await c.query<{ id: string }>(
            `INSERT INTO users (identity_platform_uid, email, name) VALUES ($1, $2, $3)
             ON CONFLICT (identity_platform_uid) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [idpUid, email, intervieweeName]
          );
          await c.query(
            `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'interviewee')
             ON CONFLICT (user_id, tenant_id) DO NOTHING`,
            [u.rows[0].id, ctx.tenantId]
          );
          await c.query("COMMIT");
          return u.rows[0].id;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      });

      // 2. Interview row with its private state namespace.
      const row = await withTenant(ctx.tenantId, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO interviews
             (tenant_id, client_name, interviewee_name, interviewee_role,
              interviewee_user_id, state_module, created_by,
              interviewer_name, interviewer_voice, round_number, depth)
           VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                   $1, $2, $3, $4, 'pending', $5,
                   NULLIF($6, ''), NULLIF($7, ''), $8,
                   -- COALESCE, not a route-side default: 028 owns the default,
                   -- so there is one place to change it and no way for the two
                   -- to disagree.
                   COALESCE($9, 'deep'))
           RETURNING id`,
          [clientName, intervieweeName, intervieweeRole, result, ctx.userId,
           interviewerName ?? "", interviewerVoice ?? "", roundNumber ?? null,
           depth ?? null]
        );
        const id = r.rows[0].id;
        await c.query(`UPDATE interviews SET state_module = $1 WHERE id = $2`, [
          "iv_" + id.replace(/-/g, ""), id,
        ]);
        return r.rows[0];
      });

      /* Firm → shareable login link that pre-selects the firm (v5.23).
       *
       * v5.32.61: this was slug-only, so a firm that had never been given a
       * slug — which is every firm that has not been white-labelled — got
       * loginPath = null, and the invite link's continue URL dropped the
       * interviewee on a bare login page with no firm context. The `?firm=`
       * parameter accepts the Identity Platform tenant id just as happily as
       * a slug (see resolveFirmContext in index.html, which passes either
       * straight to /api/firm), so fall back to it rather than to nothing.
       * It is an identifier, not a secret — the login form has always
       * accepted it typed by hand. */
      const firmRow = await withoutTenant(async (c) => {
        const r = await c.query<{ slug: string | null; idp_tenant_id: string | null }>(
          `SELECT slug, idp_tenant_id FROM tenants WHERE id = $1`, [ctx.tenantId]);
        return r.rows[0] ?? null;
      });
      const firmRef = firmRow?.slug ?? firmRow?.idp_tenant_id ?? null;
      const loginPath = firmRef ? `/?firm=${encodeURIComponent(firmRef)}` : null;

      /*
       * Invite email (v5.32.58).
       *
       * There was no mail transport in this application at all — no SMTP, no
       * SendGrid, nothing. Creating an invite minted a login and handed the
       * consultant a sentence to relay by hand, which in practice means a
       * password travelling by email or chat in plain text, typed by someone
       * else, for an executive at a client.
       *
       * Rather than add a mail service and start storing initial passwords
       * more carefully, this uses the one that already exists: Identity
       * Platform generates a password-reset link for the firm's own tenant
       * pool. The interviewee sets their own password, we never see it, the
       * link expires on Google's schedule, and no credential is ever pasted
       * into a message.
       *
       * SENDING is deliberately left to the consultant. Firms have their own
       * conventions about how a client executive is approached, an automatic
       * mail from an unfamiliar domain lands in spam, and — the honest reason
       * — wiring an outbound mail provider is a decision about deliverability,
       * SPF and a from-address that belongs to whoever runs the firm, not to
       * me. What the API returns is a ready link, so the consultant sends one
       * sentence instead of managing a password.
       */
      let inviteLink: string | null = null;
      let inviteLinkError: string | null = null;
      if (!devAuth) {
        try {
          const { getAuth } = await import("firebase-admin/auth");
          const t2 = await withoutTenant(async (c) => {
            const r = await c.query<{ idp_tenant_id: string | null }>(
              `SELECT idp_tenant_id FROM tenants WHERE id = $1`, [ctx.tenantId]);
            return r.rows[0]?.idp_tenant_id ?? null;
          });
          if (t2) {
            const pool2 = getAuth().tenantManager().authForTenant(t2);
            const base = process.env.APP_BASE_URL || "";
            inviteLink = await pool2.generatePasswordResetLink(
              email,
              base ? { url: base + (loginPath ?? "/"), handleCodeInApp: false } : undefined
            );
          }
        } catch (e) {
          // A failed link is not a failed invite — the login exists either way.
          inviteLinkError = (e as Error).message?.slice(0, 200) ?? "link_generation_failed";
          req.log.warn({ err: e }, "invite link generation failed");
        }
      }

      reply.code(201).send({
        id: row.id,
        loginPath,
        inviteLink,
        inviteLinkError,
        // Ready to paste into an email, so nobody has to compose one — or send
        // a password — themselves.
        inviteMessage: inviteLink
          ? `Hello ${intervieweeName},\n\n`
            + `You have been asked to take part in an AI readiness interview for ${clientName}. `
            + `It takes about 45 minutes and you can pause and return at any time.\n\n`
            + `Set your password and begin here:\n${inviteLink}\n\n`
            + `Your sign-in address is ${email}.`
          : null,
        loginHint: devAuth
          ? `Dev mode: interviewee signs in as "${email}" on the landing page.`
          : (inviteLink
            ? `An invite link has been generated — copy the message below and send it to ${email}. `
              + `They set their own password, so no password needs to be shared.`
            : (loginPath
              ? `Send them this login link: ${loginPath} — the firm is pre-selected; they just enter ${email} + password.`
              : `Interviewee signs in with firm tenant + ${email}.`)),
      });
    }
  );

  // ── Consultant: tracker ───────────────────────────────────────────────────
  app.get(
    "/api/interviews",
    { preHandler: requireRole("owner", "consultant") },
    async (req) => {
      const ctx = req.ctx!;
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      return withTenant(ctx.tenantId, async (c) => {
        const r = await c.query<{ client_name: string }>(
          `SELECT i.id, i.client_name, i.interviewee_name, i.interviewee_role,
                  i.status, i.created_at, i.started_at, i.completed_at, u.email,
                  i.kind, i.parent_interview_id, i.agenda_status, i.agenda,
                  i.interviewer_name, i.interviewer_voice, i.round_number, i.depth
             FROM interviews i LEFT JOIN users u ON u.id = i.interviewee_user_id
            WHERE i.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
            ORDER BY i.created_at DESC`
        );
        // Client scoping: consultants only see their assigned clients' rows.
        const rows = allowed === null
          ? r.rows
          : r.rows.filter((row) => clientAllowed(allowed, row.client_name));
        return { interviews: rows };
      });
    }
  );

  // ── Consultant: read an interviewee's session state ───────────────────────
  app.get(
    "/api/interviews/:id/state",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { id } = req.params as { id: string };
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      const data = await withTenant(ctx.tenantId, async (c) => {
        const iv = await c.query<{ state_module: string; client_name: string }>(
          `SELECT state_module, client_name FROM interviews
            WHERE id = $1
              AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`, [id]);
        if (!iv.rows[0]) return null;
        if (!clientAllowed(allowed, iv.rows[0].client_name)) return null; // indistinguishable from not-found
        const st = await c.query<{ key: string; value: { v: string } }>(
          `SELECT key, value FROM module_state WHERE module = $1`, [iv.rows[0].state_module]);
        const out: Record<string, string> = {};
        for (const row of st.rows) out[row.key] = row.value.v;
        return out;
      });
      if (data === null) { reply.code(404).send({ error: "not_found" }); return; }
      return { state: data };
    }
  );

  // ── Consultant: read an interview's transcript ────────────────────────────
  //
  // The point of the whole record: a consultant challenged on a finding can
  // read exactly what was said. Client-scoped like every other consultant
  // route, and 404s indistinguishably for a client they are not assigned to.
  app.get(
    "/api/interviews/:id/transcript",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { id } = req.params as { id: string };
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      const rows = await withTenant(ctx.tenantId, async (c) => {
        const r = await c.query<{
          id: string; client_name: string; interviewee_name: string;
          interviewee_role: string; round_number: number | null;
          turns: unknown; turn_count: number; mode: string; captured_at: string;
          findings: unknown; score_events: unknown;
        }>(
          // findings / score_events (v5.32.66): the evidence beside the words.
          // NULL on any interview completed before that release — the viewer
          // distinguishes "no journal was kept" from "nothing was found".
          `SELECT id, client_name, interviewee_name, interviewee_role, round_number,
                  turns, turn_count, mode, captured_at, findings, score_events
             FROM interview_transcripts
            WHERE interview_id = $1
              AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
            ORDER BY captured_at DESC
            LIMIT 20`,
          [id]
        );
        return r.rows.filter((row) => clientAllowed(allowed, row.client_name));
      });
      if (!rows.length) { reply.code(404).send({ error: "no_transcript" }); return; }
      return { transcripts: rows };
    }
  );

  // ── Consultant: edit an interview (details and/or status) ─────────────────
  app.patch(
    "/api/interviews/:id",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { id } = req.params as { id: string };
      const body = z
        .object({
          status: z.enum(["invited", "in_progress", "completed"]).optional(),
          clientName: z.string().min(1).max(200).optional(),
          intervieweeName: z.string().min(1).max(200).optional(),
          intervieweeRole: z.string().min(1).max(100).optional(),
          interviewerName: InterviewerName,
          interviewerVoice: InterviewerVoice,
          roundNumber: z.number().int().min(1).max(50).nullable().optional(),
          /* v5.33.8. Changeable after the invite goes out, because the diary
           * changes after the invite goes out — the CFO who had ninety minutes
           * now has thirty. It has no effect once they have started, which the
           * row editor says on the control rather than enforcing silently. */
          depth: Depth,
        })
        .safeParse(req.body);
      if (!body.success || Object.keys(body.data).length === 0) {
        // v5.32.50: was a bare "invalid_input". The create route has always
        // sent the offending field back; this one left the consultant guessing
        // which of six inputs the server disliked.
        reply.code(400).send({
          error: "invalid_input",
          detail: body.success ? "no fields to update" : body.error.flatten(),
        });
        return;
      }
      const d = body.data;
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      // Consultants can neither touch an unassigned client's interview nor
      // move an interview TO a client they aren't assigned to.
      if (d.clientName && !clientAllowed(allowed, d.clientName)) {
        reply.code(403).send({ error: "client_not_assigned" });
        return;
      }
      const n = await withTenant(ctx.tenantId, async (c) => {
        if (allowed !== null) {
          const cur = await c.query<{ client_name: string }>(
            `SELECT client_name FROM interviews WHERE id = $1`, [id]);
          if (!cur.rows[0] || !clientAllowed(allowed, cur.rows[0].client_name)) return 0;
        }
        const r = await c.query(
          // The interviewer fields deliberately do NOT use COALESCE. These two
          // are the only nullable ones, and NULL is a meaningful value for them
          // ("use the firm default"), so COALESCE would make a choice
          // impossible to UNDO — the consultant could switch voices forever but
          // never get back to the default. Absent (undefined → SQL NULL) leaves
          // the column alone; an explicit "" clears it.
          `UPDATE interviews SET
             status            = COALESCE($1, status),
             client_name       = COALESCE($2, client_name),
             interviewee_name  = COALESCE($3, interviewee_name),
             interviewee_role  = COALESCE($4, interviewee_role),
             interviewer_name  = CASE WHEN $5::text IS NULL THEN interviewer_name
                                      WHEN $5 = '' THEN NULL ELSE $5 END,
             interviewer_voice = CASE WHEN $6::text IS NULL THEN interviewer_voice
                                      WHEN $6 = '' THEN NULL ELSE $6 END,
             round_number      = CASE WHEN $7::int IS NULL AND NOT $8 THEN round_number
                                      ELSE $7 END,
             -- COALESCE is right here and wrong two lines above: depth is NOT
             -- NULL and has no "unset" state to return to, so "absent means
             -- leave it alone" is the whole requirement.
             depth             = COALESCE($9, depth)
           WHERE id = $10`,
          [d.status ?? null, d.clientName ?? null, d.intervieweeName ?? null, d.intervieweeRole ?? null,
           d.interviewerName ?? null, d.interviewerVoice ?? null,
           d.roundNumber ?? null, Object.prototype.hasOwnProperty.call(d, "roundNumber"),
           d.depth ?? null, id]
        );
        return r.rowCount;
      });
      if (!n) { reply.code(404).send({ error: "not_found" }); return; }
      return { ok: true };
    }
  );

  // ── Consultant: delete an interview (row + its private session state; the
  //    interviewee's membership is removed too if this was their only
  //    interview, so their login stops granting access) ──────────────────────
  app.delete(
    "/api/interviews/:id",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { id } = req.params as { id: string };
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      /*
       * v5.32.57 — the orphan check moved IN HERE, and this is the whole fix.
       *
       * It used to live in the withoutTenant() block below, as
       *   AND NOT EXISTS (SELECT 1 FROM interviews i WHERE ... i.tenant_id = $2)
       * and withoutTenant() never sets app.tenant_id. `interviews` has FORCE
       * ROW LEVEL SECURITY with a policy of
       *   tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
       * so with the setting unset that predicate is NULL, ZERO rows are
       * visible, and NOT EXISTS is unconditionally true.
       *
       * Verified against real Postgres as the app role: with one interview
       * present the probe returns {"orphaned": true, "visible": 0}. So the
       * guard that was supposed to say "this person still has other interviews,
       * keep their login" always said the opposite. Deleting a stakeholder's
       * round-1 row destroyed their membership AND their Identity Platform
       * account while their approved follow-up was still open — they then got
       * a 403 on sign-in with no way back through the UI.
       *
       * It never showed up in testing because the dev/CI DSN connects as the
       * database owner, which is not subject to the policy the way the runtime
       * app role is. Counting inside withTenant() — where the tenant context
       * actually exists — is the only place this question can be answered.
       */
      const outcome = await withTenant(ctx.tenantId, async (c) => {
        const iv = await c.query<{ state_module: string; interviewee_user_id: string | null; client_name: string }>(
          `SELECT state_module, interviewee_user_id, client_name FROM interviews WHERE id = $1`, [id]);
        if (!iv.rows[0]) return null;
        if (!clientAllowed(allowed, iv.rows[0].client_name)) return null;
        await c.query(`DELETE FROM module_state WHERE module = $1`, [iv.rows[0].state_module]);
        await c.query(`DELETE FROM interviews WHERE id = $1`, [id]);

        const userId = iv.rows[0].interviewee_user_id;
        let stillHasInterviews = false;
        if (userId) {
          // Same transaction, so this sees the row we just deleted as gone and
          // every OTHER interview of theirs as present.
          const rest = await c.query<{ n: string }>(
            `SELECT count(*) AS n FROM interviews
              WHERE interviewee_user_id = $1
                AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
            [userId]
          );
          stillHasInterviews = Number(rest.rows[0]?.n ?? 0) > 0;
        }
        return { userId, stillHasInterviews };
      });
      if (outcome === null) { reply.code(404).send({ error: "not_found" }); return; }
      const deleted = outcome.stillHasInterviews ? null : outcome.userId;
      if (deleted) {
        // Membership cleanup needs system access (memberships has no RLS).
        const removed = await withoutTenant(async (c) => {
          const r = await c.query(
            // No NOT EXISTS here any more: the question was already answered
            // inside the tenant transaction above, where it can be answered.
            `DELETE FROM memberships m
              WHERE m.user_id = $1 AND m.tenant_id = $2 AND m.role = 'interviewee'
              RETURNING m.user_id`,
            [deleted, ctx.tenantId]
          );
          if (!r.rows[0]) return null;
          const info = await c.query<{ uid: string; idp: string | null }>(
            `SELECT u.identity_platform_uid AS uid, t.idp_tenant_id AS idp
               FROM users u, tenants t WHERE u.id = $1 AND t.id = $2`,
            [deleted, ctx.tenantId]
          );
          return info.rows[0] ?? null;
        });
        // Their IdP login goes too (v5.22) — otherwise re-inviting the same
        // email later collides with the orphaned account. Best-effort: a
        // failure here must not undo the interview deletion.
        const devAuth = process.env.DEV_AUTH === "1" && process.env.NODE_ENV !== "production";
        if (removed?.idp && !devAuth) {
          try {
            const { getAuth } = await import("firebase-admin/auth");
            await getAuth().tenantManager().authForTenant(removed.idp).deleteUser(removed.uid);
          } catch (e) {
            req.log.warn({ err: e }, "IdP interviewee cleanup failed (non-fatal)");
          }
        }
      }
      return { ok: true };
    }
  );

  // ── Consultant: draft a follow-up agenda for a completed interview ────────
  // (NEXT_SESSION_SPEC.md #1 — must-have.) Agenda items are pulled from the
  // client's OTHER interviewees' findings for the latest engagement round —
  // findings already stored function-level ("observed condition", never
  // attributed to a name — see synthetic.ts's synthPrompt and
  // sanitizeEngagementForInterviewee's doc comment above), so drafting from
  // them carries no more attribution risk than the round-2+ context every
  // interviewee already receives. This interviewee's OWN prior findings are
  // excluded — a follow-up probes what OTHERS said, not a recap of their own
  // answers. The draft is NOT visible to the interviewee until a consultant
  // approves it via PATCH .../followup below (safeguard #2).
  app.post(
    "/api/interviews/:id/followup/draft",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { id } = req.params as { id: string };
      /*
       * v5.32.88: the consultant may name the dimensions (and add their own
       * topic) rather than accepting whatever the last round happened to
       * produce. A follow-up is a directed conversation; the draft should keep
       * the direction it is given.
       */
      const Body = z.object({
        dimensions: z.array(z.enum(["D1", "D2", "D3", "D4", "D5", "D6", "D7"])).max(7).optional(),
        note: z.string().max(1000).optional(),
      });
      const parsedBody = Body.safeParse(req.body ?? {});
      if (!parsedBody.success) { reply.code(400).send({ error: "invalid_input" }); return; }
      const wantDims = parsedBody.data.dimensions ?? null;
      const consultantNote = (parsedBody.data.note ?? "").trim();

      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      const result = await withTenant(ctx.tenantId, async (c) => {
        const parent = await c.query<{
          id: string; client_name: string; interviewee_name: string; interviewee_role: string;
          interviewee_user_id: string | null; status: string; depth: string;
        }>(
          // depth (v5.33.8) so the follow-up INHERITS it. A consultant who gave
          // this executive a quick screen in round 1 is unlikely to want a deep
          // dive from them in round 2, and inheriting is a better guess than the
          // column default. The consultant can still change it in the row
          // editor before approving the agenda.
          `SELECT id, client_name, interviewee_name, interviewee_role, interviewee_user_id, status, depth
             FROM interviews WHERE id = $1`,
          [id]
        );
        if (!parent.rows[0]) return "not_found" as const;
        const p = parent.rows[0];
        if (!clientAllowed(allowed, p.client_name)) return "not_found" as const;
        if (p.status !== "completed") return "not_completed" as const;
        if (!p.interviewee_user_id) return "no_login" as const;

        const norm = normClient(p.client_name);
        const idxRow = await c.query<{ value: { v: string } }>(
          `SELECT value FROM module_state WHERE module = 'workspace' AND key = 'vynora_engagement_index'`
        );
        let idx: Record<string, string> = {};
        try { idx = JSON.parse(idxRow.rows[0]?.value.v ?? "{}"); } catch { /* none yet */ }
        const code = idx[norm];

        let agenda: { dimension: string; text: string; evidence?: string[] }[] = [];
        if (code) {
          const engRow = await c.query<{ value: { v: string } }>(
            `SELECT value FROM module_state WHERE module = 'workspace' AND key = $1`,
            ["vynora_engagement_" + code]
          );
          if (engRow.rows[0]) {
            try {
              const eng = JSON.parse(engRow.rows[0].value.v) as {
                rounds?: {
                  roundNumber: number;
                  interviews?: {
                    role?: string; sourceInterviewId?: string;
                    interviewee?: string; name?: string;
                    scores?: Record<string, number>;
                    findings?: { dimension?: string; text?: string }[];
                  }[];
                }[];
              };
              /*
               * WHICH ROUND THIS DRAFTS FROM (v5.32.87).
               *
               * This was `rounds[rounds.length - 1]` — the last element of the
               * ARRAY, not the highest round number. The two are not the same,
               * which is the entire reason `sortRounds` exists: v5.32.55 let a
               * consultant pin a round number at invite time, so a round can be
               * appended to the array out of order, and the repo's own
               * synthesis fixture is deliberately built `[2, 1]` for exactly
               * that case. On such an engagement the follow-up agenda was drawn
               * from the OLDER round's findings while presenting itself as the
               * latest picture.
               *
               * Nor is plain `latestRound()` right here. A round is created
               * EMPTY when a consultant plans it (see latestScoredRound's note
               * in scoring.ts), so the highest-numbered round is frequently one
               * nobody has been interviewed for — and drafting from it yields
               * no findings at all, dropping every follow-up to the generic
               * fallback item the moment the next round is planned.
               *
               * What this needs is the newest round that actually has something
               * to draft FROM: the highest-numbered round carrying at least one
               * finding. Both failure modes are silent — the agenda still
               * renders, it is just built from the wrong material — which is
               * why this is selected explicitly rather than by position.
               */
              const rounds = eng.rounds ?? [];
              const hasFindings = (r: { interviews?: { findings?: { dimension?: string; text?: string }[] }[] }) =>
                (r.interviews ?? []).some((x) => (x?.findings ?? []).some((f) => f?.dimension && f?.text));
              const ordered = sortRounds(rounds as never) as typeof rounds;
              let latest: (typeof rounds)[number] | undefined;
              for (let i = ordered.length - 1; i >= 0; i--) {
                if (hasFindings(ordered[i])) { latest = ordered[i]; break; }
              }
              // Nothing anywhere carries a finding: fall back to the newest
              // round so the shape of what follows is unchanged, and let the
              // empty-agenda fallback below do its job.
              if (!latest) latest = ordered[ordered.length - 1];
              if (latest) {
                /*
                 * THE INTERVIEWEE'S OWN PRIOR WORDS (v5.32.88).
                 *
                 * Collected across EVERY round, newest wins, so a follow-up
                 * after round 3 can still quote something said in round 1 if
                 * that is the last thing they said on the dimension.
                 *
                 * This is what makes a follow-up specific without raising a
                 * confidentiality question at all. The probe was generic
                 * precisely because the only specific material available was
                 * COLLEAGUES' — which cannot be shown, and is stripped at the
                 * bootstrap. Quoting somebody back to themselves discloses
                 * nothing, so it can go in the interviewee-facing `text`.
                 */
                const ownByDim = new Map<string, { text: string; round: number }>();
                const myName = String(p.interviewee_name ?? "").trim().toLowerCase();
                for (const rr of ordered) {
                  const rn = typeof rr.roundNumber === "number" ? rr.roundNumber : 0;
                  for (const iv of rr.interviews ?? []) {
                    /*
                     * ── WHOSE WORDS ARE THESE? (v5.33.4, audit 5332-8) ───────
                     *
                     * Everything in ownByDim ends up inside `probeFor`, which
                     * is INTERVIEWEE-FACING text of the form "Last time you
                     * said…". The entire justification for putting specific
                     * material there — see the note above — is that quoting
                     * somebody back to THEMSELVES discloses nothing.
                     *
                     * sourceInterviewId is the only field that actually
                     * identifies a person, and rounds recorded before it was
                     * stamped do not have it. The old fallback matched on ROLE
                     * alone, so on an engagement with two people in one role —
                     * divisional COOs, a second CTO — B's finding could be read
                     * back to A as A's own words. That is the same
                     * role-as-identity defect v5.32.86 fixed across the refresh
                     * pipeline and v5.33.2 fixed for mandatory questions.
                     *
                     * So the fallback now needs role AND name. When a legacy
                     * entry carries no name at all, identity cannot be
                     * established and the entry is SKIPPED: the follow-up falls
                     * back to its generic probe, which is what it did before
                     * v5.32.88 and is merely less specific. Being less specific
                     * costs a little polish; quoting the wrong colleague's
                     * words to somebody is a confidentiality failure.
                     */
                    let isThem: boolean;
                    if (iv.sourceInterviewId) {
                      isThem = iv.sourceInterviewId === p.id;
                    } else {
                      const ivName = String((iv as { name?: unknown }).name ?? "").trim().toLowerCase();
                      isThem = iv.role === p.interviewee_role && !!ivName && !!myName && ivName === myName;
                    }
                    if (!isThem) continue;
                    for (const f of iv.findings ?? []) {
                      if (!f.dimension || !f.text) continue;
                      const prev = ownByDim.get(f.dimension);
                      if (!prev || rn >= prev.round) ownByDim.set(f.dimension, { text: f.text, round: rn });
                    }
                  }
                }

                const byDim = new Map<string, string[]>();
                for (const iv of latest.interviews ?? []) {
                  // Their own prior answers — skip. Identity first: the merge
                  // stamps every round entry with the interview it came from,
                  // and that is the only field that actually identifies a
                  // person. Role was the sole test before, which both
                  // over-excluded (two executives sharing a title) and
                  // under-excluded (the same person recorded under a differently
                  // worded role).
                  if (iv.sourceInterviewId && iv.sourceInterviewId === p.id) continue;
                  if (!iv.sourceInterviewId && iv.role === p.interviewee_role) continue;
                  for (const f of iv.findings ?? []) {
                    if (!f.dimension || !f.text) continue;
                    const arr = byDim.get(f.dimension) ?? [];
                    if (arr.length < 2 && !arr.includes(f.text)) arr.push(f.text);
                    byDim.set(f.dimension, arr);
                  }
                }
                // One item per DIMENSION now, not one per finding: the item the
                // interviewee sees is a neutral probe about the dimension, so
                // several items carrying the same probe would be noise. The
                // colleagues' sentences ride along as consultant-only evidence.
                /*
                 * The consultant's dimensions win where they are given. A
                 * dimension they asked for that nobody has said anything about
                 * still gets an item — the point of naming it is to have it
                 * asked, and dropping it silently would be the opposite of
                 * "keeps the direction it is given".
                 */
                const dims = wantDims && wantDims.length
                  ? wantDims
                  : [...byDim.keys()];
                for (const dimension of dims) {
                  agenda.push({
                    dimension,
                    text: probeFor(dimension, ownByDim.get(dimension) ?? null, consultantNote),
                    evidence: byDim.get(dimension) ?? [],
                  });
                }
                agenda = agenda.slice(0, 8);
              }
            } catch { /* no usable engagement data yet */ }
          }
        }
        if (!agenda.length) {
          agenda = [{
            dimension: "D1",
            text: "Revisit this dimension with updated context from the wider engagement — no specific findings were available to draft from yet.",
          }];
        }

        // Reuse a still-pending (not yet approved) follow-up row if one
        // already exists for this parent, instead of stacking duplicates.
        const existing = await c.query<{ id: string }>(
          `SELECT id FROM interviews WHERE parent_interview_id = $1 AND agenda_status <> 'approved'
            ORDER BY created_at DESC LIMIT 1`,
          [id]
        );
        let followUpId: string;
        if (existing.rows[0]) {
          followUpId = existing.rows[0].id;
          await c.query(`UPDATE interviews SET agenda = $1, agenda_status = 'draft' WHERE id = $2`, [
            JSON.stringify(agenda), followUpId,
          ]);
        } else {
          const ins = await c.query<{ id: string }>(
            `INSERT INTO interviews
               (tenant_id, client_name, interviewee_name, interviewee_role,
                interviewee_user_id, status, state_module, created_by,
                kind, parent_interview_id, agenda, agenda_status, depth)
             VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                     $1, $2, $3, $4, 'invited', 'pending', $5,
                     'follow_up', $6, $7, 'draft', COALESCE($8, 'deep'))
             RETURNING id`,
            [p.client_name, p.interviewee_name, p.interviewee_role, p.interviewee_user_id,
              ctx.userId, id, JSON.stringify(agenda), p.depth ?? null]
          );
          followUpId = ins.rows[0].id;
          await c.query(`UPDATE interviews SET state_module = $1 WHERE id = $2`, [
            "iv_" + followUpId.replace(/-/g, ""), followUpId,
          ]);
        }
        return { id: followUpId, agenda };
      });
      if (result === "not_found") { reply.code(404).send({ error: "not_found" }); return; }
      if (result === "not_completed") {
        reply.code(409).send({ error: "parent_not_completed", detail: "The interview must be completed before requesting a follow-up." });
        return;
      }
      if (result === "no_login") {
        reply.code(409).send({ error: "no_login", detail: "This interview has no interviewee login to reuse for a follow-up." });
        return;
      }
      reply.code(201).send(result);
    }
  );

  // ── Consultant: edit and/or approve a follow-up agenda ─────────────────────
  // agenda_status flips to 'approved' ONLY here, on an explicit consultant
  // action — until then, GET /api/interviews/mine/bootstrap keeps returning
  // whatever interview the interviewee already had; this row stays invisible
  // to them (see the bootstrap/state-eligibility filter below).
  app.patch(
    "/api/interviews/:id/followup",
    { preHandler: requireRole("owner", "consultant") },
    async (req, reply) => {
      const ctx = req.ctx!;
      const { id } = req.params as { id: string };
      const body = z
        .object({
          agenda: z.array(z.object({
            dimension: z.string().min(1).max(20),
            // What the INTERVIEWEE will read. A consultant writing something
            // specific here is a deliberate disclosure decision; the drafted
            // default is neutral. See neutralAgendaProbe.
            text: z.string().min(1).max(2000),
            // Consultant-only. Accepted so an edit round-trips the item
            // whole instead of silently dropping the evidence the consultant
            // is judging it against. Never leaves the consultant side — see
            // projectAgendaForInterviewee at the bootstrap.
            evidence: z.array(z.string().max(2000)).max(5).optional(),
          })).min(1).max(20).optional(),
          approve: z.boolean().optional(),
          /* v5.33.8: settable in the same request that approves the agenda, so
           * the consultant reviewing what will be asked can also decide how long
           * it may take — which is the moment they are best placed to judge it,
           * having just read the agenda. */
          depth: Depth,
        })
        .safeParse(req.body);
      if (!body.success
          || (body.data.agenda === undefined && body.data.approve === undefined
              && body.data.depth === undefined)) {
        reply.code(400).send({ error: "invalid_input" });
        return;
      }
      const allowed = await allowedClientNorms(ctx.tenantId, ctx.userId, ctx.role);
      const n = await withTenant(ctx.tenantId, async (c) => {
        const cur = await c.query<{ client_name: string; kind: string }>(
          `SELECT client_name, kind FROM interviews WHERE id = $1`, [id]
        );
        if (!cur.rows[0] || cur.rows[0].kind !== "follow_up") return 0;
        if (!clientAllowed(allowed, cur.rows[0].client_name)) return 0;
        const r = await c.query(
          `UPDATE interviews SET
             agenda        = COALESCE($1, agenda),
             agenda_status = CASE WHEN $2::boolean IS TRUE THEN 'approved' ELSE agenda_status END,
             depth         = COALESCE($3, depth)
           WHERE id = $4`,
          [body.data.agenda ? JSON.stringify(body.data.agenda) : null, body.data.approve ?? null,
           body.data.depth ?? null, id]
        );
        return r.rowCount;
      });
      if (!n) { reply.code(404).send({ error: "not_found" }); return; }
      return { ok: true };
    }
  );

  // ── Interviewee: bootstrap (interview + sanitized context + own state) ────
  app.get("/api/interviews/mine/bootstrap", async (req, reply) => {
    const ctx = req.ctx!;
    const data = await withTenant(ctx.tenantId, async (c) => {
      // Eligibility: a follow-up row only becomes visible once a consultant
      // approves its agenda (agenda_status='approved') — see the PATCH
      // .../followup route above. Until then this query keeps returning
      // whatever interview the interviewee already had (typically their
      // completed initial one), so a drafted-but-unapproved follow-up is
      // completely invisible to them.
      const iv = await c.query(
        // interviewer_name / interviewer_voice (v5.32.47): the consultant's
        // choice has to reach the INTERVIEWEE's browser, and this bootstrap is
        // the only channel that goes there. Neither field is confidential —
        // the interviewee hears the voice and the name within seconds of
        // starting — so no sanitisation applies.
        // round_number (v5.32.65, audit V2-H3): the sanitiser needs to know
        // which round THIS interviewee belongs to in order to withhold it. It
        // is not returned to the browser by any path that did not already have
        // it — see the projection below.
        // depth (v5.33.8): the consultant's question budget. Like the
        // interviewer fields it is not confidential — the interviewee lives
        // through it — and this bootstrap is the only channel to their browser.
        `SELECT id, client_name, interviewee_name, interviewee_role, status, state_module,
                kind, agenda, parent_interview_id,
                interviewer_name, interviewer_voice, round_number, depth
           FROM interviews
          WHERE interviewee_user_id = $1 AND (kind = 'initial' OR agenda_status = 'approved')
          ORDER BY created_at DESC LIMIT 1`,
        [ctx.userId]
      );
      if (!iv.rows[0]) return null;
      const interview = iv.rows[0];

      // Sanitized slice of the consultant workspace: briefing context minus
      // consultant-only fields, plus engagement round data for continuity.
      // CLIENT-SCOPED: an interviewee only ever receives THEIR client's data
      // — never another customer's briefing, engagements, or sessions.
      /*
       * v5.32.58 SCALE. This used to be an unqualified
       *   SELECT key, value FROM module_state WHERE module = 'workspace'
       * — every client's briefing and every engagement blob for the whole firm,
       * loaded into the process and then filtered down in JavaScript to the ONE
       * client this interviewee belongs to.
       *
       * For a firm with forty clients whose engagement records run to megabytes
       * each, that is tens to hundreds of megabytes of heap per interviewee
       * PAGE LOAD, driven by the least-privileged role in the product. It is
       * also uncomfortable on principle: every other customer's material
       * transits the request, and the only thing keeping it out of the response
       * is a filter applied afterwards.
       *
       * The prefixes below are exactly what CONSULTANT_SAFE_PREFIXES admits, so
       * the SQL now does what the JS filter did, before the rows are read. The
       * JS filter stays as the authority on WHICH client — it is the security
       * boundary — but it is no longer also the size limit.
       */
      const ws = await c.query<{ key: string; value: { v: string } }>(
        `SELECT key, value FROM module_state
          WHERE module = 'workspace'
            AND (key LIKE 'vynora_briefing_%'
                 OR key LIKE 'vynora_engagement_%'
                 OR key = 'vynora_code_index')`
      );
      const raw: Record<string, string> = {};
      for (const row of ws.rows) {
        const k = row.key;
        if (BLOCKED_PREFIXES.some((p) => k.startsWith(p))) continue;
        if (!CONSULTANT_SAFE_PREFIXES.some((p) => k === p || k.startsWith(p))) continue;
        raw[k] = row.value.v;
      }
      const ownClient = new Set([normClient(interview.client_name)]);
      const scoped = filterWorkspaceState(raw, ownClient);
      const injected: Record<string, string> = {};
      for (const [k, v] of Object.entries(scoped)) {
        // V225-audit CRITICAL fix: vynora_engagement_<code> used to be sent
        // verbatim, leaking every other interviewee's attributed findings
        // (see sanitizeEngagementForInterviewee's doc comment above). The
        // index key (vynora_engagement_index) has a different shape
        // ({normClient: CODE}) and must NOT be routed through the sanitizer.
        injected[k] = k.startsWith("vynora_briefing_")
          ? sanitizeBriefing(v)
          : (k.startsWith("vynora_engagement_") && k !== "vynora_engagement_index")
          ? sanitizeEngagementForInterviewee(
              v,
              typeof (interview as { round_number?: unknown }).round_number === "number"
                ? (interview as { round_number: number }).round_number
                : null
            )
          : v;
      }

      // The interviewee's own saved session state (their private namespace).
      const st = await c.query<{ key: string; value: { v: string } }>(
        `SELECT key, value FROM module_state WHERE module = $1`, [interview.state_module]);
      const own: Record<string, string> = {};
      for (const row of st.rows) own[row.key] = row.value.v;

      // v5.32.65 (audit V2-M1). `agenda` items keep the colleagues' verbatim
      // findings as consultant-only `evidence`; the interviewee gets the
      // dimension and the neutral probe and nothing else. Stripped here, at the
      // one route that goes to an interviewee's browser, rather than trusted to
      // every future reader of the column.
      const safeInterview = {
        ...(interview as Record<string, unknown>),
        agenda: projectAgendaForInterviewee((interview as { agenda?: unknown }).agenda),
      };
      return { interview: safeInterview, injected, own };
    });
    if (!data) { reply.code(404).send({ error: "no_interview_assigned" }); return; }
    return data;
  });

  // ── Interviewee: persist own session state ────────────────────────────────
  app.put("/api/interviews/mine/state", async (req, reply) => {
    const ctx = req.ctx!;
    // v5.32.29 (audit M-7). z.record caps each VALUE at 2 MB and capped
    // neither the key count nor the key length, while the whole insert loop
    // runs inside one withTenant() transaction holding one of ten pool
    // connections — and this route has no rate limit. Ten concurrent requests
    // with thousands of keys each took every connection and stalled every
    // DB-backed route in the process, including the auth membership lookup.
    // An interview's scratch space is a handful of keys; 200 is generous.
    const body = z
      .object({
        sets: z.record(z.string().max(2_000_000)).default({}),
        deletes: z.array(z.string().max(512)).max(200).default([]),
      })
      .refine((b) => Object.keys(b.sets).length <= 200, { message: "too_many_keys" })
      .refine((b) => Object.keys(b.sets).every((k) => k.length <= 512), { message: "key_too_long" })
      .safeParse(req.body);
    if (!body.success) { reply.code(400).send({ error: "invalid_input" }); return; }
    const result = await withTenant(ctx.tenantId, async (c) => {
      const iv = await c.query<{ id: string; state_module: string; status: string }>(
        `SELECT id, state_module, status FROM interviews
          WHERE interviewee_user_id = $1 AND (kind = 'initial' OR agenda_status = 'approved')
          ORDER BY created_at DESC LIMIT 1`,
        [ctx.userId]
      );
      if (!iv.rows[0]) return "not_found" as const;
      const { id, state_module, status } = iv.rows[0];
      // V225-audit LOW fix: this used to write unconditionally regardless
      // of status — an interviewee who already hit POST .../mine/complete
      // could still PUT further state changes afterward, silently mutating
      // session data (answers, findings) the consultant may already be
      // relying on as final. `already_completed` is returned as a distinct
      // sentinel (not the generic `ok: true`) so the frontend can surface
      // it rather than silently pretending the save succeeded.
      if (status === "completed") return "already_completed" as const;
      for (const [key, v] of Object.entries(body.data.sets)) {
        await c.query(
          `INSERT INTO module_state (tenant_id, module, key, value, updated_by)
           VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4)
           ON CONFLICT (tenant_id, module, key)
           DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [state_module, key, JSON.stringify({ v }), ctx.userId]
        );
      }
      if (body.data.deletes.length) {
        await c.query(`DELETE FROM module_state WHERE module = $1 AND key = ANY($2::text[])`, [
          state_module, body.data.deletes,
        ]);
      }
      if (status === "invited") {
        await c.query(`UPDATE interviews SET status = 'in_progress', started_at = now() WHERE id = $1`, [id]);
      }
      return "ok" as const;
    });
    if (result === "not_found") { reply.code(404).send({ error: "no_interview_assigned" }); return; }
    if (result === "already_completed") {
      reply.code(409).send({ error: "interview_already_completed", detail: "This interview is already marked complete; further changes aren't saved." });
      return;
    }
    return { ok: true };
  });

  // ── Interviewee: finish ───────────────────────────────────────────────────
  // Also runs the tracker → Synthesis auto-flow (see tenant/engagementMerge.ts):
  // folds this interviewee's own private session into the firm's shared
  // engagement record in the SAME transaction as marking the interview
  // completed, so it shows up in the Synthesis Dashboard immediately — no
  // manual "Session" JSON download + import. Best-effort: a merge failure is
  // logged but never undoes the completion itself (the interviewee's answers
  // are never lost even if the fold-in has a problem; a consultant can still
  // pull the raw session via GET /api/interviews/:id/state as before).
  app.post("/api/interviews/mine/complete", async (req, reply) => {
    const ctx = req.ctx!;
    const result = await withTenant(ctx.tenantId, async (c) => {
      const upd = await c.query<{
        id: string; state_module: string; kind: string;
        parent_interview_id: string | null; client_name: string;
        interviewee_role: string; interviewee_name: string;
        round_number: number | null;
      }>(
        `UPDATE interviews SET status = 'completed', completed_at = now()
          WHERE id = (
            SELECT id FROM interviews
             WHERE interviewee_user_id = $1 AND status <> 'completed'
               -- v5.32.25: the bootstrap and state routes both gate on
               -- "initial, or a follow-up the consultant has approved"; this
               -- one didn't, so an interviewee could mark a DRAFTED-but-
               -- unapproved follow-up complete — neutralising it before the
               -- consultant ever saw it, and showing it as done in the tracker
               -- with no session data behind it.
               AND (kind = 'initial' OR agenda_status = 'approved')
             ORDER BY created_at DESC LIMIT 1
          )
         RETURNING id, state_module, kind, parent_interview_id, client_name,
                   interviewee_role, interviewee_name, round_number`,
        [ctx.userId]
      );
      if (!upd.rows[0]) return "not_found" as const;
      const { id, state_module, kind, parent_interview_id, client_name,
              interviewee_role, interviewee_name, round_number } = upd.rows[0];

      try {
        const st = await c.query<{ key: string; value: { v: string } }>(
          `SELECT key, value FROM module_state WHERE module = $1`, [state_module]
        );
        const raw: Record<string, string> = {};
        for (const row of st.rows) raw[row.key] = row.value.v;
        const session = pickLatestSession(raw);
        if (session) {
          // v5.32.25 SECURITY. This used to be:
          //     if (!session.client) session.client = client_name;
          //     const norm = normClient(session.client);
          // i.e. the interviewee's OWN session blob decided which client's
          // engagement got written. That blob is writable via
          // PUT /api/interviews/mine/state, whose schema is
          // z.record(z.string()) — no key or value validation — and this route
          // has no requireRole and no clientAllowed check. So an interviewee
          // at client Beta could set {"client":"Acme Corp","stakeholderRole":"CEO"}
          // and, because mergeSessionIntoEngagement upserts BY ROLE, replace
          // Acme's real CEO interview: their findings deleted, the round scores
          // recomputed, and the result flowing into Synthesis, the scorecard,
          // the roadmap and the client deck. It also allowed minting brand-new
          // clients in vynora_engagement_index.
          //
          // The interview ROW is the only trustworthy source of which client
          // this person was invited to talk about — it is set by the
          // consultant at invite time and returned by the UPDATE above. The
          // sibling follow-up route already did this correctly (see
          // `clientAllowed(allowed, p.client_name)` earlier in this file);
          // this one didn't.
          // v5.32.29 SECURITY (audit CR-2). v5.32.25 pinned the CLIENT here
          // and stopped there, which closed the cross-client half of this hole
          // and left the same-client half wide open: role and name are the
          // upsert identity, so an interviewee could still claim to be the CEO
          // and replace that interview outright. Verified before the fix —
          // the real CEO's findings were overwritten and the round score moved
          // 2.0 to 5.0, with nothing written to audit_log.
          //
          // All three now come from the interview ROW, which the consultant
          // set at invite time. See sanitizeIntervieweeSession() for what else
          // the blob is no longer allowed to assert.
          const session2 = sanitizeIntervieweeSession(session, {
            client: client_name,
            role: interviewee_role,
            name: interviewee_name,
          });

          /*
           * Persist the TRANSCRIPT as an auditable record (v5.32.58).
           *
           * Until now the only copy lived inside the session blob in the
           * interview's private namespace, and it was deleted with the
           * interview. The engagement record that Synthesis and the client
           * document read carries scores and findings and no transcript at
           * all — so the evidence behind a number in a board deck was one hop
           * further away than anyone assumed, and one DELETE from gone.
           *
           * Written in the SAME transaction as the merge, from the same
           * sanitised session, so a transcript cannot exist for an interview
           * that did not complete or disagree with the scores it produced.
           * Best-effort in the sense that a failure here must not fail the
           * completion — the interviewee has finished either way — but it is
           * logged loudly rather than swallowed.
           */
          try {
            const dm = Array.isArray((session2 as Record<string, unknown>).displayMessages)
              ? ((session2 as Record<string, unknown>).displayMessages as Array<Record<string, unknown>>)
              : [];
            const turns = dm
              .map((m, i) => ({
                who: m.role === "user" ? "Interviewee" : m.role === "ai" ? "Interviewer" : String(m.role ?? ""),
                text: String(m.text ?? ""),
                at: typeof m.at === "number" ? m.at : null,
                // v5.32.66: position in the ORIGINAL displayMessages array.
                // Score events anchor on that index, and this filter drops
                // empty messages — without keeping the original index every
                // anchor after the first blank message would point one turn
                // too far down.
                idx: i,
              }))
              .filter((t) => t.text.trim().length > 0);
            if (turns.length) {
              // The realtime path never writes `messages`; the text path always
              // does. That is the only reliable signal for which one ran, and a
              // reviewer reading a flat exchange should know which they have.
              const mode = Array.isArray((session2 as Record<string, unknown>).messages)
                && ((session2 as Record<string, unknown>).messages as unknown[]).length > 0
                ? "text" : "voice";
              /*
               * v5.32.66. The words alone never answered the question people
               * actually ask, which is "why is this dimension a 2.4". The
               * findings and the score movements go in beside them — see
               * migration 023 and tenant/transcriptEvidence.ts.
               */
              const evidence = transcriptEvidenceFor(session2 as unknown as Record<string, unknown>);
              await c.query(
                `INSERT INTO interview_transcripts
                   (tenant_id, interview_id, client_name, interviewee_name, interviewee_role,
                    round_number, turns, turn_count, mode, findings, score_events)
                 VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                         $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb)`,
                [id, client_name, interviewee_name, interviewee_role,
                 round_number ?? null, JSON.stringify(turns), turns.length, mode,
                 // NULL rather than [] when there is nothing: "this interview
                 // predates the journal" and "this interview found nothing" are
                 // different facts and the UI says which.
                 evidence.findings.length ? JSON.stringify(evidence.findings) : null,
                 evidence.scoreEvents.length ? JSON.stringify(evidence.scoreEvents) : null]
              );
            }
          } catch (tErr) {
            req.log.error({ err: tErr, interviewId: id }, "transcript capture failed");
          }
          const norm = normClient(client_name);

          const idxRow = await c.query<{ value: { v: string } }>(
            `SELECT value FROM module_state WHERE module = 'workspace' AND key = 'vynora_engagement_index'`
          );
          let idx: Record<string, string> = {};
          try { idx = JSON.parse(idxRow.rows[0]?.value.v ?? "{}"); } catch { /* fresh */ }
          let code = idx[norm];

          let eng: EngagementRecord | null = null;
          if (code) {
            const engRow = await c.query<{ value: { v: string } }>(
              `SELECT value FROM module_state WHERE module = 'workspace' AND key = $1`,
              ["vynora_engagement_" + code]
            );
            if (engRow.rows[0]) {
              try {
                eng = JSON.parse(engRow.rows[0].value.v);
              } catch (parseErr) {
                /*
                 * v5.32.58 DATA LOSS. This used to swallow the error and carry
                 * on with `eng = null`, which makes mergeSessionIntoEngagement
                 * construct a BRAND NEW record — and the upsert below then
                 * writes it over the same key. Every prior round, every
                 * interview, every finding for that client: gone, with a
                 * single req.log.warn as the only trace, triggered by nothing
                 * more than a truncated write or a bad character.
                 *
                 * An unreadable engagement is not a reason to destroy it. Fail
                 * the completion instead: the interviewee's own session is
                 * safe in its private namespace, the interview row stays
                 * completed, and the merge can be retried once someone has
                 * looked at the record. Losing a merge is recoverable; losing
                 * the engagement is not.
                 */
                req.log.error({ err: parseErr, code },
                  "engagement record is unreadable — refusing to overwrite it with a fresh one");
                throw new Error("engagement_record_unreadable");
              }
            }
          }
          /*
           * v5.32.59 (F8). If the index has no entry for this client — or has
           * one pointing at a record that is gone — this used to mint a BRAND
           * NEW engagement code on the spot.
           *
           * The index is a convenience map and it goes stale routinely: a
           * client rename rewrites it, an imported snapshot arrives without
           * it, and synthesis.html carries its own repair code for exactly
           * this. So a client with three completed rounds under ACME-1 could
           * have their fourth interview land in a fresh ACME-9F2C — and then
           * the portfolio scorecard lists "Acme" twice, with two different
           * maturity scores, neither of which is the whole picture. Nothing
           * warns anybody, because from each record's point of view it is
           * internally consistent.
           *
           * engagementLookup.resolveEngagementCode has scanned the records
           * themselves as a fallback since v5.32.21; this path never did.
           * Scan first, mint only when there genuinely is no record for this
           * client, and repair the index either way.
           */
          if (!code || !eng) {
            const scan = await c.query<{ key: string; value: { v: string } }>(
              `SELECT key, value FROM module_state
                WHERE module = 'workspace'
                  AND key LIKE 'vynora_engagement_%'
                  AND key <> 'vynora_engagement_index'`
            );
            for (const row of scan.rows) {
              let rec: EngagementRecord | null = null;
              // A record we cannot read is not a match, but it is also not a
              // reason to fail someone else's completion — skip it. The
              // unreadable-record guard above already protects the ONE record
              // we were pointed at.
              try { rec = JSON.parse(row.value.v) as EngagementRecord; } catch { continue; }
              if (!rec) continue;
              const name = String(rec.client ?? (rec as Record<string, unknown>).clientName ?? "");
              if (!name || normClient(name) !== norm) continue;
              const foundCode = rec.code ?? row.key.replace("vynora_engagement_", "");
              if (!foundCode) continue;
              code = foundCode;
              eng = rec;
              idx[norm] = code;
              req.log.warn({ client: client_name, code },
                "engagement index was stale — adopted the existing record instead of minting a duplicate");
              break;
            }
          }
          if (!code) {
            code = (client_name.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4) || "ENG") +
              "-" + id.replace(/-/g, "").slice(0, 4).toUpperCase();
            idx[norm] = code;
          }

          const merged = mergeSessionIntoEngagement(eng, code, session2, {
            sourceInterviewId: id,
            kind: kind === "follow_up" ? "follow_up" : "initial",
            parentInterviewId: parent_interview_id,
            // v5.32.55: the round the CONSULTANT invited this interview for.
            // Without it a second diagnostic of the same executive resolved to
            // the same round entry as the first and replaced it.
            roundNumber: round_number ?? null,
          });

          const upsert = async (key: string, value: string) => {
            await c.query(
              `INSERT INTO module_state (tenant_id, module, key, value, updated_by)
               VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid, 'workspace', $1, $2, $3)
               ON CONFLICT (tenant_id, module, key)
               DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
              [key, JSON.stringify({ v: value }), ctx.userId]
            );
          };
          await upsert("vynora_engagement_index", JSON.stringify(idx));
          await upsert("vynora_engagement_" + code, JSON.stringify(merged));
        }
      } catch (e) {
        req.log.warn({ err: e }, "engagement auto-merge failed (interview still marked completed)");
      }
      return "ok" as const;
    });
    if (result === "not_found") { reply.code(404).send({ error: "no_open_interview" }); return; }
    return { ok: true };
  });
}
