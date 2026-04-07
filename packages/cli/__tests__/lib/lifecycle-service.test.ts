import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LifecycleManager, OrchestratorConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockLifecycleStart, mockLifecycleStop, mockLifecyclePin, mockGetLifecycleManager } =
  vi.hoisted(() => {
    const mockLifecycleStart = vi.fn();
    const mockLifecycleStop = vi.fn();
    const mockLifecyclePin = vi.fn();
    const mockInstance: LifecycleManager = {
      start: mockLifecycleStart,
      stop: mockLifecycleStop,
      pin: mockLifecyclePin,
    } as unknown as LifecycleManager;
    const mockGetLifecycleManager = vi.fn().mockResolvedValue(mockInstance);
    return {
      mockLifecycleStart,
      mockLifecycleStop,
      mockLifecyclePin,
      mockGetLifecycleManager,
      mockInstance,
    };
  });

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getLifecycleManager: mockGetLifecycleManager,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const config = {
  configPath: "/home/user/project/agent-orchestrator.yaml",
  projects: {
    "my-project": {
      path: "/home/user/project",
      agent: "claude-code",
      runtime: "tmux",
      sessionPrefix: "mp",
      name: "P",
    },
  },
} as unknown as OrchestratorConfig;

/** Re-import lifecycle-service with a fresh activeManagers Map each time. */
async function freshModule() {
  vi.resetModules();
  return import("../../src/lib/lifecycle-service.js");
}

describe("lifecycle-service (in-process)", () => {
  beforeEach(() => {
    mockLifecycleStart.mockReset();
    mockLifecycleStop.mockReset();
    mockLifecyclePin.mockReset();
    mockGetLifecycleManager.mockClear();
  });

  describe("ensureLifecycleWorker", () => {
    it("creates and starts a lifecycle manager on first call", async () => {
      const { ensureLifecycleWorker } = await freshModule();

      const status = await ensureLifecycleWorker(config, "my-project");

      expect(mockGetLifecycleManager).toHaveBeenCalledWith(config, "my-project");
      expect(mockLifecycleStart).toHaveBeenCalledWith(30_000);
      expect(status.running).toBe(true);
      expect(status.started).toBe(true);
      expect(status.pid).toBe(process.pid);
    });

    it("returns running=true, started=false if already active", async () => {
      const { ensureLifecycleWorker } = await freshModule();

      // First call starts it
      await ensureLifecycleWorker(config, "my-project");
      mockGetLifecycleManager.mockClear();
      mockLifecycleStart.mockClear();

      // Second call on the same module instance should not recreate
      const status = await ensureLifecycleWorker(config, "my-project");

      expect(mockGetLifecycleManager).not.toHaveBeenCalled();
      expect(mockLifecycleStart).not.toHaveBeenCalled();
      expect(status.running).toBe(true);
      expect(status.started).toBe(false);
      expect(status.pid).toBe(process.pid);
    });

    it("manages separate managers for different project IDs", async () => {
      const { ensureLifecycleWorker } = await freshModule();

      await ensureLifecycleWorker(config, "project-a");
      await ensureLifecycleWorker(config, "project-b");

      expect(mockGetLifecycleManager).toHaveBeenCalledTimes(2);
      expect(mockGetLifecycleManager).toHaveBeenCalledWith(config, "project-a");
      expect(mockGetLifecycleManager).toHaveBeenCalledWith(config, "project-b");
    });

    it("propagates start failures to concurrent callers instead of reporting running", async () => {
      const { ensureLifecycleWorker, getLifecycleWorkerStatus } = await freshModule();
      let resolveManager: ((value: LifecycleManager) => void) | undefined;
      mockGetLifecycleManager.mockImplementationOnce(
        () =>
          new Promise<LifecycleManager>((resolve) => {
            resolveManager = resolve;
          }),
      );
      mockLifecycleStart.mockImplementation(() => {
        throw new Error("start failed");
      });

      const firstCall = ensureLifecycleWorker(config, "my-project");
      const secondCall = ensureLifecycleWorker(config, "my-project");

      resolveManager?.({
        start: mockLifecycleStart,
        stop: mockLifecycleStop,
      } as unknown as LifecycleManager);

      await expect(firstCall).rejects.toThrow("start failed");
      await expect(secondCall).rejects.toThrow("start failed");
      expect(getLifecycleWorkerStatus(config, "my-project")).toEqual({
        running: false,
        started: false,
        pid: null,
      });
    });

    it("returns started=false for a concurrent caller when creation succeeds", async () => {
      const { ensureLifecycleWorker } = await freshModule();
      let resolveManager: ((value: LifecycleManager) => void) | undefined;
      mockGetLifecycleManager.mockImplementationOnce(
        () =>
          new Promise<LifecycleManager>((resolve) => {
            resolveManager = resolve;
          }),
      );

      const firstCall = ensureLifecycleWorker(config, "my-project");
      const secondCall = ensureLifecycleWorker(config, "my-project");

      resolveManager?.({
        start: mockLifecycleStart,
        stop: mockLifecycleStop,
        pin: mockLifecyclePin,
      } as unknown as LifecycleManager);

      await expect(firstCall).resolves.toEqual({
        running: true,
        started: true,
        pid: process.pid,
      });
      await expect(secondCall).resolves.toEqual({
        running: true,
        started: false,
        pid: process.pid,
      });
      expect(mockGetLifecycleManager).toHaveBeenCalledTimes(1);
    });

    it("propagates the start error when stop also fails during cleanup", async () => {
      const { ensureLifecycleWorker } = await freshModule();
      mockLifecycleStart.mockImplementation(() => {
        throw new Error("start failed");
      });
      mockLifecycleStop.mockImplementation(() => {
        throw new Error("stop also failed");
      });

      await expect(ensureLifecycleWorker(config, "my-project")).rejects.toThrow("start failed");
    });
  });

  describe("stopLifecycleWorker", () => {
    it("stops and removes an active manager", async () => {
      const { ensureLifecycleWorker, stopLifecycleWorker, getLifecycleWorkerStatus } =
        await freshModule();

      await ensureLifecycleWorker(config, "my-project");

      const stopped = await stopLifecycleWorker(config, "my-project");

      expect(stopped).toBe(true);
      expect(mockLifecycleStop).toHaveBeenCalled();

      // Should no longer be tracked
      const status = getLifecycleWorkerStatus(config, "my-project");
      expect(status.running).toBe(false);
    });

    it("returns false if no manager is running for the project", async () => {
      const { stopLifecycleWorker } = await freshModule();

      const stopped = await stopLifecycleWorker(config, "nonexistent");
      expect(stopped).toBe(false);
    });
  });

  describe("getLifecycleWorkerStatus", () => {
    it("returns running=false for unknown project", async () => {
      const { getLifecycleWorkerStatus } = await freshModule();

      const status = getLifecycleWorkerStatus(config, "unknown");
      expect(status.running).toBe(false);
      expect(status.started).toBe(false);
      expect(status.pid).toBeNull();
    });

    it("returns running=true with pid for active project", async () => {
      const { ensureLifecycleWorker, getLifecycleWorkerStatus } = await freshModule();

      await ensureLifecycleWorker(config, "active-project");

      const status = getLifecycleWorkerStatus(config, "active-project");
      expect(status.running).toBe(true);
      expect(status.started).toBe(true);
      expect(status.pid).toBe(process.pid);
    });
  });

  describe("pinLifecycleWorker", () => {
    it("calls pin on an active lifecycle manager", async () => {
      const { ensureLifecycleWorker, pinLifecycleWorker } = await freshModule();

      await ensureLifecycleWorker(config, "my-project");
      pinLifecycleWorker("my-project");

      expect(mockLifecyclePin).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when no manager is active", async () => {
      const { pinLifecycleWorker } = await freshModule();

      expect(() => pinLifecycleWorker("nonexistent")).not.toThrow();
      expect(mockLifecyclePin).not.toHaveBeenCalled();
    });
  });
});
