/**
 * Global config management for multi-project architecture.
 *
 * Layout:
 *   ~/.agent-orchestrator/
 *     config.yaml              ← Registry: project identity + global settings
 *
 * The global config at config.yaml owns:
 * - Project registry (identity: name, path, project ID)
 * - Global operational settings (port, defaults, notifiers, reactions)
 *
 * Per-project behavior (agent, runtime, tracker, reactions, etc.) lives in
 * each project's local `agent-orchestrator.yaml` and is read at startup.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { resolve, join, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { expandHome } from "./paths.js";

// =============================================================================
// TYPES
// =============================================================================

/** Config ownership mode per project — always "hybrid" (local config required) */
export type ConfigMode = "hybrid";

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

/** Project entry in global config — identity only (name + path). */
const GlobalProjectEntrySchema = z.object({
  /** Display name */
  name: z.string().optional(),
  /** Local path to the repo */
  path: z.string(),
});

/**
 * Global config schema.
 * Contains project registry + operational settings.
 */
const GlobalConfigSchema = z.object({
  /** Web dashboard port */
  port: z.number().default(3000),
  /** Terminal WebSocket server port */
  terminalPort: z.number().optional(),
  /** Direct terminal WebSocket server port */
  directTerminalPort: z.number().optional(),
  /** Milliseconds before "ready" becomes "idle" */
  readyThresholdMs: z.number().nonnegative().default(300_000),
  /** Default plugin selections */
  defaults: z
    .object({
      runtime: z.string().default("tmux"),
      agent: z.string().default("claude-code"),
      workspace: z.string().default("worktree"),
      notifiers: z.array(z.string()).default(["composio", "desktop"]),
      orchestrator: z.object({ agent: z.string().optional() }).optional(),
      worker: z.object({ agent: z.string().optional() }).optional(),
    })
    .default({}),
  /** Project registry (identity: name + path; behavior comes from each project's local config) */
  projects: z.record(GlobalProjectEntrySchema).default({}),
  /** Display order for projects in sidebar/portfolio */
  projectOrder: z.array(z.string()).optional(),
  /** Installed external plugins */
  plugins: z.array(z.record(z.unknown())).optional(),
  /** Global notifier channel definitions */
  notifiers: z.record(z.object({ plugin: z.string() }).passthrough()).optional(),
  /** Global notification routing by priority level */
  notificationRouting: z.record(z.array(z.string())).optional(),
  /** Global reaction definitions (overridden per-project via local config) */
  reactions: z.record(z.any()).optional(),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type GlobalProjectEntry = z.infer<typeof GlobalProjectEntrySchema>;

// =============================================================================
// LOCAL (FLAT) CONFIG SCHEMA
// =============================================================================

/**
 * Default notification routing: maps EventPriority → notifier channel names.
 *
 * Defined here (not in config.ts) so both config.ts and migration.ts can
 * import it without creating a circular dependency.
 */
export const DEFAULT_NOTIFICATION_ROUTING: Record<string, string[]> = {
  urgent: ["desktop", "composio"],
  action: ["desktop", "composio"],
  warning: ["composio"],
  info: ["composio"],
};

/**
 * Shared Zod schema for `orchestratorSessionStrategy`.
 *
 * Exported so `ProjectConfigSchema` in config.ts can import it — ensuring
 * both parsing paths (local YAML + global pipeline) stay in sync.
 */
export const OrchestratorSessionStrategySchema = z
  .string()
  .optional()
  .transform((v) => {
    if (v === "kill-previous" || v === "delete-new") return "delete";
    if (v === "ignore-new") return "ignore";
    return v as "reuse" | "delete" | "ignore" | "new" | undefined;
  })
  .pipe(z.enum(["reuse", "delete", "ignore", "new"]).optional());

/**
 * New local project config — flat, behavior-only.
 * No `projects:` wrapper, no identity fields (name, path, sessionPrefix).
 */
const LocalProjectConfigSchema = z
  .object({
    repo: z.string(),
    defaultBranch: z.string().default("main"),
    runtime: z.string().optional(),
    agent: z.string().optional(),
    workspace: z.string().optional(),
    tracker: z.object({ plugin: z.string() }).passthrough().optional(),
    scm: z
      .object({
        plugin: z.string(),
        webhook: z
          .object({
            enabled: z.boolean().default(true),
            path: z.string().optional(),
            secretEnvVar: z.string().optional(),
            signatureHeader: z.string().optional(),
            eventHeader: z.string().optional(),
            deliveryHeader: z.string().optional(),
            maxBodyBytes: z.number().int().positive().optional(),
          })
          .optional(),
      })
      .passthrough()
      .optional(),
    symlinks: z.array(z.string()).optional(),
    postCreate: z.array(z.string()).optional(),
    agentConfig: z
      .object({
        permissions: z
          .enum(["permissionless", "default", "auto-edit", "suggest", "skip"])
          .default("permissionless")
          .transform((v) => (v === "skip" ? "permissionless" : v)),
        model: z.string().optional(),
        orchestratorModel: z.string().optional(),
        opencodeSessionId: z.string().optional(),
      })
      .passthrough()
      .default({}),
    orchestrator: z
      .object({
        agent: z.string().optional(),
        agentConfig: z
          .object({
            permissions: z
              .union([
                z.enum(["permissionless", "default", "auto-edit", "suggest"]),
                z.literal("skip"),
              ])
              .optional(),
            model: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .optional(),
    worker: z
      .object({
        agent: z.string().optional(),
        agentConfig: z
          .object({
            permissions: z
              .union([
                z.enum(["permissionless", "default", "auto-edit", "suggest"]),
                z.literal("skip"),
              ])
              .optional(),
            model: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .optional(),
    reactions: z.record(z.any()).optional(),
    notifiers: z.record(z.object({ plugin: z.string() }).passthrough()).optional(),
    notificationRouting: z.record(z.array(z.string())).optional(),
    agentRules: z.string().optional(),
    agentRulesFile: z.string().optional(),
    orchestratorRules: z.string().optional(),
    orchestratorSessionStrategy: OrchestratorSessionStrategySchema,
    decomposer: z
      .object({
        enabled: z.boolean().default(false),
        maxDepth: z.number().min(1).max(5).default(3),
        model: z.string().default("claude-sonnet-4-20250514"),
        requireApproval: z.boolean().default(true),
      })
      .optional(),
  })
  .passthrough();

export type LocalProjectConfig = z.infer<typeof LocalProjectConfigSchema>;

// =============================================================================
// DISCOVERY
// =============================================================================

/**
 * Discover the global config file path.
 *
 * Discovery order:
 * 1. AO_GLOBAL_CONFIG_PATH env var (dedicated to global config — avoids
 *    collision with AO_CONFIG_PATH which points to local/legacy configs)
 * 2. $XDG_CONFIG_HOME/agent-orchestrator/config.yaml (if XDG_CONFIG_HOME set)
 * 3. ~/.agent-orchestrator/config.yaml (fallback)
 */
export function findGlobalConfigPath(): string {
  if (process.env["AO_GLOBAL_CONFIG_PATH"]) {
    return resolve(process.env["AO_GLOBAL_CONFIG_PATH"]);
  }

  if (process.env["XDG_CONFIG_HOME"]) {
    return resolve(process.env["XDG_CONFIG_HOME"], "agent-orchestrator", "config.yaml");
  }

  return resolve(homedir(), ".agent-orchestrator", "config.yaml");
}

// =============================================================================
// LOADING
// =============================================================================

/**
 * Load the global config. Returns null if not found.
 */
export function loadGlobalConfig(): GlobalConfig | null {
  const path = findGlobalConfigPath();
  if (!existsSync(path)) {
    return null;
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);

  let validated: z.infer<typeof GlobalConfigSchema>;
  try {
    validated = GlobalConfigSchema.parse(parsed);
  } catch (err) {
    const detail = err instanceof z.ZodError
      ? err.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
      : String(err);
    throw new Error(`Invalid global config at ${path}:\n${detail}`, { cause: err });
  }

  // Build a new config with expanded home paths — immutable, no mutation.
  const config = structuredClone(validated);
  return {
    ...config,
    projects: Object.fromEntries(
      Object.entries(config.projects).map(([id, entry]) => [id, { ...entry, path: expandHome(entry.path) }])
    ),
  };
}


// =============================================================================
// SAVING
// =============================================================================

/**
 * Write the global config atomically (write to temp, rename).
 */
export function saveGlobalConfig(config: GlobalConfig): void {
  const path = findGlobalConfigPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  // Contract paths back to ~ for readability
  const serializable = structuredClone(config);
  const home = homedir();
  for (const entry of Object.values(serializable.projects)) {
    if (entry.path.startsWith(home + "/")) {
      entry.path = "~/" + entry.path.slice(home.length + 1);
    }
  }

  const yaml = stringifyYaml(serializable, { lineWidth: 0 });
  // Write temp file in the same directory as the target to avoid EXDEV errors
  // when /tmp is on a different filesystem (common on Linux with tmpfs).
  const tmpPath = join(dir, `.config-${randomBytes(6).toString("hex")}.yaml.tmp`);
  writeFileSync(tmpPath, yaml, "utf-8");
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// =============================================================================
// SCAFFOLD
// =============================================================================

/**
 * Create a minimal global config with no projects registered.
 */
export function scaffoldGlobalConfig(): GlobalConfig {
  const config = GlobalConfigSchema.parse({});
  saveGlobalConfig(config);
  return config;
}

// =============================================================================
// PROJECT REGISTRATION
// =============================================================================

/**
 * Register a project in the global config.
 * Does not save — caller must call saveGlobalConfig().
 */
export function registerProject(
  globalConfig: GlobalConfig,
  projectId: string,
  entry: GlobalProjectEntry,
): GlobalConfig {
  const updated = structuredClone(globalConfig);
  updated.projects[projectId] = entry;
  // Keep projectOrder consistent: if it's defined, append the new project
  // so it appears in the portfolio UI instead of being silently omitted.
  if (updated.projectOrder && !updated.projectOrder.includes(projectId)) {
    updated.projectOrder = [...updated.projectOrder, projectId];
  }
  return updated;
}

/**
 * Remove a project from the global config.
 * Does not save — caller must call saveGlobalConfig().
 */
export function unregisterProject(
  globalConfig: GlobalConfig,
  projectId: string,
): GlobalConfig {
  const updated = structuredClone(globalConfig);
  const { [projectId]: _, ...remainingProjects } = updated.projects;
  updated.projects = remainingProjects;
  if (updated.projectOrder) {
    updated.projectOrder = updated.projectOrder.filter((id) => id !== projectId);
  }
  return updated;
}

/**
 * Find the local config file for a project, if it exists.
 */
export function findLocalConfigPath(projectPath: string): string | null {
  const expanded = expandHome(projectPath);
  const candidates = [
    join(expanded, "agent-orchestrator.yaml"),
    join(expanded, "agent-orchestrator.yml"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Walk up the directory tree from startDir to find a local project config.
 * Returns the config path and the directory it was found in (the project root),
 * or null if no config is found up to the filesystem root.
 */
export function findLocalConfigUpwards(
  startDir: string,
): { configPath: string; projectRoot: string } | null {
  let dir = resolve(startDir);
  // Loop processes every directory except the root (where dir === dirname(dir)).
  while (dir !== dirname(dir)) {
    const configPath = findLocalConfigPath(dir);
    if (configPath) return { configPath, projectRoot: dir };
    dir = dirname(dir);
  }
  // Check the root directory (the loop exits before inspecting it).
  const rootConfigPath = findLocalConfigPath(dir);
  if (rootConfigPath) return { configPath: rootConfigPath, projectRoot: dir };
  return null;
}

/**
 * Load a flat local project config from a file path.
 */
export function loadLocalProjectConfig(configPath: string): LocalProjectConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read local project config at ${configPath}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`Invalid YAML in local project config at ${configPath}`, { cause: err });
  }
  try {
    return LocalProjectConfigSchema.parse(parsed);
  } catch (err) {
    throw new Error(`Invalid local project config at ${configPath}`, { cause: err });
  }
}

/**
 * Match the current working directory to a registered project.
 * Returns the project ID if found, null otherwise.
 */
export function matchProjectByCwd(
  globalConfig: GlobalConfig,
  cwd: string,
): string | null {
  const resolvedCwd = resolve(cwd);
  let bestMatch: { id: string; pathLen: number } | null = null;
  for (const [id, entry] of Object.entries(globalConfig.projects)) {
    const resolvedPath = resolve(expandHome(entry.path));
    if (resolvedCwd === resolvedPath || resolvedCwd.startsWith(resolvedPath + sep)) {
      // Prefer the longest (most specific) matching path
      if (!bestMatch || resolvedPath.length > bestMatch.pathLen) {
        bestMatch = { id, pathLen: resolvedPath.length };
      }
    }
  }
  return bestMatch?.id ?? null;
}

/**
 * Check if a project path is already registered (under a different ID).
 */
export function findProjectByPath(
  globalConfig: GlobalConfig,
  projectPath: string,
): { id: string; entry: GlobalProjectEntry } | null {
  const resolvedPath = resolve(expandHome(projectPath));
  for (const [id, entry] of Object.entries(globalConfig.projects)) {
    if (resolve(expandHome(entry.path)) === resolvedPath) {
      return { id, entry };
    }
  }
  return null;
}
