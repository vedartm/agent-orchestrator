import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as aoCore from "@composio/ao-core";
import type { OrchestratorConfig } from "@composio/ao-core";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  openSync: vi.fn(),
  closeSync: vi.fn(),
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    getProjectBaseDir: vi.fn(() => "/mock/project"),
    killProcessTree: vi.fn(() => Promise.resolve()),
  };
});

const config: OrchestratorConfig = {
  configPath: "/mock/config.yaml",
  projects: { "my-project": { path: "." } },
} as unknown as OrchestratorConfig;

describe("stopLifecycleWorker", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(aoCore.getProjectBaseDir).mockReturnValue("/mock/project");
    vi.mocked(aoCore.killProcessTree).mockResolvedValue(undefined);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("12345\n");
  });

  it("returns false and skips kill when PID is stale (process died between checks)", async () => {
    // First call: getLifecycleWorkerStatus sees a live process
    // Second call: our explicit check sees it's already dead (race)
    let callCount = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      callCount++;
      if (callCount === 1) return true;
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });

    const { stopLifecycleWorker } = await import("../src/lib/lifecycle-service.js");
    const result = await stopLifecycleWorker(config, "my-project");

    expect(result).toBe(false);
    expect(aoCore.killProcessTree).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("sends SIGTERM and returns true when process exits within timeout", async () => {
    // Calls: 1=getLifecycleWorkerStatus, 2=explicit check, 3+=polling loop
    let callCount = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      callCount++;
      if (callCount <= 2) return true; // alive
      throw Object.assign(new Error("no such process"), { code: "ESRCH" }); // dead after SIGTERM
    });

    const { stopLifecycleWorker } = await import("../src/lib/lifecycle-service.js");
    const result = await stopLifecycleWorker(config, "my-project");

    expect(result).toBe(true);
    expect(aoCore.killProcessTree).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(aoCore.killProcessTree).not.toHaveBeenCalledWith(12345, "SIGKILL");
    killSpy.mockRestore();
  });

  it("sends SIGKILL when process does not exit within timeout", async () => {
    vi.useFakeTimers();

    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true); // process never dies

    const { stopLifecycleWorker } = await import("../src/lib/lifecycle-service.js");
    const promise = stopLifecycleWorker(config, "my-project");

    // Advance past the 5s timeout
    await vi.advanceTimersByTimeAsync(6000);
    const result = await promise;

    expect(result).toBe(true);
    expect(aoCore.killProcessTree).toHaveBeenCalledWith(12345, "SIGKILL");

    vi.useRealTimers();
    killSpy.mockRestore();
  });
});
