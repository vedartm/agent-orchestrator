/**
 * Task Decomposer — LLM-driven recursive task decomposition.
 *
 * Classifies issues as atomic (one agent can handle it) or composite
 * (needs to be broken into subtasks). Composite tasks are recursively
 * decomposed until all leaves are atomic.
 *
 * Integration: sits upstream of SessionManager.spawn(). When enabled,
 * complex issues are decomposed into child issues before agents are spawned.
 */

import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MultiRepoDecompositionPlan, MultiRepoSubTask } from "./types.js";

const execFileAsync = promisify(execFile);

// =============================================================================
// TYPES
// =============================================================================

export type TaskKind = "atomic" | "composite";
export type TaskStatus = "pending" | "decomposing" | "ready" | "running" | "done" | "failed";

export interface TaskNode {
  id: string; // hierarchical: "1", "1.2", "1.2.3"
  depth: number;
  description: string;
  kind?: TaskKind;
  status: TaskStatus;
  lineage: string[]; // ancestor descriptions root→parent
  children: TaskNode[];
  result?: string;
  issueId?: string; // tracker issue created for this subtask
  sessionId?: string; // AO session working on this task
}

export interface DecompositionPlan {
  id: string;
  rootTask: string;
  tree: TaskNode;
  maxDepth: number;
  phase: "decomposing" | "review" | "approved" | "executing" | "done" | "failed";
  createdAt: string;
  approvedAt?: string;
  parentIssueId?: string;
}

export interface DecomposerConfig {
  /** Enable auto-decomposition for backlog issues (default: false) */
  enabled: boolean;
  /** Max recursion depth (default: 3) */
  maxDepth: number;
  /** Model to use for decomposition (default: claude-sonnet-4-20250514) */
  model: string;
  /** Require human approval before executing decomposed plans (default: true) */
  requireApproval: boolean;
}

export const DEFAULT_DECOMPOSER_CONFIG: DecomposerConfig = {
  enabled: false,
  maxDepth: 3,
  model: "claude-sonnet-4-20250514",
  requireApproval: true,
};

// =============================================================================
// LINEAGE CONTEXT
// =============================================================================

/** Format the task lineage as an indented hierarchy for LLM context. */
export function formatLineage(lineage: string[], current: string): string {
  const parts = lineage.map((desc, i) => `${"  ".repeat(i)}${i}. ${desc}`);
  parts.push(`${"  ".repeat(lineage.length)}${lineage.length}. ${current}  <-- (this task)`);
  return parts.join("\n");
}

/** Format sibling tasks for awareness context. */
export function formatSiblings(siblings: string[], current: string): string {
  if (siblings.length === 0) return "";
  const lines = siblings.map((s) => (s === current ? `  - ${s}  <-- (you)` : `  - ${s}`));
  return `Sibling tasks being worked on in parallel:\n${lines.join("\n")}`;
}

// =============================================================================
// LLM CALLS
// =============================================================================

const CLASSIFY_SYSTEM = `You decide whether a software task is "atomic" or "composite".

- "atomic" = a developer can implement this directly without needing to plan further. It may involve multiple steps, but they're all part of one coherent unit of work.
- "composite" = this clearly contains 2+ independent concerns that should be worked on separately (e.g., backend + frontend, or auth + database + UI).

Decision heuristics:
- If the task names a single feature, endpoint, component, or module: atomic.
- If the task bundles unrelated concerns (e.g., "build auth and set up CI"): composite.
- If you're at depth 2 or deeper in the hierarchy, it is almost certainly atomic — only mark composite if you can name 2+ truly independent deliverables.
- When in doubt, choose atomic. Over-decomposition creates more overhead than under-decomposition.

Respond with ONLY the word "atomic" or "composite". Nothing else.`;

const DECOMPOSE_SYSTEM = `You are a pragmatic task decomposition engine for software projects.

Given a composite task, break it into the MINIMUM number of subtasks needed:
- A simple task might only need 2 subtasks.
- A complex task might need up to 7, but only if each is truly distinct.
- Do NOT pad with extra subtasks. Do NOT create "test and polish" or "define requirements" subtasks.
- Do NOT create subtasks that overlap or restate each other.
- Each subtask should represent real, distinct work.

Think about how an experienced developer would actually split this work.

Respond with a JSON array of strings, each being a subtask description. Example:
["Implement Stripe webhook handler", "Build subscription management UI"]

Nothing else — just the JSON array.`;

async function classifyTask(
  client: Anthropic,
  model: string,
  task: string,
  lineage: string[],
): Promise<TaskKind> {
  const context = formatLineage(lineage, task);
  const res = await client.messages.create({
    model,
    max_tokens: 10,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: "user", content: `Task hierarchy:\n${context}` }],
  });

  const text = res.content[0].type === "text" ? res.content[0].text.trim().toLowerCase() : "";
  return text === "composite" ? "composite" : "atomic";
}

async function decomposeTask(
  client: Anthropic,
  model: string,
  task: string,
  lineage: string[],
): Promise<string[]> {
  const context = formatLineage(lineage, task);
  const res = await client.messages.create({
    model,
    max_tokens: 1024,
    system: DECOMPOSE_SYSTEM,
    messages: [{ role: "user", content: `Task hierarchy:\n${context}` }],
  });

  const text = res.content[0].type === "text" ? res.content[0].text.trim() : "[]";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`Decomposition failed — no JSON array in response: ${text}`);
  }

  const subtasks = JSON.parse(jsonMatch[0]) as string[];
  if (!Array.isArray(subtasks) || subtasks.length < 2) {
    throw new Error(`Decomposition produced ${subtasks.length} subtasks — need at least 2`);
  }

  return subtasks;
}

// =============================================================================
// TREE OPERATIONS
// =============================================================================

function createTaskNode(
  id: string,
  description: string,
  depth: number,
  lineage: string[],
): TaskNode {
  return { id, depth, description, status: "pending", lineage, children: [] };
}

/** Recursively decompose a task tree (planning phase — no execution). */
async function planTree(
  client: Anthropic,
  model: string,
  task: TaskNode,
  maxDepth: number,
): Promise<TaskNode> {
  const kind = task.depth >= maxDepth ? "atomic" : await classifyTask(client, model, task.description, task.lineage);

  task.kind = kind;

  if (kind === "atomic") {
    task.status = "ready";
    return task;
  }

  task.status = "decomposing";
  const subtaskDescriptions = await decomposeTask(client, model, task.description, task.lineage);

  const childLineage = [...task.lineage, task.description];
  task.children = subtaskDescriptions.map((desc, i) =>
    createTaskNode(`${task.id}.${i + 1}`, desc, task.depth + 1, childLineage),
  );

  // Recurse on children concurrently
  await Promise.all(task.children.map((child) => planTree(client, model, child, maxDepth)));

  task.status = "ready";
  return task;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** Create a decomposition plan for a task. */
export async function decompose(
  taskDescription: string,
  config: DecomposerConfig = DEFAULT_DECOMPOSER_CONFIG,
): Promise<DecompositionPlan> {
  const client = new Anthropic();
  const tree = createTaskNode("1", taskDescription, 0, []);

  await planTree(client, config.model, tree, config.maxDepth);

  return {
    id: `plan-${Date.now()}`,
    rootTask: taskDescription,
    tree,
    maxDepth: config.maxDepth,
    phase: config.requireApproval ? "review" : "approved",
    createdAt: new Date().toISOString(),
  };
}

/** Collect all leaf (atomic) tasks from a tree. */
export function getLeaves(task: TaskNode): TaskNode[] {
  if (task.children.length === 0) return [task];
  return task.children.flatMap(getLeaves);
}

/** Get sibling task descriptions for a given task. */
export function getSiblings(root: TaskNode, taskId: string): string[] {
  function findParent(node: TaskNode): TaskNode | null {
    for (const child of node.children) {
      if (child.id === taskId) return node;
      const found = findParent(child);
      if (found) return found;
    }
    return null;
  }

  const parent = findParent(root);
  if (!parent) return [];
  return parent.children.filter((c) => c.id !== taskId).map((c) => c.description);
}

/** Format the plan tree as a human-readable string. */
export function formatPlanTree(task: TaskNode, indent = 0): string {
  const prefix = "  ".repeat(indent);
  const kindTag = task.kind === "atomic" ? "[ATOMIC]" : task.kind === "composite" ? "[COMPOSITE]" : "";
  const statusTag = task.status !== "ready" ? ` (${task.status})` : "";
  let line = `${prefix}${task.id}. ${kindTag} ${task.description}${statusTag}`;

  if (task.children.length > 0) {
    const childLines = task.children.map((c) => formatPlanTree(c, indent + 1)).join("\n");
    line += "\n" + childLines;
  }

  return line;
}

/** Propagate done/failed status up the tree. */
export function propagateStatus(task: TaskNode): void {
  if (task.children.length === 0) return;
  task.children.forEach(propagateStatus);
  if (task.children.every((c) => c.status === "done")) {
    task.status = "done";
  } else if (task.children.some((c) => c.status === "failed")) {
    task.status = "failed";
  } else if (task.children.some((c) => c.status === "running" || c.status === "done")) {
    task.status = "running";
  }
}

// =============================================================================
// MULTI-REPO DECOMPOSITION
// =============================================================================

export interface MultiRepoDecomposeConfig {
  model?: string; // default "claude-opus-4"
  repos: Record<string, string>; // repo name -> context/description
  sequencingRules: Array<{ upstream: string; downstream: string[] }>;
}

const MULTI_REPO_DECOMPOSE_SYSTEM = `You are a multi-repo task decomposition engine.

You decompose a high-level task into per-repo sub-tasks for a distributed system.

CRITICAL RULES:
- Each sub-task MUST be completely self-contained. Workers only see their sub-task — never the parent ticket or other sub-tasks.
- Include API contracts, type definitions, and acceptance criteria directly in each sub-task description.
- If a sub-task depends on another repo's output (e.g., an API endpoint), spell out the exact contract (method, path, request/response types) in the sub-task description.
- Respect sequencing rules: upstream repos must be completed before downstream repos can start.
- Use the minimum number of sub-tasks needed. One sub-task per repo is typical; only split within a repo if truly independent work streams exist.

Respond with a JSON object matching this shape:
{
  "subTasks": [
    {
      "title": "Short title",
      "description": "Self-contained description with API contracts, type defs, acceptance criteria",
      "repo": "repo-name",
      "fileImpactList": ["src/file.ts"],
      "dependsOn": [],
      "acceptanceCriteria": ["criterion 1", "criterion 2"]
    }
  ],
  "sequencingNotes": "Brief explanation of execution order"
}

dependsOn is an array of zero-based indices into the subTasks array.
Nothing else — just the JSON object.`;

/**
 * Decompose a task across multiple repositories into self-contained sub-tasks.
 * Uses Claude Code CLI (`claude -p`) instead of direct API calls.
 */
export async function decomposeMultiRepo(
  taskDescription: string,
  config: MultiRepoDecomposeConfig,
): Promise<MultiRepoDecompositionPlan> {
  const model = config.model ?? "opus";

  const repoContext = Object.entries(config.repos)
    .map(([name, desc]) => `- **${name}**: ${desc}`)
    .join("\n");

  const sequencingContext =
    config.sequencingRules.length > 0
      ? config.sequencingRules
          .map((r) => `  ${r.upstream} → [${r.downstream.join(", ")}]`)
          .join("\n")
      : "  No explicit sequencing rules.";

  const prompt = `${MULTI_REPO_DECOMPOSE_SYSTEM}\n\nRepos:\n${repoContext}\n\nSequencing rules:\n${sequencingContext}\n\nTask:\n${taskDescription}`;

  const { stdout } = await execFileAsync(
    "claude",
    ["-p", prompt, "--model", model, "--output-format", "text"],
    { timeout: 120_000, maxBuffer: 5 * 1024 * 1024 },
  );

  const text = stdout.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Multi-repo decomposition failed — no JSON object in response: ${text}`);
  }

  const parsed: unknown = JSON.parse(jsonMatch[0]);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("subTasks" in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).subTasks)
  ) {
    throw new Error("Multi-repo decomposition returned invalid shape — missing subTasks array");
  }

  const raw = parsed as { subTasks: unknown[]; sequencingNotes?: unknown };

  const subTasks: MultiRepoSubTask[] = raw.subTasks.map((item: unknown, idx: number) => {
    const t = item as Record<string, unknown>;
    if (typeof t.title !== "string" || typeof t.description !== "string" || typeof t.repo !== "string") {
      throw new Error(`Sub-task at index ${idx} missing required string fields (title, description, repo)`);
    }
    return {
      title: t.title,
      description: t.description,
      repo: t.repo,
      fileImpactList: Array.isArray(t.fileImpactList)
        ? (t.fileImpactList as unknown[]).filter((f): f is string => typeof f === "string")
        : [],
      dependsOn: Array.isArray(t.dependsOn)
        ? (t.dependsOn as unknown[]).filter((d): d is number => typeof d === "number")
        : [],
      acceptanceCriteria: Array.isArray(t.acceptanceCriteria)
        ? (t.acceptanceCriteria as unknown[]).filter((c): c is string => typeof c === "string")
        : [],
    };
  });

  return {
    parentTaskDescription: taskDescription,
    subTasks,
    sequencingNotes: typeof raw.sequencingNotes === "string" ? raw.sequencingNotes : "",
  };
}
