/**
 * Routing policy — WHICH provider chain serves WHICH task, as config not code.
 *
 * Platform decision (Aug 2026):
 *   - Default for dev/testing: Gemini Flash free tier (gemini-aistudio)
 *   - Production default: Gemini Flash on Vertex (cheap, no-training)
 *   - Premium tasks (synthesis, strategy deck): Claude first
 *   - Free-tier adapters are HARD-EXCLUDED in production (blockFreeTier)
 *   - Every chain is a fallback list: first configured+allowed adapter that
 *     succeeds wins.
 *
 * Override without redeploying code: LLM_DEFAULT_CHAIN env var, or edit
 * TASK_CHAINS and redeploy (manual-deploy world for now).
 */

export interface RoutingPolicy {
  defaultChain: string[];
  taskChains: Record<string, string[]>;
}

export const DEV_POLICY: RoutingPolicy = {
  // gemini-aistudio-2 (a FULL Flash model on the same free key) backs up the
  // primary: separate per-model quota pool absorbs 503s/429s, and it carries
  // audio-capable tasks when the primary is a lite model.
  defaultChain: ["gemini-aistudio", "gemini-aistudio-2", "gemini-vertex", "anthropic-vertex"],
  taskChains: {
    // Audio understanding needs a full Flash model — lite variants reject it.
    transcribe: ["gemini-aistudio-2", "gemini-aistudio", "gemini-vertex"],
    // Money artifacts still prefer Claude even in dev, if configured.
    synthesis: ["anthropic-vertex", "gemini-vertex", "gemini-aistudio"],
    strategy_deck: ["anthropic-vertex", "gemini-vertex", "gemini-aistudio"],
  },
};

export const PROD_POLICY: RoutingPolicy = {
  defaultChain: ["gemini-vertex", "anthropic-vertex"],
  taskChains: {
    synthesis: ["anthropic-vertex", "gemini-vertex"],
    strategy_deck: ["anthropic-vertex", "gemini-vertex"],
  },
};

export function chainForTask(
  policy: RoutingPolicy,
  task: string,
  overrides?: { defaultChain?: string[] }
): string[] {
  if (policy.taskChains[task]) return policy.taskChains[task];
  return overrides?.defaultChain ?? policy.defaultChain;
}
