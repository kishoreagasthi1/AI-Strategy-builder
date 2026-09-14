import type { FastifyInstance } from "fastify";
import { getPool } from "../db/pool.js";
import { VERSION } from "../version.js";

export async function healthRoutes(app: FastifyInstance, opts?: { env?: string }): Promise<void> {
  app.get("/api/health", async () => {
    let db = "down";
    try {
      await getPool().query("SELECT 1");
      db = "up";
    } catch {
      /* reported below */
    }
    return { status: db === "up" ? "ok" : "degraded", db, version: VERSION };
  });

  // Lightweight, unauthenticated version stamp. See version.ts's doc comment
  // for why this exists — frontend/about.html fetches this and compares it
  // against its own hardcoded VYNE_VERSION so a partial/stale deploy shows
  // up as a visible mismatch inside the running app.
  app.get("/api/version", async () => ({
    version: VERSION,
    env: opts?.env ?? "unknown",
  }));
}
