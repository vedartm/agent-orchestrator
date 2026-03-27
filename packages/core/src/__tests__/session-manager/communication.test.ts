import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createTestContext,
  cleanupTestContext,
  makeHandle,
  createRegistryWithPlugins,
  createSessionManager as createSessionManagerImport,
  writeMetadata,
  readMetadataRaw,
  updateMetadata,
} from "./fixtures.js";

import {
  installMockOpencode,
  installMockOpencodeSequence,
} from "./opencode-helpers.js";

describe("send", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  it("sends message via runtime.sendMessage and confirms delivery", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });
    vi.mocked(ctx.mockRuntime.getOutput).mockResolvedValueOnce("before").mockResolvedValueOnce("after");

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.send("app-1", "Fix CI failures");

    expect(ctx.mockRuntime.sendMessage).toHaveBeenCalledWith(makeHandle("rt-1"), "Fix CI failures");
  });

  it("blocks send to worker sessions while project is globally paused", async () => {
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

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });

    await expect(sm.send("app-1", "Fix CI failures")).rejects.toThrow(
      "Project is paused due to model rate limit until",
    );
    expect(ctx.mockRuntime.sendMessage).not.toHaveBeenCalled();
  });

  it("restores a dead session before sending the message", async () => {
    const wsPath = join(ctx.tmpDir, "ws-app-1");
    mkdirSync(wsPath, { recursive: true });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: wsPath,
      branch: "feat/TEST-1",
      status: "working",
      project: "my-app",
      issue: "TEST-1",
      runtimeHandle: JSON.stringify(makeHandle("rt-old")),
    });

    vi.mocked(ctx.mockRuntime.isAlive).mockImplementation(async (handle) => handle.id !== "rt-old");
    vi.mocked(ctx.mockAgent.isProcessRunning).mockImplementation(
      async (handle) => handle.id !== "rt-old",
    );
    vi.mocked(ctx.mockRuntime.create).mockResolvedValue(makeHandle("rt-restored"));
    vi.mocked(ctx.mockRuntime.getOutput)
      .mockResolvedValueOnce("restored prompt")
      .mockResolvedValueOnce("before send")
      .mockResolvedValueOnce("after send");

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.send("app-1", "Please fix the review comments");

    expect(ctx.mockRuntime.create).toHaveBeenCalled();
    expect(ctx.mockRuntime.sendMessage).toHaveBeenCalledWith(
      makeHandle("rt-restored"),
      "Please fix the review comments",
    );
  });

  it("waits for spawning sessions to become interactive before considering restore", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "spawning",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    let isProcessCallCount = 0;
    vi.mocked(ctx.mockRuntime.isAlive).mockResolvedValue(true);
    vi.mocked(ctx.mockAgent.isProcessRunning).mockImplementation(async () => {
      isProcessCallCount++;
      return isProcessCallCount > 2; // First 2 calls return false, rest return true
    });
    vi.mocked(ctx.mockRuntime.getOutput)
      .mockResolvedValueOnce("Bootstrapping OpenCode...")
      .mockResolvedValueOnce("OpenCode ready")
      .mockResolvedValueOnce("OpenCode ready")
      .mockResolvedValueOnce("OpenCode ready")
      .mockResolvedValueOnce("processed message");

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.send("app-1", "wait until interactive");

    expect(ctx.mockRuntime.create).not.toHaveBeenCalled();
    expect(ctx.mockRuntime.sendMessage).toHaveBeenCalledWith(
      makeHandle("rt-1"),
      "wait until interactive",
    );
  });

  it("resolves when delivery cannot be confirmed (message already sent)", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });
    vi.mocked(ctx.mockRuntime.getOutput).mockResolvedValue("steady output");
    vi.mocked(ctx.mockAgent.detectActivity).mockReturnValue("idle");

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    // Should resolve without throwing — message was already sent via
    // sendMessage, so unconfirmed delivery is treated as a soft success
    // to avoid duplicate dispatches on next poll cycle.
    await expect(sm.send("app-1", "Fix CI failures")).resolves.toBeUndefined();
    expect(ctx.mockRuntime.sendMessage).toHaveBeenCalled();
  });

  it("throws for nonexistent session", async () => {
    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await expect(sm.send("nope", "hello")).rejects.toThrow("not found");
  });

  it("falls back to session ID as runtime handle when no runtimeHandle stored", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
    });
    vi.mocked(ctx.mockRuntime.getOutput).mockResolvedValueOnce("before").mockResolvedValueOnce("after");

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.send("app-1", "hello");

    expect(ctx.mockRuntime.sendMessage).toHaveBeenCalledWith(
      { id: "app-1", runtimeName: "mock", data: {} },
      "hello",
    );
  });

  it("auto-discovers OpenCode mapping before sending when missing", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-send-remap.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        {
          id: "ses_send_discovered",
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
    await sm.send("app-1", "hello");

    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_send_discovered");
    expect(ctx.mockRuntime.sendMessage).toHaveBeenCalledWith(makeHandle("rt-1"), "hello");
  });

  it("re-discovers OpenCode mapping before sending when stored mapping is invalid", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-send-remap-invalid.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        {
          id: "ses_send_discovered_valid",
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
      opencodeSessionId: "ses bad id",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    await sm.send("app-1", "hello");

    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_send_discovered_valid");
    expect(ctx.mockRuntime.sendMessage).toHaveBeenCalledWith(makeHandle("rt-1"), "hello");
  });

  it("confirms OpenCode delivery from session updated timestamps", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-send-confirmation.log");
    const listLogPath = join(ctx.tmpDir, "opencode-send-confirmation-list.log");
    const mockBin = installMockOpencodeSequence(
      ctx.tmpDir,
      [
        JSON.stringify([
          {
            id: "ses_send_confirmed",
            title: "AO:app-1",
            updated: "2026-01-01T00:00:00.000Z",
          },
        ]),
        JSON.stringify([
          {
            id: "ses_send_confirmed",
            title: "AO:app-1",
            updated: "2026-01-01T00:00:05.000Z",
          },
        ]),
      ],
      deleteLogPath,
      listLogPath,
    );
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_send_confirmed",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    vi.mocked(ctx.mockRuntime.getOutput).mockResolvedValue("steady output");
    vi.mocked(ctx.mockAgent.detectActivity).mockReturnValue("idle");

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const startedAt = Date.now();
    await sm.send("app-1", "confirm via updated timestamp");
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(readFileSync(listLogPath, "utf-8").trim().split("\n").length).toBeGreaterThanOrEqual(2);
    expect(ctx.mockRuntime.sendMessage).toHaveBeenCalledWith(
      makeHandle("rt-1"),
      "confirm via updated timestamp",
    );
  });

  it("does not confirm OpenCode delivery from timestamp visibility alone", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-send-no-false-positive.log");
    const listLogPath = join(ctx.tmpDir, "opencode-send-no-false-positive-list.log");
    const mockBin = installMockOpencodeSequence(
      ctx.tmpDir,
      [
        "[]",
        JSON.stringify([
          {
            id: "ses_send_visibility_only",
            title: "AO:app-1",
            updated: "2026-01-01T00:00:00.000Z",
          },
        ]),
      ],
      deleteLogPath,
      listLogPath,
    );
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_send_visibility_only",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    vi.mocked(ctx.mockRuntime.getOutput).mockResolvedValue("steady output");
    vi.mocked(ctx.mockAgent.detectActivity).mockReturnValue("idle");

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const startedAt = Date.now();
    await sm.send("app-1", "do not confirm on visibility");
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(2_000);
    expect(readFileSync(listLogPath, "utf-8").trim().split("\n").length).toBeGreaterThanOrEqual(2);
    expect(ctx.mockRuntime.sendMessage).toHaveBeenCalledWith(
      makeHandle("rt-1"),
      "do not confirm on visibility",
    );
  });
});

describe("remap", () => {
  let ctx: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  it("returns persisted OpenCode session id", async () => {
    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
      opencodeSessionId: "ses_remap",
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const mapped = await sm.remap("app-1");

    expect(mapped).toBe("ses_remap");
    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_remap");
  });

  it("refreshes mapping when force remap is requested", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-force-remap.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        {
          id: "ses_fresh",
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
      opencodeSessionId: "ses_stale",
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const mapped = await sm.remap("app-1", true);

    expect(mapped).toBe("ses_fresh");
    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_fresh");
  });

  it("uses a longer discovery timeout for explicit remap operations", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-slow-remap.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        {
          id: "ses_slow_discovery",
          title: "AO:app-1",
        },
      ]),
      deleteLogPath,
      3,
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
    const mapped = await sm.remap("app-1", true);

    expect(mapped).toBe("ses_slow_discovery");
    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_slow_discovery");
  });

  it("throws when OpenCode session id mapping is missing", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-missing-remap.log");
    const mockBin = installMockOpencode(ctx.tmpDir, "[]", deleteLogPath);
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
    await expect(sm.remap("app-1")).rejects.toThrow("mapping is missing");
  });

  it("discovers mapping by AO session title and persists it", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-remap.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        {
          id: "ses_discovered",
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
    const mapped = await sm.remap("app-1");

    expect(mapped).toBe("ses_discovered");
    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_discovered");
  });

  it("falls back to title discovery when persisted mapping is invalid", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-remap-invalid.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        {
          id: "ses_discovered_valid",
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
      opencodeSessionId: "ses bad id",
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const mapped = await sm.remap("app-1");

    expect(mapped).toBe("ses_discovered_valid");
    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_discovered_valid");
  });

  it("uses project agent fallback when metadata does not persist agent name", async () => {
    const deleteLogPath = join(ctx.tmpDir, "opencode-delete-remap-project-agent.log");
    const mockBin = installMockOpencode(
      ctx.tmpDir,
      JSON.stringify([
        {
          id: "ses_project_agent",
          title: "AO:app-1",
        },
      ]),
      deleteLogPath,
    );
    process.env.PATH = `${mockBin}:${ctx.originalPath ?? ""}`;

    const configWithOpenCode = {
      ...ctx.config,
      projects: {
        ...ctx.config.projects,
        "my-app": {
          ...ctx.config.projects["my-app"],
          agent: "opencode",
        },
      },
    };

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: configWithOpenCode, registry: ctx.mockRegistry });
    const mapped = await sm.remap("app-1");

    expect(mapped).toBe("ses_project_agent");
    const meta = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(meta?.["opencodeSessionId"]).toBe("ses_project_agent");
  });
});
