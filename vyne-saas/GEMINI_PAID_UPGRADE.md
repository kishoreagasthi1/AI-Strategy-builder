# Moving to Paid Gemini — steps for the GCP deployment

Why: the free AI Studio tier is rate-limited per account (~15 requests/min on
Flash, daily caps, and frequent 429/503 under load) and its prompts may be
used by Google for product improvement. Paid removes all three problems —
which is what makes the interview voice experience consistently seamless and
makes client data handling defensible.

You have two paid paths. The platform already supports both; they can run
together (the gateway falls back automatically).

---

## Path A — Paid AI Studio key (simplest; same key, 10 minutes)

Your current `GEMINI_API_KEY` keeps working — you just attach billing to the
Google Cloud project behind it. TTS (the interview voice) and transcription
also run through this key, so this path upgrades the whole voice loop.

1. Go to **https://aistudio.google.com** → API keys. Note which Google Cloud
   project your key belongs to (create a key in a named project if it's in
   the default one).
2. In **https://console.cloud.google.com** → Billing → **Link a billing
   account** to that project (add a card if you don't have a billing account
   yet).
3. That's it for Google — the same API key is now on the **pay-as-you-go
   tier**: much higher rate limits, no daily cap, and paid-tier prompts are
   **not** used for product improvement.
4. Tell the platform the key is paid by adding one env var wherever the API
   runs (locally or Cloud Run):

   ```
   GEMINI_PAID=1
   ```

   This flips the AI Studio adapters to `freeTier: false`, so the
   production free-tier block no longer excludes them. (Without billing
   linked, do NOT set this in production — the block exists to keep client
   data off the free tier.)
5. Recommended models once paid: `GEMINI_MODEL=gemini-3.5-flash` (full Flash
   everywhere — no need for the lite model you used to stay under free
   limits) and keep `GEMINI_TTS_MODEL` as you have it.

Cost feel: Flash-class models are fractions of a cent per interview turn;
a full 45-minute voice interview (LLM + TTS + transcription) lands around
$0.10–0.30. The platform meters every call per firm in `usage_events`, so
you can watch real numbers from day one.

## Path B — Vertex AI (enterprise-grade; already coded, for the Cloud Run deploy)

Vertex is Google Cloud's enterprise serving of the same Gemini models:
per-project quotas you can raise, IAM auth instead of API keys, data
residency, and it never trains on your data. The `gemini-vertex` adapter is
already in the chain — it just needs the project wired up.

1. `gcloud services enable aiplatform.googleapis.com --project YOUR_PROJECT`
2. Give the Cloud Run service account access:
   `gcloud projects add-iam-policy-binding YOUR_PROJECT --member serviceAccount:SA_EMAIL --role roles/aiplatform.user`
3. Set on the service: `GCP_PROJECT=YOUR_PROJECT` (and `VERTEX_LOCATION` if
   not the default). No API key — Cloud Run's identity is the credential.
4. In production the router already prefers Vertex for heavy tasks
   (synthesis, strategy deck) and uses it as fallback for everything else.

## Recommended end state on Cloud Run

```
GEMINI_API_KEY=<paid key>        # voice (TTS + transcribe) + fast turns
GEMINI_PAID=1
GEMINI_MODEL=gemini-3.5-flash
GCP_PROJECT=<project>            # Vertex for heavy synthesis + fallback
NODE_ENV=production              # keeps the free-tier block + dev-auth gate armed
```

Order of operations during the move: link billing (A) first — it's
10 minutes and immediately fixes rate-limit stutters even while you still
run locally — then wire Vertex (B) as part of the Cloud Run deployment.

One caution: after linking billing, rotate the API key that was pasted into
chats/terminals during development (AI Studio → create new key → update env
→ delete old), since a paid key now spends real money if leaked.
