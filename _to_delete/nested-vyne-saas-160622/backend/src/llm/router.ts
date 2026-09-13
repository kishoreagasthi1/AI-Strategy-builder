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
    // Solution Design Studio (v5.30) — a client-facing deliverable per use
    // case, same tier as synthesis/strategy_deck.
    solution_design: ["anthropic-vertex", "gemini-vertex", "gemini-aistudio"],
    // v5.32.18 — the Design Studio artifacts that end up in front of a client.
    // Its other three tasks (design_intake, design_l3, design_tools) are
    // consultant-facing scaffolding and deliberately ride the default chain.
    design_brief: ["anthropic-vertex", "gemini-vertex", "gemini-aistudio"],
    design_governance: ["anthropic-vertex", "gemini-vertex", "gemini-aistudio"],
    design_artifact: ["anthropic-vertex", "gemini-vertex", "gemini-aistudio"],
  },
};

export const PROD_POLICY: RoutingPolicy = {
  defaultChain: ["gemini-vertex", "anthropic-vertex"],
  // TEMPORARY (v5.32.2, explicit request): every task — including the
  // "premium" ones below — now tries gemini-vertex first, same as
  // defaultChain. anthropic-vertex stays listed second as a safety
  // fallback (still used automatically if Gemini itself fails), it just
  // isn't preferred anymore. This was requested during end-to-end testing,
  // to run on one known-working provider while confirming everything else
  // works, independent of whether Claude-on-Vertex model access is fully
  // sorted out yet.
  //
  // To restore the original "Claude first for money artifacts" design
  // (synthesis/strategy_deck/solution_design), swap each pair back to
  // ["anthropic-vertex", "gemini-vertex"] — matches DEV_POLICY below,
  // which was NOT changed and still prefers Claude for these three tasks.
  taskChains: {
    synthesis: ["gemini-vertex", "anthropic-vertex"],
    strategy_deck: ["gemini-vertex", "anthropic-vertex"],
    solution_design: ["gemini-vertex", "anthropic-vertex"],
    design_brief: ["gemini-vertex", "anthropic-vertex"],
    design_governance: ["gemini-vertex", "anthropic-vertex"],
    design_artifact: ["gemini-vertex", "anthropic-vertex"],
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
