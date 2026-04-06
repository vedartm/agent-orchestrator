import type { ProjectConfig } from "./types.js";

export type NormalizedOrchestratorSessionStrategy = "reuse" | "delete" | "ignore" | "new";

export function normalizeOrchestratorSessionStrategy(
  strategy: ProjectConfig["orchestratorSessionStrategy"] | undefined,
): NormalizedOrchestratorSessionStrategy {
  return strategy ?? "reuse";
}
