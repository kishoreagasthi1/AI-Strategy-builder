/**
 * Realtime voice sessions for the Interview Agent (v5.32.32).
 *
 * ── Why this file exists, and why it is shaped this way ─────────────────────
 *
 * The batch TTS path (llm/tts.ts) sounds like someone READING, because that is
 * literally what it is: an LLM writes consultant prose, a TTS model reads it.
 * No amount of voice tuning fixes the three things that actually make a voice
 * conversation feel alive — barge-in, turn-taking latency, and prosody that
 * carries across a whole thought rather than resetting at each chunk. Those
 * need a duplex connection to a speech-native model.
 *
 * ── The architectural fork, and the security problem it creates ─────────────
 *
 * There are two ways to give a browser a duplex connection to Gemini Live:
 *
 *   (A) PROXY through Cloud Run. Every audio frame in both directions crosses
 *       our container. Attractive because nothing changes about metering — we
 *       see every byte. Rejected on three grounds:
 *         · Cloud Run bills an instance as active for the whole time a
 *           WebSocket is open, so a 45-minute interview pins an instance for
 *           45 minutes, per concurrent interview;
 *         · Cloud Run's request timeout caps a connection at 60 minutes, and
 *           interviews legitimately run longer;
 *         · session affinity is explicitly best-effort, so a reconnect can
 *           land on a different instance mid-interview.
 *
 *   (B) DIRECT browser → Google, authorised by an EPHEMERAL TOKEN this server
 *       mints. Google recommends exactly this for production rather than
 *       shipping an API key to a client. No audio crosses our infrastructure,
 *       no instance is pinned, no timeout ceiling, no affinity problem.
 *
 * (B) is the right transport. But it moves money OUTSIDE our request path, and
 * that is the same shape as audit CR-3 — the finding that an interviewee, the
 * least-privileged role in the product, could bill a firm without limit. Once
 * a session is live we cannot refuse a single frame of it. Our entire spend
 * story so far has been "check the cap, then do one bounded thing"; a live
 * session is unbounded by construction.
 *
 * So the token is not a key. It is a BUDGETED GRANT, and every field below is
 * a bound on blast radius rather than a convenience:
 *
 *   · checkLimit() runs BEFORE minting, so a firm over its monthly cap or a
 *     user over their daily cap never gets a session at all.
 *   · A reservation is written to usage_events at mint time for the maximum
 *     the session could possibly cost (see reserveTokensFor). The budget is
 *     therefore spent the moment it is granted, not when it is consumed — this
 *     is the reserve-then-commit pattern the architecture doc names as the
 *     proper fix for the metering TOCTOU gap, and a live session is the first
 *     place we genuinely cannot avoid it. Ten concurrent sessions cannot each
 *     see a budget the other nine have already committed to spending.
 *   · uses: 1 — the token initiates exactly one session. A leaked token cannot
 *     be fanned out.
 *   · newSessionExpireTime — a short window to START. A token stolen from a
 *     browser five minutes later is already dead.
 *   · expireTime — a hard ceiling on session length, which is the real cost
 *     bound: audio output is the expensive direction and it is billed by time.
 *   · liveConnectConstraints pins the MODEL and the response modality at mint
 *     time. Without this a stolen token could be pointed at a more expensive
 *     model, and our reservation arithmetic — which assumes a known per-second
 *     rate — would silently understate the real spend.
 *
 * The residual gap is honest and worth stating: reconciliation depends on the
 * client reporting its final usage, and a hostile client can under-report. The
 * reservation is what makes that survivable — under-reporting can only ever
 * REFUND budget that was already committed, never overspend it. A client that
 * reports nothing at all simply forfeits the whole reservation, which is the
 * safe direction.
 */
import type { LimitCheck, Meter, Payer } from "./gateway.js";
import { estimateCost } from "./types.js";
import { withTenant } from "../db/pool.js";

/**
 * Gemini bills Live audio by tokens, and audio tokenises at a fixed rate over
 * time rather than by content — roughly 25 tokens per second in each
 * direction. That is what makes a duration cap into a spend cap, and it is the
 * only reason a reservation can be computed at all.
 */
export const AUDIO_TOKENS_PER_SECOND = 25;

/** Hard ceiling on one interview session. Also the spend bound — see above. */
export const MAX_SESSION_SECONDS = 45 * 60;

/**
 * Default length of a granted session, and therefore the size of the HOLD.
 *
 * v5.32.44: was MAX_SESSION_SECONDS. A 45-minute grant holds 135,000 tokens —
 * about $1.42 — the instant it is issued, and a twenty-second test
 * conversation was billed exactly that. Fifteen minutes covers most of an
 * interview segment at a third of the exposure, and the client extends by
 * simply starting another session when it lapses.
 */
export const DEFAULT_SESSION_SECONDS = Number(process.env.VYNE_LIVE_DEFAULT_SECONDS || 15 * 60);

/**
 * Task names. These are load-bearing, not labels.
 *
 * HOLD and HOLD_RELEASE are an INTERNAL budget mechanism — they bound what a
 * session could cost before it runs. They must never reach a client invoice,
 * because a hold is not something the client consumed. TASK_ACTUAL is the real
 * measured usage and is the only one of the three that is billable.
 */
export const TASK_HOLD = "live_session_hold";
export const TASK_HOLD_RELEASE = "live_session_hold_release";
export const TASK_ACTUAL = "live_session";
/**
 * Task names used by the FIRST version of the hold mechanism (v5.32.32–.43).
 * Rows carrying these already exist in usage_events on live deployments, and
 * they are holds — so they must be excluded from invoices exactly like the
 * current names, or a client keeps seeing a $1.42 pre-authorisation on their
 * statement forever.
 *
 * Excluding them here rather than rewriting the rows is deliberate: nothing is
 * destroyed, the history stays auditable, and it takes effect the moment this
 * deploys. The trade-off is that the small amount of REAL usage buried in those
 * old paired rows (a partial refund left the net = actual) drops off the
 * invoice too. That is a few cents of development testing, and undercounting a
 * test is much better than billing a client for a reservation.
 */
export const LEGACY_HOLD_TASKS = ["live_session_reserve", "live_session_refund"];

/** Every internal, non-billable task — one list, used by billing and metering. */
export const NON_BILLABLE_TASKS = [TASK_HOLD, TASK_HOLD_RELEASE, ...LEGACY_HOLD_TASKS];

/**
 * Selectable interviewer voices.
 *
 * Google documents each voice's CHARACTER (bright, firm, breezy) but does not
 * publish a gender. The `presents` field below is therefore an observation, not
 * a specification — it is there so a consultant can find a suitable voice
 * quickly, and the UI says as much rather than claiming Google's authority. Two
 * people may hear the same voice differently; auditioning is the only real test.
 *
 * This is an ALLOWLIST, not a suggestion. The voice arrives from the browser,
 * and an unvalidated string would be passed straight into the token constraint —
 * so anything not on this list is refused and the default is used instead.
 */
export const VOICES: ReadonlyArray<{ id: string; presents: "female" | "male"; character: string }> = [
  { id: "Aoede",        presents: "female", character: "breezy" },
  { id: "Kore",         presents: "female", character: "firm" },
  { id: "Zephyr",       presents: "female", character: "bright" },
  { id: "Leda",         presents: "female", character: "youthful" },
  { id: "Callirrhoe",   presents: "female", character: "easy-going" },
  { id: "Autonoe",      presents: "female", character: "bright" },
  { id: "Despina",      presents: "female", character: "smooth" },
  { id: "Erinome",      presents: "female", character: "clear" },
  { id: "Achernar",     presents: "female", character: "soft" },
  { id: "Vindemiatrix", presents: "female", character: "gentle" },
  { id: "Sulafat",      presents: "female", character: "warm" },
  { id: "Charon",       presents: "male",   character: "informative" },
  { id: "Puck",         presents: "male",   character: "upbeat" },
  { id: "Orus",         presents: "male",   character: "firm" },
  { id: "Iapetus",      presents: "male",   character: "clear" },
  { id: "Umbriel",      presents: "male",   character: "easy-going" },
  { id: "Algieba",      presents: "male",   character: "smooth" },
  { id: "Rasalgethi",   presents: "male",   character: "informative" },
  { id: "Alnilam",      presents: "male",   character: "firm" },
  { id: "Schedar",      presents: "male",   character: "even" },
  { id: "Achird",       presents: "male",   character: "friendly" },
  { id: "Sadaltager",   presents: "male",   character: "knowledgeable" },
];

const VOICE_IDS = new Set(VOICES.map((v) => v.id));
/** Refuse anything not on the allowlist rather than forwarding it to Google. */
export function resolveVoice(requested: string | undefined, fallback: string): string {
  return requested && VOICE_IDS.has(requested) ? requested : fallback;
}
/**
 * The same allowlist, asked as a question rather than applied as a substitution.
 *
 * resolveVoice() falls back silently, which is right at MINT time — a live
 * session must not fail to open because of a stale voice id. It is wrong at
 * WRITE time: a consultant saving a voice against an interview deserves to be
 * told the id is not real, instead of discovering weeks of interviews later
 * that every one of them ran on the default. One source of truth, two
 * deliberately different failure modes.
 */
export function isKnownVoice(id: string): boolean {
  return VOICE_IDS.has(id);
}

/** How long the client has to actually OPEN the session after minting. */
export const START_WINDOW_SECONDS = 60;

export interface LiveSessionOptions {
  apiKey: string | undefined;
  model?: string;
  voice?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Same meaning as tts.ts / geminiAiStudio.ts: true when the key is billed. */
  paidTier?: boolean;
  /** Pin a thinkingBudget into the token (0 = no thinking). Defaults to
   *  GEMINI_LIVE_THINKING_BUDGET; unset leaves the model's default. */
  thinkingBudget?: number;
}

export interface LiveSessionGrant {
  /** The ephemeral token the browser presents to Google. Never our API key. */
  token: string;
  model: string;
  voice: string;
  /** Wall-clock ceiling the client must enforce locally, and we enforce by expiry. */
  maxSeconds: number;
  /** Echoed so the client can show the user how long they have. */
  expiresAt: string;
  /** Correlates the reservation with the later reconciliation. */
  sessionId: string;
  /** True when the model, modality and persona are frozen into the token.
   *  False means the API rejected the constraint field and the caller must
   *  supply the system instruction in the client setup frame instead. */
  pinned: boolean;
  /** The thinking budget actually pinned, when one was configured AND the
   *  API accepted it. Echoed so the client trace can show it. */
  thinkingBudget?: number;
  /** Which optional setup fields the token actually carries (v5.34.24). */
  pinnedExtras?: { transcription: boolean; manualVad: boolean; vad?: Record<string, unknown>;
                   resumption?: boolean; compression?: Record<string, unknown>; resumed?: boolean };
}

/**
 * Worst-case token cost of a session of `seconds`, counting BOTH directions at
 * the full rate. Real sessions are nowhere near this — nobody talks and
 * listens simultaneously for the entire duration — which is the point: a
 * reservation must be an upper bound to be safe, and the excess is refunded on
 * reconciliation.
 */
export function reserveTokensFor(seconds: number): { tokensIn: number; tokensOut: number } {
  return {
    tokensIn: seconds * AUDIO_TOKENS_PER_SECOND,
    tokensOut: seconds * AUDIO_TOKENS_PER_SECOND,
  };
}

/**
 * Models this account actually exposes for bidiGenerateContent.
 *
 * Enumerated from the live account, not guessed — the same list
 * test/liveSession.test.ts prices. It is a WARNING list, not an allowlist:
 * Google adds Live models faster than we redeploy, and refusing an unknown id
 * outright would take voice down the day we wanted to adopt one. What it buys
 * is a loud line in the logs at boot, which is the thing that was missing.
 */
export const LIVE_CAPABLE_MODELS: readonly string[] = [
  "gemini-2.5-flash-native-audio-latest",
  "gemini-2.5-flash-native-audio-preview-09-2025",
  "gemini-2.5-flash-native-audio-preview-12-2025",
  "gemini-3.1-flash-live-preview",
];

/**
 * The model a live session runs on when nothing overrides it.
 *
 * v5.34.18: was "gemini-live-2.5-flash-preview", which is NOT one of the models
 * this account exposes for bidiGenerateContent. It MINTS a token perfectly
 * happily — so every check on our side passes — and is then rejected by the
 * WebSocket on every endpoint variant, because a name Google cannot resolve as
 * a public model falls through to a project-scoped (tuned-model) lookup that an
 * ephemeral token by construction cannot perform:
 *
 *   1007 — token-based requests cannot use project-scoped features such as
 *          tuned models
 *
 * The client then falls back to text + TTS, which is a WORKING interview in a
 * robotic voice — so nothing alerts, and the failure is only discoverable by
 * listening. The correct value was carried solely as a hand-set Cloud Run env
 * var (see HANDOFF_2026-09-08.md), documented as "a fresh deploy does NOT
 * restore this automatically". That is one forgotten variable away from every
 * interview silently losing its voice, and it is not a state the default should
 * make reachable. The default is now the value production actually uses; the
 * env var remains, for pinning a newer model without a redeploy.
 */
export const DEFAULT_LIVE_MODEL = "models/gemini-2.5-flash-native-audio-latest";

/** Bare id, however the name was written — the price table is keyed bare. */
function bareModelId(m: string): string {
  return m.startsWith("models/") ? m.slice(7) : m;
}

export function makeLiveSession(opts: LiveSessionOptions) {
  const model = opts.model ?? process.env.GEMINI_LIVE_MODEL ?? DEFAULT_LIVE_MODEL;
  const voice = opts.voice ?? process.env.GEMINI_LIVE_VOICE ?? "Aoede";
  // Say so at boot rather than at the first interview. A model the Live socket
  // refuses costs a real conversation to discover, and the symptom (a robotic
  // voice) points at TTS rather than at this line.
  if (!LIVE_CAPABLE_MODELS.includes(bareModelId(model))) {
    console.warn(
      `[liveSession] GEMINI_LIVE_MODEL="${model}" is not a known bidiGenerateContent model. ` +
      `Live voice may mint tokens successfully and then be rejected by the WebSocket ` +
      `(close 1007/1008), falling back to TTS silently. Known-good: ${LIVE_CAPABLE_MODELS.join(", ")}.`
    );
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com";

  return {
    isConfigured: () => Boolean(opts.apiKey),
    model,
    voice,
    /** See tts.ts — the free-tier production lockdown applies here too. */
    freeTier: !opts.paidTier,

    /**
     * Mint a single-use, model-pinned, time-bounded token.
     *
     * `liveConnectConstraints` is the load-bearing part: it freezes the model
     * and the response modality into the token itself, so the grant cannot be
     * redirected to something we did not price.
     */
    async mint(sessionId: string, maxSeconds: number, systemInstruction?: string, requestedVoice?: string,
               mintOpts?: { manualVad?: boolean; resumeHandle?: string }): Promise<LiveSessionGrant> {
      const useVoice = resolveVoice(requestedVoice, voice);
      const now = Date.now();
      const expireTime = new Date(now + maxSeconds * 1000).toISOString();
      const newSessionExpireTime = new Date(now + START_WINDOW_SECONDS * 1000).toISOString();

      /**
       * The REST shape of this endpoint is not publicly documented, and the
       * SDK's friendly field names do not match the proto. Verified against
       * the live API: a body carrying `liveConnectConstraints` is rejected with
       *   400 Unknown name "liveConnectConstraints" at 'auth_token'
       * so the constraint field is named something else (or is absent) on this
       * API version.
       *
       * Rather than guess and redeploy, try the constrained form and fall back
       * to a plain token when the field is rejected. Both are correct tokens;
       * the difference is only whether the model, modality and persona are
       * PINNED server-side. When we cannot pin them, `pinned` comes back false
       * and the caller must send the system instruction in the client setup
       * frame instead — functional, but weaker, so it is logged as such.
       */
      const base: Record<string, unknown> = { uses: 1, expireTime, newSessionExpireTime };

      /*
       * The shape below is read off Google's own SDK, not guessed.
       *
       * Source: @google/genai 2.16.0, dist/index.cjs.
       *   - liveConnectConstraintsToMldev() writes the caller's constraints to
       *     the wire field `bidiGenerateContentSetup` (line 23252).
       *   - convertBidiSetupToTokenSetup() then FLATTENS it: if the value has a
       *     `setup` key, the value is REPLACED by that inner setup object
       *     (line 23713). So what actually goes on the wire is the
       *     BidiGenerateContentSetup itself — model, generationConfig,
       *     systemInstruction — with no wrapper.
       *
       * v5.32.53. This used to send `{ model, config: {...} }`. `config` is not
       * a field of BidiGenerateContentSetup, so the request was rejected with
       * "Unknown name", the retry loop fell through to an unconstrained token,
       * and `pinned` came back false on every single session. The voice and the
       * persona then had to travel client-side — which is why this whole
       * feature depended on a code path that was only ever meant to be a
       * fallback.
       *
       * Same nesting rule as the browser's setup frame: speechConfig lives
       * under generationConfig, NOT beside it.
       */
      const thinkingBudget = liveThinkingBudget(opts.thinkingBudget);
      const manualVad = !!mintOpts?.manualVad;
      /*
       * v5.34.24: EXTRAS pinned into the token, not left to the browser's setup
       * frame. A production trace (5.34.23) showed 22 s of agent audio with
       * ZERO outputTranscription frames although the client's setup asked for
       * both transcriptions — i.e. on the constrained endpoint the client's
       * setup fields are not reliably honoured; what the token carries is what
       * the session runs with. So the transcriptions (the transcript IS the
       * product) and, when asked, the manual-VAD switch travel in the token.
       * Unknown-field rejections drop the extras before they drop the pin.
       */
      const vad = liveVadConfig(manualVad);
      const resumeHandle = (mintOpts?.resumeHandle || "").trim() || undefined;
      /*
       * v5.34.29: two more extras, both documented Live API session controls.
       *
       * contextWindowCompression (sliding window): without it an audio-only
       * session is hard-capped at 15 minutes and its context grows without
       * bound — which is the "slowed down after 7-8 minutes" report: every
       * reply re-reads a longer history. The sliding window keeps the context
       * bounded and lifts the cap.
       *
       * sessionResumption: the server hands the client a handle
       * (sessionResumptionUpdate) that a NEW connection can present to carry
       * the conversation over. Connections die at ~10 minutes regardless; with
       * a handle the renewal keeps the interview's memory instead of starting
       * Jack from a blank slate with a "connection was renewed" nudge.
       */
      const compression = liveCompressionConfig();
      const resumptionOn = liveResumptionEnabled();
      const extrasFor = () => ({
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        ...(compression ? { contextWindowCompression: compression } : {}),
        ...(resumptionOn ? { sessionResumption: resumeHandle ? { handle: resumeHandle } : {} } : {}),
        ...(vad ? { realtimeInputConfig: { automaticActivityDetection: vad } } : {}),
      });
      const constraintsFor = (withThinking: boolean, withExtras: boolean) => ({
        model,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: useVoice } } },
          // v5.34.22: OPT-IN. gemini-2.5 native-audio thinks (dynamic budget)
          // before every reply, in text; that is the 3-15 s "nothing happening"
          // after the interviewee speaks. thinkingBudget: 0 turns it off. Same
          // nesting as the SDK (liveConnectConfigToMldev → generationConfig.
          // thinkingConfig). Unset = wire unchanged from 5.34.21.
          ...(withThinking && thinkingBudget !== undefined
            ? { thinkingConfig: { thinkingBudget } }
            : {}),
        },
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
        ...(withExtras ? extrasFor() : {}),
      });

      // Field-name candidates, most-preferred first. The empty entry is the
      // unconstrained fallback and must stay last.
      //
      // The `{ setup: constraints }` wrapper on the second attempt mirrors the
      // pre-flatten shape the SDK accepts from callers, in case this API
      // version does the flattening server-side instead.
      //
      // Optional features (thinking budget, extras) are shed one set at a time
      // before pinning is given up: an unknown optional field must cost that
      // feature, never the persona pin (a security boundary).
      const wantThinking = thinkingBudget !== undefined;
      const featureSets: Array<{ thinking: boolean; extras: boolean }> = [
        { thinking: wantThinking, extras: true },
        { thinking: wantThinking, extras: false },
        ...(wantThinking ? [{ thinking: false, extras: true }, { thinking: false, extras: false }] : []),
      ];
      type Attempt = { body: Record<string, unknown>; thinking: boolean; extras: boolean; pinned: boolean; optional: boolean };
      const attempts: Attempt[] = [];
      for (const fs of featureSets) {
        const c = constraintsFor(fs.thinking, fs.extras);
        const optional = fs.thinking || fs.extras;
        attempts.push({ body: { ...base, bidiGenerateContentSetup: c }, ...fs, pinned: true, optional });
        attempts.push({ body: { ...base, bidiGenerateContentSetup: { setup: c } }, ...fs, pinned: true, optional });
      }
      attempts.push({ body: { ...base }, thinking: false, extras: false, pinned: false, optional: false });

      let res: Response | undefined;
      let detail = "";
      let pinned = false;
      let thinkingApplied = false;
      let extrasApplied = false;
      for (let i = 0; i < attempts.length; i++) {
        res = await fetchImpl(`${baseUrl}/v1alpha/auth_tokens`, {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          // Same key-transport reasoning as tts.ts and the AI Studio adapter:
          // newer "AQ."-prefixed keys 401 on the ?key= query form.
          headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey ?? "" },
          body: JSON.stringify(attempts[i].body),
        });
        if (res.ok) { pinned = attempts[i].pinned; thinkingApplied = attempts[i].thinking; extrasApplied = attempts[i].extras; break; }
        detail = await res.text().catch(() => "");
        // Only a rejected FIELD NAME is worth retrying. A bad key, a quota
        // problem or a disabled API must surface immediately rather than being
        // masked by two more doomed attempts. An attempt carrying OPTIONAL
        // features is the one exception: ANY 400 there falls through to the
        // next feature set, because the features are optional and the pin is not.
        if (attempts[i].optional && res.status === 400) {
          console.warn(`[liveSession] optional setup fields rejected by auth_tokens (thinking=${attempts[i].thinking}, extras=${attempts[i].extras}: ${detail.slice(0, 160)}); retrying with fewer`);
          continue;
        }
        if (!/Unknown name|Cannot find field/i.test(detail)) break;
      }
      if (thinkingBudget !== undefined && !thinkingApplied) {
        console.warn(`[liveSession] GEMINI_LIVE_THINKING_BUDGET=${thinkingBudget} could not be pinned; session runs with the model default`);
      }
      if (!extrasApplied) {
        console.warn(`[liveSession] transcription${manualVad ? "/manualVad" : ""} could not be pinned into the token; the browser's setup frame is the only carrier`);
      }

      if (!res || !res.ok) {
        throw new Error(`live-session ${res?.status ?? 0}: ${detail.slice(0, 300)}`);
      }

      const data = (await res.json()) as { name?: string; token?: string };
      // The provisioning endpoint returns the token as `name`; accept `token`
      // too rather than depending on one field name surviving a version bump.
      const token = data.token ?? data.name;
      if (!token) throw new Error("live-session: no token in response");

      return { token, model, voice: useVoice, maxSeconds, expiresAt: expireTime, sessionId, pinned,
               thinkingBudget: thinkingApplied ? thinkingBudget : undefined,
               pinnedExtras: { transcription: extrasApplied, manualVad: extrasApplied && manualVad, vad: extrasApplied ? vad : undefined,
                               resumption: extrasApplied && resumptionOn, compression: extrasApplied ? compression : undefined,
                               resumed: extrasApplied && resumptionOn && !!resumeHandle } };
    },
  };
}

/**
 * Context-window compression to pin into the token (v5.34.30).
 *
 * A native-audio session accrues ~25 tokens per second of audio in EACH
 * direction; nothing about the model is "exponential", but every reply
 * re-reads everything said so far, so per-turn latency climbs with the length
 * of the conversation. 5.34.28's accidental 5-minute token reset the context
 * every 5 minutes (fast, but amnesiac); 5.34.29 kept the context (right, but
 * slower and slower). The documented answer is a sliding window with EXPLICIT
 * sizes — the empty `slidingWindow: {}` 5.34.29 sent leaves the trigger at the
 * server default, i.e. near the 128k ceiling, i.e. never in an interview.
 *
 *   GEMINI_LIVE_COMPRESS_TRIGGER_TOKENS   default 25600  (docs example)
 *   GEMINI_LIVE_COMPRESS_TARGET_TOKENS    default 12800  (docs example; ≈8 min of audio)
 *   GEMINI_LIVE_COMPRESS=0                 turn compression off entirely
 *
 * The persona (systemInstruction) is not part of the window; the scoring
 * pass reads its own transcript. Only the model's short-term conversational
 * memory is bounded, which is what an interviewer needs.
 */
export function liveCompressionConfig(): Record<string, unknown> | undefined {
  const off = String(process.env.GEMINI_LIVE_COMPRESS ?? "").trim();
  if (off === "0" || off.toLowerCase() === "false" || off.toLowerCase() === "off") return undefined;
  const int = (raw: string | undefined, name: string, dflt: number) => {
    if (raw === undefined || raw === "") return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) { console.warn(`[liveSession] ${name}="${raw}" ignored — must be a positive integer`); return dflt; }
    return n;
  };
  const trigger = int(process.env.GEMINI_LIVE_COMPRESS_TRIGGER_TOKENS, "GEMINI_LIVE_COMPRESS_TRIGGER_TOKENS", 25600);
  const target = int(process.env.GEMINI_LIVE_COMPRESS_TARGET_TOKENS, "GEMINI_LIVE_COMPRESS_TARGET_TOKENS", 12800);
  return { triggerTokens: trigger, slidingWindow: { targetTokens: Math.min(target, trigger) } };
}

/** `GEMINI_LIVE_RESUMPTION=0` disables session resumption (to isolate its
 *  cost if a trace shows per-turn latency tracking sessionResumptionUpdate). */
export function liveResumptionEnabled(): boolean {
  const v = String(process.env.GEMINI_LIVE_RESUMPTION ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/**
 * Server-side voice-activity settings to pin into the token (v5.34.28).
 *
 * The first v1alpha production trace answered audio — with 13–28 s between the
 * interviewee stopping and the model starting, and thought summaries arriving
 * only ~0.5 s before the audio. That gap is the server deciding the turn has
 * ended, not the model thinking. These knobs are the documented controls for
 * it (Live API docs, automaticActivityDetection): a HIGH end-of-speech
 * sensitivity and a short silence window close the turn sooner.
 *
 *   GEMINI_LIVE_VAD_END_SENSITIVITY = LOW | HIGH   → endOfSpeechSensitivity
 *   GEMINI_LIVE_VAD_START_SENSITIVITY = LOW | HIGH → startOfSpeechSensitivity
 *   GEMINI_LIVE_VAD_SILENCE_MS = <int>              → silenceDurationMs
 *   GEMINI_LIVE_VAD_PREFIX_MS = <int>               → prefixPaddingMs
 *
 * Unset = nothing sent (server defaults). manualVad (from the browser flag)
 * sets disabled:true alongside whatever is configured.
 */
export function liveVadConfig(manualVad: boolean): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  const sens = (raw: string | undefined, prefix: string) => {
    const v = String(raw || "").trim().toUpperCase();
    if (!v) return undefined;
    if (v === "LOW" || v === "HIGH") return `${prefix}_${v}`;
    console.warn(`[liveSession] VAD sensitivity "${raw}" ignored — must be LOW or HIGH`);
    return undefined;
  };
  const int = (raw: string | undefined, name: string) => {
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) { console.warn(`[liveSession] ${name}="${raw}" ignored — must be a non-negative integer`); return undefined; }
    return n;
  };
  const end = sens(process.env.GEMINI_LIVE_VAD_END_SENSITIVITY, "END_SENSITIVITY");
  const start = sens(process.env.GEMINI_LIVE_VAD_START_SENSITIVITY, "START_SENSITIVITY");
  const silence = int(process.env.GEMINI_LIVE_VAD_SILENCE_MS, "GEMINI_LIVE_VAD_SILENCE_MS");
  const prefix = int(process.env.GEMINI_LIVE_VAD_PREFIX_MS, "GEMINI_LIVE_VAD_PREFIX_MS");
  if (manualVad) out.disabled = true;
  if (end) out.endOfSpeechSensitivity = end;
  if (start) out.startOfSpeechSensitivity = start;
  if (silence !== undefined) out.silenceDurationMs = silence;
  if (prefix !== undefined) out.prefixPaddingMs = prefix;
  return Object.keys(out).length ? out : undefined;
}

/**
 * The thinking budget to pin, or undefined for "leave the model alone".
 *
 * Read from the option first, then GEMINI_LIVE_THINKING_BUDGET. Anything that
 * is not a non-negative integer is treated as unset and warned about once,
 * rather than sent to Google as a string and rejected on every mint.
 */
export function liveThinkingBudget(explicit?: number): number | undefined {
  const raw = explicit !== undefined ? String(explicit) : process.env.GEMINI_LIVE_THINKING_BUDGET;
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.warn(`[liveSession] GEMINI_LIVE_THINKING_BUDGET="${raw}" ignored — must be a non-negative integer (0 disables thinking)`);
    return undefined;
  }
  return n;
}

export type LiveSession = ReturnType<typeof makeLiveSession>;

/**
 * Commit the reservation. Called at mint time, BEFORE the client can spend
 * anything. Writing the worst case up front is what makes concurrent sessions
 * safe: each one sees the budget the others have already claimed.
 *
 * v5.32.65 (audit V2-H2): NOT the production path any more, and must not be
 * called on its own. Writing the hold in a transaction of its own is what made
 * it invisible to a concurrent opener's count — the reservation landed after
 * the advisory lock guarding the decision had already been released. The route
 * now goes through metering.admitLiveSession, which performs the count, the
 * caps check and this insert in one transaction under one lock. What remains
 * here is the ledger-shape reference used by the reconciliation tests.
 */
export async function reserveSession(
  meter: Meter,
  args: {
    tenantId: string; userId: string; module: string; model: string;
    clientName?: string; sessionId: string; maxSeconds: number;
  }
): Promise<void> {
  const { tokensIn, tokensOut } = reserveTokensFor(args.maxSeconds);
  await meter({
    tenantId: args.tenantId,
    userId: args.userId,
    module: args.module,
    // v5.32.54: stamped so the close path can find THIS hold and release
    // exactly it — see findOpenHold() and migration 015.
    sessionId: args.sessionId,
    task: TASK_HOLD,
    provider: "gemini-live",
    model: args.model,
    tokensIn,
    tokensOut,
    costEstUsd: estimateCost(args.model, tokensIn, tokensOut),
    latencyMs: 0,
    ok: true,
    clientName: args.clientName,
  });
}

/**
 * Reconcile actual usage against the reservation, as a COMPENSATING negative
 * row rather than by editing the reservation.
 *
 * Two reasons it is a new row and not an update. usage_events is an
 * append-only audit of what was attempted, and rewriting history there would
 * make the billing statement unreproducible. And a refund that is itself a row
 * leaves the reservation visible, so an operator reading the table can see
 * that a session was granted 45 minutes of budget and gave 38 of it back —
 * which is exactly the forensic trail you want when a bill looks wrong.
 *
 * Clamped at the reservation: reported usage ABOVE what we reserved is never
 * refunded into existence, and never charged beyond the cap either, because
 * the session was physically bounded by expireTime. A client reporting absurd
 * numbers can only forfeit its own reservation.
 */
/**
 * The hold a close request is allowed to release, or null.
 *
 * v5.32.54 SECURITY. This lookup is the whole fix. The close route used to take
 * `maxSeconds` from the request body and hand it to reconcileSession, which
 * wrote a negative row of that size with no evidence that any session had ever
 * existed. An interviewee could call close in a loop and drive the firm's
 * `used` total arbitrarily negative, disabling both spend caps and the
 * concurrency guard for everyone. See migration 015.
 *
 * Three conditions, all required:
 *   - a hold row exists for this EXACT tenant, user and session, so a caller
 *     cannot release someone else's reservation or one they invented;
 *   - no release row exists for it yet, so the compensating entry is written
 *     once (the unique index in 015 is the real guarantee — this check exists
 *     to fail politely rather than on a constraint violation);
 *   - the amounts come from the STORED row, never from the request.
 */
export async function findOpenHold(
  tenantId: string,
  userId: string,
  sessionId: string
): Promise<{ tokensIn: number; tokensOut: number; payer: Payer; payerKeyHint?: string } | null> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query<{ tokens_in: number; tokens_out: number; payer: string | null; payer_key_hint: string | null }>(
      `SELECT h.tokens_in, h.tokens_out, h.payer, h.payer_key_hint
         FROM usage_events h
        WHERE h.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND h.user_id = $1
          AND h.session_id = $2
          AND h.task = $3
          AND NOT EXISTS (
            SELECT 1 FROM usage_events r2
             WHERE r2.tenant_id = h.tenant_id
               AND r2.session_id = h.session_id
               AND r2.task = $4)
        ORDER BY h.created_at DESC
        LIMIT 1`,
      [userId, sessionId, TASK_HOLD, TASK_HOLD_RELEASE]
    );
    const row = r.rows[0];
    if (!row) return null;
    /*
     * The payer comes from the STORED hold for the same reason the amounts do
     * (v5.32.54, above): the browser must have no say in who gets billed. A
     * request that could name its own payer could move an interview onto — or
     * off — a client's account from the client's own laptop.
     */
    return {
      tokensIn: Number(row.tokens_in),
      tokensOut: Number(row.tokens_out),
      payer: row.payer === "client_key" ? "client_key" : "platform",
      payerKeyHint: row.payer_key_hint ?? undefined,
    };
  });
}

export async function reconcileSession(
  meter: Meter,
  args: {
    tenantId: string; userId: string; module: string; model: string;
    clientName?: string; sessionId: string; maxSeconds: number;
    actualTokensIn: number; actualTokensOut: number; actualSeconds: number;
    /**
     * The amounts actually held, read from the ledger by the caller. When
     * absent — the mint-failed path, where the hold was just written in the
     * same request and is known-good — the reservation arithmetic is used.
     * NEVER derive this from anything the browser sent.
     */
    reservedOverride?: { tokensIn: number; tokensOut: number };
    /**
     * v5.34.59 — whose credential paid. Both rows written here MUST carry the
     * same value as the hold they compensate; the caller reads it from the
     * ledger (findOpenHold), never from the request body.
     */
    payer?: Payer;
    payerKeyHint?: string;
  }
): Promise<void> {
  const reserved = args.reservedOverride ?? reserveTokensFor(args.maxSeconds);
  const payer: Payer = args.payer ?? "platform";

  // 1. Release the ENTIRE hold. Previously this wrote a partial refund, which
  //    left the difference sitting in usage_events looking like consumption —
  //    and because billing sums that table, the client was invoiced for a
  //    worst-case estimate instead of what actually happened.
  await meter({
    tenantId: args.tenantId, userId: args.userId, module: args.module,
    sessionId: args.sessionId,
    task: TASK_HOLD_RELEASE, provider: "gemini-live", model: args.model,
    tokensIn: -reserved.tokensIn, tokensOut: -reserved.tokensOut,
    costEstUsd: -estimateCost(args.model, reserved.tokensIn, reserved.tokensOut),
    latencyMs: 0, ok: true, clientName: args.clientName,
    payer, payerKeyHint: args.payerKeyHint,
  });

  // 2. Record what the session ACTUALLY used. Clamped to the hold, so a client
  //    reporting inflated numbers can never bill beyond what was already
  //    bounded — the property that makes it safe to accept these from a browser.
  const usedIn = Math.max(0, Math.min(args.actualTokensIn, reserved.tokensIn));
  const usedOut = Math.max(0, Math.min(args.actualTokensOut, reserved.tokensOut));
  if (usedIn === 0 && usedOut === 0) return;

  await meter({
    tenantId: args.tenantId, userId: args.userId, module: args.module,
    sessionId: args.sessionId,
    task: TASK_ACTUAL, provider: "gemini-live", model: args.model,
    tokensIn: usedIn, tokensOut: usedOut,
    costEstUsd: estimateCost(args.model, usedIn, usedOut),
    latencyMs: Math.round(args.actualSeconds * 1000), ok: true,
    clientName: args.clientName,
    payer, payerKeyHint: args.payerKeyHint,
  });
}
