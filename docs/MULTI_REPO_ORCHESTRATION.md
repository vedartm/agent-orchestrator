# Multi-Repo Orchestration

Automated two-layer agent system for multi-repo codebases. The orchestrator decomposes tickets across repos, and workers execute a three-phase pipeline per sub-ticket.

## Overview

```
┌─────────────────────────────────────────────────────────┐
│                  ORCHESTRATOR LOOP                       │
│  Polls Linear → Clarity check → Decompose → Sub-tickets │
│  Watches completion → Closes parent when all done        │
└──────────────┬──────────────────────────┬───────────────┘
               │                          │
        sub-tickets                sub-tickets
               │                          │
    ┌──────────▼──────────┐   ┌───────────▼──────────┐
    │   WORKER: server    │   │   WORKER: web-app    │
    │  Plan → Execute →   │   │  Plan → Execute →    │
    │  Test → PR          │   │  Test → PR           │
    └─────────────────────┘   └──────────────────────┘
```

## Configuration

Add these blocks to `agent-orchestrator.yaml`:

```yaml
orchestratorLoop:
  enabled: true
  pollIntervalMs: 600000        # 10 minutes
  decompositionModel: sonnet    # Claude model for decomposition
  clarificationModel: sonnet    # Claude model for clarity checks
  repos:
    server:
      projectId: my-server      # must match a key in `projects:`
    web-app:
      projectId: my-web
    dashboard:
      projectId: my-dashboard
  sequencingRules:
    - upstream: server
      downstream: [web-app, dashboard]
      postMergeCommands: ["pnpm install"]

workerLoop:
  enabled: true
  pollIntervalMs: 600000        # 10 minutes
  maxConcurrent: 1              # max parallel pipelines per repo
  maxRetries: 3                 # retries before parking
```

Both blocks are optional. Without them, the system runs as vanilla agent-orchestrator.

## Linear Labels

The system uses these Linear labels to drive the workflow:

| Label | Applied by | Meaning |
|-------|-----------|---------|
| `agent-ready` | Human | Ticket ready for agent pickup |
| `worker-ready` | Orchestrator | Sub-ticket ready for worker |
| `repo:server` | Orchestrator | Sub-ticket targets the server repo |
| `repo:web-app` | Orchestrator | Sub-ticket targets the web-app repo |
| `parked` | Worker | Failed after max retries |
| `pr-open` | Worker | PR created successfully |
| `needs-redecomp` | Human | Bad decomposition, needs redo |

## Orchestrator Loop

**File:** `packages/core/src/orchestrator-loop.ts`

Runs inside `ao start`. Polls Linear every N minutes for tickets with the `agent-ready` label.

### Poll cycle

1. **Fetch** — `listIssues({ labels: ["agent-ready"] })`
2. **Clarity check** — Uses Claude Code CLI to assess if ticket is clear enough. If unclear: posts a comment explaining what's missing, removes `agent-ready` label, skips.
3. **Decompose** — Calls `decomposeMultiRepo()` which uses Claude to split the task into per-repo sub-tasks. Each sub-task is self-contained with API contracts, type definitions, and acceptance criteria.
4. **Create sub-tickets** — Creates child issues in Linear with `worker-ready` + `repo:<name>` labels and `blocked-by` relations for sequencing.
5. **Update parent** — Removes `agent-ready`, sets status to `in-progress`.
6. **Completion watch** — Checks tracked parents each cycle. All children closed → close parent. Any child parked → mark parent blocked.

### Clarity check

The LLM assesses whether a ticket has:
- A specific, actionable goal
- Enough context to start implementation
- No ambiguous requirements

If unclear, the orchestrator posts a comment like:
> "This ticket needs clarification: Missing specifics about which module, what the expected interface looks like..."

## Worker Loop

**File:** `packages/core/src/worker-loop.ts`

Polls Linear for sub-tickets with `worker-ready` + `repo:<name>` labels.

### For each sub-ticket

1. Verifies it's not blocked (checks `blocked-by` relations)
2. Creates a git worktree
3. Runs the three-phase worker pipeline
4. Updates Linear with results

## Worker Pipeline

**File:** `packages/core/src/worker-pipeline.ts`

Three phases, all sharing the same git worktree:

### Phase 1: PLAN (Claude Code / Sonnet)
- Explores the codebase
- Produces a step-by-step implementation plan
- Does NOT implement anything
- Prompt enforces: "Do NOT ask clarifying questions. Make reasonable assumptions."

### Phase 2: EXECUTE (OpenCode)
- Receives the plan as prompt
- Implements the changes
- Commits to the branch

### Phase 3: TEST (Claude Code / Sonnet)
- Runs tests and validates against acceptance criteria
- If tests pass → creates a PR
- If tests fail → triggers retry

### Retry strategy

- On failure: always re-plan from scratch with failure context
- Same failure reason 3 times → park the ticket
- Different failure reason → reset counter, re-plan
- Test session stays alive after PR creation for review feedback

## Cross-Repo Sequencing

**File:** `packages/core/src/dependency-tracker.ts`

In-memory DAG with cycle detection. Configured via `sequencingRules`:

```yaml
sequencingRules:
  - upstream: server
    downstream: [web-app, dashboard]
    postMergeCommands: ["pnpm install"]
```

This means:
1. Server sub-ticket must complete before web-app/dashboard can start
2. After server PR merges, `pnpm install` runs in downstream repos (type sync)
3. Then downstream sub-tickets are unblocked

The dependency tracker:
- `addDependency(blocked, blocker)` — with cycle detection
- `markComplete(issueId)` — returns newly unblocked issue IDs
- `isBlocked(issueId)` — checked by both worker loop and lifecycle manager

## Conflict Detection

**File:** `packages/core/src/file-impact.ts`

Before creating sub-tickets, the orchestrator can predict which files a task will touch using `predictFileImpact()`. If predicted files overlap with in-flight tickets, the new ticket gets a `blocked-by` relation.

Uses Claude Code CLI — no separate API key needed.

## PR Review Feedback

When a reviewer comments on an agent's PR:

### If session is alive
The lifecycle manager detects the comment and sends it to the agent via `tmux send-keys`. The agent reads the comment and pushes fixes.

### If session is dead (machine restart, manual kill, days later)
The lifecycle manager auto-spawns a fresh session on the same branch/worktree with the review comments as the prompt.

### Plain PR comments
Since the PR author can't submit a formal GitHub review on their own PR, the system also monitors plain PR conversation comments (not just review threads). New comments are forwarded to the agent via the `changes-requested` reaction.

Requires `reactions` in project config:
```yaml
reactions:
  ci-failed:
    auto: true
    action: send-to-agent
    message: "CI failed. Read the failure logs and fix."
    retries: 3
  changes-requested:
    auto: true
    action: send-to-agent
    message: "Review comments need to be addressed."
    retries: 3
```

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `LINEAR_API_KEY` | Yes | Linear API access |
| `ANTHROPIC_API_KEY` | No | Not needed — uses Claude Code CLI |

## New Files

| File | Purpose |
|------|---------|
| `packages/core/src/orchestrator-loop.ts` | Orchestrator polling loop |
| `packages/core/src/worker-loop.ts` | Worker polling loop |
| `packages/core/src/worker-pipeline.ts` | Three-phase Plan/Execute/Test pipeline |
| `packages/core/src/dependency-tracker.ts` | In-memory DAG for cross-repo sequencing |
| `packages/core/src/file-impact.ts` | LLM file impact prediction |

## Modified Files

| File | Changes |
|------|---------|
| `packages/core/src/types.ts` | WorkerPhase, SubTicketMeta, MultiRepoSubTask, OrchestratorLoopConfig, WorkerLoopConfig, IssueRelation, IssueComment + extended SessionSpawnConfig, Tracker, Issue, CreateIssueInput, OrchestratorConfig |
| `packages/core/src/config.ts` | Zod schemas for new config blocks |
| `packages/core/src/decomposer.ts` | `decomposeMultiRepo()` via Claude CLI |
| `packages/core/src/lifecycle-manager.ts` | Dependency blocking, auto-respawn dead sessions, conversation comment reactions |
| `packages/core/src/session-manager.ts` | `workspacePath` reuse, `model` override |
| `packages/core/src/index.ts` | Exports for all new modules |
| `packages/plugins/tracker-linear/src/index.ts` | removeLabels, parentIssueId, addIssueRelation, getIssueComments, parent/relations in getIssue |
| `packages/plugins/scm-github/src/index.ts` | getConversationComments for plain PR comments |
| `packages/cli/src/commands/start.ts` | Wired orchestrator loop + worker loop into `ao start` |
