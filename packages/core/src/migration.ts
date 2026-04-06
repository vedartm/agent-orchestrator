/**
 * Effective config builder for multi-project mode.
 *
 * Merges the global config registry (identity) with each project's local
 * config (behavior) to produce an OrchestratorConfig compatible with the
 * rest of the system.
 */

import type {
  OrchestratorConfig,
  ProjectConfig,
  TrackerConfig,
  SCMConfig,
  AgentSpecificConfig,
  RoleAgentConfig,
  ReactionConfig,
  DefaultPlugins,
  EventPriority,
} from "./types.js";
import {
  type GlobalConfig,
  findLocalConfigPath,
  loadLocalProjectConfig,
  DEFAULT_NOTIFICATION_ROUTING,
} from "./global-config.js";
import { expandHome } from "./paths.js";

// ---------------------------------------------------------------------------
// Type-safe behavior field helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
    ? (v as string[])
    : undefined;
}

function asObject<T>(v: unknown): T | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as T)
    : undefined;
}

/** Return the value only if it is one of the allowed literals, otherwise undefined. */
function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : undefined;
}

const ORCHESTRATOR_SESSION_STRATEGIES = ["reuse", "delete", "ignore", "new"] as const;

/**
 * Build an OrchestratorConfig from global config + local configs.
 *
 * For each project in the global config, reads behavior from the local
 * `agent-orchestrator.yaml` at project.path. If the local config is absent
 * or invalid, the project is included with empty behavior fields (and a
 * warning is emitted for invalid configs).
 *
 * @param warnings Optional array that receives warning messages (e.g. invalid
 *   local configs). Callers that surface messages to the user should pass this in.
 */
export function buildEffectiveConfig(
  globalConfig: GlobalConfig,
  globalConfigPath: string,
  warnings?: string[],
): OrchestratorConfig {
  const projects: Record<string, ProjectConfig> = {};
  // Seed with global-level settings; per-project local config merges on top.
  let mergedNotifiers: OrchestratorConfig["notifiers"] = { ...(globalConfig.notifiers ?? {}) };
  let mergedRouting: Partial<Record<EventPriority, string[]>> = { ...(globalConfig.notificationRouting ?? {}) };

  for (const [projectId, entry] of Object.entries(globalConfig.projects)) {
    // Expand for internal use (findLocalConfigPath needs an absolute path).
    // The project stores the raw entry.path so expandPaths in applyGlobalConfigPipeline
    // performs the single canonical expansion — avoiding double-expansion.
    const expandedPath = expandHome(entry.path);

    let behaviorFields: Record<string, unknown>;
    let effectiveConfigPath: string | undefined;

    const localPath = findLocalConfigPath(expandedPath);
    if (localPath) {
      effectiveConfigPath = localPath;
      try {
        const localConfig = loadLocalProjectConfig(localPath);
        behaviorFields = localConfig as Record<string, unknown>;
      } catch (err) {
        // Invalid local config — fall back to empty behavior and warn the caller
        // so the user knows their local config is NOT being applied.
        warnings?.push(
          `Project "${projectId}": local config at ${localPath} is invalid ` +
            `(${err instanceof Error ? err.message : String(err)}); ` +
            `using empty behavior. Fix the local config and re-run \`ao start\`.`,
        );
        behaviorFields = {};
      }
    } else {
      // No local config — use empty behavior fields.
      behaviorFields = {};
    }

    // Use the explicit sessionPrefix from the local config fields if present.
    // Leave it empty otherwise — applyProjectDefaults (via applyGlobalConfigPipeline)
    // is the single source of truth for deriving the prefix from the project path.
    const sessionPrefix = asString(behaviorFields["sessionPrefix"]) ?? "";
    const repo = String(behaviorFields["repo"] ?? "");

    // Don't infer scm/tracker here — leave them for applyProjectDefaults
    // which has the full inferScmPlugin logic (GitLab detection, etc.).

    projects[projectId] = {
      name: entry.name ?? projectId,
      repo,
      path: entry.path,
      defaultBranch: String(behaviorFields["defaultBranch"] ?? "main"),
      sessionPrefix,
      configMode: "hybrid",
      effectiveConfigPath,
      runtime: asString(behaviorFields["runtime"]),
      agent: asString(behaviorFields["agent"]),
      workspace: asString(behaviorFields["workspace"]),
      tracker: asObject<TrackerConfig>(behaviorFields["tracker"]),
      scm: asObject<SCMConfig>(behaviorFields["scm"]),
      symlinks: asStringArray(behaviorFields["symlinks"]),
      postCreate: asStringArray(behaviorFields["postCreate"]),
      agentConfig: asObject<AgentSpecificConfig>(behaviorFields["agentConfig"]) ?? ({} as AgentSpecificConfig),
      orchestrator: asObject<RoleAgentConfig>(behaviorFields["orchestrator"]),
      worker: asObject<RoleAgentConfig>(behaviorFields["worker"]),
      reactions: asObject<Record<string, Partial<ReactionConfig>>>(behaviorFields["reactions"]),
      agentRules: asString(behaviorFields["agentRules"]),
      agentRulesFile: asString(behaviorFields["agentRulesFile"]),
      orchestratorRules: asString(behaviorFields["orchestratorRules"]),
      orchestratorSessionStrategy: asEnum(behaviorFields["orchestratorSessionStrategy"], ORCHESTRATOR_SESSION_STRATEGIES),
      decomposer: asObject<ProjectConfig["decomposer"]>(behaviorFields["decomposer"]),
    };

    if (behaviorFields["notifiers"]) {
      mergedNotifiers = { ...mergedNotifiers, ...(asObject<OrchestratorConfig["notifiers"]>(behaviorFields["notifiers"]) ?? {}) };
    }
    if (behaviorFields["notificationRouting"]) {
      mergedRouting = { ...mergedRouting, ...(asObject<Record<string, string[]>>(behaviorFields["notificationRouting"]) ?? {}) };
    }
  }

  return {
    configPath: globalConfigPath,
    globalConfigPath,
    port: globalConfig.port,
    terminalPort: globalConfig.terminalPort,
    directTerminalPort: globalConfig.directTerminalPort,
    readyThresholdMs: globalConfig.readyThresholdMs,
    defaults: globalConfig.defaults as DefaultPlugins,
    projects,
    projectOrder: globalConfig.projectOrder,
    // These are global infrastructure settings (which channels exist, how
    // priorities route). Per-project reaction overrides are on ProjectConfig.
    notifiers: mergedNotifiers,
    notificationRouting: {
      ...DEFAULT_NOTIFICATION_ROUTING,
      ...mergedRouting,
    } as Record<EventPriority, string[]>,
    reactions: globalConfig.reactions ?? {},
    plugins: (globalConfig.plugins ?? []).filter(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as Record<string, unknown>)["name"] === "string" &&
        typeof (p as Record<string, unknown>)["source"] === "string",
    ) as unknown as OrchestratorConfig["plugins"],
  };
}

