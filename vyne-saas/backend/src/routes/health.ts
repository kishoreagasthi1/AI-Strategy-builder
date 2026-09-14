import type { FastifyInstance } from "fastify";
import { getPool } from "../db/pool.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => {
    let db = "down";
    try {
      await getPool().query("SELECT 1");
      db = "up";
    } catch {
      /* reported below */
    }
    return { status: db === "up" ? "ok" : "degraded", db, version: "0.1.0" };
  });
}
