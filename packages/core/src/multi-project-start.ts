/**
 * Multi-project registration and sync logic for `ao start`.
 *
 * Pure functions that handle project registration and
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
  findLocalConfigUpwards,
  matchProjectByCwd,
  findGlobalConfigPath,
} from "./global-config.js";
import { buildEffectiveConfig } from "./migration.js";
import { generateProjectId, expandHome } from "./paths.js";
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
  configMode: "hybrid";
  messages: Array<{ level: "info" | "warn" | "success"; text: string }>;
}

/**
 * Register a new project in the global config registry.
 *
 * Handles ID derivation, collision resolution, and registerProject.
 *
 * Pure — no disk writes. Call validateAndCommitRegistration to commit after
 * validation passes (validate-first, write-after: no cleanup paths needed on failure).
 */
export function registerNewProject(
  globalConfig: GlobalConfig,
  projectPath: string,
  opts?: RegisterNewProjectOpts,
): RegisterNewProjectResult {
  const messages: RegisterNewProjectResult["messages"] = [];

  // Resolve projectPath so callers passing relative or ~-prefixed paths work correctly.
  const resolvedProjectPath = resolve(expandHome(projectPath));

  // Derive project ID from the directory basename (human-readable, collision-resistant).
  // generateSessionPrefix is intentionally NOT applied here — that produces short
  // tmux-friendly prefixes (e.g. "ao" for "agent-orchestrator") which are fine for
  // session names but make poor registry IDs. The session prefix is derived
  // separately during applyProjectDefaults.
  let projectId = opts?.explicitId ?? generateProjectId(resolvedProjectPath);

  // Collision resolution
  if (globalConfig.projects[projectId]) {
    const conflicting = globalConfig.projects[projectId];
    const expandedConflicting = expandHome(conflicting.path);
    // If HOME is unset, expandHome returns the path unchanged (still starts with "~").
    // resolve("~/foo") would treat ~ as a literal directory name, not the home dir.
    // In that case, treat the paths as non-matching (safe: generates a suffix ID).
    const resolvedConflicting = expandedConflicting.startsWith("~")
      ? expandedConflicting
      : resolve(expandedConflicting);
    if (resolvedConflicting !== resolvedProjectPath) {
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
    name: opts?.name ?? basename(resolvedProjectPath),
    path: resolvedProjectPath,
  };
  const updatedGlobalConfig = registerProject(globalConfig, projectId, entry);

  return { projectId, updatedGlobalConfig, configMode: "hybrid", messages };
}

// ---------------------------------------------------------------------------
// Registration commit helper (shared by resolveMultiProjectStart + CLI)
// ---------------------------------------------------------------------------

/**
 * Validate a pending registration and, if valid, commit it to disk.
 *
 * 1. Build effective config and run applyGlobalConfigPipeline — throws on
 *    any validation error (e.g. session prefix collision).
 * 2. Do a final re-read immediately before writing to minimise the concurrent-
 *    registration window to just the rename(2) syscall. If another process
 *    registered a different project between resolveMultiProjectStart's re-read
 *    and here, merging onto the latest state ensures their entry is preserved.
 *
 * @param warnings - Optional array to collect non-fatal build warnings
 */
export function validateAndCommitRegistration(
  reg: RegisterNewProjectResult,
  globalConfigPath: string,
  warnings?: string[],
): ReturnType<typeof applyGlobalConfigPipeline> {
  const built = buildEffectiveConfig(reg.updatedGlobalConfig, globalConfigPath, warnings);
  const effectiveConfig = applyGlobalConfigPipeline(built);

  // Final re-read — shrinks the TOCTOU window to the rename(2) syscall duration.
  const latestGc = loadGlobalConfig();
  let configToSave = reg.updatedGlobalConfig;
  if (latestGc) {
    if (latestGc.projects[reg.projectId]) {
      // Another process already wrote this project ID — keep their version.
      configToSave = latestGc;
    } else {
      // Merge our new entry onto the absolute-latest state so no concurrent
      // registration from a different project gets silently dropped.
      const entry = reg.updatedGlobalConfig.projects[reg.projectId];
      if (entry) {
        configToSave = registerProject(latestGc, reg.projectId, entry);
      }
    }
  }

  saveGlobalConfig(configToSave);
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
 * Core logic for multi-project registration and config resolution.
 *
 * Returns null if no global config exists (caller should fall back to
 * legacy single-file flow).
 */
export function resolveMultiProjectStart(
  workingDir: string,
): MultiProjectStartResult | null {
  const resolvedDir = resolve(workingDir);
  let messages: MultiProjectStartResult["messages"] = [];

  // Load global config
  let globalConfig = loadGlobalConfig();
  if (!globalConfig) {
    return null;
  }

  // 3. Match CWD to a registered project
  let projectId = matchProjectByCwd(globalConfig, resolvedDir);
  let isNewRegistration = false;

  // newReg is set for new registrations and carries the updated global config
  // through to the validateAndCommitRegistration call below.
  let newReg: RegisterNewProjectResult | undefined;

  if (!projectId) {
    const found = findLocalConfigUpwards(resolvedDir);

    if (found) {
      // Auto-register via shared helper — pure, no disk writes.
      const reg = registerNewProject(globalConfig, found.projectRoot);
      projectId = reg.projectId;
      globalConfig = reg.updatedGlobalConfig;
      newReg = reg;
      isNewRegistration = true;
      // Track index so we can roll back all registration messages on concurrent detection.
      const regMessagesStart = messages.length;
      messages.push(...reg.messages);
      messages.push({ level: "success", text: `Registered project "${projectId}" (${reg.configMode} mode)` });

      // Re-read config before committing to detect concurrent registrations
      // from another process that may have registered while we were computing.
      const freshGc = loadGlobalConfig();
      if (freshGc) {
        const alreadyRegistered = matchProjectByCwd(freshGc, resolvedDir);
        if (alreadyRegistered) {
          // Same project registered by another process — use their registration.
          projectId = alreadyRegistered;
          globalConfig = freshGc;
          isNewRegistration = false;
          newReg = undefined;
          // Drop all messages from this registration attempt — it's misleading to
          // show registration output when another process did the actual registration.
          messages = messages.slice(0, regMessagesStart);
        } else {
          // A different project may have been registered concurrently. Re-base our
          // registration on freshGc so we don't overwrite the concurrent entry when
          // validateAndCommitRegistration saves the global config.
          const entry = reg.updatedGlobalConfig.projects[reg.projectId];
          if (entry) {
            newReg = {
              ...newReg,
              updatedGlobalConfig: registerProject(freshGc, reg.projectId, entry),
            };
          }
        }
      }
    } else {
      return null;
    }
  }

  // Build effective config. New registrations are committed to disk here;
  // already-registered projects just read from their local config directly.
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
