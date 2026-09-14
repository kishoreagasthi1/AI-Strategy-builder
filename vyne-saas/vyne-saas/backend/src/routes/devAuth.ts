/**
 * Dev-mode token minting — LOCAL DEVELOPMENT ONLY.
 *
 * V225-audit M2 fix: DevVerifier now requires an HMAC signature it alone
 * can produce (see auth/devVerifier.ts's doc comment). The frontend can't
 * hold that secret (it's shipped static JS, readable by anyone), so instead
 * of constructing "dev:<uid>" client-side it now calls this endpoint to ask
 * the server — the only party holding DEV_AUTH_SECRET — to mint a signed
 * token for the uid the user typed into the dev-login box.
 *
 * Only ever registered when DevVerifier was actually constructed (see
 * index.ts) — i.e. DEV_AUTH=1 and NODE_ENV !== 'production'. There is
 * deliberately no additional guard inside this route: DEV_AUTH mode itself
 * means "anyone who can reach this deployment can log in as any uid" by
 * design (that's the whole point of a zero-setup local dev auth mode) — the
 * fix here is narrower, closing the "a leaked/cached bare token works
 * forever, independent of any secret" gap, not changing what DEV_AUTH=1
 * itself grants. Operators who leave DEV_AUTH=1 set on a reachable
 * deployment have a bigger problem than this route.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DevVerifier } from "../auth/devVerifier.js";

const MintBody = z.object({
  uid: z.string().min(1).max(128).optional(),
});

export async function devAuthRoutes(app: FastifyInstance, verifier: DevVerifier): Promise<void> {
  app.post("/api/dev/mint-token", async (req, reply) => {
    const parsed = MintBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_input" });
      return;
    }
    const uid = (parsed.data.uid ?? "dev-owner").trim() || "dev-owner";
    return { token: verifier.sign(uid) };
  });
}
