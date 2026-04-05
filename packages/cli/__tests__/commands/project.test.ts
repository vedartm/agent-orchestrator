import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import type { GlobalConfig, SessionManager } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockLoadGlobalConfig,
  mockSaveGlobalConfig,
  mockSaveShadowFile,
  mockRegisterNewProject,
  mockUnregisterProject,
  mockDeleteShadowFile,
  mockScaffoldGlobalConfig,
  mockFindProjectByPath,
  mockBuildEffectiveConfig,
  mockApplyGlobalConfigPipeline,
  mockFindGlobalConfigPath,
  mockLoadConfig,
  mockExpandHome,
  mockSessionManager,
  mockGetRunning,
  mockPromptConfirm,
  mockIsHumanCaller,
} = vi.hoisted(() => {
  const pendingGc = {
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: ["composio", "desktop"] },
    projects: { "ma": { name: "my-app", path: "/home/user/my-app" } },
  };
  const defaultRegisterResult = {
    projectId: "ma",
    updatedGlobalConfig: pendingGc,
    configMode: "global-only" as const,
    messages: [] as Array<{ level: "info" | "warn" | "success"; text: string }>,
    pendingShadow: { repo: "", defaultBranch: "main" },
  };
  return {
    mockLoadGlobalConfig: vi.fn(),
    mockSaveGlobalConfig: vi.fn(),
    mockSaveShadowFile: vi.fn(),
    mockRegisterNewProject: vi.fn().mockReturnValue(defaultRegisterResult),
    mockUnregisterProject: vi.fn(),
    mockDeleteShadowFile: vi.fn(),
    mockScaffoldGlobalConfig: vi.fn(),
    mockFindProjectByPath: vi.fn().mockReturnValue(null),
    mockBuildEffectiveConfig: vi.fn().mockReturnValue({ projects: {} }),
    mockApplyGlobalConfigPipeline: vi.fn().mockImplementation((c: unknown) => c),
    mockFindGlobalConfigPath: vi.fn().mockReturnValue("/home/user/.ao/config.yaml"),
    mockLoadConfig: vi.fn(),
    mockExpandHome: vi.fn((p: string) => p),
    mockSessionManager: {
      list: vi.fn().mockResolvedValue([]),
      kill: vi.fn(),
      cleanup: vi.fn(),
      get: vi.fn(),
      spawn: vi.fn(),
      spawnOrchestrator: vi.fn(),
      send: vi.fn(),
      claimPR: vi.fn(),
    },
    mockGetRunning: vi.fn().mockResolvedValue(null),
    mockPromptConfirm: vi.fn().mockResolvedValue(true),
    mockIsHumanCaller: vi.fn().mockReturnValue(false),
  };
});

vi.mock("@composio/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    loadGlobalConfig: mockLoadGlobalConfig,
    saveGlobalConfig: mockSaveGlobalConfig,
    saveShadowFile: mockSaveShadowFile,
    registerNewProject: mockRegisterNewProject,
    unregisterProject: mockUnregisterProject,
    deleteShadowFile: mockDeleteShadowFile,
    scaffoldGlobalConfig: mockScaffoldGlobalConfig,
    findProjectByPath: mockFindProjectByPath,
    buildEffectiveConfig: mockBuildEffectiveConfig,
    applyGlobalConfigPipeline: mockApplyGlobalConfigPipeline,
    findGlobalConfigPath: mockFindGlobalConfigPath,
    loadConfig: mockLoadConfig,
    expandHome: mockExpandHome,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as unknown as SessionManager,
}));

vi.mock("../../src/lib/running-state.js", () => ({
  getRunning: () => mockGetRunning(),
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptConfirm: (...args: unknown[]) => mockPromptConfirm(...args),
}));

vi.mock("../../src/lib/caller-context.js", () => ({
  isHumanCaller: () => mockIsHumanCaller(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { registerProjectCommand } from "../../src/commands/project.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGlobalConfig(
  projectIds: string[] = ["my-project"],
): GlobalConfig {
  const projects: GlobalConfig["projects"] = {};
  for (const id of projectIds) {
    projects[id] = { name: id, path: `/home/user/${id}` } as GlobalConfig["projects"][string];
  }
  return {
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: ["composio", "desktop"] },
    projects,
  } as GlobalConfig;
}

function runCommand(args: string[]): Promise<Command> {
  const program = new Command();
  program.exitOverride();
  registerProjectCommand(program);
  return program.parseAsync(["node", "ao", ...args]);
}

// ---------------------------------------------------------------------------
// ao project list
// ---------------------------------------------------------------------------

describe("ao project list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists registered projects", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["app", "api"]));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCommand(["project", "list"]);
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("app");
    expect(output).toContain("api");
    spy.mockRestore();
  });

  it("shows message when no global config", async () => {
    mockLoadGlobalConfig.mockReturnValue(null);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCommand(["project", "list"]);
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("No global config");
    spy.mockRestore();
  });

  it("shows message when no projects registered", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCommand(["project", "list"]);
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("No projects");
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// ao project add
// ---------------------------------------------------------------------------

describe("ao project add", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindProjectByPath.mockReturnValue(null);
    mockExpandHome.mockImplementation((p: string) => p);
    mockBuildEffectiveConfig.mockReturnValue({ projects: {} });
    mockApplyGlobalConfigPipeline.mockImplementation((c: unknown) => c);
    mockFindGlobalConfigPath.mockReturnValue("/home/user/.ao/config.yaml");
    mockRegisterNewProject.mockReturnValue({
      projectId: "ma",
      updatedGlobalConfig: makeGlobalConfig(["ma"]),
      configMode: "global-only" as const,
      messages: [],
      pendingShadow: { repo: "", defaultBranch: "main" },
    });
  });

  it("registers a new global-only project", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    await runCommand(["project", "add", "/home/user/my-app"]);
    expect(mockRegisterNewProject).toHaveBeenCalled();
    expect(mockSaveShadowFile).toHaveBeenCalledWith("ma", { repo: "", defaultBranch: "main" });
    expect(mockSaveGlobalConfig).toHaveBeenCalled();
  });

  it("scaffolds global config when none exists", async () => {
    mockLoadGlobalConfig.mockReturnValue(null);
    mockScaffoldGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    await runCommand(["project", "add", "/home/user/new-app"]);
    expect(mockScaffoldGlobalConfig).toHaveBeenCalled();
    expect(mockRegisterNewProject).toHaveBeenCalled();
    expect(mockSaveGlobalConfig).toHaveBeenCalled();
  });

  it("skips registration when already registered (exact path match)", async () => {
    const config = makeGlobalConfig(["ma"]);
    mockLoadGlobalConfig.mockReturnValue(config);
    mockFindProjectByPath.mockReturnValue({ id: "ma", entry: config.projects["ma"] });
    await runCommand(["project", "add", "/home/user/my-app"]);
    expect(mockRegisterNewProject).not.toHaveBeenCalled();
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
  });

  it("passes --id override to registerNewProject", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    await runCommand(["project", "add", "/home/user/my-app", "--id", "custom"]);
    expect(mockRegisterNewProject).toHaveBeenCalledWith(
      expect.anything(),
      "/home/user/my-app",
      expect.objectContaining({ explicitId: "custom" }),
    );
  });

  it("passes --name override to registerNewProject", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    await runCommand(["project", "add", "/home/user/my-app", "--name", "My App"]);
    expect(mockRegisterNewProject).toHaveBeenCalledWith(
      expect.anything(),
      "/home/user/my-app",
      expect.objectContaining({ name: "My App" }),
    );
  });

  it("errors when registerNewProject throws (e.g. --id already in use)", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    mockRegisterNewProject.mockImplementation(() => {
      throw new Error('Project ID "custom" is already in use by /other/path.');
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    await expect(runCommand(["project", "add", "/home/user/my-app", "--id", "custom"])).rejects.toThrow();
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/already in use/);
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("uses auto-suffixed project ID returned by registerNewProject", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    const updatedGc = makeGlobalConfig(["my2"]);
    mockRegisterNewProject.mockReturnValue({
      projectId: "my2",
      updatedGlobalConfig: updatedGc,
      configMode: "global-only" as const,
      messages: [{ level: "warn" as const, text: 'ID "my" taken, using "my2"' }],
      pendingShadow: { repo: "", defaultBranch: "main", sessionPrefix: "my2" },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCommand(["project", "add", "/home/user/my-app"]);
    logSpy.mockRestore();

    expect(mockSaveShadowFile).toHaveBeenCalledWith("my2", expect.objectContaining({ sessionPrefix: "my2" }));
    expect(mockSaveGlobalConfig).toHaveBeenCalledWith(updatedGc);
  });

  it("does not write shadow or global config when validation fails", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    mockApplyGlobalConfigPipeline.mockImplementation(() => {
      throw new Error("Session prefix collision detected");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    await expect(runCommand(["project", "add", "/home/user/my-app"])).rejects.toThrow();

    // Critical: no shadow or global config written on validation failure
    expect(mockSaveShadowFile).not.toHaveBeenCalled();
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("reports excluded secrets from registerNewProject messages", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    mockRegisterNewProject.mockReturnValue({
      projectId: "ma",
      updatedGlobalConfig: makeGlobalConfig(["ma"]),
      configMode: "hybrid" as const,
      messages: [{ level: "warn" as const, text: "Excluded secret-like fields: apiToken" }],
      pendingShadow: { repo: "org/app", defaultBranch: "main" },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCommand(["project", "add", "/home/user/my-app"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("apiToken");
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// ao project remove
// ---------------------------------------------------------------------------

describe("ao project remove", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRunning.mockResolvedValue(null);
    mockPromptConfirm.mockResolvedValue(true);
    mockIsHumanCaller.mockReturnValue(false);
    mockSessionManager.list.mockResolvedValue([]);
    mockUnregisterProject.mockImplementation((cfg: GlobalConfig, id: string) => {
      const { [id]: _removed, ...rest } = cfg.projects;
      const updated = { ...cfg, projects: rest };
      return updated;
    });
    mockLoadConfig.mockReturnValue(makeGlobalConfig());
  });

  it("removes a project when found in global config", async () => {
    const globalConfig = makeGlobalConfig(["my-project"]);
    mockLoadGlobalConfig.mockReturnValue(globalConfig);

    await runCommand(["project", "remove", "my-project", "--force"]);

    expect(mockUnregisterProject).toHaveBeenCalledWith(globalConfig, "my-project");
    expect(mockSaveGlobalConfig).toHaveBeenCalled();
    expect(mockDeleteShadowFile).toHaveBeenCalledWith("my-project");
  });

  it("exits with error when global config is not found", async () => {
    mockLoadGlobalConfig.mockReturnValue(null);
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    await expect(runCommand(["project", "remove", "nonexistent", "--force"])).rejects.toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
  });

  it("exits with error when project ID is not in global config", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["other-project"]));
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    await expect(runCommand(["project", "remove", "nonexistent", "--force"])).rejects.toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
  });

  it("shows active sessions and includes orphan warning in prompt", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["my-project"]));
    mockSessionManager.list.mockResolvedValue([{ id: "my-project-session-1" }, { id: "my-project-session-2" }]);
    mockIsHumanCaller.mockReturnValue(true);
    mockPromptConfirm.mockResolvedValue(true);

    await runCommand(["project", "remove", "my-project"]);

    expect(mockPromptConfirm).toHaveBeenCalledWith(
      expect.stringContaining("active sessions will be orphaned"),
      false,
    );
  });

  it("cancels when user declines confirmation", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["my-project"]));
    mockIsHumanCaller.mockReturnValue(true);
    mockPromptConfirm.mockResolvedValue(false);

    await runCommand(["project", "remove", "my-project"]);

    expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
    expect(mockDeleteShadowFile).not.toHaveBeenCalled();
  });

  it("skips confirmation with --force", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["my-project"]));
    mockIsHumanCaller.mockReturnValue(true);

    await runCommand(["project", "remove", "my-project", "--force"]);

    expect(mockPromptConfirm).not.toHaveBeenCalled();
    expect(mockSaveGlobalConfig).toHaveBeenCalled();
  });

  it("warns when ao start daemon is running after removal", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["my-project"]));
    mockGetRunning.mockResolvedValue({ pid: 12345, configPath: "/tmp/config.yaml", port: 3000, startedAt: "", projects: ["my-project"] });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCommand(["project", "remove", "my-project", "--force"]);

    const output = spy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(output).toContain("12345");
    spy.mockRestore();
  });

  it("proceeds even when getRunning throws", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["my-project"]));
    mockGetRunning.mockRejectedValue(new Error("no running.json"));

    await runCommand(["project", "remove", "my-project", "--force"]);

    expect(mockSaveGlobalConfig).toHaveBeenCalled();
    expect(mockDeleteShadowFile).toHaveBeenCalledWith("my-project");
  });

  it("proceeds when session manager throws", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["my-project"]));
    mockLoadConfig.mockImplementation(() => { throw new Error("no config"); });

    await runCommand(["project", "remove", "my-project", "--force"]);

    expect(mockSaveGlobalConfig).toHaveBeenCalled();
  });
});
