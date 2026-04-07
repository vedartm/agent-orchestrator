/**
 * Unit tests for global-config.ts — multi-project registry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import type * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";

// We test functions via direct import since they use env vars for paths
import {
  findGlobalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
  scaffoldGlobalConfig,
  registerProject,
  unregisterProject,
  matchProjectByCwd,
  findProjectByPath,
  loadLocalProjectConfig,
  type GlobalConfig,
} from "../global-config.js";

// Use a unique temp dir per test run to avoid conflicts
let testDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `ao-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(testDir, { recursive: true });
  originalEnv = process.env["AO_GLOBAL_CONFIG_PATH"];
  process.env["AO_GLOBAL_CONFIG_PATH"] = join(testDir, "config.yaml");
});

afterEach(() => {
  if (originalEnv !== undefined) {
    process.env["AO_GLOBAL_CONFIG_PATH"] = originalEnv;
  } else {
    delete process.env["AO_GLOBAL_CONFIG_PATH"];
  }
  delete process.env["XDG_CONFIG_HOME"];
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(join(testDir, "config.yaml"), stringifyYaml(data), "utf-8");
}

describe("findGlobalConfigPath", () => {
  it("uses AO_GLOBAL_CONFIG_PATH when set", () => {
    const path = findGlobalConfigPath();
    expect(path).toBe(join(testDir, "config.yaml"));
  });

  it("uses XDG_CONFIG_HOME when AO_GLOBAL_CONFIG_PATH is unset", () => {
    delete process.env["AO_GLOBAL_CONFIG_PATH"];
    const xdgDir = join(testDir, "xdg-home");
    process.env["XDG_CONFIG_HOME"] = xdgDir;

    expect(findGlobalConfigPath()).toBe(join(xdgDir, "agent-orchestrator", "config.yaml"));
  });

  it("falls back to homedir when env vars are unset", () => {
    delete process.env["AO_GLOBAL_CONFIG_PATH"];
    delete process.env["XDG_CONFIG_HOME"];

    expect(findGlobalConfigPath()).toBe(join(os.homedir(), ".agent-orchestrator", "config.yaml"));
  });
});

describe("loadGlobalConfig / saveGlobalConfig", () => {
  it("returns null when file does not exist", () => {
    expect(loadGlobalConfig()).toBeNull();
  });

  it("loads a valid config", () => {
    writeConfig({
      projects: {
        ao: { name: "Agent Orchestrator", path: "/tmp/ao" },
      },
    });
    const config = loadGlobalConfig();
    expect(config).not.toBeNull();
    expect(config!.projects["ao"].name).toBe("Agent Orchestrator");
  });

  it("throws user-friendly error on invalid config", () => {
    writeFileSync(join(testDir, "config.yaml"), "port: not-a-number\n", "utf-8");
    expect(() => loadGlobalConfig()).toThrow(/Invalid global config/);
  });

  it("saves and reloads config", () => {
    const config: GlobalConfig = {
      port: 4000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { test: { name: "Test", path: "/tmp/test" } },
    };
    saveGlobalConfig(config);
    const loaded = loadGlobalConfig();
    expect(loaded!.port).toBe(4000);
    expect(loaded!.projects["test"].name).toBe("Test");
  });

  it("contracts project paths under homedir to ~/ when saving", () => {
    const projectPath = join(os.homedir(), `.ao-home-${randomBytes(6).toString("hex")}`);
    mkdirSync(projectPath, { recursive: true });

    try {
      const config: GlobalConfig = {
        port: 4000,
        readyThresholdMs: 300000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: { homeproj: { name: "Home Project", path: projectPath } },
      };

      saveGlobalConfig(config);

      const saved = readFileSync(join(testDir, "config.yaml"), "utf-8");
      expect(saved).toContain(`path: ~/${projectPath.slice(os.homedir().length + 1)}`);
      expect(saved).not.toContain(`path: ${projectPath}`);
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("rethrows rename failures after best-effort temp cleanup", async () => {
    const renameError = new Error("rename failed");
    const unlinkSpy = vi.fn(() => {
      throw new Error("unlink failed");
    });
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof fs>("node:fs");
      return {
        ...actual,
        renameSync: () => {
          throw renameError;
        },
        unlinkSync: unlinkSpy,
      };
    });

    const { saveGlobalConfig: saveGlobalConfigWithMock } = await import("../global-config.js");

    const config: GlobalConfig = {
      port: 4000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { test: { name: "Test", path: "/tmp/test" } },
    };

    expect(() => saveGlobalConfigWithMock(config)).toThrow(renameError);
    expect(unlinkSpy).toHaveBeenCalledOnce();

    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});

describe("scaffoldGlobalConfig", () => {
  it("creates a minimal config file", () => {
    const config = scaffoldGlobalConfig();
    expect(config.projects).toEqual({});
    expect(existsSync(join(testDir, "config.yaml"))).toBe(true);
  });
});

describe("registerProject / unregisterProject", () => {
  it("registers a project immutably", () => {
    const original: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {},
    };
    const updated = registerProject(original, "ao", { name: "AO", path: "/tmp/ao" });
    expect(updated.projects["ao"]).toBeDefined();
    expect(original.projects["ao"]).toBeUndefined(); // immutable
  });

  it("appends to projectOrder when defined", () => {
    const original: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { existing: { name: "Existing", path: "/tmp/existing" } },
      projectOrder: ["existing"],
    };
    const updated = registerProject(original, "new-proj", { name: "New", path: "/tmp/new" });
    expect(updated.projectOrder).toEqual(["existing", "new-proj"]);
    expect(original.projectOrder).toEqual(["existing"]); // immutable
  });

  it("does not duplicate in projectOrder if already present", () => {
    const original: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: "/tmp/ao" } },
      projectOrder: ["ao"],
    };
    const updated = registerProject(original, "ao", { name: "AO", path: "/tmp/ao" });
    expect(updated.projectOrder).toEqual(["ao"]);
  });

  it("leaves projectOrder undefined when not defined", () => {
    const original: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {},
    };
    const updated = registerProject(original, "ao", { name: "AO", path: "/tmp/ao" });
    expect(updated.projectOrder).toBeUndefined();
  });

  it("unregisters a project immutably", () => {
    const config: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: "/tmp/ao" } },
    };
    const updated = unregisterProject(config, "ao");
    expect(updated.projects["ao"]).toBeUndefined();
    expect(config.projects["ao"]).toBeDefined(); // immutable
  });

  it("removes unregistered projects from projectOrder", () => {
    const config: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        ao: { name: "AO", path: "/tmp/ao" },
        other: { name: "Other", path: "/tmp/other" },
      },
      projectOrder: ["ao", "other"],
    };

    const updated = unregisterProject(config, "ao");
    expect(updated.projectOrder).toEqual(["other"]);
  });
});

describe("matchProjectByCwd", () => {
  it("matches exact path", () => {
    const config: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: testDir } },
    };
    expect(matchProjectByCwd(config, testDir)).toBe("ao");
  });

  it("matches subdirectory", () => {
    const subDir = join(testDir, "src");
    mkdirSync(subDir, { recursive: true });
    const config: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: testDir } },
    };
    expect(matchProjectByCwd(config, subDir)).toBe("ao");
  });

  it("prefers most specific match", () => {
    const subDir = join(testDir, "packages", "sub");
    mkdirSync(subDir, { recursive: true });
    const config: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        parent: { name: "Parent", path: testDir },
        sub: { name: "Sub", path: join(testDir, "packages", "sub") },
      },
    };
    expect(matchProjectByCwd(config, subDir)).toBe("sub");
  });

  it("returns null for unmatched path", () => {
    const config: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: "/some/other/path" } },
    };
    expect(matchProjectByCwd(config, testDir)).toBeNull();
  });
});

describe("findProjectByPath", () => {
  it("returns the matching project by exact path", () => {
    const config: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: testDir } },
    };
    const result = findProjectByPath(config, testDir);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ao");
  });

  it("matches after expanding ~ in stored path", () => {
    const home = process.env["HOME"] ?? "";
    const config: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: testDir.replace(home, "~") } },
    };
    const result = findProjectByPath(config, testDir);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ao");
  });

  it("returns null when path does not match any project", () => {
    const config: GlobalConfig = {
      port: 3000,
      readyThresholdMs: 300000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: { ao: { name: "AO", path: "/some/other/path" } },
    };
    expect(findProjectByPath(config, testDir)).toBeNull();
  });
});

describe("loadLocalProjectConfig", () => {
  it("throws a readable error when the local config file cannot be read", () => {
    const missingPath = join(testDir, "missing", "agent-orchestrator.yaml");

    expect(() => loadLocalProjectConfig(missingPath)).toThrow(
      `Cannot read local project config at ${missingPath}`,
    );
  });
});
