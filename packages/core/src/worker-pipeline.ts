/**
 * Worker Pipeline — three-phase Plan/Execute/Test agent inner loop.
 *
 * Each worker runs: Plan (Opus) → Execute (OpenCode) → Test (Sonnet)
 * All phases share the same git worktree. On failure, always re-plan
 * from scratch with failure context.
 */

import type {
  SessionManager,
  SessionSpawnConfig,
  Session,
  ProjectConfig,
  WorkerPhase,
  SessionStatus,
} from "./types.js";

// ─── Public interfaces ───────────────────────────────────────────────────────

export interface WorkerPipelineDeps {
  sessionManager: SessionManager;
  projectId: string;
  projectConfig: ProjectConfig;
}

export interface WorkerPipelineConfig {
  issueId: string;
  ticketDescription: string;
  acceptanceCriteria: string[];
  branch: string;
  workspacePath: string;
  /** Max retries before parking. Default 3. */
  maxRetries?: number;
}

export interface WorkerPipelineResult {
  success: boolean;
  phase: WorkerPhase;
  prUrl?: string;
  error?: string;
  retryCount: number;
}

// ─── Terminal statuses for polling ────────────────────────────────────────────

const TERMINAL_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "done",
  "killed",
  "errored",
  "terminated",
  "merged",
]);

// ─── Wait helper ─────────────────────────────────────────────────────────────

/**
 * Poll `sm.get(sessionId)` until the session reaches a terminal status
 * or the timeout elapses. Returns `null` on timeout.
 */
export async function waitForSession(
  sm: SessionManager,
  sessionId: string,
  timeoutMs = 30 * 60 * 1000,
  pollMs = 10_000,
): Promise<Session | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const session = await sm.get(sessionId);
    if (!session) {
      console.error(`[worker-pipeline] session ${sessionId} not found, treating as terminal`);
      return null;
    }
    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  console.error(`[worker-pipeline] session ${sessionId} timed out after ${timeoutMs}ms`);
  return null;
}

// ─── Phase helpers ───────────────────────────────────────────────────────────

async function runPhase(
  deps: WorkerPipelineDeps,
  spawnConfig: SessionSpawnConfig,
  phaseName: string,
): Promise<Session | null> {
  const session = await deps.sessionManager.spawn(spawnConfig);
  console.error(`[worker-pipeline] ${phaseName} spawned: ${session.id}`);

  const result = await waitForSession(deps.sessionManager, session.id);

  // Best-effort kill to clean up resources
  try {
    await deps.sessionManager.kill(session.id);
  } catch (_err) {
    console.error(`[worker-pipeline] failed to kill ${phaseName} session ${session.id}`);
  }

  return result;
}

function buildPlanPrompt(config: WorkerPipelineConfig, failureContext?: string): string {
  const base = [
    "You are a planning agent. Read the ticket and explore the codebase.",
    "Produce a step-by-step implementation plan. Do NOT implement anything.",
    "",
    `Ticket: ${config.ticketDescription}`,
    `Acceptance Criteria:\n${config.acceptanceCriteria.join("\n")}`,
    "",
    "Output your plan as structured markdown with:",
    "1. Step-by-step implementation steps",
    "2. Files to modify/create",
    "3. Key code changes per file",
  ];

  if (failureContext) {
    base.push("", `Previous attempt failed: ${failureContext}. Re-plan from scratch.`);
  }

  return base.join("\n");
}

function extractPlan(session: Session | null): string {
  if (!session) return "(no plan available — session timed out)";
  return session.metadata["plan"] ?? session.metadata["summary"] ?? "(plan produced — see session logs)";
}

function extractFailureReason(session: Session | null, phase: string): string {
  if (!session) return `${phase} session timed out`;
  if (session.status === "killed") return `${phase} session was killed`;
  if (session.status === "errored") return session.metadata["error"] ?? `${phase} session errored`;
  return `${phase} did not produce expected result`;
}

// ─── Main pipeline ───────────────────────────────────────────────────────────

export async function runWorkerPipeline(
  deps: WorkerPipelineDeps,
  config: WorkerPipelineConfig,
): Promise<WorkerPipelineResult> {
  const maxRetries = config.maxRetries ?? 3;
  let retryCount = 0;
  let lastFailureReason = "";
  let failureContext: string | undefined;

  while (retryCount <= maxRetries) {
    // ── Phase 1: PLAN ──────────────────────────────────────────────────────
    const planSession = await runPhase(deps, {
      projectId: deps.projectId,
      issueId: config.issueId,
      branch: config.branch,
      workspacePath: config.workspacePath,
      agent: "claude-code",
      model: "opus",
      prompt: buildPlanPrompt(config, failureContext),
    }, "plan");

    if (!planSession || planSession.status !== "done") {
      return {
        success: false,
        phase: "plan",
        error: extractFailureReason(planSession, "plan"),
        retryCount,
      };
    }

    const plan = extractPlan(planSession);

    // ── Phase 2: EXECUTE ───────────────────────────────────────────────────
    const executeSession = await runPhase(deps, {
      projectId: deps.projectId,
      issueId: config.issueId,
      branch: config.branch,
      workspacePath: config.workspacePath,
      agent: "opencode",
      prompt: `Implement the following plan:\n\n${plan}\n\nWork in the existing worktree. Commit your changes.`,
    }, "execute");

    if (!executeSession || executeSession.status !== "done") {
      return {
        success: false,
        phase: "execute",
        error: extractFailureReason(executeSession, "execute"),
        retryCount,
      };
    }

    // ── Phase 3: TEST ──────────────────────────────────────────────────────
    const testSession = await runPhase(deps, {
      projectId: deps.projectId,
      issueId: config.issueId,
      branch: config.branch,
      workspacePath: config.workspacePath,
      agent: "claude-code",
      model: "sonnet",
      prompt: [
        "Run all relevant tests and validate the implementation.",
        `Acceptance Criteria:\n${config.acceptanceCriteria.join("\n")}`,
        "",
        "If tests pass, create a PR to develop branch.",
        "If tests fail, report the failure details.",
      ].join("\n"),
    }, "test");

    // Check for PR creation
    const prUrl = testSession?.metadata["pr"] ?? testSession?.pr?.url;
    if (prUrl) {
      return {
        success: true,
        phase: "done",
        prUrl,
        retryCount,
      };
    }

    // ── Retry logic ────────────────────────────────────────────────────────
    const currentFailure = extractFailureReason(testSession, "test");

    if (currentFailure === lastFailureReason) {
      retryCount++;
    } else {
      lastFailureReason = currentFailure;
      retryCount = 1;
    }

    if (retryCount >= maxRetries) {
      console.error(`[worker-pipeline] parking after ${retryCount} retries: ${currentFailure}`);
      return {
        success: false,
        phase: "parked",
        error: currentFailure,
        retryCount,
      };
    }

    console.error(`[worker-pipeline] retry ${retryCount}/${maxRetries}: ${currentFailure}`);
    failureContext = currentFailure;
  }

  // Should not reach here, but satisfy the compiler
  return {
    success: false,
    phase: "parked",
    error: "exceeded retry loop",
    retryCount,
  };
}
