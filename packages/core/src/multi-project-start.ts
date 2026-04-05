/**
 * Multi-project registration and sync logic for `ao start`.
 *
 * Pure functions that handle project registration, shadow sync, and
 * config building without any CLI dependencies (no chalk, no console).
 * The CLI command wraps these with user-facing output.
 */

import { resolve, basename } from "node:path";
import type { OrchestratorConfig } from "./types.js";
import {
  type GlobalConfig,
  type GlobalProjectEntry,
  loadGlobalConfig,
  saveGlobalConfig,
  registerProject,
  detectConfigMode,
  findLocalConfigPath,
  findLocalConfigUpwards,
  loadLocalProjectConfig,
  computeShadow,
  syncShadow,
  saveShadowFile,
  matchProjectByCwd,
  findGlobalConfigPath,
} from "./global-config.js";
import { buildEffectiveConfig } from "./migration.js";
import { generateSessionPrefix, generateProjectId, expandHome } from "./paths.js";
import { applyGlobalConfigPipeline } from "./config.js";

// ---------------------------------------------------------------------------
// Shared registration helper (used by both ao project add and resolveMultiProjectStart)
// ---------------------------------------------------------------------------

export interface RegisterNewProjectOpts {
  /** Explicit project ID requested by the user (e.g. via --id). Throws on collision. */
  explicitId?: string;
  /** Name override (e.g. via --name). Falls back to basename(projectPath). */
  name?: string;
}

export interface RegisterNewProjectResult {
  projectId: string;
  /** Updated global config with the new project registered (not yet saved). */
  updatedGlobalConfig: GlobalConfig;
  configMode: "hybrid" | "global-only";
  messages: Array<{ level: "info" | "warn" | "success"; text: string }>;
  /**
   * Computed shadow content — NOT yet written to disk.
   * The caller must write this with saveShadowFile AFTER validation passes.
   * This enables the validate-first, write-after pattern: no cleanup paths needed.
   */
  pendingShadow: Record<string, unknown>;
}

/**
 * Register a new project in the global config registry and write its shadow file.
 *
 * Handles: ID derivation, collision resolution, registerProject, shadow sync
 * (hybrid) or scaffold (global-only), and session prefix writeback for
 * auto-suffixed IDs.
 *
 * Does NOT validate (applyGlobalConfigPipeline) or save (saveGlobalConfig) —
 * the caller is responsible for both so it can clean up on validation failure.
 *
 * Throws if shadow sync fails on a new registration — this prevents persisting
 * a broken state where the project is registered but has an empty/missing shadow.
 */
export function registerNewProject(
  globalConfig: GlobalConfig,
  projectPath: string,
  opts?: RegisterNewProjectOpts,
): RegisterNewProjectResult {
  const messages: RegisterNewProjectResult["messages"] = [];

  // Derive project ID
  let projectId = opts?.explicitId ?? generateSessionPrefix(generateProjectId(projectPath));
  const originalProjectId = projectId;

  // Collision resolution
  if (globalConfig.projects[projectId]) {
    const conflicting = globalConfig.projects[projectId];
    if (resolve(expandHome(conflicting.path)) !== projectPath) {
      if (opts?.explicitId) {
        throw new Error(
          `Project ID "${projectId}" is already in use by ${conflicting.path}.`,
        );
      }
      let suffix = 2;
      let altId = `${projectId}${suffix}`;
      while (globalConfig.projects[altId]) {
        suffix++;
        altId = `${projectId}${suffix}`;
      }
      messages.push({ level: "warn", text: `ID "${projectId}" taken, using "${altId}"` });
      projectId = altId;
    }
  }

  const entry: GlobalProjectEntry = {
    name: opts?.name ?? basename(projectPath),
    path: projectPath,
  };
  const updatedGlobalConfig = registerProject(globalConfig, projectId, entry);

  // Compute shadow content (no disk writes — caller writes after validation).
  const configMode = detectConfigMode(projectPath);
  let pendingShadow: Record<string, unknown>;

  if (configMode === "hybrid") {
    const localPath = findLocalConfigPath(projectPath);
    if (localPath) {
      const localConfig = loadLocalProjectConfig(localPath);
      const { shadow, excludedSecrets } = computeShadow(localConfig);
      pendingShadow = shadow;
      if (excludedSecrets.length > 0) {
        messages.push({ level: "warn", text: `Excluded secret-like fields: ${excludedSecrets.join(", ")}` });
      }
      messages.push({ level: "success", text: "Shadow synced" });
    } else {
      pendingShadow = { repo: "", defaultBranch: "main" };
    }
  } else {
    // Global-only: scaffold a minimal shadow so buildEffectiveConfig has values
    // for repo/defaultBranch/agent rather than falling back to empty defaults.
    pendingShadow = { repo: "", defaultBranch: "main" };
  }

  // If the ID was auto-suffixed to resolve a collision (e.g. "ao" → "ao2"),
  // applyProjectDefaults would re-derive the session prefix from basename(path),
  // producing the same prefix as the original project and causing a collision.
  // Store the suffixed prefix in the pending shadow so buildEffectiveConfig
  // picks it up and applyProjectDefaults uses it instead of re-deriving.
  if (projectId !== originalProjectId) {
    pendingShadow = { ...pendingShadow, sessionPrefix: generateSessionPrefix(projectId) };
  }

  return { projectId, updatedGlobalConfig, configMode, messages, pendingShadow };
}

// ---------------------------------------------------------------------------
// Registration commit helper (shared by resolveMultiProjectStart + CLI)
// ---------------------------------------------------------------------------

/**
 * Validate a pending registration and, if valid, commit it to disk atomically.
 *
 * Encapsulates the validate-first, write-after contract:
 * 1. Build effective config using pendingShadow (no disk reads for new project)
 * 2. Run applyGlobalConfigPipeline — throws on any validation error
 * 3. Write shadow file + global config only after validation passes
 *
 * Throws on validation failure. Because no files are written until step 3,
 * no cleanup is needed on failure.
 *
 * @param warnings - Optional array to collect non-fatal build warnings
 */
export function validateAndCommitRegistration(
  reg: RegisterNewProjectResult,
  globalConfigPath: string,
  warnings?: string[],
): ReturnType<typeof applyGlobalConfigPipeline> {
  const pendingShadows = { [reg.projectId]: reg.pendingShadow };
  const built = buildEffectiveConfig(reg.updatedGlobalConfig, globalConfigPath, warnings, pendingShadows);
  const effectiveConfig = applyGlobalConfigPipeline(built);
  saveShadowFile(reg.projectId, reg.pendingShadow);
  saveGlobalConfig(reg.updatedGlobalConfig);
  return effectiveConfig;
}

// ---------------------------------------------------------------------------
// Multi-project start result
// ---------------------------------------------------------------------------

export interface MultiProjectStartResult {
  config: OrchestratorConfig;
  projectId: string;
  /** Messages for the CLI to display (type + text) */
  messages: Array<{ level: "info" | "warn" | "success"; text: string }>;
}

/**
 * Core logic for multi-project registration and shadow sync.
 *
 * Returns null if no global config exists (caller should fall back to
 * legacy single-file flow).
 */
export function resolveMultiProjectStart(
  workingDir: string,
): MultiProjectStartResult | null {
  const resolvedDir = resolve(workingDir);
  const messages: MultiProjectStartResult["messages"] = [];

  // Load global config
  let globalConfig = loadGlobalConfig();
  if (!globalConfig) {
    return null;
  }

  // 3. Match CWD to a registered project
  let projectId = matchProjectByCwd(globalConfig, resolvedDir);
  let isNewRegistration = false;

  // newReg is set for new registrations and carries the pending shadow + updated global config
  // through to the validateAndCommitRegistration call below.
  let newReg: RegisterNewProjectResult | undefined;

  if (!projectId) {
    const found = findLocalConfigUpwards(resolvedDir);
    const projectRoot = found?.projectRoot ?? resolvedDir;

    if (found) {
      // Auto-register via shared helper — pure, no disk writes.
      const reg = registerNewProject(globalConfig, projectRoot);
      projectId = reg.projectId;
      globalConfig = reg.updatedGlobalConfig;
      newReg = reg;
      isNewRegistration = true;
      messages.push(...reg.messages);
      messages.push({ level: "success", text: `Registered project "${projectId}" (${reg.configMode} mode)` });
    } else {
      return null;
    }
  } else {
    // Already registered — sync shadow if hybrid.
    // syncShadow writes immediately here: the project already exists in the registry,
    // so there's no risk of leaving an orphaned shadow on validation failure.
    const registeredPath = expandHome(globalConfig.projects[projectId].path);
    const mode = detectConfigMode(registeredPath);
    if (mode === "hybrid") {
      const localPath = findLocalConfigPath(registeredPath);
      if (localPath) {
        try {
          const localConfig = loadLocalProjectConfig(localPath);
          const { excludedSecrets } = syncShadow(globalConfig, projectId, localConfig);
          if (excludedSecrets.length > 0) {
            messages.push({ level: "warn", text: `Excluded secret-like fields: ${excludedSecrets.join(", ")}` });
          }
        } catch (err) {
          messages.push({ level: "warn", text: `Shadow sync failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    }
  }

  // 4. Validate and commit.
  // New registrations: validateAndCommitRegistration builds with pendingShadow
  // so validation sees the correct session prefix before any writes, then writes
  // both files only after validation passes.
  // Already-registered: build normally (shadow already on disk, no new writes needed).
  const globalPath = findGlobalConfigPath();
  const buildWarnings: string[] = [];
  let effectiveConfig: ReturnType<typeof applyGlobalConfigPipeline>;

  if (isNewRegistration && newReg) {
    effectiveConfig = validateAndCommitRegistration(newReg, globalPath, buildWarnings);
  } else {
    const built = buildEffectiveConfig(globalConfig, globalPath, buildWarnings);
    effectiveConfig = applyGlobalConfigPipeline(built);
  }
  for (const w of buildWarnings) {
    messages.push({ level: "warn", text: w });
  }

  return { config: effectiveConfig, projectId, messages };
}
