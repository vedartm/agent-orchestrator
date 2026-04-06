import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Strategy: the module uses homedir() at load time for STATE_DIR.
// We mock os.homedir before each test, reset modules, then dynamically import.
// ---------------------------------------------------------------------------

let stateDir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockProcessKill: any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunningState(overrides: Record<string, unknown> = {}) {
  return {
    pid: process.pid,
    configPath: "/fake/agent-orchestrator.yaml",
    port: 3000,
    startedAt: new Date().toISOString(),
    projects: [] as string[],
    ...overrides,
  };
}

function writeRunningJson(dir: string, state: unknown) {
  const stateFile = join(dir, "running.json");
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();

  stateDir = mkdtempSync(join(tmpdir(), "ao-running-state-test-"));

  // Mock os.homedir to return our temp dir so STATE_DIR points there on module load
  vi.mock("node:os", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, homedir: () => stateDir };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockProcessKill = vi.spyOn(process, "kill").mockImplementation((() => true) as any);
});

afterEach(() => {
  mockProcessKill.mockRestore();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests for addProjectToRunning
// ---------------------------------------------------------------------------

describe("addProjectToRunning", () => {
  it("adds project and process.pid to the running state", async () => {
    const dir = join(stateDir, ".agent-orchestrator");
    mkdirSync(dir, { recursive: true });
    writeRunningJson(dir, makeRunningState({ projects: ["existing-project"] }));

    const { addProjectToRunning, getRunning } = await import("../../src/lib/running-state.js");

    await addProjectToRunning("new-project");

    const state = await getRunning();
    expect(state).not.toBeNull();
    expect(state!.projects).toContain("new-project");
    expect(state!.projects).toContain("existing-project");
    expect(state!.secondaryPids).toContain(process.pid);
  });

  it("no-ops when there is no running state", async () => {
    // No running.json — state dir doesn't even exist yet
    const { addProjectToRunning } = await import("../../src/lib/running-state.js");

    await expect(addProjectToRunning("some-project")).resolves.toBeUndefined();
  });

  it("no-ops when the running process is dead", async () => {
    const deadPid = 999999;
    const dir = join(stateDir, ".agent-orchestrator");
    mkdirSync(dir, { recursive: true });
    writeRunningJson(dir, makeRunningState({ pid: deadPid, projects: ["existing"] }));

    // Make process.kill(deadPid, 0) throw ESRCH (process is dead)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockProcessKill.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0 && pid === deadPid) {
        const err = new Error("ESRCH") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as any);

    const { addProjectToRunning } = await import("../../src/lib/running-state.js");

    // Should not throw — just no-op
    await expect(addProjectToRunning("new-project")).resolves.toBeUndefined();

    // State was not updated with the new project (dead pid → no-op)
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(join(dir, "running.json"), "utf-8");
    const state = JSON.parse(raw) as Record<string, unknown>;
    expect((state["projects"] as string[])).not.toContain("new-project");
  });

  it("does not duplicate project or pid when called twice", async () => {
    const dir = join(stateDir, ".agent-orchestrator");
    mkdirSync(dir, { recursive: true });
    writeRunningJson(dir, makeRunningState({ projects: [], secondaryPids: [] }));

    const { addProjectToRunning, getRunning } = await import("../../src/lib/running-state.js");

    await addProjectToRunning("my-project");
    await addProjectToRunning("my-project");

    const state = await getRunning();
    expect(state).not.toBeNull();
    const projectCount = state!.projects.filter((p) => p === "my-project").length;
    expect(projectCount).toBe(1);
    const pidCount = (state!.secondaryPids ?? []).filter((p) => p === process.pid).length;
    expect(pidCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests for killRunningInstance
// ---------------------------------------------------------------------------

describe("killRunningInstance", () => {
  it("sends signal to the main pid", async () => {
    const { killRunningInstance } = await import("../../src/lib/running-state.js");
    const state = makeRunningState({ pid: 12345 });

    killRunningInstance(state as Parameters<typeof killRunningInstance>[0]);

    expect(mockProcessKill).toHaveBeenCalledWith(12345, "SIGTERM");
  });

  it("also sends signal to all secondaryPids", async () => {
    const { killRunningInstance } = await import("../../src/lib/running-state.js");
    const state = makeRunningState({ pid: 12345, secondaryPids: [22222, 33333] });

    killRunningInstance(state as Parameters<typeof killRunningInstance>[0]);

    expect(mockProcessKill).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(mockProcessKill).toHaveBeenCalledWith(22222, "SIGTERM");
    expect(mockProcessKill).toHaveBeenCalledWith(33333, "SIGTERM");
  });

  it("allows a custom signal to be specified", async () => {
    const { killRunningInstance } = await import("../../src/lib/running-state.js");
    const state = makeRunningState({ pid: 12345 });

    killRunningInstance(state as Parameters<typeof killRunningInstance>[0], "SIGKILL");

    expect(mockProcessKill).toHaveBeenCalledWith(12345, "SIGKILL");
  });

  it("does not throw when the process is already dead", async () => {
    const { killRunningInstance } = await import("../../src/lib/running-state.js");
    const state = makeRunningState({ pid: 99999 });

    mockProcessKill.mockImplementation(() => {
      throw new Error("ESRCH");
    });

    // Should not throw — errors are caught internally
    expect(() =>
      killRunningInstance(state as Parameters<typeof killRunningInstance>[0]),
    ).not.toThrow();
  });
});
