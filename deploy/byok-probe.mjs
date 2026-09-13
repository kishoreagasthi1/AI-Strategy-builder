#!/usr/bin/env node
/**
 * byok-probe.mjs — what can we actually LEARN about a Google AI Studio key?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The BYOK design rests on one claim: that we can refuse a client's key if it
 * is on the free tier, because free-tier prompts may be used by Google for
 * product improvement and an interview transcript is the most confidential
 * thing this product handles.
 *
 * Today the application does NOT measure that. `config.geminiPaidTier` is an
 * env flag — GEMINI_PAID=1 — that an operator sets by hand, and every
 * downstream guard (`adapter.freeTier`, `blockFreeTier`,
 * `live_free_tier_blocked`) trusts it. That is defensible when the operator is
 * you and the key is yours. It is NOT defensible when the assertion comes from
 * a client who wants their pilot to be free: "is this key billed?" would be a
 * checkbox on a form, and the honest answer to "how do you know?" would be
 * "they told us".
 *
 * So before any of it is built, this establishes what is observable from
 * outside. It does not assume an answer. It reports what each endpoint says
 * and lets the evidence decide whether a reliable signal exists.
 *
 * ── Running it ──────────────────────────────────────────────────────────────
 *
 * It must run in YOUR terminal: this agent's egress to
 * generativelanguage.googleapis.com is blocked at the proxy, and a key must
 * never be pasted into a chat window.
 *
 *   printf '%s' 'YOUR_KEY' > ~/vyne/probe-key.txt   # no trailing newline needed
 *   chmod 600 ~/vyne/probe-key.txt
 *   node deploy/byok-probe.mjs ~/vyne/probe-key.txt
 *
 * Run it against a BILLED key first. If you can also create a throwaway
 * project with an unbilled key, run it against that too and diff the two
 * outputs — the difference, if any, IS the signal we would gate on.
 *
 * It never prints the key. It makes three small reads and one ephemeral-token
 * request; the cost is a fraction of a cent.
 */

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node deploy/byok-probe.mjs <path-to-file-containing-the-key>");
  console.error("       (a FILE — do not pass the key on the command line, it lands in shell history)");
  process.exit(2);
}

let KEY;
try {
  KEY = readFileSync(path.replace(/^~/, process.env.HOME), "utf8").trim();
} catch (e) {
  console.error(`cannot read ${path}: ${e.message}`);
  process.exit(2);
}
if (!KEY) { console.error("that file is empty"); process.exit(2); }

const HOST = "https://generativelanguage.googleapis.com";
const MODEL = "gemini-flash-latest";
const LIVE_MODEL = "models/gemini-2.5-flash-native-audio-latest";

const mask = (k) => `${k.slice(0, 4)}…${k.slice(-4)} (${k.length} chars)`;
const line = (s = "") => console.log(s);

/** Headers worth comparing between a billed and an unbilled key. */
const INTERESTING = [
  "x-ratelimit-limit-requests", "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens",
  "x-goog-quota-user", "retry-after", "x-goog-api-client",
];

function headerReport(res) {
  const out = [];
  for (const h of INTERESTING) {
    const v = res.headers.get(h);
    if (v !== null) out.push(`      ${h}: ${v}`);
  }
  return out.length ? out.join("\n") : "      (none of the rate-limit headers were returned)";
}

async function probe(label, fn) {
  line(`── ${label}`);
  try {
    const { res, body } = await fn();
    line(`   HTTP ${res.status} ${res.statusText}`);
    line(headerReport(res));
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    line(`   NETWORK FAILURE: ${e.message}`);
    return { ok: false, status: 0, body: "" };
  } finally {
    line();
  }
}

const get = (url) => async () => {
  const res = await fetch(url, { headers: { "x-goog-api-key": KEY } });
  return { res, body: await res.text() };
};

const post = (url, payload) => async () => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify(payload),
  });
  return { res, body: await res.text() };
};

line();
line("BYOK key probe — establishing what is observable, not assuming it");
line(`key: ${mask(KEY)}`);
line();

/*
 * 1. Does the key work at all? The cheapest possible generate. If this fails
 *    the key is unusable and nothing else matters.
 */
const gen = await probe("generateContent — does the key work?",
  post(`${HOST}/v1beta/models/${MODEL}:generateContent`, {
    contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }],
    generationConfig: { maxOutputTokens: 5 },
  }));

/*
 * 2. Which models does this key see? A paid project sometimes exposes models a
 *    free one does not. Worth capturing as a candidate signal rather than
 *    relied upon — model availability also varies by account age and region.
 */
const models = await probe("models.list — what does this key have access to?",
  get(`${HOST}/v1beta/models?pageSize=200`));

let names = [];
try {
  names = (JSON.parse(models.body).models ?? []).map((m) => m.name);
} catch { /* reported below */ }

/*
 * 3. THE ONE THAT MATTERS. The ephemeral token endpoint is what the Live voice
 *    path mints from, so a key that cannot do this is useless for this product
 *    whatever its tier. It is also the best candidate for a tier signal: this
 *    session's working notes recorded that free-tier keys are refused here.
 *    That note is UNVERIFIED — it is the reason this script exists. Whatever
 *    comes back, print it verbatim.
 */
const tokens = await probe("auth_tokens — can this key mint a Live ephemeral token?",
  post(`${HOST}/v1alpha/auth_tokens`, {
    uses: 1,
    expireTime: new Date(Date.now() + 60_000).toISOString(),
    bidiGenerateContentSetup: { model: LIVE_MODEL },
  }));

line("─────────────────────────────── what we learned ───────────────────────────────");
line();
line(`  key works for text:        ${gen.ok ? "YES" : `NO (HTTP ${gen.status})`}`);
line(`  models visible:            ${names.length || "could not parse"}`);
const live = names.filter((n) => n.includes("native-audio") || n.includes("live"));
line(`  live/native-audio models:  ${live.length ? live.join(", ") : "none listed"}`);
line(`  can mint a Live token:     ${tokens.ok ? "YES" : `NO (HTTP ${tokens.status})`}`);
line();

if (!gen.ok) {
  line("  The key does not work for ordinary generation. Everything below is moot.");
  line(`  Response body: ${gen.body.slice(0, 500)}`);
} else if (!tokens.ok) {
  line("  The key generates text but CANNOT mint a Live ephemeral token.");
  line("  If this key is unbilled, that refusal is a usable free-tier signal and");
  line("  BYOK can gate on it. If this key IS billed, the refusal is something");
  line("  else and the message below says what.");
  line();
  line(`  Response body: ${tokens.body.slice(0, 800)}`);
} else {
  line("  The key does both. If this key is BILLED, that tells us a billed key");
  line("  passes — it does not yet tell us an unbilled key fails. Run this again");
  line("  against an unbilled key; only the DIFFERENCE between the two runs is");
  line("  evidence. If both pass identically, there is no observable signal and");
  line("  BYOK cannot verify the tier itself — see the note below.");
}

line();
line("  If no signal separates the two, the honest options are:");
line("    · require BYOC (a client GCP project + Vertex), where the no-training");
line("      position is contractual rather than inferred; or");
line("    · accept a client ATTESTATION that the key is billed, record who");
line("      attested and when, and say so plainly in the consent text — rather");
line("      than implying a check the product does not perform.");
line();
line("  Nothing about this probe is stored. Delete the key file when you are done:");
line(`    rm ${path}`);
line();
