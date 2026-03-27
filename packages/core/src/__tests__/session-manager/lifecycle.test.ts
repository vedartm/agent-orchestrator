import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getWorktreesDir, getSessionsDir } from "../../paths.js";
import type { OrchestratorConfig, PluginRegistry, Runtime, Agent, Workspace, SCM } from "../../types.js";

import {
  createTestContext,
  cleanupTestContext,
  makeHandle,
  createRegistryWithPlugins,
  createSessionManager,
  writeMetadata,
  readMetadata,
  readMetadataRaw,
  deleteMetadata,
  createSessionManager as createSessionManagerImport,
} from "./fixtures.js";

import {
  installMockOpencode,
  installMockOpencodeWithNotFoundDelete,
} from "./opencode-helpers.js";

import { makeMockSCM } from "./fixtures.js";

describe("kill", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  it("destroys runtime, workspace, and archives metadata", async () => {
    const managedWorktree = join(
      getWorktreesDir(ctx.config.configPath, ctx.config.projects["my-app"]!.path),
      "app-1",
    );
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: managedWorktree,
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.kill("app-1");

    expect(ctx.mockRuntime.destroy).toHaveBeenCalledWith(makeHandle("rt-1"));
    expect(ctx.mockWorkspace.destroy).toHaveBeenCalledWith(managedWorktree);
    expect(readMetadata(ctx.sessionsDir, "app-1")).toBeNull(); // archived + deleted
  });

  it("does not destroy workspace paths outside managed roots", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.kill("app-1");

    expect(ctx.mockWorkspace.destroy).not.toHaveBeenCalled();
  });

  it("destroys workspace under legacy ~/.worktrees root", async () => {
    const legacyWorktree = join(homedir(), ".worktrees", "my-app", "app-1");
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: legacyWorktree,
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.kill("app-1");

    expect(ctx.mockWorkspace.destroy).toHaveBeenCalledWith(legacyWorktree);
  });

  it("never destroys workspace equal to project path", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: ctx.config.projects["my-app"]!.path,
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.kill("app-1");

    expect(ctx.mockWorkspace.destroy).not.toHaveBeenCalled();
  });

  it("does not destroy workspace when worktree resolves to project path", async () => {
    const projectPath = ctx.config.projects["my-app"]?.path;
    if (!projectPath) throw new Error("missing project path");

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: `${projectPath}/`,
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.kill("app-1");

    expect(ctx.mockWorkspace.destroy).not.toHaveBeenCalled();
  });

  it("throws for nonexistent session", async () => {
    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await expect(sm.kill("nonexistent")).rejects.toThrow("not found");
  });

  it("tolerates runtime destroy failure", async () => {
    const failRuntime = {
      ...ctx.mockRuntime,
      destroy: vi.fn().mockRejectedValue(new Error("already gone")),
    };
    const registryWithFail = createRegistryWithPlugins(ctx, {
      runtime: failRuntime,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithFail });
    await expect(sm.kill("app-1")).resolves.toBeUndefined();
    expect(failRuntime.destroy).toHaveBeenCalled();
  });

  it("does not purge mapped OpenCode session on default kill", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-kill-default.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_keep",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.kill("app-1");

    expect(existsSync(deleteLogPath)).toBe(false);
  });

  it("purges mapped OpenCode session when requested", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-kill-purge.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_purge",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.kill("app-1", { purgeOpenCode: true });

    const deleteLog = readFileSync(deleteLogPath, "utf-8");
    expect(deleteLog).toContain("session delete ses_purge");
  });

  it("skips purge when mapped OpenCode session id is invalid", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-kill-invalid.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses bad id",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.kill("app-1", { purgeOpenCode: true });

    expect(existsSync(deleteLogPath)).toBe(false);
  });
});

describe("cleanup", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  it("kills sessions with merged PRs", async () => {
    const mockSCM = makeMockSCM({
      getPRState: vi.fn().mockResolvedValue("merged"),
    });

    const registryWithSCM = createRegistryWithPlugins(ctx, {
      scm: mockSCM,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/repo/pull/10",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSCM });
    const result = await sm.cleanup();

    expect(result.killed).toContain("app-1");
    expect(result.skipped).toHaveLength(0);
  });

  it("deletes mapped OpenCode session during cleanup", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    const mockSCM = makeMockSCM({
      getPRState: vi.fn().mockResolvedValue("merged"),
    });

    const registryWithSCM = createRegistryWithPlugins(ctx, {
      scm: mockSCM,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_cleanup",
      pr: "https://github.com/org/repo/pull/10",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSCM });
    const result = await sm.cleanup();

    expect(result.killed).toContain("app-1");
    const deleteLog = readFileSync(deleteLogPath, "utf-8");
    expect(deleteLog).toContain("session delete ses_cleanup");
  });

  it("treats missing mapped OpenCode session as already cleaned", async () => {
    const mockBin = installMockOpencodeWithNotFoundDelete(ctx.tmpDir, "[]");
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    const mockSCM = makeMockSCM({
      getPRState: vi.fn().mockResolvedValue("merged"),
    });

    const registryWithSCM = createRegistryWithPlugins(ctx, {
      scm: mockSCM,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "pr_open",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_missing",
      pr: "https://github.com/org/repo/pull/10",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSCM });
    const result = await sm.cleanup();

    expect(result.killed).toContain("app-1");
    expect(result.errors).toEqual([]);
  });

  it("deletes mapped OpenCode session from archived killed sessions", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-archived.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    writeMetadata(ctx.sessionsDir, "app-6", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_archived",
      runtimeHandle: JSON.stringify(makeHandle("rt-6")),
    });
    deleteMetadata(ctx.sessionsDir, "app-6", true);

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const result = await sm.cleanup();

    expect(result.killed).toContain("app-6");
    const deleteLog = readFileSync(deleteLogPath, "utf-8");
    expect(deleteLog).toContain("session delete ses_archived");
  });

  it("does not skip archived cleanup for matching session IDs in other projects", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-archived-cross-project.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    const project2Path = join(ctx.tmpDir, "my-app-2");
    const configWithSecondProject: OrchestratorConfig = {
      ...ctx.config,
      projects: {
        ...ctx.config.projects,
        "my-app-2": {
          name: "My App 2",
          repo: "org/my-app-2",
          path: project2Path,
          defaultBranch: "main",
          sessionPrefix: "app",
          scm: { plugin: "github" },
          tracker: { plugin: "github" },
        },
      },
    };
    const sessionsDir2 = getSessionsDir(ctx.configPath, project2Path);
    mkdirSync(sessionsDir2, { recursive: true });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/project-1",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    writeMetadata(sessionsDir2, "app-1", {
      worktree: "/tmp/project-2",
      branch: "main",
      status: "killed",
      project: "my-app-2",
      agent: "opencode",
      opencodeSessionId: "ses_archived_project2",
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });
    deleteMetadata(sessionsDir2, "app-1", true);

    const sm = createSessionManager({ config: configWithSecondProject, registry: ctx.mockRegistry });
    const result = await sm.cleanup();

    const deleteLog = readFileSync(deleteLogPath, "utf-8");
    expect(deleteLog).toContain("session delete ses_archived_project2");
    expect(result.killed).toContain("my-app-2:app-1");
    expect(result.skipped).toContain("my-app:app-1");
  });

  it("skips invalid archived OpenCode session ids during cleanup", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-archived-invalid.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    writeMetadata(ctx.sessionsDir, "app-8", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses bad id",
      runtimeHandle: JSON.stringify(makeHandle("rt-8")),
    });
    deleteMetadata(ctx.sessionsDir, "app-8", true);

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const result = await sm.cleanup();

    expect(result.killed).not.toContain("app-8");
    expect(result.errors).toEqual([]);
    expect(result.skipped).toContain("app-8");
    expect(existsSync(deleteLogPath)).toBe(false);
  });

  it("does not delete archived OpenCode sessions in cleanup dry-run", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-archived-dry-run.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    writeMetadata(ctx.sessionsDir, "app-7", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_archived_dry_run",
      runtimeHandle: JSON.stringify(makeHandle("rt-7")),
    });
    deleteMetadata(ctx.sessionsDir, "app-7", true);

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const result = await sm.cleanup(undefined, { dryRun: true });

    expect(result.killed).toContain("app-7");
    expect(existsSync(deleteLogPath)).toBe(false);
  });

  it("skips sessions without merged PRs or completed issues", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const result = await sm.cleanup();

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toContain("app-1");
  });

  it("skips orchestrator sessions by role metadata", async () => {
    const deadRuntime = {
      ...ctx.mockRuntime,
      isAlive: vi.fn().mockResolvedValue(false),
    };
    const registryWithDead = createRegistryWithPlugins(ctx, {
      runtime: deadRuntime,
    });

    writeMetadata(ctx.sessionsDir, "app-99", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-orch")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithDead });
    const result = await sm.cleanup();

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toContain("app-99");
  });

  it("skips orchestrator sessions by name fallback (no role metadata)", async () => {
    const deadRuntime = {
      ...ctx.mockRuntime,
      isAlive: vi.fn().mockResolvedValue(false),
    };
    const registryWithDead = createRegistryWithPlugins(ctx, {
      runtime: deadRuntime,
    });

    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: ctx.config.projects["my-app"]!.path,
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-orch")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithDead });
    const result = await sm.cleanup();

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toContain("app-orchestrator");
  });

  it("never cleans canonical orchestrator session even with stale worker-like metadata", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-orchestrator.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    const deadRuntime = {
      ...ctx.mockRuntime,
      isAlive: vi.fn().mockResolvedValue(false),
    };
    const mockSCM = makeMockSCM({
      getPRState: vi.fn().mockResolvedValue("merged"),
    });
    const mockTracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "INT-42",
        title: "Issue",
        description: "",
        url: "https://example.com/INT-42",
        state: "closed",
        labels: [],
      }),
      isCompleted: vi.fn().mockResolvedValue(true),
      issueUrl: vi.fn().mockReturnValue("https://example.com/INT-42"),
      branchName: vi.fn().mockReturnValue("feat/INT-42"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithSignals = createRegistryWithPlugins(ctx, {
      runtime: deadRuntime,
      scm: mockSCM,
      tracker: mockTracker,
    });

    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: ctx.config.projects["my-app"]!.path,
      branch: "main",
      status: "ci_failed",
      project: "my-app",
      issue: "INT-42",
      pr: "https://github.com/org/repo/pull/88",
      agent: "opencode",
      opencodeSessionId: "ses_orchestrator_active",
      runtimeHandle: JSON.stringify(makeHandle("rt-orchestrator")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSignals });
    const result = await sm.cleanup();

    expect(result.killed).not.toContain("app-orchestrator");
    expect(result.skipped).toContain("app-orchestrator");
    expect(existsSync(deleteLogPath)).toBe(false);
  });

  it("never cleans archived orchestrator mappings even when metadata looks stale", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-archived-orchestrator.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: ctx.config.projects["my-app"]!.path,
      branch: "main",
      status: "killed",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_orchestrator_archived",
      pr: "https://github.com/org/repo/pull/88",
      runtimeHandle: JSON.stringify(makeHandle("rt-orchestrator")),
    });
    deleteMetadata(ctx.sessionsDir, "app-orchestrator", true);

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const result = await sm.cleanup();

    expect(result.killed).not.toContain("app-orchestrator");
    expect(result.skipped).toContain("app-orchestrator");
    expect(existsSync(deleteLogPath)).toBe(false);
  });

  it("kills sessions with dead runtimes", async () => {
    const deadRuntime = {
      ...ctx.mockRuntime,
      isAlive: vi.fn().mockResolvedValue(false),
    };
    const registryWithDead = createRegistryWithPlugins(ctx, {
      runtime: deadRuntime,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithDead });
    const result = await sm.cleanup();

    expect(result.killed).toContain("app-1");
  });
});
