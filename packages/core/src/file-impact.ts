/**
 * File Impact Predictor — LLM-driven prediction of which files a task will touch.
 *
 * Uses Claude Code CLI (`claude -p`) to analyze a task description against repo
 * context and return a list of likely impacted file paths.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FILE_IMPACT_SYSTEM = `You predict which files in a repository a given task will likely touch.

Given a task description and repository context, return a JSON array of file paths (relative to repo root) that will likely need modification.

Rules:
- Only include files that are directly relevant to the task.
- Order by likelihood of impact (most likely first).
- Include both source files and test files if applicable.
- Do NOT include config/lockfiles unless the task explicitly mentions them.

Respond with ONLY a JSON array of strings. Example:
["src/api/auth.ts", "src/api/__tests__/auth.test.ts", "src/types.ts"]

Nothing else — just the JSON array.`;

/**
 * Predict which files a task will likely touch using Claude Code CLI.
 *
 * @param taskDescription - Description of the task to analyze
 * @param repoContext - Context about the repository structure and contents
 * @param model - Model to use (default: sonnet)
 * @returns Array of predicted file paths, or empty array if prediction fails
 */
export async function predictFileImpact(
  taskDescription: string,
  repoContext: string,
  model = "sonnet",
): Promise<string[]> {
  const prompt = `${FILE_IMPACT_SYSTEM}\n\nRepository context:\n${repoContext}\n\nTask:\n${taskDescription}`;

  try {
    const { stdout } = await execFileAsync(
      "claude",
      ["-p", prompt, "--model", model, "--output-format", "text"],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );

    const text = stdout.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    if (!parsed.every((item): item is string => typeof item === "string")) return [];
    return parsed;
  } catch {
    return [];
  }
}
