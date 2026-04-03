import { describe, expect, it } from "vitest";
import { resolveAgentSelection } from "../agent-selection.js";
import type { DefaultPlugins, ProjectConfig } from "../types.js";

function buildDefaults(): DefaultPlugins {
  return {
    runtime: "tmux",
    agent: "claude-code",
    workspace: "worktree",
    notifiers: [],
    orchestrator: {
      agent: "claude-code",
    },
    worker: {
      agent: "claude-code",
    },
  };
}

function buildProject(): ProjectConfig {
  return {
    name: "Demo",
    path: "/tmp/demo",
    defaultBranch: "main",
    sessionPrefix: "demo",
    orchestrator: {
      agent: "claude-code",
    },
    worker: {
      agent: "claude-code",
    },
  };
}

describe("resolveAgentSelection", () => {
  it("does not apply spawnAgentOverride for orchestrators", () => {
    const selection = resolveAgentSelection({
      role: "orchestrator",
      project: buildProject(),
      defaults: buildDefaults(),
      spawnAgentOverride: "codex",
    });

    expect(selection.agentName).toBe("claude-code");
  });

  it("applies spawnAgentOverride for workers", () => {
    const selection = resolveAgentSelection({
      role: "worker",
      project: buildProject(),
      defaults: buildDefaults(),
      spawnAgentOverride: "codex",
    });

    expect(selection.agentName).toBe("codex");
  });
});
