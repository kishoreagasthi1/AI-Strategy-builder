/**
 * Worked example for v5.32.89 — what a synthetic transcript now carries.
 *
 * Not a test. This drives the real route with a fake adapter and prints the
 * rows exactly as they land in `interview_transcripts`, so the change can be
 * read rather than inferred from an assertion.
 *
 *   TEST_DATABASE_URL=... RLS_APP_URL=... npx tsx test/scoreTrailExample.mts
 */
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { initPool, closePool } from "../src/db/pool.js";
import { buildServer } from "../src/server.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/verify.js";
import type { ProviderAdapter } from "../src/llm/types.js";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://vyne:vyne@localhost:5433/vyne";
const APP_URL = process.env.RLS_APP_URL ?? "postgres://vyne_app:change-me-via-ops@localhost:5433/vyne";

class V implements TokenVerifier {
  async verify(t: string): Promise<VerifiedIdentity> {
    if (t !== "tok") throw new Error("bad");
    return { uid: "uid-ex", email: "ex@f.com", idpTenantId: undefined };
  }
}

/* Two of the five personas answer with a trail; the rest omit it, so both the
 * model path and the fallback appear side by side in the output. */
let n = 0;
const adapter: ProviderAdapter = {
  name: "gemini-aistudio", model: "fake", freeTier: true,
  isConfigured: () => true,
  async generate() {
    const withTrail = n++ < 2;
    return {
      text: JSON.stringify({
        scores: { D1: 2, D2: 2.4, D3: 3, D4: 2, D5: 2.5, D6: 1.5, D7: 2.6 },
        findings: [
          { dimension: "D1", text: "Three warehouses, no single source of truth." },
          { dimension: "D6", text: "Nobody owns AI governance." },
        ],
        ...(withTrail ? { scoreEvents: [
          { dimension: "D1", from: 3, to: 2, afterTurn: 2 },
          { dimension: "D6", from: null, to: 1, afterTurn: 999 },
        ] } : {}),
        summary: "Fragmented data landscape.",
      }),
      model: "fake", usage: { tokensIn: 100, tokensOut: 200, costEstUsd: 0 },
    };
  },
};

const admin = new pg.Client({ connectionString: ADMIN_URL });
await migrate(ADMIN_URL);
await admin.connect();
const t = await admin.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('Example Firm') RETURNING id`);
const tenant = t.rows[0].id;
const u = await admin.query<{ id: string }>(
  `INSERT INTO users (identity_platform_uid, email) VALUES ('uid-ex','ex@f.com')
   ON CONFLICT (identity_platform_uid) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
await admin.query(`INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1,$2,'owner')`,
  [u.rows[0].id, tenant]);

initPool(APP_URL);
const app = await buildServer({
  config: { port: 0, env: "test", databaseUrl: APP_URL, gcpProject: undefined,
    vertexLocation: "us-east5", geminiApiKey: undefined, openaiApiKey: undefined,
    anthropicApiKey: undefined, llmDefaultChain: undefined, blockFreeTier: false,
    geminiPaidTier: false },
  verifier: new V(), adapters: [adapter], meter: async () => {},
});

const gen = await app.inject({
  method: "POST", url: "/api/synthetic/engagement",
  headers: { authorization: "Bearer tok" },
  payload: { clientName: "Meridian Foods EX", industry: "Manufacturing", includeRefresh: false },
});
if (gen.statusCode !== 200) { console.error(gen.body.slice(0, 500)); process.exit(1); }

const rows = await admin.query<{
  interviewee_name: string; interviewee_role: string; kind: string; turn_count: number;
  findings: { dimension: string; text: string }[] | null;
  score_events: { dimension: string; from: number | null; to: number; afterTurn: number }[] | null;
}>(`SELECT t.interviewee_name, t.interviewee_role, i.kind, t.turn_count, t.findings, t.score_events
      FROM interview_transcripts t JOIN interviews i ON i.id = t.interview_id
     WHERE t.client_name = 'Meridian Foods EX'
     ORDER BY i.kind, t.interviewee_name`);

const DIM = { D1: "Data", D2: "Technology", D3: "Process", D4: "People",
  D5: "Strategy", D6: "Governance", D7: "Culture" } as Record<string, string>;

console.log("\n" + "=".repeat(74));
console.log("v5.32.89 — what a synthetic transcript carries");
console.log("=".repeat(74));

for (const r of rows.rows) {
  console.log(`\n${r.interviewee_name} · ${r.interviewee_role}` +
    (r.kind === "follow_up" ? "  [FOLLOW-UP]" : "") + `  · ${r.turn_count} turns`);
  console.log("-".repeat(74));

  if (!r.score_events) { console.log("  score_events: NULL  ← the v5.32.88 behaviour"); continue; }

  console.log("  Score trail");
  for (const e of r.score_events) {
    const move = e.from === null ? `first evidenced at ${e.to}` : `${e.from} → ${e.to}`;
    console.log(`    ${e.dimension} ${DIM[e.dimension]}`.padEnd(22) +
      `${move}`.padEnd(26) + `after turn ${e.afterTurn}`);
  }
  console.log("  Findings");
  for (const f of r.findings ?? []) console.log(`    ${f.dimension}  ${f.text}`);
}

console.log("\n" + "=".repeat(74));
console.log("Reading the output");
console.log("=".repeat(74));
console.log(`
  · The first two personas got a trail from the model: D1 moves 3 → 2 at turn
    2, which is a movement anchored to a moment in the conversation. The model
    put D6 at turn 999; the route clamped it to the last real turn rather than
    writing a citation to a turn that does not exist.

  · The remaining personas got no trail from the model, so the route derived
    one from the final scores, anchored at the end. Same panel, weaker claim —
    "this is where it ended up", not "this is where it moved". Note D6 = 1.5
    there against D6 → 1 above: the derived trail carries the score, the model
    trail carries the movement.

  · The follow-up carries its own trail over its own turns. It is the row a
    consultant opens to see what a follow-up looks like, so copying the
    persona trail onto it would have shown the wrong conversation.

  · On v5.32.88 every one of these rows stored NULL and the viewer said "No
    score trail was kept for this interview — trails are recorded from
    v5.32.66 onward", which was false for data generated on v5.32.83.
`);

await app.close();
await closePool();
await admin.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
await admin.query(`DELETE FROM users WHERE identity_platform_uid = 'uid-ex'`);
await admin.end();
