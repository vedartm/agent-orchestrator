import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { validateConfig } from "../../config.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Agent,
  Workspace,
  Tracker,
  RuntimeHandle,
} from "../../types.js";

import {
  createTestContext,
  cleanupTestContext,
  makeHandle,
  createRegistryWithPlugins,
  createSessionManager,
  writeMetadata,
  readMetadataRaw,
  updateMetadata,
  deleteMetadata,
  getWorktreesDir,
} from "./fixtures.js";

import {
  installMockOpencode,
  installMockGit,
} from "./opencode-helpers.js";

describe("spawn", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  it("creates a session with workspace, runtime, and agent", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    const session = await sm.spawn({ projectId: "my-app" });

    expect(session.id).toBe("app-1");
    expect(session.status).toBe("spawning");
    expect(session.projectId).toBe("my-app");
    expect(session.runtimeHandle).toEqual(makeHandle("rt-1"));

    expect(ctx.mockWorkspace.create).toHaveBeenCalled();
    expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalled();
    expect(ctx.mockRuntime.create).toHaveBeenCalled();
  });

  it("blocks spawn while the project is globally paused", async () => {
    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: join(ctx.tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-orchestrator")),
    });
    updateMetadata(ctx.sessionsDir, "app-orchestrator", {
      globalPauseUntil: new Date(Date.now() + 60_000).toISOString(),
      globalPauseReason: "Rate limit reached",
      globalPauseSource: "app-9",
    });

    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow(
      "Project is paused due to model rate limit until",
    );
    expect(ctx.mockRuntime.create).not.toHaveBeenCalled();
  });

  it("uses issue ID to derive branch name", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(session.branch).toBe("feat/INT-100");
    expect(session.issueId).toBe("INT-100");
  });

  it("sanitizes free-text issueId into a valid branch slug", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "fix login bug" });

    expect(session.branch).toBe("feat/fix-login-bug");
  });

  it("preserves casing for branch-safe issue IDs without tracker", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-9999" });

    expect(session.branch).toBe("feat/INT-9999");
  });

  it("sanitizes issueId with special characters", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    const session = await sm.spawn({
      projectId: "my-app",
      issueId: "Fix: user can't login (SSO)",
    });

    expect(session.branch).toBe("feat/fix-user-can-t-login-sso");
  });

  it("truncates long slugs to 60 characters", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    const session = await sm.spawn({
      projectId: "my-app",
      issueId:
        "this is a very long issue description that should be truncated to sixty characters maximum",
    });

    expect(session.branch!.replace("feat/", "").length).toBeLessThanOrEqual(60);
  });

  it("does not leave trailing dash after truncation", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    const session = await sm.spawn({
      projectId: "my-app",
      issueId: "ab ".repeat(30),
    });

    const slug = session.branch!.replace("feat/", "");
    expect(slug).not.toMatch(/-$/);
    expect(slug).not.toMatch(/^-/);
  });

  it("falls back to sessionId when issueId sanitizes to empty string", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "!!!" });

    expect(session.branch).toMatch(/^feat\/app-\d+$/);
  });

  it("sanitizes issueId containing '..' (invalid in git branch names)", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "foo..bar" });

    expect(session.branch).toBe("feat/foo-bar");
  });

  it("uses tracker.branchName when tracker is available", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({}),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("custom/INT-100-my-feature"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker = createRegistryWithPlugins(ctx, {
      tracker: mockTracker,
    });

    const sm = createSessionManager({
      config: ctx.config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });
    expect(session.branch).toBe("custom/INT-100-my-feature");
  });

  it("increments session numbers correctly", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    writeMetadata(ctx.sessionsDir, "app-3", { worktree: "/tmp", branch: "b", status: "working" });
    writeMetadata(ctx.sessionsDir, "app-7", { worktree: "/tmp", branch: "b", status: "working" });

    const session = await sm.spawn({ projectId: "my-app" });
    expect(session.id).toBe("app-8");
  });

  it("does not reuse a killed session branch on recreate", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    const first = await sm.spawn({ projectId: "my-app" });
    expect(first.id).toBe("app-1");
    expect(first.branch).toBe("session/app-1");

    await sm.kill(first.id);

    const second = await sm.spawn({ projectId: "my-app" });
    expect(second.id).toBe("app-2");
    expect(second.branch).toBe("session/app-2");
  });

  it("skips remote session branches when allocating a fresh session id", async () => {
    const mockGitBin = installMockGit(ctx.tmpDir, ["session/app-22"]);
    process.env.PATH = `${mockGitBin}:${ctx.originalPath ?? ""}`;
    mkdirSync(ctx.config.projects["my-app"]!.path, { recursive: true });

    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });
    const session = await sm.spawn({ projectId: "my-app" });

    expect(session.id).toBe("app-23");
    expect(session.branch).toBe("session/app-23");
  });

  it("writes metadata file", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    expect(session.id).toBe("app-1");
    expect(session.status).toBe("spawning");
    expect(session.projectId).toBe("my-app");
    expect(session.runtimeHandle).toEqual(makeHandle("rt-1"));
  });

  it("reuses OpenCode session mapping by issue when available", async () => {
    const opencodeAgent: Agent = {
      ...ctx.mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode = createRegistryWithPlugins(ctx, {
      agent: opencodeAgent,
    });

    ctx.config = {
      ...ctx.config,
      defaults: { ...ctx.config.defaults, agent: "opencode" },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
        },
      },
    };

    writeMetadata(ctx.sessionsDir, "app-9", {
      worktree: "/tmp/old",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      createdAt: "2026-01-01T00:00:00.000Z",
      opencodeSessionId: "ses_existing",
    });

    const sm = createSessionManager({ config: ctx.config, registry: registryWithOpenCode });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ opencodeSessionId: "ses_existing" }),
        }),
      }),
    );

    const metadata = readMetadataRaw(ctx.sessionsDir, session.id);
    expect(metadata?.["opencodeSessionId"]).toBe("ses_existing");
  });

  it("reuses most recent session-id candidate without relying on timestamps", async () => {
    const opencodeAgent: Agent = {
      ...ctx.mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode = createRegistryWithPlugins(ctx, {
      agent: opencodeAgent,
    });

    ctx.config = {
      ...ctx.config,
      defaults: { ...ctx.config.defaults, agent: "opencode" },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
        },
      },
    };

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/old-no-ts",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_invalid_ts",
    });

    writeMetadata(ctx.sessionsDir, "app-2", {
      worktree: "/tmp/new-with-ts",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_valid_newer",
    });

    const sm = createSessionManager({ config: ctx.config, registry: registryWithOpenCode });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ opencodeSessionId: "ses_valid_newer" }),
        }),
      }),
    );

    const metadata = readMetadataRaw(ctx.sessionsDir, session.id);
    expect(metadata?.["opencodeSessionId"]).toBe("ses_valid_newer");
  });

  it("does not reuse issue mapping when opencodeIssueSessionStrategy is ignore", async () => {
    const opencodeAgent: Agent = {
      ...ctx.mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode = createRegistryWithPlugins(ctx, {
      agent: opencodeAgent,
    });

    ctx.config = {
      ...ctx.config,
      defaults: { ...ctx.config.defaults, agent: "opencode" },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
          opencodeIssueSessionStrategy: "ignore",
        },
      },
    };

    writeMetadata(ctx.sessionsDir, "app-9", {
      worktree: "/tmp/old",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_existing",
    });

    const sm = createSessionManager({ config: ctx.config, registry: registryWithOpenCode });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.not.objectContaining({ opencodeSessionId: expect.any(String) }),
        }),
      }),
    );

    const metadata = readMetadataRaw(ctx.sessionsDir, session.id);
    expect(metadata?.["opencodeSessionId"]).toBeUndefined();
  });

  it("deletes old issue mappings and starts fresh when opencodeIssueSessionStrategy is delete", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-issue.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    const opencodeAgent: Agent = {
      ...ctx.mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode = createRegistryWithPlugins(ctx, {
      agent: opencodeAgent,
    });

    ctx.config = {
      ...ctx.config,
      defaults: { ...ctx.config.defaults, agent: "opencode" },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
          opencodeIssueSessionStrategy: "delete",
        },
      },
    };

    writeMetadata(ctx.sessionsDir, "app-8", {
      worktree: "/tmp/old1",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_old_1",
    });
    writeMetadata(ctx.sessionsDir, "app-9", {
      worktree: "/tmp/old2",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_old_2",
    });

    const sm = createSessionManager({ config: ctx.config, registry: registryWithOpenCode });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    const deleteLog = readFileSync(deleteLogPath, "utf-8");
    expect(deleteLog).toContain("session delete ses_old_1");
    expect(deleteLog).toContain("session delete ses_old_2");

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.not.objectContaining({ opencodeSessionId: expect.any(String) }),
        }),
      }),
    );

    const metadata = readMetadataRaw(ctx.sessionsDir, session.id);
    expect(metadata?.["opencodeSessionId"]).toBeUndefined();
  });

  it("throws for unknown project", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });
    await expect(sm.spawn({ projectId: "nonexistent" })).rejects.toThrow("Unknown project");
  });

  it("throws when runtime plugin is missing", async () => {
    const emptyRegistry = {
      ...ctx.mockRegistry,
      get: vi.fn().mockReturnValue(null),
    };

    const sm = createSessionManager({ config: ctx.config, registry: emptyRegistry });
    await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow("not found");
  });

  describe("agent override", () => {
    let mockCodexAgent: Agent;

    beforeEach(() => {
      mockCodexAgent = {
        name: "codex",
        processName: "codex",
        getLaunchCommand: vi.fn().mockReturnValue("codex --start"),
        getEnvironment: vi.fn().mockReturnValue({ CODEX_VAR: "1" }),
        detectActivity: vi.fn().mockReturnValue("active"),
        getActivityState: vi.fn().mockResolvedValue(null),
        isProcessRunning: vi.fn().mockResolvedValue(true),
        getSessionInfo: vi.fn().mockResolvedValue(null),
      };
    });

    it("uses overridden agent when spawnConfig.agent is provided", async () => {
      const registryWithMultipleAgents = createRegistryWithPlugins(ctx, {
        agent: mockCodexAgent,
      });
      const sm = createSessionManager({ config: ctx.config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app", agent: "codex" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(ctx.mockAgent.getLaunchCommand).not.toHaveBeenCalled();
    });

    it("throws when agent override plugin is not found", async () => {
      const registryWithMultipleAgents = createRegistryWithPlugins(ctx, {
        agent: mockCodexAgent,
      });
      const sm = createSessionManager({ config: ctx.config, registry: registryWithMultipleAgents });

      await expect(sm.spawn({ projectId: "my-app", agent: "nonexistent" })).rejects.toThrow(
        "Agent plugin 'nonexistent' not found",
      );
    });

    it("uses default agent when no override specified", async () => {
      const registryWithMultipleAgents = createRegistryWithPlugins(ctx, {
        agent: mockCodexAgent,
      });
      const sm = createSessionManager({ config: ctx.config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app" });

      expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalled();
      expect(mockCodexAgent.getLaunchCommand).not.toHaveBeenCalled();
    });

    it("persists agent name in metadata when override is used", async () => {
      const registryWithMultipleAgents = createRegistryWithPlugins(ctx, {
        agent: mockCodexAgent,
      });
      const sm = createSessionManager({ config: ctx.config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app", agent: "codex" });

      const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
      expect(meta).not.toBeNull();
      expect(meta!["agent"]).toBe("codex");
    });

    it("persists default agent name in metadata when no override", async () => {
      const registryWithMultipleAgents = createRegistryWithPlugins(ctx, {
        agent: mockCodexAgent,
      });
      const sm = createSessionManager({ config: ctx.config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app" });

      const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
      expect(meta).not.toBeNull();
      expect(meta!["agent"]).toBe("mock-agent");
    });

    it("uses project worker agent when configured and no spawn override is provided", async () => {
      const configWithWorkerAgent: OrchestratorConfig = {
        ...ctx.config,
        projects: {
          ...ctx.config.projects,
          "my-app": {
            ...ctx.config.projects["my-app"],
            agent: "mock-agent",
            worker: {
              agent: "codex",
            },
          },
        },
      };

      const registryWithMultipleAgents = createRegistryWithPlugins(ctx, {
        agent: mockCodexAgent,
      });
      const sm = createSessionManager({
        config: configWithWorkerAgent,
        registry: registryWithMultipleAgents,
      });
      await sm.spawn({ projectId: "my-app" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(ctx.mockAgent.getLaunchCommand).not.toHaveBeenCalled();
      expect(readMetadataRaw(ctx.sessionsDir, "app-1")?.["agent"]).toBe("codex");
    });

    it("uses defaults worker agent when project agent is not set", async () => {
      const configWithDefaultWorkerAgent: OrchestratorConfig = {
        ...ctx.config,
        defaults: {
          ...ctx.config.defaults,
          worker: {
            agent: "codex",
          },
        },
        projects: {
          ...ctx.config.projects,
          "my-app": {
            ...ctx.config.projects["my-app"],
            agent: undefined,
          },
        },
      };

      const registryWithMultipleAgents = createRegistryWithPlugins(ctx, {
        agent: mockCodexAgent,
      });
      const sm = createSessionManager({
        config: configWithDefaultWorkerAgent,
        registry: registryWithMultipleAgents,
      });
      await sm.spawn({ projectId: "my-app" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(readMetadataRaw(ctx.sessionsDir, "app-1")?.["agent"]).toBe("codex");
    });

    it("readMetadata returns agent field (typed SessionMetadata)", async () => {
      const registryWithMultipleAgents = createRegistryWithPlugins(ctx, {
        agent: mockCodexAgent,
      });
      const sm = createSessionManager({ config: ctx.config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app", agent: "codex" });

      const meta = createSessionManager(ctx.config, ctx.mockRegistry);
      const session = await sm.spawn({ projectId: "my-app", agent: "codex" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(ctx.mockAgent.getLaunchCommand).not.toHaveBeenCalled();
    });
  });

  it("forwards configured subagent to spawn launch when no override is provided", async () => {
    const configWithSubagent: OrchestratorConfig = {
      ...ctx.config,
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agentConfig: {
            subagent: "oracle",
          },
        },
      },
    };

    const sm = createSessionManager({
      config: configWithSubagent,
      registry: ctx.mockRegistry,
    });
    await sm.spawn({ projectId: "my-app" });

    expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ subagent: "oracle" }),
    );
  });

  it("prefers spawn subagent override over configured subagent", async () => {
    const configWithSubagent: OrchestratorConfig = {
      ...ctx.config,
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agentConfig: {
            subagent: "oracle",
          },
        },
      },
    };

    const sm = createSessionManager({
      config: configWithSubagent,
      registry: ctx.mockRegistry,
    });
    await sm.spawn({ projectId: "my-app", subagent: "librarian" });

    expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ subagent: "librarian" }),
    );
  });

  it("validates issue exists when issueId provided", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "INT-100",
        title: "Test issue",
        description: "Test description",
        url: "https://linear.app/test/issue/INT-100",
        state: "open",
        labels: [],
      }),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue("https://linear.app/test/issue/INT-100"),
      branchName: vi.fn().mockReturnValue("feat/INT-100"),
      generatePrompt: vi.fn().mockResolvedValue("Work on INT-100"),
    };

    const registryWithTracker = createRegistryWithPlugins(ctx, {
      tracker: mockTracker,
    });

    const sm = createSessionManager({
      config: ctx.config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(mockTracker.getIssue).toHaveBeenCalledWith("INT-100", ctx.config.projects["my-app"]);
    expect(session.issueId).toBe("INT-100");
  });

  it("succeeds with ad-hoc issue string when tracker returns IssueNotFoundError", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockRejectedValue(new Error("Issue INT-9999 not found")),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("feat/INT-9999"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker = createRegistryWithPlugins(ctx, {
      tracker: mockTracker,
    });

    const sm = createSessionManager({
      config: ctx.config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-9999" });

    expect(session.issueId).toBe("INT-9999");
    expect(session.branch).toBe("feat/INT-9999");
    expect(mockTracker.branchName).not.toHaveBeenCalled();
    expect(mockTracker.generatePrompt).not.toHaveBeenCalled();
    expect(ctx.mockWorkspace.create).toHaveBeenCalled();
    expect(ctx.mockRuntime.create).toHaveBeenCalled();
  });

  it("succeeds with ad-hoc free-text when tracker returns 'invalid issue format'", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockRejectedValue(new Error("invalid issue format: fix login bug")),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue(""),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker = createRegistryWithPlugins(ctx, {
      tracker: mockTracker,
    });

    const sm = createSessionManager({
      config: ctx.config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "fix login bug" });

    expect(session.issueId).toBe("fix login bug");
    expect(session.branch).toBe("feat/fix-login-bug");
    expect(mockTracker.branchName).not.toHaveBeenCalled();
    expect(ctx.mockWorkspace.create).toHaveBeenCalled();
  });

  it("fails on tracker auth errors", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockRejectedValue(new Error("Unauthorized")),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("feat/INT-100"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker = createRegistryWithPlugins(ctx, {
      tracker: mockTracker,
    });

    const sm = createSessionManager({
      config: ctx.config,
      registry: registryWithTracker,
    });

    await expect(sm.spawn({ projectId: "my-app", issueId: "INT-100" })).rejects.toThrow(
      "Failed to fetch issue",
    );

    expect(ctx.mockWorkspace.create).not.toHaveBeenCalled();
    expect(ctx.mockRuntime.create).not.toHaveBeenCalled();
  });

  it("spawns without issue tracking when no issueId provided", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    const session = await sm.spawn({ projectId: "my-app" });

    expect(session.issueId).toBeNull();
    expect(session.branch).toMatch(/^session\/app-\d+$/);
    expect(session.branch).not.toBe("main");
  });

  it("sends prompt post-launch when agent.promptDelivery is 'post-launch'", async () => {
    vi.useFakeTimers();
    const postLaunchAgent = {
      ...ctx.mockAgent,
      promptDelivery: "post-launch" as const,
    };
    const registryWithPostLaunch = createRegistryWithPlugins(ctx, {
      agent: postLaunchAgent,
    });

    const sm = createSessionManager({ config: ctx.config, registry: registryWithPostLaunch });
    const spawnPromise = sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });
    await vi.advanceTimersByTimeAsync(5_000);
    await spawnPromise;

    expect(ctx.mockRuntime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.stringContaining("Fix the bug"),
    );
    vi.useRealTimers();
  });

  it("does not send prompt post-launch when agent.promptDelivery is not set", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });

    expect(ctx.mockRuntime.sendMessage).not.toHaveBeenCalled();
  });

  it("sends AO guidance post-launch even when no explicit prompt is provided", async () => {
    vi.useFakeTimers();
    const postLaunchAgent = {
      ...ctx.mockAgent,
      promptDelivery: "post-launch" as const,
    };
    const registryWithPostLaunch = createRegistryWithPlugins(ctx, {
      agent: postLaunchAgent,
    });

    const sm = createSessionManager({ config: ctx.config, registry: registryWithPostLaunch });
    const spawnPromise = sm.spawn({ projectId: "my-app" });
    await vi.advanceTimersByTimeAsync(5_000);
    await spawnPromise;

    expect(ctx.mockRuntime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.stringContaining("ao session claim-pr"),
    );
    vi.useRealTimers();
  });

  it("does not destroy session when post-launch prompt delivery fails", async () => {
    vi.useFakeTimers();
    const failingRuntime: Runtime = {
      ...ctx.mockRuntime,
      sendMessage: vi.fn().mockRejectedValue(new Error("tmux send failed")),
    };
    const postLaunchAgent = {
      ...ctx.mockAgent,
      promptDelivery: "post-launch" as const,
    };
    const registryWithFailingSend = createRegistryWithPlugins(ctx, {
      runtime: failingRuntime,
      agent: postLaunchAgent,
    });

    const sm = createSessionManager({ config: ctx.config, registry: registryWithFailingSend });
    const spawnPromise = sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });
    await vi.advanceTimersByTimeAsync(5_000);
    const session = await spawnPromise;

    expect(session.id).toBe("app-1");
    expect(session.status).toBe("spawning");
    expect(failingRuntime.destroy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("waits before sending post-launch prompt", async () => {
    vi.useFakeTimers();
    const postLaunchAgent = {
      ...ctx.mockAgent,
      promptDelivery: "post-launch" as const,
    };
    const registryWithPostLaunch = createRegistryWithPlugins(ctx, {
      agent: postLaunchAgent,
    });

    const sm = createSessionManager({ config: ctx.config, registry: registryWithPostLaunch });
    const spawnPromise = sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(ctx.mockRuntime.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await spawnPromise;
    expect(ctx.mockRuntime.sendMessage).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("spawnOrchestrator", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  it("blocks orchestrator spawn while the project is globally paused", async () => {
    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: join(ctx.tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-orchestrator")),
    });
    updateMetadata(ctx.sessionsDir, "app-orchestrator", {
      globalPauseUntil: new Date(Date.now() + 60_000).toISOString(),
      globalPauseReason: "Rate limit reached",
      globalPauseSource: "app-9",
    });

    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow(
      "Project is paused due to model rate limit until",
    );
    expect(ctx.mockRuntime.create).not.toHaveBeenCalled();
  });

  it("creates orchestrator session with correct ID", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.id).toBe("app-orchestrator");
    expect(session.status).toBe("working");
    expect(session.projectId).toBe("my-app");
    expect(session.branch).toBe("main");
    expect(session.issueId).toBeNull();
    expect(session.workspacePath).toBe(join(ctx.tmpDir, "my-app"));
  });

  it("writes metadata with proper fields", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    await sm.spawnOrchestrator({ projectId: "my-app" });

    const meta = createSessionManager(ctx.config, ctx.mockRegistry);
    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.id).toBe("app-orchestrator");
    expect(session.status).toBe("working");
    expect(session.projectId).toBe("my-app");
    expect(session.branch).toBe("main");
    expect(session.issueId).toBeNull();
    expect(session.workspacePath).toBe(join(ctx.tmpDir, "my-app"));
  });

  it("deletes previous OpenCode orchestrator sessions before starting", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-orchestrator.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        { id: "ses_old", title: "AO:app-orchestrator", updated: "2025-01-01T00:00:00.000Z" },
        { id: "ses_new", title: "AO:app-orchestrator", updated: "2025-01-02T00:00:00.000Z" },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    const opencodeAgent: Agent = {
      ...ctx.mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode = createRegistryWithPlugins(ctx, {
      agent: opencodeAgent,
    });

    const configWithDelete: OrchestratorConfig = {
      ...ctx.config,
      defaults: { ...ctx.config.defaults, agent: "opencode" },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
          orchestratorSessionStrategy: "delete",
        },
      },
    };

    const sm = createSessionManager({ config: configWithDelete, registry: registryWithOpenCode });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    const deleteLog = readFileSync(deleteLogPath, "utf-8");
    expect(deleteLog).toContain("session delete ses_old");
    expect(deleteLog).toContain("session delete ses_new");

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "app-orchestrator",
        projectConfig: expect.objectContaining({
          agentConfig: expect.not.objectContaining({ opencodeSessionId: expect.any(String) }),
        }),
      }),
    );

    const meta = readMetadataRaw(ctx.sessionsDir, "app-orchestrator");
    expect(meta?.["agent"]).toBe("opencode");
    expect(meta?.["opencodeSessionId"]).toBeUndefined();
  });

  it("discovers and persists OpenCode session id by title when strategy is reuse", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-orchestrator-reuse-discovery.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        {
          id: "ses_discovered_orchestrator",
          title: "AO:app-orchestrator",
          updated: 1_772_777_000_000,
        },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    const opencodeAgent: Agent = {
      ...ctx.mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode = createRegistryWithPlugins(ctx, {
      agent: opencodeAgent,
    });

    const configWithReuse: OrchestratorConfig = {
      ...ctx.config,
      defaults: { ...ctx.config.defaults, agent: "opencode" },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
          orchestratorSessionStrategy: "reuse",
        },
      },
    };

    const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    const meta = readMetadataRaw(ctx.sessionsDir, "app-orchestrator");
    expect(meta?.["opencodeSessionId"]).toBe("ses_discovered_orchestrator");
  });

  it("reuses an existing orchestrator session when strategy is reuse", async () => {
    const listLogPath = join(ctx.tmpDir, "opencode-list-orchestrator-reuse.log");
    const mockBin = join(ctx.tmpDir, "mock-bin-reuse-no-list");
    mkdirSync(mockBin, { recursive: true });
    const scriptPath = join(mockBin, "opencode");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "$1" == "session" && "$2" == "list" ]]; then',
        `  printf '%s\\n' "$*" >> '${listLogPath.replace(/'/g, "'\\''")}'`,
        "  printf '[]\\n'",
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(scriptPath, 0o755);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    const opencodeAgent: Agent = {
      ...ctx.mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode = createRegistryWithPlugins(ctx, {
      agent: opencodeAgent,
    });

    const configWithReuse: OrchestratorConfig = {
      ...ctx.config,
      defaults: { ...ctx.config.defaults, agent: "opencode" },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
          orchestratorSessionStrategy: "reuse",
        },
      },
    };

    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: join(ctx.tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      opencodeSessionId: "ses_existing",
      createdAt: new Date().toISOString(),
    });

    const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.id).toBe("app-orchestrator");
    expect(session.metadata["orchestratorSessionReused"]).toBe("true");
    expect(ctx.mockRuntime.create).not.toHaveBeenCalled();
    expect(ctx.mockRuntime.destroy).not.toHaveBeenCalled();
    expect(existsSync(listLogPath)).toBe(false);
  });

  it("destroys orphaned runtime when reuse strategy finds alive runtime but get returns null", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-orphaned-runtime.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    const opencodeAgent: Agent = {
      ...ctx.mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode = createRegistryWithPlugins(ctx, {
      agent: opencodeAgent,
    });

    const configWithReuse: OrchestratorConfig = {
      ...ctx.config,
      defaults: { ...ctx.config.defaults, agent: "opencode" },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
          orchestratorSessionStrategy: "reuse",
        },
      },
    };

    const orphanedHandle = makeHandle("rt-orphaned");
    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: join(ctx.tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(orphanedHandle),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(ctx.mockRuntime.isAlive).mockImplementation(async (handle: RuntimeHandle) => {
      if (handle?.id === "rt-orphaned") {
        deleteMetadata(ctx.sessionsDir, "app-orchestrator");
        return true;
      }
      return false;
    });

    const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.id).toBe("app-orchestrator");
    expect(ctx.mockRuntime.destroy).toHaveBeenCalledWith(orphanedHandle);
    expect(ctx.mockRuntime.create).toHaveBeenCalled();
  });

  it("reuses mapped OpenCode session id when strategy is reuse and runtime is restarted", async () => {
    const opencodeAgent: Agent = {
      ...ctx.mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode = createRegistryWithPlugins(ctx, {
      agent: opencodeAgent,
    });

    const configWithReuse: OrchestratorConfig = {
      ...ctx.config,
      defaults: { ...ctx.config.defaults, agent: "opencode" },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
          orchestratorSessionStrategy: "reuse",
        },
      },
    };

    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: join(ctx.tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      opencodeSessionId: "ses_existing",
      createdAt: new Date().toISOString(),
    });

    vi.mocked(ctx.mockRuntime.isAlive).mockResolvedValue(false);

    const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ opencodeSessionId: "ses_existing" }),
        }),
      }),
    );
    const meta = readMetadataRaw(ctx.sessionsDir, "app-orchestrator");
    expect(meta?.["opencodeSessionId"]).toBe("ses_existing");
  });

  it("reuses archived OpenCode mapping for orchestrator when active metadata has no mapping", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-orchestrator-reuse-archived.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        null,
        { id: "ses_existing", title: "AO:app-orchestrator", updated: 1_772_777_000_000 },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    const opencodeAgent: Agent = {
      ...ctx.mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode = createRegistryWithPlugins(ctx, {
      agent: opencodeAgent,
    });

    const configWithReuse: OrchestratorConfig = {
      ...ctx.config,
      defaults: { ...ctx.config.defaults, agent: "opencode" },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
          orchestratorSessionStrategy: "reuse",
        },
      },
    };

    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: join(ctx.tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      opencodeSessionId: "ses_existing",
      createdAt: new Date().toISOString(),
    });
    deleteMetadata(ctx.sessionsDir, "app-orchestrator", true);
    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: join(ctx.tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(ctx.mockRuntime.isAlive).mockResolvedValue(false);

    const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ opencodeSessionId: "ses_existing" }),
        }),
      }),
    );
  });

  it("reuses OpenCode session by title when orchestrator mapping is missing", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-orchestrator-reuse-title.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        null,
        { id: "ses_title_match", title: "AO:app-orchestrator", updated: 1_772_777_000_000 },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    const opencodeAgent: Agent = {
      ...ctx.mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode = createRegistryWithPlugins(ctx, {
      agent: opencodeAgent,
    });

    const configWithReuse: OrchestratorConfig = {
      ...ctx.config,
      defaults: { ...ctx.config.defaults, agent: "opencode" },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
          orchestratorSessionStrategy: "reuse",
        },
      },
    };

    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: join(ctx.tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(ctx.mockRuntime.isAlive).mockResolvedValue(false);

    const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ opencodeSessionId: "ses_title_match" }),
        }),
      }),
    );
    const meta = readMetadataRaw(ctx.sessionsDir, "app-orchestrator");
    expect(meta?.["opencodeSessionId"]).toBe("ses_title_match");
  });

  it("starts fresh without deleting prior OpenCode sessions when strategy is ignore", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-ignore.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        { id: "ses_old", title: "AO:app-orchestrator", updated: "2025-01-01T00:00:00.000Z" },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    const opencodeAgent: Agent = {
      ...ctx.mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode = createRegistryWithPlugins(ctx, {
      agent: opencodeAgent,
    });

    const configWithIgnoreNew: OrchestratorConfig = {
      ...ctx.config,
      defaults: { ...ctx.config.defaults, agent: "opencode" },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
          orchestratorSessionStrategy: "ignore",
        },
      },
    };

    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: join(ctx.tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(ctx.mockRuntime.isAlive).mockResolvedValueOnce(true);

    const sm = createSessionManager({
      config: configWithIgnoreNew,
      registry: registryWithOpenCode,
    });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(ctx.mockRuntime.destroy).toHaveBeenCalledWith(makeHandle("rt-existing"));
    expect(ctx.mockRuntime.create).toHaveBeenCalled();
    expect(existsSync(deleteLogPath)).toBe(false);
  });

  it("skips workspace creation", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(ctx.mockWorkspace.create).not.toHaveBeenCalled();
  });

  it("calls agent.setupWorkspaceHooks on project path", async () => {
    const agentWithHooks: Agent = {
      ...ctx.mockAgent,
      setupWorkspaceHooks: vi.fn().mockResolvedValue(undefined),
    };
    const registryWithHooks = createRegistryWithPlugins(ctx, {
      agent: agentWithHooks,
    });

    const sm = createSessionManager({ config: ctx.config, registry: registryWithHooks });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(agentWithHooks.setupWorkspaceHooks).toHaveBeenCalledWith(
      join(ctx.tmpDir, "my-app"),
      expect.objectContaining({ dataDir: ctx.sessionsDir }),
    );
  });

  it("calls runtime.create with proper config", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(ctx.mockRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: join(ctx.tmpDir, "my-app"),
        launchCommand: "mock-agent --start",
      }),
    );
  });

  it("does not persist orchestratorSessionReused metadata on newly created sessions", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    await sm.spawnOrchestrator({ projectId: "my-app" });

    const meta = readMetadataRaw(ctx.sessionsDir, "app-orchestrator");
    expect(meta?.["orchestratorSessionReused"]).toBeUndefined();
  });

  it("respawns orchestrator when stale metadata exists but runtime is dead", async () => {
    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: join(ctx.tmpDir, "my-app"),
      branch: "main",
      status: "working",
      project: "my-app",
      role: "orchestrator",
      runtimeHandle: JSON.stringify(makeHandle("rt-stale")),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(ctx.mockRuntime.isAlive).mockResolvedValue(false);

    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(ctx.mockRuntime.create).toHaveBeenCalledTimes(1);
    const meta = readMetadataRaw(ctx.sessionsDir, "app-orchestrator");
    expect(meta?.["runtimeHandle"]).toBe(JSON.stringify(makeHandle("rt-1")));
  });

  it("uses orchestratorModel when configured", async () => {
    const configWithOrchestratorModel: OrchestratorConfig = {
      ...ctx.config,
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agentConfig: {
            model: "worker-model",
            orchestratorModel: "orchestrator-model",
          },
        },
      },
    };

    const sm = createSessionManager({
      config: configWithOrchestratorModel,
      registry: ctx.mockRegistry,
    });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ model: "orchestrator-model" }),
    );
  });

  it("keeps orchestrator launch permissionless even when shared config sets permissions", async () => {
    const configWithSharedPermissions: OrchestratorConfig = {
      ...ctx.config,
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agentConfig: {
            permissions: "suggest",
          },
        },
      },
    };

    const sm = createSessionManager({
      config: configWithSharedPermissions,
      registry: ctx.mockRegistry,
    });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: "permissionless",
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ permissions: "permissionless" }),
        }),
      }),
    );
  });

  it("uses project orchestrator agent when configured", async () => {
    const mockCodexAgent: Agent = {
      ...ctx.mockAgent,
      name: "codex",
      processName: "codex",
      getLaunchCommand: vi.fn().mockReturnValue("codex --start"),
      getEnvironment: vi.fn().mockReturnValue({ CODEX_VAR: "1" }),
    };

    const configWithOrchestratorAgent: OrchestratorConfig = {
      ...ctx.config,
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "mock-agent",
          orchestrator: {
            agent: "codex",
          },
        },
      },
    };

    const registryWithMultipleAgents = createRegistryWithPlugins(ctx, {
      agent: mockCodexAgent,
    });
    const sm = createSessionManager({
      config: configWithOrchestratorAgent,
      registry: registryWithMultipleAgents,
    });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
    expect(ctx.mockAgent.getLaunchCommand).not.toHaveBeenCalled();
    expect(readMetadataRaw(ctx.sessionsDir, "app-orchestrator")?.["agent"]).toBe("codex");
  });

  it("uses defaults orchestrator agent when project agent is not set", async () => {
    const mockCodexAgent: Agent = {
      ...ctx.mockAgent,
      name: "codex",
      processName: "codex",
      getLaunchCommand: vi.fn().mockReturnValue("codex --start"),
      getEnvironment: vi.fn().mockReturnValue({ CODEX_VAR: "1" }),
    };

    const configWithDefaultOrchestratorAgent: OrchestratorConfig = {
      ...ctx.config,
      defaults: {
        ...ctx.config.defaults,
        orchestrator: {
          agent: "codex",
        },
      },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: undefined,
        },
      },
    };

    const registryWithMultipleAgents = createRegistryWithPlugins(ctx, {
      agent: mockCodexAgent,
    });
    const sm = createSessionManager({
      config: configWithDefaultOrchestratorAgent,
      registry: registryWithMultipleAgents,
    });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
    expect(readMetadataRaw(ctx.sessionsDir, "app-orchestrator")?.["agent"]).toBe("codex");
  });

  it("keeps shared worker permissions when role-specific config only overrides model", async () => {
    const configWithSharedPermissions: OrchestratorConfig = {
      ...ctx.config,
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agentConfig: {
            permissions: "suggest",
          },
          worker: {
            agentConfig: {
              model: "worker-model",
            },
          },
        },
      },
    };

    const validatedConfig = validateConfig(configWithSharedPermissions);
    validatedConfig.configPath = ctx.config.configPath;
    const sm = createSessionManager({
      config: validatedConfig,
      registry: ctx.mockRegistry,
    });
    await sm.spawn({ projectId: "my-app" });

    expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: "suggest", model: "worker-model" }),
    );
  });

  it("uses role-specific orchestratorModel when configured", async () => {
    const configWithRoleOrchestratorModel: OrchestratorConfig = {
      ...ctx.config,
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agentConfig: {
            model: "worker-model",
            orchestratorModel: "shared-orchestrator-model",
          },
          orchestrator: {
            agentConfig: {
              orchestratorModel: "role-orchestrator-model",
            },
          },
        },
      },
    };

    const sm = createSessionManager({
      config: configWithRoleOrchestratorModel,
      registry: ctx.mockRegistry,
    });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ model: "role-orchestrator-model" }),
    );
  });

  it("forwards configured subagent to orchestrator launch", async () => {
    const configWithSubagent: OrchestratorConfig = {
      ...ctx.config,
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agentConfig: {
            subagent: "oracle",
          },
        },
      },
    };

    const sm = createSessionManager({
      config: configWithSubagent,
      registry: ctx.mockRegistry,
    });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ subagent: "oracle" }),
    );
  });

  it("writes system prompt to file and passes systemPromptFile to agent", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    await sm.spawnOrchestrator({
      projectId: "my-app",
      systemPrompt: "You are orchestrator.",
    });

    expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "app-orchestrator",
        systemPromptFile: expect.stringContaining("orchestrator-prompt.md"),
      }),
    );

    const callArgs = vi.mocked(ctx.mockAgent.getLaunchCommand).mock.calls[0][0];
    const promptFile = callArgs.systemPromptFile!;
    expect(existsSync(promptFile)).toBe(true);
    const { readFileSync: readFileSyncDynamic } = await import("node:fs");
    expect(readFileSyncDynamic(promptFile, "utf-8")).toBe("You are orchestrator.");
  });

  it("throws for unknown project", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    await expect(sm.spawnOrchestrator({ projectId: "nonexistent" })).rejects.toThrow(
      "Unknown project",
    );
  });

  it("throws when runtime plugin is missing", async () => {
    const emptyRegistry = {
      ...ctx.mockRegistry,
      get: vi.fn().mockReturnValue(null),
    };

    const sm = createSessionManager({ config: ctx.config, registry: emptyRegistry });

    await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow("not found");
  });

  it("returns session with runtimeHandle", async () => {
    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.runtimeHandle).toEqual(makeHandle("rt-1"));
  });

  it("reuses existing orchestrator on reservation conflict when strategy is reuse", async () => {
    const opencodeAgent: Agent = {
      ...ctx.mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode = createRegistryWithPlugins(ctx, {
      agent: opencodeAgent,
    });

    const configWithReuse: OrchestratorConfig = {
      ...ctx.config,
      defaults: { ...ctx.config.defaults, agent: "opencode" },
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
          orchestratorSessionStrategy: "reuse",
        },
      },
    };

    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: join(ctx.tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-concurrent")),
      opencodeSessionId: "ses_concurrent",
      createdAt: new Date().toISOString(),
    });

    vi.mocked(ctx.mockRuntime.isAlive).mockResolvedValue(true);

    const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.metadata["orchestratorSessionReused"]).toBe("true");
    expect(ctx.mockRuntime.create).not.toHaveBeenCalled();
  });

  it("recovers reservation conflict when existing session is not usable", async () => {
    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: join(ctx.tmpDir, "my-app"),
      branch: "main",
      status: "killed",
      role: "orchestrator",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-dead")),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(ctx.mockRuntime.isAlive).mockResolvedValue(false);

    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });
    await expect(sm.spawnOrchestrator({ projectId: "my-app" })).resolves.toBeDefined();
    expect(ctx.mockRuntime.create).toHaveBeenCalledTimes(1);
  });

  it("creates only one runtime on reservation conflict", async () => {
    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: join(ctx.tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(ctx.mockRuntime.isAlive).mockResolvedValue(false);

    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });
    await expect(sm.spawnOrchestrator({ projectId: "my-app" })).resolves.toBeDefined();
    expect(ctx.mockRuntime.create).toHaveBeenCalledTimes(1);
  });

  it("does not delete an in-progress reservation file without runtime metadata", async () => {
    const { reserveSessionId: reserveSessionIdFn } = await import("../../metadata.js");
    expect(reserveSessionIdFn(ctx.sessionsDir, "app-orchestrator")).toBe(true);

    const sm = createSessionManager({ config: ctx.config, registry: ctx.mockRegistry });

    await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow(
      "already exists but is not in a reusable state",
    );
    expect(ctx.mockRuntime.create).not.toHaveBeenCalled();
    expect(readMetadataRaw(ctx.sessionsDir, "app-orchestrator")).toEqual({});
  });
});
