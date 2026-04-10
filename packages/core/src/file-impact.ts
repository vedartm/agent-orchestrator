/**
 * File Impact Predictor — LLM-driven prediction of which files a task will touch.
 *
 * Uses the Anthropic SDK to analyze a task description against repo context
 * and return a list of likely impacted file paths.
 */

import Anthropic from "@anthropic-ai/sdk";

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
 * Predict which files a task will likely touch using LLM analysis.
 *
 * @param taskDescription - Description of the task to analyze
 * @param repoContext - Context about the repository structure and contents
 * @param model - Anthropic model to use (default: claude-sonnet-4-20250514)
 * @returns Array of predicted file paths, or empty array if prediction fails
 */
export async function predictFileImpact(
  taskDescription: string,
  repoContext: string,
  model = "claude-sonnet-4-20250514",
): Promise<string[]> {
  const client = new Anthropic();

  const res = await client.messages.create({
    model,
    max_tokens: 1024,
    system: FILE_IMPACT_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Repository context:\n${repoContext}\n\nTask:\n${taskDescription}`,
      },
    ],
  });

  const text = res.content[0].type === "text" ? res.content[0].text.trim() : "[]";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    // Validate every element is a string
    if (!parsed.every((item): item is string => typeof item === "string")) return [];
    return parsed;
  } catch {
    return [];
  }
}
