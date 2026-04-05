/**
 * Global config management for multi-project architecture.
 *
 * Layout:
 *   ~/.agent-orchestrator/
 *     config.yaml              <- Lightweight registry: project identity + global settings
 *     projects/
 *       {id}.yaml              <- Per-project shadow: behavior fields only
 *
 * The global config at config.yaml owns:
 * - Project registry (identity: name, path, project ID)
 * - Global operational settings (port, defaults, notifiers, reactions)
 *
 * Shadow files at projects/{id}.yaml own:
 * - Project behavior (agent, runtime, tracker, reactions, etc.)
 * - Synced from local config on `ao start` (hybrid mode)
 * - Edited directly by user (global-only mode)
 *
 * Two ownership modes per project:
 * - Hybrid: local config exists -> shadow is a read-only cache synced on `ao start`
 * - Global-only: no local config -> shadow IS the authoritative config
 *
 * Sync rules:
 *   - Shadow updated ONLY on `ao start`
 *   - Fields matching secret-like patterns excluded with warning
 *   - Identity fields (name, path) never overwritten by shadow sync
 *   - Unknown / future fields preserved as opaque passthrough
 *   - Write is always atomic (temp-file + rename)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, unlinkSync } from "node:fs";
import { resolve, join, dirname, basename, sep } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { atomicWriteFileSync } from "./atomic-write.js";
import { expandHome } from "./paths.js";

// =============================================================================
// TYPES / CONSTANTS
// =============================================================================

/** Config ownership mode per project */
export type ConfigMode = "hybrid" | "global-only";

/** Identity fields owned by the global registry — never overwritten by shadow. */
const IDENTITY_FIELDS = new Set(["name", "path", "sessionPrefix"]);

/** Internal fields prefixed with underscore (e.g. _shadowSyncedAt). */
const INTERNAL_FIELD_PREFIX = "_";

/** Internal fields (prefixed with _) */
const isInternalField = (key: string): boolean => key.startsWith(INTERNAL_FIELD_PREFIX);

/** Fields excluded from shadow sync (secret hygiene). Case-insensitive suffix match. */
const SECRET_SUFFIX_PATTERN = /(token|key|secret|password)$/i;

/**
 * Secret-like field patterns (excluded from shadow sync in hybrid mode).
 *
 * These patterns are intentionally specific to avoid accidentally excluding
 * config fields that only look like secrets by name (e.g. a field called
 * `apiKey` that holds an env-var *name* rather than the secret itself).
 * `/key$/i` alone is too broad — it would also match `workerKey`, `sessionKey`,
 * or any other field that ends in "key" but is not a credential. Instead we
 * require the field name to start with a known secret-category prefix, handling
 * both camelCase (`apiKey`) and SCREAMING_SNAKE_CASE (`API_KEY`) variants via
 * the optional `[-_]?` separator.
 */
const SECRET_PATTERNS = [
  /(?:access|auth|api|bearer|refresh|id|secret)[-_]?token$/i,
  /(?:api|secret|private|access|signing|encryption|auth)[-_]?key$/i,
  /secret$/i,
  /password$/i,
  /credentials?$/i,
];

export function isSecretField(key: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(key));
}

// =============================================================================
// GLOBAL CONFIG PATH (XDG-aware)
// =============================================================================

/**
 * Return the canonical path to the global config file.
 *
 * Priority:
 *   1. AO_GLOBAL_CONFIG environment variable (explicit global config override)
 *   2. $XDG_CONFIG_HOME/agent-orchestrator/config.yaml
 *   3. ~/.agent-orchestrator/config.yaml  (default)
 *
 * NOTE: This intentionally does NOT read AO_CONFIG_PATH. That env var is used
 * by findConfigFile() to locate any config (including project-local ones).
 * Using it here would risk overwriting a project-local config with global-format
 * YAML when syncProjectShadow/registerProjectInGlobalConfig call this function.
 */
export function getGlobalConfigPath(): string {
  if (process.env["AO_GLOBAL_CONFIG"]) {
    return resolve(process.env["AO_GLOBAL_CONFIG"]);
  }

  const xdgConfigHome = process.env["XDG_CONFIG_HOME"];
  if (xdgConfigHome) {
    return join(xdgConfigHome, "agent-orchestrator", "config.yaml");
  }

  return join(homedir(), ".agent-orchestrator", "config.yaml");
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

/**
 * Project entry in global config — identity only.
 * Behavior fields live in separate shadow files at ~/.agent-orchestrator/projects/{id}.yaml.
 */
export const GlobalProjectEntrySchema = z.object({
  /** Display name */
  name: z.string().optional(),
  /** Local path to the repo */
  path: z.string(),
  /** Unix timestamp of last successful shadow sync from local config. */
  _shadowSyncedAt: z.number().optional(),
}).passthrough();

export type GlobalProjectEntry = z.infer<typeof GlobalProjectEntrySchema>;

/**
 * Global config schema.
 * Contains project registry + operational settings.
 */
export const GlobalConfigSchema = z.object({
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
  /** Project registry (identity only — behavior is in shadow files) */
  projects: z.record(GlobalProjectEntrySchema).default({}),
  /** Display order for projects in sidebar/portfolio */
  projectOrder: z.array(z.string()).optional(),
  /** Installed external plugins */
  plugins: z.array(z.any()).optional(),
  /** Global notifier channel definitions */
  notifiers: z.record(z.object({ plugin: z.string() }).passthrough()).optional(),
  /** Global notification routing by priority level */
  notificationRouting: z.record(z.array(z.string())).optional(),
  /** Global reaction definitions (overridden per-project via shadow/local config) */
  reactions: z.record(z.any()).optional(),
}).passthrough();

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

// =============================================================================
// LOCAL (FLAT) CONFIG SCHEMA
// =============================================================================

/**
 * Flat, behavior-only local project config.
 * Lives at <project>/agent-orchestrator.yaml.
 *
 * Does NOT contain identity fields: name, path, sessionPrefix.
 * Those are owned by the global registry.
 *
 * Uses passthrough() for forward compatibility — unknown fields from
 * future ao versions are stored in the shadow without re-parsing.
 */
export const LocalProjectConfigSchema = z
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
    orchestratorSessionStrategy: z
      .enum(["reuse", "delete", "ignore", "delete-new", "ignore-new", "kill-previous"])
      .optional(),
    opencodeIssueSessionStrategy: z.enum(["reuse", "delete", "ignore"]).optional(),
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
 * Load and validate the global config.
 * Returns null if the file does not exist (not an error — first run).
 *
 * When called without arguments, uses findGlobalConfigPath() for the path.
 * When called with configPath, loads from the specified path directly (used by
 * tests and backward-compatible code that manages its own config location).
 */
export function loadGlobalConfig(configPath?: string): GlobalConfig | null {
  const path = configPath ?? findGlobalConfigPath();
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object") return null;

  let validated: z.infer<typeof GlobalConfigSchema>;
  try {
    validated = GlobalConfigSchema.parse(parsed);
  } catch (err) {
    const detail = err instanceof z.ZodError
      ? err.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
      : String(err);
    throw new Error(`Invalid global config at ${path}:\n${detail}`, { cause: err });
  }

  // Clone before mutating to avoid modifying Zod's parse output directly
  const config = structuredClone(validated);
  // Expand ~ in project paths
  for (const entry of Object.values(config.projects)) {
    entry.path = expandHome(entry.path);
  }

  return config;
}

// =============================================================================
// SAVING
// =============================================================================

/**
 * Save the global config atomically (temp-file + rename).
 * Creates parent directories if they don't exist.
 *
 * When called without configPath, uses findGlobalConfigPath() and contracts
 * paths back to ~ for readability. When called with configPath, writes to the
 * specified location directly (used by tests and backward-compatible code).
 */
export function saveGlobalConfig(config: GlobalConfig, configPath?: string): void {
  const path = configPath ?? findGlobalConfigPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  if (configPath) {
    // Legacy path: write directly using atomicWriteFileSync
    atomicWriteFileSync(path, stringifyYaml(config, { indent: 2 }));
  } else {
    // New path: contract paths back to ~ for readability
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
    renameSync(tmpPath, path);
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
  // Note: shadow file deletion is NOT done here — callers should call
  // deleteShadowFile(projectId) AFTER successfully saving the global config,
  // to avoid data loss if saveGlobalConfig fails.
  return updated;
}

// =============================================================================
// SHADOW FILE I/O
// =============================================================================

/**
 * Get the directory where per-project shadow files are stored.
 * Located next to the global config file: ~/.agent-orchestrator/projects/
 */
export function getShadowDir(): string {
  const globalPath = findGlobalConfigPath();
  return join(dirname(globalPath), "projects");
}

/**
 * Get the shadow file path for a specific project.
 * Validates the project ID to prevent path traversal.
 */
export function getShadowFilePath(projectId: string): string {
  // Reject IDs with path separators or traversal patterns
  if (!projectId || /[/\\]/.test(projectId) || /\.\./.test(projectId) || projectId === ".") {
    throw new Error(`Invalid project ID for shadow file: "${projectId}"`);
  }
  return join(getShadowDir(), `${projectId}.yaml`);
}

/**
 * Load a shadow file for a project. Returns null if missing or unparseable.
 * Fault-isolated: one broken shadow does not affect other projects.
 */
export function loadShadowFile(projectId: string): Record<string, unknown> | null {
  const filePath = getShadowFilePath(projectId);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Save a shadow file for a project. Atomic write (temp + rename).
 */
export function saveShadowFile(projectId: string, data: Record<string, unknown>): void {
  const dir = getShadowDir();
  mkdirSync(dir, { recursive: true });
  const filePath = getShadowFilePath(projectId);
  const yaml = stringifyYaml(data, { lineWidth: 0 });
  const tmpPath = join(dir, `.${projectId}-${randomBytes(6).toString("hex")}.yaml.tmp`);
  writeFileSync(tmpPath, yaml, "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * Delete a shadow file for a project.
 */
export function deleteShadowFile(projectId: string): void {
  const filePath = getShadowFilePath(projectId);
  if (!existsSync(filePath)) return;
  try {
    unlinkSync(filePath);
  } catch {
    // Best-effort cleanup
  }
}

// =============================================================================
// MODE DETECTION
// =============================================================================

/**
 * Detect the config ownership mode for a project.
 *
 * - If a local `agent-orchestrator.yaml` exists at project.path -> hybrid
 * - Otherwise -> global-only
 */
export function detectConfigMode(projectPath: string): ConfigMode {
  const localPath = findLocalConfigPath(projectPath);
  return localPath ? "hybrid" : "global-only";
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
 * Load a flat local project config.
 *
 * Accepts either:
 *   - A file path (ending in .yaml/.yml) — loads directly
 *   - A project directory path — searches for agent-orchestrator.yaml/.yml
 *
 * Returns null when:
 *   - No config file found
 *   - File has a `projects:` wrapper (old format — use loadConfig() instead)
 *   - File is empty or malformed
 */
export function loadLocalProjectConfig(configOrProjectPath: string): LocalProjectConfig | null {
  // If it's a file path (ends with .yaml/.yml), load directly
  if (configOrProjectPath.endsWith(".yaml") || configOrProjectPath.endsWith(".yml")) {
    try {
      const raw = readFileSync(configOrProjectPath, "utf-8");
      const parsed = parseYaml(raw);
      return LocalProjectConfigSchema.parse(parsed);
    } catch {
      return null;
    }
  }

  // Otherwise treat as project directory path and search for config
  const candidates = [
    join(configOrProjectPath, "agent-orchestrator.yaml"),
    join(configOrProjectPath, "agent-orchestrator.yml"),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;

    let parsed: unknown;
    try {
      const raw = readFileSync(path, "utf-8");
      parsed = parseYaml(raw);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object") return null;

    // Old format: has `projects:` wrapper -> not a flat local config
    if ("projects" in (parsed as Record<string, unknown>)) return null;

    try {
      return LocalProjectConfigSchema.parse(parsed);
    } catch {
      return null;
    }
  }

  return null;
}


// =============================================================================
// SHADOW SYNC
// =============================================================================

/**
 * Compute shadow content from a local config without writing to disk.
 *
 * Pure function: excludes identity fields, internal fields, and secret-like
 * fields. Stamps _shadowSyncedAt. Used to validate before any disk writes.
 *
 * Returns { shadow, excludedSecrets }
 */
export function computeShadow(
  localConfig: LocalProjectConfig,
): { shadow: Record<string, unknown>; excludedSecrets: string[] } {
  const excludedSecrets: string[] = [];
  const shadow: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(localConfig)) {
    if (IDENTITY_FIELDS.has(key) || isInternalField(key)) continue;

    if (isSecretField(key)) {
      excludedSecrets.push(key);
      continue;
    }

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      shadow[key] = filterSecrets(value as Record<string, unknown>, excludedSecrets, key);
    } else {
      shadow[key] = value;
    }
  }

  shadow["_shadowSyncedAt"] = Math.floor(Date.now() / 1000);
  return { shadow, excludedSecrets };
}

/**
 * Sync local config into a per-project shadow file (hybrid mode).
 *
 * Writes behavior fields to ~/.agent-orchestrator/projects/{id}.yaml.
 * Does NOT modify the global config (identity stays in config.yaml).
 * Excludes secret-like fields with a warning.
 *
 * Returns { unchanged global config, excluded secret fields }
 */
export function syncShadow(
  globalConfig: GlobalConfig,
  projectId: string,
  localConfig: LocalProjectConfig,
): { config: GlobalConfig; excludedSecrets: string[] } {
  if (!globalConfig.projects[projectId]) {
    throw new Error(`Project "${projectId}" not found in global config`);
  }

  const { shadow, excludedSecrets } = computeShadow(localConfig);

  // Write to per-project shadow file (not inline in global config)
  saveShadowFile(projectId, shadow);

  // Return globalConfig unchanged — identity stays in config.yaml
  return { config: globalConfig, excludedSecrets };
}

/**
 * Sync local project behavior fields into the global config shadow, atomically.
 *
 * Legacy API — writes shadow fields inline into the global config projects map.
 * Kept for backward compatibility with tests and code that expects this pattern.
 * New code should use syncShadow() which writes to per-project shadow files.
 *
 * Rules:
 *   - Identity fields (name, path, sessionPrefix) are never overwritten
 *   - Fields starting with `_` (internal) are excluded
 *   - Fields matching secret patterns are excluded (warn)
 *   - All other fields from localConfig are written verbatim (passthrough)
 *   - _shadowSyncedAt is set to current Unix timestamp
 *   - Write is atomic
 */
export function syncProjectShadow(
  projectId: string,
  localConfig: LocalProjectConfig,
  globalConfigPath?: string,
): void {
  const configPath = globalConfigPath ?? getGlobalConfigPath();
  const globalConfig = loadGlobalConfig(configPath) ?? makeEmptyGlobalConfig();

  const existing = globalConfig.projects[projectId] as
    | (GlobalProjectEntry & Record<string, unknown>)
    | undefined;

  // Build shadow from local config fields
  const shadowFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(localConfig as Record<string, unknown>)) {
    if (IDENTITY_FIELDS.has(key)) continue;
    if (key.startsWith(INTERNAL_FIELD_PREFIX)) continue;
    if (SECRET_SUFFIX_PATTERN.test(key)) {
      process.stderr.write(
        `ao: warning — excluding "${key}" from shadow sync (secret-like field name). ` +
          `Use environment variables for secrets.\n`,
      );
      continue;
    }
    shadowFields[key] = value;
  }

  // Rebuild project entry: preserve identity, overwrite behavior
  globalConfig.projects[projectId] = {
    ...(existing?.name !== null && existing?.name !== undefined ? { name: existing.name } : {}),
    path: existing?.path ?? "",
    ...(typeof existing?.sessionPrefix === "string"
      ? { sessionPrefix: existing.sessionPrefix }
      : {}),
    ...shadowFields,
    _shadowSyncedAt: Math.floor(Date.now() / 1000),
  };

  saveGlobalConfig(globalConfig, configPath);
}

/** Recursively filter secret-like fields from an object at all nesting levels */
export function filterSecrets(
  obj: Record<string, unknown>,
  excluded: string[],
  parentKey: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSecretField(key)) {
      excluded.push(`${parentKey}.${key}`);
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = filterSecrets(value as Record<string, unknown>, excluded, `${parentKey}.${key}`);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// =============================================================================
// REGISTRATION (Legacy inline API)
// =============================================================================

/**
 * Register or update a project in the global registry.
 *
 * Legacy API — writes project entry inline into the global config.
 * New code should use registerProject() + saveGlobalConfig() separately.
 *
 * - If the project already exists, identity fields are preserved and only
 *   updated if explicitly provided.
 * - If localConfig is provided, the shadow is synced immediately after
 *   writing the registry entry.
 * - Write is atomic.
 */
export function registerProjectInGlobalConfig(
  projectId: string,
  name: string,
  projectPath: string,
  localConfig?: LocalProjectConfig,
  globalConfigPath?: string,
): void {
  const configPath = globalConfigPath ?? getGlobalConfigPath();
  const globalConfig = loadGlobalConfig(configPath) ?? makeEmptyGlobalConfig();

  const existing = globalConfig.projects[projectId] as
    | (GlobalProjectEntry & Record<string, unknown>)
    | undefined;

  // Preserve existing shadow behavior fields; update identity
  globalConfig.projects[projectId] = {
    ...(existing ?? {}),
    name,
    path: projectPath,
  };

  saveGlobalConfig(globalConfig, configPath);

  if (localConfig) {
    syncProjectShadow(projectId, localConfig, configPath);
  }
}

// =============================================================================
// EFFECTIVE CONFIG BUILD
// =============================================================================

/**
 * Build effective project configuration by merging global registry identity
 * with local behavior config.
 *
 * Load order:
 *   1. Global entry supplies identity (name, path) + shadow behavior
 *   2. Local flat config (if present) overrides shadow behavior with fresh fields
 *   3. Shadow-fallback mode: global shadow used when local config is absent
 *
 * Returns a plain object compatible with ProjectConfig from config.ts.
 * Returns null if the project is not registered in the global config.
 */
export function buildEffectiveProjectConfig(
  projectId: string,
  globalConfig: GlobalConfig,
): (Record<string, unknown> & { name: string; path: string }) | null {
  const entry = globalConfig.projects[projectId] as
    | (GlobalProjectEntry & Record<string, unknown>)
    | undefined;
  if (!entry || !entry.path) return null;

  const projectPath = entry.path as string;
  const name = (entry.name as string | undefined) ?? projectId;

  const localConfig = loadLocalProjectConfig(projectPath);

  if (localConfig) {
    // In-project mode: global identity + local behavior (override shadow)
    const { name: _name, path: _path, _shadowSyncedAt: _ts, ...shadowBehavior } = entry;
    void _name;
    void _path;
    void _ts;

    return {
      name,
      path: projectPath,
      ...shadowBehavior,
      ...(localConfig as Record<string, unknown>),
    };
  }

  // Shadow-fallback mode: use shadow as-is
  const { _shadowSyncedAt: _ts, ...rest } = entry;
  void _ts;
  return {
    ...rest,
    name,
    path: projectPath,
  };
}

// =============================================================================
// STALENESS DETECTION
// =============================================================================

/**
 * Returns true if the local config file is newer than the last shadow sync.
 * Used by `ao status` to warn the user to restart ao.
 */
export function isProjectShadowStale(projectId: string, globalConfig: GlobalConfig): boolean {
  const entry = globalConfig.projects[projectId] as
    | (GlobalProjectEntry & { _shadowSyncedAt?: number })
    | undefined;
  if (!entry) return false;

  const syncedAt = entry._shadowSyncedAt;
  if (!syncedAt) return true; // Never synced

  const projectPath = entry.path as string;
  const candidates = [
    join(projectPath, "agent-orchestrator.yaml"),
    join(projectPath, "agent-orchestrator.yml"),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const stat = statSync(candidate);
      const mtimeSeconds = Math.floor(stat.mtimeMs / 1000);
      return mtimeSeconds > syncedAt;
    } catch {
      return false;
    }
  }

  return false;
}

// =============================================================================
// MIGRATION
// =============================================================================

/**
 * Detect if a raw parsed YAML object uses the old single-file config format.
 * Old format: top-level `projects:` map where each entry has `path` + behavior.
 */
export function isOldConfigFormat(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  if (!("projects" in obj) || typeof obj["projects"] !== "object") return false;

  // Confirm at least one project entry has `path` (old format)
  const projects = obj["projects"] as Record<string, unknown>;
  return Object.values(projects).some(
    (entry) =>
      entry !== null && entry !== undefined && typeof entry === "object" && "path" in (entry as Record<string, unknown>),
  );
}

/**
 * Migrate an old single-file config to the new hybrid format.
 *
 * What happens:
 *   1. Read old config from oldConfigPath
 *   2. Create global config at ~/.agent-orchestrator/config.yaml with:
 *      - Global settings (port, defaults, notifiers, reactions)
 *      - Project registry entries (identity) + full behavior as shadow
 *      - _shadowSyncedAt = now (treating existing config as synced)
 *   3. Rewrite local config at oldConfigPath to flat behavior-only format
 *      (removes name, path, sessionPrefix from each project entry, removes
 *       the `projects:` wrapper — only the first/matched project is written
 *       when the old config is inside the project directory)
 *   4. Returns the new global config path
 *
 * @param oldConfigPath  Absolute path to the old agent-orchestrator.yaml
 * @param globalConfigPath  Override for global config path (default: getGlobalConfigPath())
 * @returns The global config path
 */
export function migrateToGlobalConfig(oldConfigPath: string, globalConfigPath?: string): string {
  const targetGlobalPath = globalConfigPath ?? getGlobalConfigPath();

  const raw = readFileSync(oldConfigPath, "utf-8");
  const parsed = parseYaml(raw) as Record<string, unknown>;

  if (!isOldConfigFormat(parsed)) {
    throw new Error(`File at ${oldConfigPath} is not an old-format config.`);
  }

  const oldProjects = (parsed["projects"] ?? {}) as Record<string, Record<string, unknown>>;

  // Build new global config
  const newGlobal: GlobalConfig = makeEmptyGlobalConfig();

  // Preserve global operational settings
  if (typeof parsed["port"] === "number") newGlobal.port = parsed["port"];
  if (parsed["terminalPort"] !== null && parsed["terminalPort"] !== undefined) newGlobal.terminalPort = parsed["terminalPort"] as number;
  if (parsed["directTerminalPort"] !== null && parsed["directTerminalPort"] !== undefined)
    newGlobal.directTerminalPort = parsed["directTerminalPort"] as number;
  if (parsed["readyThresholdMs"] !== null && parsed["readyThresholdMs"] !== undefined)
    newGlobal.readyThresholdMs = parsed["readyThresholdMs"] as number;
  if (parsed["defaults"] !== null && parsed["defaults"] !== undefined)
    newGlobal.defaults = parsed["defaults"] as GlobalConfig["defaults"];
  if (parsed["notifiers"] !== null && parsed["notifiers"] !== undefined)
    newGlobal.notifiers = parsed["notifiers"] as GlobalConfig["notifiers"];
  if (parsed["notificationRouting"] !== null && parsed["notificationRouting"] !== undefined)
    newGlobal.notificationRouting = parsed[
      "notificationRouting"
    ] as GlobalConfig["notificationRouting"];
  if (parsed["reactions"] !== null && parsed["reactions"] !== undefined)
    newGlobal.reactions = parsed["reactions"] as GlobalConfig["reactions"];

  const now = Math.floor(Date.now() / 1000);

  // Build project registry entries
  for (const [projectId, project] of Object.entries(oldProjects)) {
    if (!project["path"]) continue;

    const projectPath =
      typeof project["path"] === "string" && project["path"].startsWith("~/")
        ? join(homedir(), (project["path"] as string).slice(2))
        : (project["path"] as string);

    // Extract behavior fields (everything except identity + internal)
    const shadowFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(project)) {
      if (key === "name" || key === "path" || key === "sessionPrefix") continue;
      if (key.startsWith(INTERNAL_FIELD_PREFIX)) continue;
      if (SECRET_SUFFIX_PATTERN.test(key)) {
        process.stderr.write(
          `ao: warning — excluding "${key}" from global config during migration (secret-like field name). ` +
            `Use environment variables for secrets.\n`,
        );
        continue;
      }
      shadowFields[key] = value;
    }

    newGlobal.projects[projectId] = {
      name: (project["name"] as string | undefined) ?? projectId,
      path: projectPath,
      ...(typeof project["sessionPrefix"] === "string"
        ? { sessionPrefix: project["sessionPrefix"] as string }
        : {}),
      ...shadowFields,
      _shadowSyncedAt: now,
    };
  }

  // Write global config atomically
  saveGlobalConfig(newGlobal, targetGlobalPath);

  // Rewrite each old project's local config to flat format.
  const oldConfigDir = dirname(resolve(oldConfigPath));
  for (const [_projectId, project] of Object.entries(oldProjects)) {
    if (!project["path"]) continue;

    const projectPath =
      typeof project["path"] === "string" && project["path"].startsWith("~/")
        ? join(homedir(), (project["path"] as string).slice(2))
        : (project["path"] as string);

    // Only rewrite if the old config lives inside this project's directory
    if (resolve(projectPath) !== resolve(oldConfigDir)) continue;

    const behaviorFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(project)) {
      if (key === "name" || key === "path" || key === "sessionPrefix") continue;
      if (key.startsWith(INTERNAL_FIELD_PREFIX)) continue;
      behaviorFields[key] = value;
    }

    // Write flat local config
    const localConfigPath = join(projectPath, basename(oldConfigPath));
    atomicWriteFileSync(localConfigPath, stringifyYaml(behaviorFields, { indent: 2 }));
  }

  return targetGlobalPath;
}

// =============================================================================
// MATCH / LOOKUP
// =============================================================================

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

// =============================================================================
// HELPERS
// =============================================================================

function makeEmptyGlobalConfig(): GlobalConfig {
  return {
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["composio", "desktop"],
    },
    projects: {},
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop", "composio"],
      action: ["desktop", "composio"],
      warning: ["composio"],
      info: ["composio"],
    },
    reactions: {},
  };
}
