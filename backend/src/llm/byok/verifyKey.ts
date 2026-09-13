/**
 * What we can actually establish about a client's key. (v5.34.50)
 *
 * ── This returns EVIDENCE, not a verdict ────────────────────────────────────
 *
 * The BYOK design wanted to refuse a free-tier key, because free-tier content
 * may be used by Google for product improvement and an interview transcript is
 * the most confidential thing this product handles. That check cannot be built.
 *
 * Measured with deploy/byok-probe.mjs on 2026-09-12, a billed key against an
 * unbilled key created in a fresh project with no billing linked:
 *
 *                           billed      unbilled
 *   generateContent         200         200
 *   models.list             200, 55     200, 55
 *     live/native-audio     six         the same six
 *   auth_tokens             200         200
 *   rate-limit headers      none        none
 *
 * Identical. There is no save-time signal. The same run also disproved a
 * belief carried in this codebase's comments: Google does NOT refuse a
 * free-tier key at auth_tokens. `live_free_tier_blocked` is our policy,
 * enforced through GEMINI_PAID=1, and never an upstream gate.
 *
 * Free tier differs under LOAD — requests per minute and per day — not at the
 * capability surface. Detecting that would mean deliberately exhausting a
 * client's quota, which is not a check worth having.
 *
 * So this function deliberately has no `paidTier` field and no `accepted`
 * boolean. It reports what each endpoint did. Whether that is good enough is a
 * policy decision made elsewhere, against an attestation recorded on the
 * tenant row — and naming it `attested` there rather than `verified` is the
 * point of the whole exercise.
 *
 * ── What it IS good for ─────────────────────────────────────────────────────
 *
 * Refusing a key that cannot do the job. A key that fails generateContent, or
 * cannot mint a Live ephemeral token, or cannot see the native-audio model,
 * will fail mid-interview in front of a client executive. Better to find that
 * out on the settings screen.
 */

const HOST = "https://generativelanguage.googleapis.com";
const TIMEOUT_MS = 20_000;

export interface KeyProbe {
  checkedAt: string;
  /** Ordinary text generation works. */
  canGenerate: boolean;
  /** A Live ephemeral token can be minted — required for voice interviews. */
  canMintLiveToken: boolean;
  /** How many models this key can see at all. */
  modelCount: number;
  /** The model the interview actually runs on is present. */
  hasNativeAudio: boolean;
  /** HTTP status per call, for diagnosing a refusal without re-running it. */
  status: { generate: number; models: number; authTokens: number };
  /** Present only when something failed, and never contains the key. */
  error?: string;
}

export interface VerifyOptions {
  fetchImpl?: typeof fetch;
  /** The model an interview runs on; overridable so a model rename is config. */
  liveModel?: string;
  textModel?: string;
  now?: () => Date;
}

/**
 * Probe a key. Never throws — a network failure is evidence too, and the
 * caller is a settings screen that must say something useful either way.
 */
export async function probeKey(key: string, opts: VerifyOptions = {}): Promise<KeyProbe> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const liveModel = opts.liveModel ?? "models/gemini-2.5-flash-native-audio-latest";
  const textModel = opts.textModel ?? "gemini-flash-latest";
  const at = (opts.now ?? (() => new Date()))().toISOString();

  const probe: KeyProbe = {
    checkedAt: at,
    canGenerate: false,
    canMintLiveToken: false,
    modelCount: 0,
    hasNativeAudio: false,
    status: { generate: 0, models: 0, authTokens: 0 },
  };

  const trimmed = (key ?? "").trim();
  if (!trimmed) return { ...probe, error: "no key was supplied" };

  const headers = { "content-type": "application/json", "x-goog-api-key": trimmed };
  const go = async (url: string, body?: unknown) =>
    fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  try {
    const gen = await go(`${HOST}/v1beta/models/${textModel}:generateContent`, {
      contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }],
      generationConfig: { maxOutputTokens: 5 },
    });
    probe.status.generate = gen.status;
    probe.canGenerate = gen.ok;
  } catch (e) {
    probe.error = `text generation could not be reached: ${(e as Error).message}`;
  }

  try {
    const models = await go(`${HOST}/v1beta/models?pageSize=200`);
    probe.status.models = models.status;
    if (models.ok) {
      const j: any = await models.json();
      const names: string[] = (j?.models ?? []).map((m: any) => String(m?.name ?? ""));
      probe.modelCount = names.length;
      probe.hasNativeAudio = names.some((n) => n.includes("native-audio"));
    }
  } catch (e) {
    probe.error = probe.error ?? `model list could not be read: ${(e as Error).message}`;
  }

  try {
    // A one-minute token that is never used. This is the cheapest way to learn
    // whether voice will work before an interviewee is sitting in front of it.
    const tok = await go(`${HOST}/v1alpha/auth_tokens`, {
      uses: 1,
      expireTime: new Date(Date.now() + 60_000).toISOString(),
      bidiGenerateContentSetup: { model: liveModel },
    });
    probe.status.authTokens = tok.status;
    probe.canMintLiveToken = tok.ok;
  } catch (e) {
    probe.error = probe.error ?? `the Live token endpoint could not be reached: ${(e as Error).message}`;
  }

  return probe;
}

/**
 * Can this key run the product? NOT "is this key billed" — see the header.
 *
 * Voice is the whole interview, so a key that cannot mint a Live token is
 * refused rather than silently dropping every engagement to the text path.
 */
/**
 * Turn an HTTP status into the sentence that tells the person what to DO.
 *
 * v5.34.60, from a real one. A newly created key was refused with "the key was
 * rejected for text generation", which is true and useless: a key that is still
 * propagating, a key restricted to a referrer, and a project without the API
 * enabled all read identically, and the three have completely different
 * remedies. It cost a detour through curl to learn the status was a 403.
 *
 * The status is not an oracle worth withholding — it is what the key's own
 * owner sees from any call they make with it, and they are the only person who
 * can act on it. What stays withheld is the probe EVIDENCE (which models the
 * key can see, whether Live works), because that is a capability map of
 * someone's credential, handed to whoever holds an invite link.
 */
function statusAdvice(status: number): string {
  if (status === 0) return "we could not reach Google at all — this is likely our end, not your key";
  if (status === 403) {
    return "Google refused it (403). A key created in the last minute or two often does this and starts " +
           "working on its own — try again shortly. If it keeps failing, check that the key has no API or " +
           "referrer restrictions, and that the Generative Language API is enabled on its project";
  }
  if (status === 400) return "Google rejected the request as malformed (400) — the key may be incomplete or mistyped";
  if (status === 429) return "the key is over its rate limit right now (429) — try again in a minute";
  if (status >= 500) return `Google returned a server error (${status}) — try again shortly`;
  return `Google returned HTTP ${status}`;
}

export function keyIsUsable(p: KeyProbe): { usable: boolean; reason?: string } {
  if (!p.canGenerate) {
    return {
      usable: false,
      reason: `the key was rejected for text generation — ${statusAdvice(p.status.generate)}`,
    };
  }
  if (!p.hasNativeAudio) {
    return { usable: false, reason: "this key cannot see the native-audio model the interview runs on" };
  }
  if (!p.canMintLiveToken) {
    return {
      usable: false,
      reason: `this key cannot start a live voice session — ${statusAdvice(p.status.authTokens)}`,
    };
  }
  return { usable: true };
}
