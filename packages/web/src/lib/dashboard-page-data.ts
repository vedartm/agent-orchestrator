import { cache } from "react";
import { type DashboardSession, type DashboardOrchestratorLink } from "@/lib/types";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadataFast,
  listDashboardOrchestrators,
} from "@/lib/serialize";
import { getProjectName } from "@/lib/project-name";
import { resolveGlobalPause, type GlobalPauseState } from "@/lib/global-pause";
import { settlesWithin } from "@/lib/async-utils";
import { isOrchestratorSession } from "@composio/ao-core";

const FAST_METADATA_ENRICH_TIMEOUT_MS = 3_000;

interface DashboardPageData {
  sessions: DashboardSession[];
  globalPause: GlobalPauseState | null;
  orchestrators: DashboardOrchestratorLink[];
  projectName: string;
}

export const getDashboardProjectName = cache(function getDashboardProjectName(
  _projectFilter?: string,
): string {
  return getProjectName();
});

export function resolveDashboardProjectFilter(_project?: string): string {
  return "";
}

export const getDashboardPageData = cache(async function getDashboardPageData(_project?: string): Promise<DashboardPageData> {
  const pageData: DashboardPageData = {
    sessions: [],
    globalPause: null,
    orchestrators: [],
    projectName: getProjectName(),
  };

  try {
    const { config, registry, sessionManager } = await getServices();
    const allSessions = await sessionManager.list();

    pageData.globalPause = resolveGlobalPause(allSessions, config.projects);

    const allSessionPrefixes = Object.entries(config.projects).map(
      ([projectId, p]) => p.sessionPrefix ?? projectId,
    );
    pageData.orchestrators = listDashboardOrchestrators(allSessions, config.projects);

    const coreSessions = allSessions.filter(
      (session) =>
        !isOrchestratorSession(
          session,
          config.projects[session.projectId]?.sessionPrefix ?? session.projectId,
          allSessionPrefixes,
        ),
    );
    pageData.sessions = coreSessions.map(sessionToDashboard);

    // Fast enrichment: issue labels (sync) + agent summaries (local disk I/O).
    await settlesWithin(
      enrichSessionsMetadataFast(coreSessions, pageData.sessions, config, registry),
      FAST_METADATA_ENRICH_TIMEOUT_MS,
    );

    // PR cache hits only (in-memory lookup, no SCM API calls)
    for (let i = 0; i < coreSessions.length; i++) {
      const core = coreSessions[i];
      if (!core.pr) continue;
      const projectConfig = resolveProject(core, config.projects);
      const scm = getSCM(registry, projectConfig);
      if (scm) {
        await enrichSessionPR(pageData.sessions[i], scm, core.pr, { cacheOnly: true });
      }
    }
  } catch {
    pageData.sessions = [];
    pageData.globalPause = null;
    pageData.orchestrators = [];
  }

  return pageData;
});
