/**
 * In-process lifecycle worker management.
 *
 * Instead of spawning a detached subprocess, the lifecycle manager runs
 * directly in the `ao start` process. This keeps `ao lifecycle-worker`
 * out of the CLI surface area.
 */

import { createHash } from "node:crypto";
import type { LifecycleManager, OrchestratorConfig } from "@composio/ao-core";
import { getLifecycleManager } from "./create-session-manager.js";

/**
 * Build a deterministic fingerprint from the config content that matters to
 * the lifecycle manager: the config file path plus each project's path and
 * agent/runtime selection. This detects in-place config edits where the file
 * path stays the same but the content changes — the previous path-only
 * fingerprint would miss those and keep running a stale manager.
 *
 * Object keys are sorted before hashing so insertion order doesn't affect
 * the result.
 */
function buildFingerprint(config: OrchestratorConfig): string {
  const projectsDigest = JSON.stringify(
    Object.entries(config.projects ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, p]) => [id, p.path, p.agent, p.runtime, p.sessionPrefix]),
  );
  return createHash("sha256")
    .update(config.configPath ?? "")
    .update(projectsDigest)
    .digest("hex")
    .slice(0, 16);
}

export interface LifecycleWorkerStatus {
  running: boolean;
  started: boolean;
  pid: number | null;
}

/** Active in-process lifecycle managers keyed by projectId (or "__all__") */
const activeManagers = new Map<string, LifecycleManager>();

/**
 * Config fingerprints for each active manager.
 * Used to detect when the config has changed so the manager can be restarted.
 */
const activeManagerFingerprints = new Map<string, string>();

/**
 * Ensure a lifecycle manager is running for the given project.
 * Creates one in-process if not already active.
 * If a manager is already running but the config has changed since it was
 * created, the old manager is stopped and a new one is started.
 */
export async function ensureLifecycleWorker(
  config: OrchestratorConfig,
  projectId: string,
): Promise<LifecycleWorkerStatus> {
  const key = projectId;
  const fingerprint = buildFingerprint(config);

  const existing = activeManagers.get(key);
  if (existing) {
    // Return immediately if the config hasn't changed
    if (activeManagerFingerprints.get(key) === fingerprint) {
      return { running: true, started: false, pid: process.pid };
    }
    // Config changed since last start — stop the stale manager and restart
    existing.stop();
    activeManagers.delete(key);
    activeManagerFingerprints.delete(key);
  }

  const lifecycle = await getLifecycleManager(config, projectId);
  lifecycle.start(30_000);
  activeManagers.set(key, lifecycle);
  activeManagerFingerprints.set(key, fingerprint);

  return { running: true, started: true, pid: process.pid };
}

/**
 * Stop the lifecycle manager for a project.
 */
export async function stopLifecycleWorker(
  _config: OrchestratorConfig,
  projectId: string,
): Promise<boolean> {
  const key = projectId;
  const manager = activeManagers.get(key);
  if (!manager) return false;

  manager.stop();
  activeManagers.delete(key);
  activeManagerFingerprints.delete(key);
  return true;
}

/**
 * Clear all active managers. Only intended for use in tests to reset state
 * between test cases without re-importing the module.
 */
export function clearActiveManagers(): void {
  for (const manager of activeManagers.values()) {
    manager.stop();
  }
  activeManagers.clear();
  activeManagerFingerprints.clear();
}

/**
 * Re-reference the lifecycle poll timer so it keeps the Node.js event loop
 * alive. Only call from the long-running daemon (`ao start`). By default the
 * timer started by ensureLifecycleWorker is unreffed and will not block exit.
 */
export function pinLifecycleWorker(projectId: string): void {
  activeManagers.get(projectId)?.pin();
}

/**
 * Check if a lifecycle manager is running for a project.
 */
export function getLifecycleWorkerStatus(
  _config: OrchestratorConfig,
  projectId: string,
): LifecycleWorkerStatus {
  const running = activeManagers.has(projectId);
  return { running, started: false, pid: running ? process.pid : null };
}
