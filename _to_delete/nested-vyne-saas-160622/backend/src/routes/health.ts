import type { FastifyInstance } from "fastify";
import { getPool } from "../db/pool.js";
import { VERSION } from "../version.js";

/**
 * How long a database probe result is reused (v5.32.65, audit V2-L9).
 *
 * /api/health is unauthenticated by necessity — Cloud Run and any uptime check
 * must be able to call it — and it took a connection out of the pool on every
 * single request. That makes the cheapest unauthenticated endpoint in the
 * product a direct lever on the resource the whole firm shares: enough
 * concurrent GETs and real requests queue behind them for a connection.
 *
 * A rate limit alone is the wrong instrument here, because the callers that
 * matter (the platform's own liveness checks) must never be throttled. Caching
 * is: it makes the endpoint's cost independent of how often it is called, while
 * every legitimate caller still sees a value at most a few seconds stale, which
 * is well inside any useful health-check interval.
 */
const PROBE_TTL_MS = 5_000;

export async function healthRoutes(app: FastifyInstance, opts?: { env?: string }): Promise<void> {
  let probedAt = 0;
  let probed: "up" | "down" = "down";
  let inFlight: Promise<void> | null = null;

  async function dbStatus(now: number): Promise<"up" | "down"> {
    if (now - probedAt < PROBE_TTL_MS) return probed;
    // Collapse a burst onto ONE query. Without this, a thousand simultaneous
    // requests all see a stale timestamp and all probe — which is the stampede
    // the cache exists to prevent.
    if (!inFlight) {
      inFlight = (async () => {
        try {
          await getPool().query("SELECT 1");
          probed = "up";
        } catch {
          probed = "down";
        } finally {
          probedAt = Date.now();
          inFlight = null;
        }
      })();
    }
    await inFlight;
    return probed;
  }

  app.get("/api/health", async () => {
    const db = await dbStatus(Date.now());
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
