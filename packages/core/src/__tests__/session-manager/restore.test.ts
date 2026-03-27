import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  createTestContext,
  cleanupTestContext,
  makeHandle,
  createRegistryWithPlugins,
  createSessionManager as createSessionManagerImport,
  writeMetadata,
  readMetadataRaw,
  deleteMetadata,
} from "./fixtures.js";

import {
  installMockOpencode,
} from "./opencode-helpers.js";

import type { OrchestratorConfig, Agent, Workspace } from "../../types.js";

import {
  SessionNotRestorableError,
  WorkspaceMissingError,
} from "../../types.js";

describe("restore", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  it("restores a killed session with existing workspace", async () => {
    // Create a workspace directory that exists
    const wsPath = join(ctx.tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      issue: "TEST-1",
      pr: "https://github.com/org/my-app/pull/10",
      createdAt: "2025-01-01T00:00:00.000Z",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const restored = await sm.restore("app-1");

    expect(restored.id).toBe("app-1");
    expect(restored.status).toBe("spawning");
    expect(restored.activity).toBe("active");
    expect(restored.workspacePath).toBe(wsPath);
    expect(restored.branch).toBe("feat/TEST-1");
    expect(restored.runtimeHandle).toEqual(makeHandle("rt-1"));
    expect(restored.restoredAt).toBeInstanceOf(Date);

    // Verify old runtime was destroyed before creating new one
    expect(ctx.mockRuntime.destroy).toHaveBeenCalledWith(makeHandle("rt-old"));
    expect(ctx.mockRuntime.create).toHaveBeenCalled();
    // Verify metadata was updated (not rewritten)
    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta!["status"]).toBe("spawning");
    expect(meta!["restoredAt"]).toBeDefined();
    // Verify original fields are preserved
    expect(meta!["issue"]).toBe("TEST-1");
    expect(meta!["pr"]).toBe("https://github.com/org/my-app/pull/10");
    expect(meta!["createdAt"]).toBe("2025-01-01T00:00:00.000Z");
  });

  it("continues restore even if old runtime destroy fails", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    // Make destroy throw — should not block restore
    const failingRuntime = {
      ...ctx.mockRuntime,
      destroy: vi.fn().mockRejectedValue(new Error("session not found")),
      create: vi.fn().mockResolvedValue(makeHandle("rt-new")),
    };

    const registryWithFailingDestroy = createRegistryWithPlugins(ctx, {
      runtime: failingRuntime,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithFailingDestroy });
    const restored = await sm.restore("app-1");

    expect(restored.status).toBe("spawning");
    expect(failingRuntime.destroy).toHaveBeenCalled();
    expect(failingRuntime.create).toHaveBeenCalled();
  });

  it("recreates workspace when missing and plugin supports restore", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-1");
    // DO NOT create directory — it's missing

    const mockWorkspaceWithRestore: Workspace = {
      ...ctx.mockWorkspace,
      exists: vi.fn().mockResolvedValue(false),
      restore: vi.fn().mockResolvedValue({
        path: wsPath,
        branch: "feat/TEST-1",
        sessionId: "app-1",
        projectId: "my-app",
      }),
    };

    const registryWithRestore = createRegistryWithPlugins(ctx, {
      workspace: mockWorkspaceWithRestore,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "terminated",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithRestore });
    const restored = await sm.restore("app-1");

    expect(restored.id).toBe("app-1");
    expect(mockWorkspaceWithRestore.restore).toHaveBeenCalled();
    expect(ctx.mockRuntime.create).toHaveBeenCalled();
  });

  it("throws SessionNotRestorableError for merged sessions", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "merged",
      project: "my-app",
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await expect(sm.restore("app-1")).rejects.toThrow(SessionNotRestorableError);
  });

  it("throws SessionNotRestorableError for working sessions", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await expect(sm.restore("app-1")).rejects.toThrow(SessionNotRestorableError);
  });

  it("throws WorkspaceMissingError when workspace gone and no restore method", async () => {
    const wsPath = join(ctx.tmpDir, "nonexistent-ws");

    const mockWorkspaceNoRestore: Workspace = {
      ...ctx.mockWorkspace,
      exists: vi.fn().mockResolvedValue(false),
      // No restore method
    };

    const registryNoRestore = createRegistryWithPlugins(ctx, {
      workspace: mockWorkspaceNoRestore,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryNoRestore });
    await expect(sm.restore("app-1")).rejects.toThrow(WorkspaceMissingError);
  });

  it("restores a session from archive when active metadata is deleted", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    // Create metadata, then delete it (which archives it)
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      issue: "TEST-1",
      pr: "https://github.com/org/my-app/pull/10",
      createdAt: "2025-01-01T00:00:00.000Z",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    // Archive it (deleteMetadata with archive=true is default)
    deleteMetadata(ctx.sessionsDir, "app-1");

    // Verify active metadata is gone
    expect(readMetadataRaw(ctx.sessionsDir, "app-1")).toBeNull();

    // Restore should find it in archive
    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const restored = await sm.restore("app-1");

    expect(restored.id).toBe("app-1");
    expect(restored.status).toBe("spawning");
    expect(restored.branch).toBe("feat/TEST-1");
    expect(restored.workspacePath).toBe(wsPath);

    // Verify active metadata was recreated
    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta).not.toBeNull();
    expect(meta!["issue"]).toBe("TEST-1");
    expect(meta!["pr"]).toBe("https://github.com/org/my-app/pull/10");
  });

  it("restores from archive with multiple archived versions (picks latest)", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    // Manually create two archive entries with different timestamps
    const archiveDir = join(ctx.sessionsDir, "archive");
    mkdirSync(archiveDir, { recursive: true });

    // Older archive — has stale branch
    writeFileSync(
      join(archiveDir, "app-1_2025-01-01T00-00-00-000Z"),
      "worktree=" + wsPath + "\nbranch=old-branch\nstatus=killed\nproject=my-app\n",
    );

    // Newer archive — has correct branch
    writeFileSync(
      join(archiveDir, "app-1_2025-06-15T12-00-00-000Z"),
      "worktree=" +
        wsPath +
        "\nbranch=feat/latest\nstatus=killed\nproject=my-app\n" +
        "runtimeHandle=" +
        JSON.stringify(makeHandle("rt-old")) +
        "\n",
    );

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const restored = await sm.restore("app-1");

    expect(restored.branch).toBe("feat/latest");
  });

  it("throws for nonexistent session (not in active or archive)", async () => {
    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await expect(sm.restore("nonexistent")).rejects.toThrow("not found");
  });

  it("does not recreate active metadata when archive restore fails validation", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });
    const deleteLogPath = join(ctx.tmpDir, "opencode-restore-validation.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });
    deleteMetadata(ctx.sessionsDir, "app-1");

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await expect(sm.restore("app-1")).rejects.toThrow(SessionNotRestorableError);

    expect(readMetadataRaw(ctx.sessionsDir, "app-1")).toBeNull();
  });

  it("does not recreate active metadata from archive when session is not restorable", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-archive-non-restorable");
    mkdirSync(wsPath, { recursive: true });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_archive_valid",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });
    deleteMetadata(ctx.sessionsDir, "app-1", true);

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await expect(sm.restore("app-1")).rejects.toThrow(SessionNotRestorableError);

    expect(readMetadataRaw(ctx.sessionsDir, "app-1")).toBeNull();
  });

  it("re-discovers OpenCode mapping when stored mapping is invalid", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-restore-invalid-map");
    mkdirSync(wsPath, { recursive: true });
    const deleteLogPath = join(ctx.tmpDir, "opencode-restore-invalid-remap.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        {
          id: "ses_restore_discovered",
          title: "AO:app-1",
        },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses bad id",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const restored = await sm.restore("app-1");

    expect(restored.status).toBe("spawning");
    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_restore_discovered");
  });

  it("uses orchestratorModel when restoring orchestrator sessions", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-orchestrator-restore");
    mkdirSync(wsPath, { recursive: true });

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

    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: wsPath,
      branch: "main",
      status: "killed",
      project: "my-app",
      role: "orchestrator",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManagerImport({ config: configWithOrchestratorModel, registry: ctx.mockRegistry });
    await sm.restore("app-orchestrator");

    expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ model: "orchestrator-model" }),
    );
  });

  it("forwards configured subagent when restoring sessions", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-restore-subagent");
    mkdirSync(wsPath, { recursive: true });

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

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-SUBAGENT",
      status: "killed",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManagerImport({ config: configWithSubagent, registry: ctx.mockRegistry });
    await sm.restore("app-1");

    expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ subagent: "oracle" }),
    );
  });

  it("uses getRestoreCommand when available", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    const mockAgentWithRestore: Agent = {
      ...ctx.mockAgent,
      getRestoreCommand: vi.fn().mockResolvedValue("claude --resume abc123"),
    };

    const registryWithAgentRestore = createRegistryWithPlugins(ctx, {
      agent: mockAgentWithRestore,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "errored",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithAgentRestore });
    await sm.restore("app-1");

    expect(mockAgentWithRestore.getRestoreCommand).toHaveBeenCalled();
    // Verify runtime.create was called with restore command
    const createCall = (ctx.mockRuntime.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.launchCommand).toBe("claude --resume abc123");
  });

  it("falls back to getLaunchCommand when getRestoreCommand returns null", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    const mockAgentWithNullRestore: Agent = {
      ...ctx.mockAgent,
      getRestoreCommand: vi.fn().mockResolvedValue(null),
    };

    const registryWithNullRestore = createRegistryWithPlugins(ctx, {
      agent: mockAgentWithNullRestore,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "killed",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithNullRestore });
    await sm.restore("app-1");

    expect(mockAgentWithNullRestore.getRestoreCommand).toHaveBeenCalled();
    expect(ctx.mockAgent.getLaunchCommand).toHaveBeenCalled();
    const createCall = (ctx.mockRuntime.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.launchCommand).toBe("mock-agent --start");
  });

  it("preserves original createdAt/issue/PR metadata", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    const originalCreatedAt = "2024-06-15T10:00:00.000Z";
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-42",
      status: "killed",
      project: "my-app",
      issue: "TEST-42",
      pr: "https://github.com/org/my-app/pull/99",
      summary: "Implementing feature X",
      createdAt: originalCreatedAt,
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.restore("app-1");

    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta!["createdAt"]).toBe(originalCreatedAt);
    expect(meta!["issue"]).toBe("TEST-42");
    expect(meta!["pr"]).toBe("https://github.com/org/my-app/pull/99");
    expect(meta!["summary"]).toBe("Implementing feature X");
    expect(meta!["branch"]).toBe("feat/TEST-42");
  });

  it("does not overwrite restored status/runtime metadata when postLaunchSetup is a no-op", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-post-launch-noop");
    mkdirSync(wsPath, { recursive: true });

    const agentWithNoopPostLaunch: Agent = {
      ...ctx.mockAgent,
      postLaunchSetup: vi.fn().mockResolvedValue(undefined),
    };

    const registryWithNoopPostLaunch = createRegistryWithPlugins(ctx, {
      agent: agentWithNoopPostLaunch,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-77",
      status: "killed",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithNoopPostLaunch });
    await sm.restore("app-1");

    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta!["status"]).toBe("spawning");
    expect(meta!["runtimeHandle"]).toBe(JSON.stringify(makeHandle("rt-1")));
    expect(meta!["restoredAt"]).toBeDefined();
  });

  it("persists only metadata updates produced by postLaunchSetup", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-post-launch-metadata");
    mkdirSync(wsPath, { recursive: true });

    const agentWithMetadataUpdate: Agent = {
      ...ctx.mockAgent,
      postLaunchSetup: vi.fn().mockImplementation(async (session) => {
        session.metadata = {
          ...session.metadata,
          opencodeSessionId: "ses_from_post_launch",
        };
      }),
    };

    const registryWithMetadataUpdate = createRegistryWithPlugins(ctx, {
      agent: agentWithMetadataUpdate,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-78",
      status: "killed",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithMetadataUpdate });
    await sm.restore("app-1");

    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta!["status"]).toBe("spawning");
    expect(meta!["runtimeHandle"]).toBe(JSON.stringify(makeHandle("rt-1")));
    expect(meta!["opencodeSessionId"]).toBe("ses_from_post_launch");
  });
});
