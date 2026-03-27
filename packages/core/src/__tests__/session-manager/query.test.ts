import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";

import { createSessionManager } from "../../session-manager.js";
import {
  writeMetadata,
  readMetadataRaw,
} from "../../metadata.js";

import {
  createTestContext,
  cleanupTestContext,
  makeHandle,
  createRegistryWithPlugins,
  createSessionManager as createSessionManagerImport,
} from "./fixtures.js";

import {
  installMockOpencode,
} from "./opencode-helpers.js";

describe("list", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  it("lists sessions from metadata", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/w1",
      branch: "feat/a",
      status: "working",
      project: "my-app",
    });
    writeMetadata(ctx.sessionsDir, "app-2", {
      worktree: "/tmp/w2",
      branch: "feat/b",
      status: "pr_open",
      project: "my-app",
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const sessions = await sm.list();

    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id).sort()).toEqual(["app-1", "app-2"]);
  });

  it("preserves lastActivityAt when read-time repair rewrites metadata", async () => {
    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: ctx.config.projects["my-app"]!.path,
      branch: "main",
      status: "merged",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: JSON.stringify(makeHandle("rt-orch")),
    });

    const oldTime = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(join(ctx.sessionsDir, "app-orchestrator"), oldTime, oldTime);

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const sessions = await sm.list("my-app");
    const orchestrator = sessions.find((session) => session.id === "app-orchestrator");

    expect(orchestrator).toBeDefined();
    expect(orchestrator!.lastActivityAt.getTime()).toBe(oldTime.getTime());

    const repaired = readMetadataRaw(ctx.sessionsDir, "app-orchestrator");
    expect(repaired!["pr"]).toBeUndefined();
    expect(repaired!["prAutoDetect"]).toBe("off");
    expect(repaired!["status"]).toBe("working");
  });

  it("filters by project ID", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const sessions = await sm.list("my-app");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("app-1");
  });

  it("preserves owning project ID for legacy metadata missing the project field", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const sessions = await sm.list("my-app");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].projectId).toBe("my-app");
  });

  it("clears enrichment timeout when enrichment completes quickly", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const sessions = await sm.list();

    expect(sessions).toHaveLength(1);
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("marks dead runtimes as killed", async () => {
    const deadRuntime = {
      ...ctx.mockRuntime,
      isAlive: vi.fn().mockResolvedValue(false),
    };
    const registryWithDead = createRegistryWithPlugins(ctx, {
      runtime: deadRuntime,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithDead });
    const sessions = await sm.list();

    expect(sessions[0].status).toBe("killed");
    expect(sessions[0].activity).toBe("exited");
  });

  it("detects activity using agent-native mechanism", async () => {
    const agentWithState = {
      ...ctx.mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
    };
    const registryWithState = createRegistryWithPlugins(ctx, {
      agent: agentWithState,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({
      config: ctx.config,
      registry: registryWithState,
    });
    const sessions = await sm.list();

    expect(agentWithState.getActivityState).toHaveBeenCalled();
    expect(sessions[0].activity).toBe("active");
  });

  it.each(["claude-code", "codex", "aider", "opencode"])(
    "uses tmuxName fallback handle for %s activity detection when runtimeHandle is missing",
    async (agentName: string) => {
      const expectedTmuxName = "hash-app-1";
      const selectedAgent = {
        ...ctx.mockAgent,
        name: agentName,
        getActivityState: vi.fn().mockImplementation(async (session: Session) => {
          return {
            state: session.runtimeHandle?.id === expectedTmuxName ? "active" : "exited",
          };
        }),
      };
      const registryWithNamedAgents = createRegistryWithPlugins(ctx, {
        agent: selectedAgent,
      });

      writeMetadata(ctx.sessionsDir, "app-1", {
        worktree: "/tmp",
        branch: "a",
        status: "working",
        project: "my-app",
        agent: agentName,
        tmuxName: expectedTmuxName,
        ...(agentName === "opencode" ? { opencodeSessionId: "ses_existing_mapping" } : {}),
      });

      const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithNamedAgents });
      const sessions = await sm.list("my-app");

      expect(sessions).toHaveLength(1);
      expect(sessions[0].runtimeHandle?.id).toBe(expectedTmuxName);
      expect(sessions[0].activity).toBe("active");
      expect(selectedAgent.getActivityState).toHaveBeenCalled();
    },
  );

  it("uses tmuxName fallback handle for runtime liveness checks when runtimeHandle is missing", async () => {
    const expectedTmuxName = "hash-app-1";
    const deadRuntime = {
      ...ctx.mockRuntime,
      isAlive: vi.fn().mockImplementation(async (handle) => handle.id !== expectedTmuxName),
    };
    const agentWithSpy = {
      ...ctx.mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
    };
    const registryWithDeadRuntime = createRegistryWithPlugins(ctx, {
      runtime: deadRuntime,
      agent: agentWithSpy,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      tmuxName: expectedTmuxName,
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithDeadRuntime });
    const sessions = await sm.list("my-app");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].runtimeHandle?.id).toBe(expectedTmuxName);
    expect(sessions[0].status).toBe("killed");
    expect(sessions[0].activity).toBe("exited");
    expect(agentWithSpy.getActivityState).not.toHaveBeenCalled();
  });

  it("keeps existing activity when getActivityState throws", async () => {
    const agentWithError = {
      ...ctx.mockAgent,
      getActivityState: vi.fn().mockRejectedValue(new Error("detection failed")),
    };
    const registryWithError = createRegistryWithPlugins(ctx, {
      agent: agentWithError,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithError });
    const sessions = await sm.list();

    expect(sessions[0].activity).toBeNull();
  });

  it("keeps existing activity when getActivityState returns null", async () => {
    const agentWithNull = {
      ...ctx.mockAgent,
      getActivityState: vi.fn().mockResolvedValue(null),
    };
    const registryWithNull = createRegistryWithPlugins(ctx, {
      agent: agentWithNull,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithNull });
    const sessions = await sm.list();

    expect(agentWithNull.getActivityState).toHaveBeenCalled();
    expect(sessions[0].activity).toBeNull();
  });

  it("updates lastActivityAt when detection timestamp is newer", async () => {
    const newerTimestamp = new Date(Date.now() + 60_000);
    const agentWithTimestamp = {
      ...ctx.mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "active", timestamp: newerTimestamp }),
    };
    const registryWithTimestamp = createRegistryWithPlugins(ctx, {
      agent: agentWithTimestamp,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({
      config: ctx.config,
      registry: registryWithTimestamp,
    });
    const sessions = await sm.list();

    expect(sessions[0].activity).toBe("active");
    expect(sessions[0].lastActivityAt).toEqual(newerTimestamp);
  });

  it("does not downgrade lastActivityAt when detection timestamp is older", async () => {
    const olderTimestamp = new Date(0);
    const agentWithOldTimestamp = {
      ...ctx.mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "active", timestamp: olderTimestamp }),
    };
    const registryWithOldTimestamp = createRegistryWithPlugins(ctx, {
      agent: agentWithOldTimestamp,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "a",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({
      config: ctx.config,
      registry: registryWithOldTimestamp,
    });
    const sessions = await sm.list();

    expect(sessions[0].activity).toBe("active");
    expect(sessions[0].lastActivityAt.getTime()).toBeGreaterThan(olderTimestamp.getTime());
  });
});

describe("get", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  it("returns session by ID", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      pr: "https://github.com/org/repo/pull/42",
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const session = await sm.get("app-1");

    expect(session).not.toBeNull();
    expect(session!.id).toBe("app-1");
    expect(session!.pr).not.toBeNull();
    expect(session!.pr!.number).toBe(42);
    expect(session!.pr!.url).toBe("https://github.com/org/repo/pull/42");
  });

  it("detects activity using agent-native mechanism", async () => {
    const agentWithState = {
      ...ctx.mockAgent,
      getActivityState: vi.fn().mockResolvedValue({ state: "idle" }),
    };
    const registryWithState = createRegistryWithPlugins(ctx, {
      agent: agentWithState,
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({
      config: ctx.config,
      registry: registryWithState,
    });
    const session = await sm.get("app-1");

    expect(agentWithState.getActivityState).toHaveBeenCalled();
    expect(session!.activity).toBe("idle");
  });

  it("returns null for nonexistent session", async () => {
    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    expect(await sm.get("nonexistent")).toBeNull();
  });

  it("assigns owning project ID when loading legacy metadata without project", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const session = await sm.get("app-1");

    expect(session).not.toBeNull();
    expect(session?.projectId).toBe("my-app");
  });

  it("auto-discovers and persists OpenCode session mapping when missing", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-get-remap.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        {
          id: "ses_get_discovered",
          title: "AO:app-1",
        },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const session = await sm.get("app-1");

    expect(session).not.toBeNull();
    expect(session?.metadata["opencodeSessionId"]).toBe("ses_get_discovered");

    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_get_discovered");
  });

  it("reuses a single OpenCode session list lookup when multiple unmapped sessions are listed", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-list-shared.log");
    const listLogPath = join(ctx.tmpDir, "opencode-list-shared.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        { id: "ses_get_discovered_1", title: "AO:app-1" },
        { id: "ses_get_discovered_2", title: "AO:app-2" },
      ]),
      deleteLogPath,
      0,
      listLogPath,
    );
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });
    writeMetadata(ctx.sessionsDir, "app-2", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const sessions = await sm.list();

    expect(sessions).toHaveLength(2);
    expect(readMetadataRaw(ctx.sessionsDir, "app-1")?.["opencodeSessionId"]).toBe(
      "ses_get_discovered_1",
    );
    expect(readMetadataRaw(ctx.sessionsDir, "app-2")?.["opencodeSessionId"]).toBe(
      "ses_get_discovered_2",
    );

    const listInvocations = readFileSync(listLogPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(listInvocations).toHaveLength(1);
  });

  it("preserves arbitrary metadata flags on loaded sessions", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "working",
      project: "my-app",
      prAutoDetect: "off",
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const session = await sm.get("app-1");

    expect(session).not.toBeNull();
    expect(session!.metadata["prAutoDetect"]).toBe("off");
  });
});
