/**
 * Worker Loop — polls Linear for "worker-ready" sub-tickets and runs
 * the three-phase Plan/Execute/Test pipeline for each.
 *
 * Each repo gets its own polling cycle. Sub-tickets are matched by
 * "worker-ready" + "repo:<name>" labels.
 */

import type {
  OrchestratorConfig,
  OrchestratorLoopConfig,
  WorkerLoopConfig,
  Tracker,
  ProjectConfig,
  SessionManager,
  Workspace,
  Issue,
} from "./types.js";
import { runWorkerPipeline } from "./worker-pipeline.js";

// =============================================================================
// TYPES
// =============================================================================

export interface WorkerLoopDeps {
  config: OrchestratorConfig;
  loopConfig: OrchestratorLoopConfig;
  workerConfig: WorkerLoopConfig;
  sessionManager: SessionManager;
  getTracker(projectId: string): Tracker;
  getProject(projectId: string): ProjectConfig;
  getWorkspace(projectId: string): Workspace | null;
}

interface ActiveWorker {
  issueId: string;
  repo: string;
  projectId: string;
  promise: Promise<void>;
}

export interface WorkerLoop {
  start(intervalMs?: number): void;
  stop(): void;
  pollOnce(): Promise<void>;
  getActiveWorkers(): ReadonlyArray<{ issueId: string; repo: string }>;
}

// =============================================================================
// FACTORY
// =============================================================================

export function createWorkerLoop(deps: WorkerLoopDeps): WorkerLoop {
  const { loopConfig, workerConfig } = deps;
  const maxConcurrent = workerConfig.maxConcurrent ?? 1;
  const maxRetries = workerConfig.maxRetries ?? 3;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const activeWorkers: ActiveWorker[] = [];
  const processedIssues = new Set<string>();

  function cleanupCompleted(): void {
    for (let i = activeWorkers.length - 1; i >= 0; i--) {
      // Check if promise has settled by racing with an already-resolved promise
      const worker = activeWorkers[i];
      void worker.promise.then(
        () => {
          const idx = activeWorkers.indexOf(worker);
          if (idx !== -1) activeWorkers.splice(idx, 1);
        },
        () => {
          const idx = activeWorkers.indexOf(worker);
          if (idx !== -1) activeWorkers.splice(idx, 1);
        },
      );
    }
  }

  async function processIssue(issue: Issue, repoName: string, projectId: string): Promise<void> {
    const { sessionManager } = deps;
    const project = deps.getProject(projectId);
    const tracker = deps.getTracker(projectId);
    const workspace = deps.getWorkspace(projectId);

    // Extract acceptance criteria from description (lines starting with - [ ] or - )
    const criteria = issue.description
      .split("\n")
      .filter((l) => /^\s*[-*]\s/.test(l))
      .map((l) => l.replace(/^\s*[-*]\s*(\[.\]\s*)?/, "").trim())
      .filter(Boolean);

    // Determine branch name
    const branch = tracker.branchName(issue.id, project);

    // Create worktree for this worker
    let workspacePath = project.path;
    if (workspace) {
      try {
        const wsInfo = await workspace.create({
          projectId,
          project,
          sessionId: `worker-${issue.id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
          branch,
        });
        workspacePath = wsInfo.path;
        if (workspace.postCreate) {
          await workspace.postCreate(wsInfo, project);
        }
      } catch (err) {
        console.error(`[worker-loop] Failed to create worktree for ${issue.id}:`, err);
        return;
      }
    }

    // Mark as in-progress in Linear
    if (tracker.updateIssue) {
      await tracker.updateIssue(
        issue.id,
        { removeLabels: ["worker-ready"], state: "in_progress" },
        project,
      ).catch((err: unknown) => {
        console.error(`[worker-loop] Failed to update ${issue.id} to in-progress:`, err);
      });
    }

    console.error(`[worker-loop] Starting pipeline for ${issue.id} (${repoName})`);

    const result = await runWorkerPipeline(
      { sessionManager, projectId, projectConfig: project },
      {
        issueId: issue.id,
        ticketDescription: `${issue.title}\n\n${issue.description}`,
        acceptanceCriteria: criteria.length > 0 ? criteria : ["Implementation matches ticket description"],
        branch,
        workspacePath,
        maxRetries,
      },
    );

    // Update Linear with result
    if (tracker.updateIssue) {
      if (result.success) {
        console.error(`[worker-loop] ${issue.id} completed — PR: ${result.prUrl}`);
        await tracker.updateIssue(
          issue.id,
          {
            labels: ["pr-open"],
            comment: `Worker pipeline completed. PR: ${result.prUrl ?? "created"}`,
          },
          project,
        ).catch((err: unknown) => {
          console.error(`[worker-loop] Failed to update ${issue.id} on success:`, err);
        });
      } else if (result.phase === "parked") {
        console.error(`[worker-loop] ${issue.id} parked after ${result.retryCount} retries: ${result.error}`);
        await tracker.updateIssue(
          issue.id,
          {
            labels: ["parked"],
            comment: `Worker pipeline failed after ${result.retryCount} retries.\n\nPhase: ${result.phase}\nError: ${result.error}`,
          },
          project,
        ).catch((err: unknown) => {
          console.error(`[worker-loop] Failed to update ${issue.id} on park:`, err);
        });
      } else {
        console.error(`[worker-loop] ${issue.id} failed at phase ${result.phase}: ${result.error}`);
      }
    }

    // Cleanup worktree if we created one
    if (workspace && workspacePath !== project.path) {
      await workspace.destroy(workspacePath).catch((err: unknown) => {
        console.error(`[worker-loop] Failed to cleanup worktree for ${issue.id}:`, err);
      });
    }
  }

  async function pollOnce(): Promise<void> {
    if (polling) return;
    polling = true;

    try {
      cleanupCompleted();

      // Poll each repo for worker-ready sub-tickets
      for (const [repoName, repoConf] of Object.entries(loopConfig.repos)) {
        const projectId = repoConf.projectId;
        const project = deps.getProject(projectId);
        const tracker = deps.getTracker(projectId);

        if (!tracker.listIssues) {
          console.error(`[worker-loop] Tracker for ${repoName} does not support listIssues — skipping`);
          continue;
        }

        // Count active workers for this repo
        const activeForRepo = activeWorkers.filter((w) => w.repo === repoName).length;
        if (activeForRepo >= maxConcurrent) continue;

        const issues = await tracker.listIssues(
          { labels: ["worker-ready", `repo:${repoName}`], state: "open" },
          project,
        );

        for (const issue of issues) {
          // Skip already processing or processed
          if (processedIssues.has(issue.id)) continue;
          if (activeWorkers.some((w) => w.issueId === issue.id)) continue;

          // Check concurrency limit
          const currentActive = activeWorkers.filter((w) => w.repo === repoName).length;
          if (currentActive >= maxConcurrent) break;

          // Check if blocked (has blocked_by relations with open issues)
          if (issue.relations?.some((r) => r.type === "blocked_by")) {
            // Fetch blocker to check if it's still open
            const blockerIds = issue.relations
              .filter((r) => r.type === "blocked_by")
              .map((r) => r.issueId);

            let isBlocked = false;
            for (const blockerId of blockerIds) {
              try {
                const blocker = await tracker.getIssue(blockerId, project);
                if (blocker.state !== "closed") {
                  isBlocked = true;
                  break;
                }
              } catch {
                // Can't fetch blocker — assume blocked to be safe
                isBlocked = true;
                break;
              }
            }

            if (isBlocked) {
              console.error(`[worker-loop] ${issue.id} is blocked — skipping`);
              continue;
            }
          }

          processedIssues.add(issue.id);
          const promise = processIssue(issue, repoName, projectId);
          activeWorkers.push({ issueId: issue.id, repo: repoName, projectId, promise });
          console.error(`[worker-loop] Queued ${issue.id} for ${repoName} (${activeWorkers.length} active)`);
        }
      }
    } catch (err) {
      console.error("[worker-loop] Poll error:", err);
    } finally {
      polling = false;
    }
  }

  return {
    start(intervalMs?: number): void {
      if (timer) return;
      const interval = intervalMs ?? workerConfig.pollIntervalMs;
      // Run immediately, then on interval
      void pollOnce();
      timer = setInterval(() => void pollOnce(), interval);
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    pollOnce,

    getActiveWorkers(): ReadonlyArray<{ issueId: string; repo: string }> {
      return activeWorkers.map((w) => ({ issueId: w.issueId, repo: w.repo }));
    },
  };
}
