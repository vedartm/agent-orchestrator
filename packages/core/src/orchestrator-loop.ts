/**
 * Orchestrator Loop — polling loop for multi-repo ticket decomposition and tracking.
 *
 * Watches for "agent-ready" tickets, decomposes them into per-repo sub-tasks,
 * creates child issues, and monitors completion. Follows the re-entrancy guard
 * pattern from lifecycle-manager.ts.
 */

import Anthropic from "@anthropic-ai/sdk";

import type {
  OrchestratorConfig,
  OrchestratorLoopConfig,
  Tracker,
  ProjectConfig,
  Issue,
  SubTicketMeta,
} from "./types.js";
import { decomposeMultiRepo } from "./decomposer.js";
import type { MultiRepoDecomposeConfig } from "./decomposer.js";

// =============================================================================
// TYPES
// =============================================================================

export interface OrchestratorLoopDeps {
  config: OrchestratorConfig;
  loopConfig: OrchestratorLoopConfig;
  /** Get tracker for a given projectId */
  getTracker(projectId: string): Tracker;
  /** Get project config for a given projectId */
  getProject(projectId: string): ProjectConfig;
}

/** State for a parent ticket being tracked */
interface TrackedTicket {
  parentIssueId: string;
  childIssueIds: string[];
  status: "decomposing" | "in_progress" | "blocked" | "done";
}

export interface OrchestratorLoop {
  start(intervalMs?: number): void;
  stop(): void;
  pollOnce(): Promise<void>;
  getTrackedTickets(): Map<string, TrackedTicket>;
}

// =============================================================================
// CLARITY CHECK
// =============================================================================

const CLARITY_CHECK_SYSTEM = `You assess whether a software task ticket is clear enough for an AI agent to work on autonomously.

A ticket is CLEAR if it has:
- A specific, actionable goal
- Enough context to start implementation without asking questions
- No ambiguous requirements that could lead to wrong implementation

A ticket is UNCLEAR if it:
- Uses vague language like "improve", "fix issues", "clean up" without specifics
- References external context not included in the ticket
- Has contradictory requirements
- Is missing critical details (which endpoint? which component? what behavior?)

Respond with a JSON object:
{ "clear": true }
or
{ "clear": false, "reason": "Brief explanation of what's missing or unclear" }

Nothing else — just the JSON object.`;

async function checkTicketClarity(
  client: Anthropic,
  model: string,
  issue: Issue,
): Promise<{ clear: boolean; reason?: string }> {
  const res = await client.messages.create({
    model,
    max_tokens: 256,
    system: CLARITY_CHECK_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Title: ${issue.title}\n\nDescription:\n${issue.description}`,
      },
    ],
  });

  const text = res.content[0].type === "text" ? res.content[0].text.trim() : "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { clear: true };

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (typeof parsed === "object" && parsed !== null && "clear" in parsed) {
      const result = parsed as { clear: unknown; reason?: unknown };
      return {
        clear: Boolean(result.clear),
        reason: typeof result.reason === "string" ? result.reason : undefined,
      };
    }
  } catch {
    // Parse failure → assume clear to avoid blocking
  }

  return { clear: true };
}

// =============================================================================
// FACTORY
// =============================================================================

export function createOrchestratorLoop(deps: OrchestratorLoopDeps): OrchestratorLoop {
  const { config: _config, loopConfig } = deps;
  const trackedTickets = new Map<string, TrackedTicket>();
  const subTicketMeta = new Map<string, SubTicketMeta>();
  let polling = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  // Resolve the "primary" project — first repo entry in loop config
  const repoEntries = Object.entries(loopConfig.repos);
  if (repoEntries.length === 0) {
    throw new Error("OrchestratorLoopConfig.repos must have at least one entry");
  }

  function getTrackerAndProject(repoName: string): {
    tracker: Tracker;
    project: ProjectConfig;
    projectId: string;
  } {
    const repoConfig = loopConfig.repos[repoName];
    if (!repoConfig) throw new Error(`Unknown repo in loop config: ${repoName}`);
    const projectId = repoConfig.projectId;
    return {
      tracker: deps.getTracker(projectId),
      project: deps.getProject(projectId),
      projectId,
    };
  }

  /** Build repo contexts from project configs for decomposition */
  function buildRepoContexts(): Record<string, string> {
    const contexts: Record<string, string> = {};
    for (const [repoName, repoConf] of Object.entries(loopConfig.repos)) {
      const project = deps.getProject(repoConf.projectId);
      contexts[repoName] = `Repo: ${project.repo}, path: ${project.path}, branch: ${project.defaultBranch}`;
    }
    return contexts;
  }

  async function pollOnce(): Promise<void> {
    if (polling) return;
    polling = true;

    try {
      // -----------------------------------------------------------------------
      // Phase 1: Poll for new "agent-ready" tickets
      // -----------------------------------------------------------------------
      const [primaryRepoName] = repoEntries[0];
      const { tracker, project } = getTrackerAndProject(primaryRepoName);

      if (!tracker.listIssues) {
        console.error("[orchestrator-loop] Tracker does not support listIssues — skipping poll");
        return;
      }

      const issues = await tracker.listIssues({ labels: ["agent-ready"], state: "open" }, project);

      for (const issue of issues) {
        // Skip already-tracked tickets
        if (trackedTickets.has(issue.id)) continue;

        // ---------------------------------------------------------------------
        // Phase 2: Clarity check
        // ---------------------------------------------------------------------
        const clarificationModel = loopConfig.clarificationModel ?? "claude-sonnet-4-20250514";
        const client = new Anthropic();
        const clarity = await checkTicketClarity(client, clarificationModel, issue);

        if (!clarity.clear) {
          console.error(
            `[orchestrator-loop] Ticket ${issue.id} unclear: ${clarity.reason ?? "unknown reason"}`,
          );
          if (tracker.updateIssue) {
            await tracker.updateIssue(
              issue.id,
              {
                comment: `This ticket needs clarification before an agent can work on it:\n\n${clarity.reason ?? "The requirements are ambiguous."}`,
                removeLabels: ["agent-ready"],
                state: "open",
              },
              project,
            );
          }
          continue;
        }

        // ---------------------------------------------------------------------
        // Phase 3: Decompose
        // ---------------------------------------------------------------------
        trackedTickets.set(issue.id, {
          parentIssueId: issue.id,
          childIssueIds: [],
          status: "decomposing",
        });

        const decomposeConfig: MultiRepoDecomposeConfig = {
          model: loopConfig.decompositionModel,
          repos: buildRepoContexts(),
          sequencingRules: loopConfig.sequencingRules.map((r) => ({
            upstream: r.upstream,
            downstream: r.downstream,
          })),
        };

        const plan = await decomposeMultiRepo(issue.description, decomposeConfig);

        // ---------------------------------------------------------------------
        // Phase 4: Create sub-tickets
        // ---------------------------------------------------------------------
        const childIds: string[] = [];

        for (let i = 0; i < plan.subTasks.length; i++) {
          const subTask = plan.subTasks[i];
          const repoEntry = loopConfig.repos[subTask.repo];
          if (!repoEntry) {
            console.error(`[orchestrator-loop] Unknown repo "${subTask.repo}" in decomposition — skipping sub-task`);
            continue;
          }

          const { tracker: repoTracker, project: repoProject } = getTrackerAndProject(subTask.repo);
          if (!repoTracker.createIssue) {
            console.error(`[orchestrator-loop] Tracker for "${subTask.repo}" does not support createIssue`);
            continue;
          }

          const childIssue = await repoTracker.createIssue(
            {
              title: subTask.title,
              description: subTask.description,
              labels: ["worker-ready", `repo:${subTask.repo}`],
              parentIssueId: issue.id,
            },
            repoProject,
          );

          childIds.push(childIssue.id);

          // Store metadata for this sub-ticket
          subTicketMeta.set(childIssue.id, {
            parentIssueId: issue.id,
            repo: subTask.repo,
            fileImpactList: subTask.fileImpactList,
            blockedBy: subTask.dependsOn.map((depIdx) => {
              // Resolve dependency index to child issue ID (if already created)
              return childIds[depIdx] ?? `pending-${depIdx}`;
            }),
            retryCount: 0,
            lastFailureReason: "",
            workerPhase: "plan",
          });

          // Add blocked_by relations for sequencing dependencies
          if (repoTracker.addIssueRelation) {
            for (const depIdx of subTask.dependsOn) {
              const depChildId = childIds[depIdx];
              if (depChildId) {
                await repoTracker.addIssueRelation(
                  childIssue.id,
                  depChildId,
                  "blocked_by",
                  repoProject,
                );
              }
            }
          }
        }

        // ---------------------------------------------------------------------
        // Phase 5: Update parent
        // ---------------------------------------------------------------------
        if (tracker.updateIssue) {
          await tracker.updateIssue(
            issue.id,
            {
              removeLabels: ["agent-ready"],
              state: "in_progress",
            },
            project,
          );
        }

        // ---------------------------------------------------------------------
        // Phase 6: Track
        // ---------------------------------------------------------------------
        trackedTickets.set(issue.id, {
          parentIssueId: issue.id,
          childIssueIds: childIds,
          status: "in_progress",
        });
      }

      // -----------------------------------------------------------------------
      // Phase 7: Completion check — scan all tracked tickets
      // -----------------------------------------------------------------------
      for (const [parentId, tracked] of trackedTickets) {
        if (tracked.status === "done" || tracked.status === "decomposing") continue;

        let allClosed = true;
        let anyParked = false;
        let anyNeedsRedecomp = false;

        for (const childId of tracked.childIssueIds) {
          // Find which repo this child belongs to via metadata
          const meta = subTicketMeta.get(childId);
          const repoName = meta?.repo ?? repoEntries[0][0];
          const { tracker: childTracker, project: childProject } = getTrackerAndProject(repoName);

          let childIssue: Issue;
          try {
            childIssue = await childTracker.getIssue(childId, childProject);
          } catch {
            // Issue fetch failed — skip this child
            allClosed = false;
            continue;
          }

          if (childIssue.state !== "closed") {
            allClosed = false;
          }

          if (childIssue.labels.includes("parked")) {
            anyParked = true;
          }

          // Phase 8: Escalation check
          if (childIssue.labels.includes("needs-redecomp")) {
            anyNeedsRedecomp = true;
          }
        }

        const { tracker: parentTracker, project: parentProject } = getTrackerAndProject(
          repoEntries[0][0],
        );

        if (allClosed && tracked.childIssueIds.length > 0) {
          // All children done → close parent
          if (parentTracker.updateIssue) {
            await parentTracker.updateIssue(parentId, { state: "closed" }, parentProject);
          }
          tracked.status = "done";
        } else if (anyParked) {
          // A child is parked → mark parent blocked
          if (parentTracker.updateIssue) {
            await parentTracker.updateIssue(
              parentId,
              {
                comment: "One or more sub-tasks have been parked. Parent ticket is now blocked.",
                state: "open",
              },
              parentProject,
            );
          }
          tracked.status = "blocked";
        }

        if (anyNeedsRedecomp) {
          console.error(
            `[orchestrator-loop] Ticket ${parentId} has children with "needs-redecomp" label — manual re-decomposition may be needed`,
          );
        }
      }
    } catch (err) {
      console.error("[orchestrator-loop] Poll error:", err);
    } finally {
      polling = false;
    }
  }

  function start(intervalMs?: number): void {
    if (timer) return;
    const interval = intervalMs ?? loopConfig.pollIntervalMs;
    // Run immediately, then on interval
    void pollOnce();
    timer = setInterval(() => void pollOnce(), interval);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getTrackedTickets(): Map<string, TrackedTicket> {
    return trackedTickets;
  }

  return { start, stop, pollOnce, getTrackedTickets };
}
