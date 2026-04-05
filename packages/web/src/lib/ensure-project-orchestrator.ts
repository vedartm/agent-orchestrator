import { generateOrchestratorPrompt, isOrchestratorSession } from "@composio/ao-core";
import type { DashboardOrchestratorLink } from "@/lib/types";
import { getServices } from "@/lib/services";
import { listDashboardOrchestrators } from "@/lib/serialize";

/** Per-project lock to prevent duplicate orchestrator spawns from concurrent requests. */
const pendingSpawns = new Map<string, Promise<DashboardOrchestratorLink | null>>();

/**
 * Ensure the canonical per-project orchestrator exists.
 *
 * This is intentionally best-effort: project pages should attempt to self-heal
 * missing orchestrators rather than forcing users through a separate CLI step.
 * Uses a per-project in-memory lock to prevent duplicate spawns from concurrent requests.
 */
export async function ensureProjectOrchestrator(
  projectId: string,
): Promise<DashboardOrchestratorLink | null> {
  const existing = pendingSpawns.get(projectId);
  if (existing) return existing;

  const promise = doEnsureOrchestrator(projectId).finally(() => {
    pendingSpawns.delete(projectId);
  });
  pendingSpawns.set(projectId, promise);
  return promise;
}

async function doEnsureOrchestrator(
  projectId: string,
): Promise<DashboardOrchestratorLink | null> {
  const { config, sessionManager } = await getServices();
  const project = config.projects[projectId];
  if (!project) return null;

  const allSessions = await sessionManager.list();
  const found = listDashboardOrchestrators(
    allSessions.filter((session) => isOrchestratorSession(session)),
    config.projects,
  ).find((orchestrator) => orchestrator.projectId === projectId);

  if (found) return found;

  const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
  const session = await sessionManager.spawnOrchestrator({ projectId, systemPrompt });
  return {
    id: session.id,
    projectId,
    projectName: project.name ?? projectId,
  };
}
