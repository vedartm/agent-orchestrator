/**
 * Tests for resolveMultiProjectStart — core multi-project registration logic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";

import { resolveMultiProjectStart, registerNewProject } from "../multi-project-start.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  loadShadowFile,
  getShadowFilePath,
  scaffoldGlobalConfig,
  type GlobalConfig,
} from "../global-config.js";

let testDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `ao-mps-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(testDir, { recursive: true });
  originalEnv = process.env["AO_GLOBAL_CONFIG_PATH"];
  process.env["AO_GLOBAL_CONFIG_PATH"] = join(testDir, ".ao", "config.yaml");
});

afterEach(() => {
  if (originalEnv !== undefined) {
    process.env["AO_GLOBAL_CONFIG_PATH"] = originalEnv;
  } else {
    delete process.env["AO_GLOBAL_CONFIG_PATH"];
  }
  rmSync(testDir, { recursive: true, force: true });
});

function setupGlobalConfig(projects: Record<string, { name: string; path: string }>): void {
  const config: GlobalConfig = {
    port: 3000,
    readyThresholdMs: 300000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects,
  };
  saveGlobalConfig(config);
}

describe("resolveMultiProjectStart", () => {
  it("returns null when no global config exists", () => {
    const result = resolveMultiProjectStart(testDir);
    expect(result).toBeNull();
  });

  it("returns null when CWD has no local config and is not registered", () => {
    setupGlobalConfig({});
    const unregisteredDir = join(testDir, "unregistered");
    mkdirSync(unregisteredDir, { recursive: true });
    const result = resolveMultiProjectStart(unregisteredDir);
    expect(result).toBeNull();
  });

  it("registers a new project with local config (hybrid mode)", () => {
    setupGlobalConfig({});
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/my-app", defaultBranch: "main", agent: "claude-code" }),
    );

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();
    expect(result!.projectId).toBeTruthy();
    expect(result!.config.projects[result!.projectId]).toBeDefined();

    // Shadow file should be created
    expect(existsSync(getShadowFilePath(result!.projectId))).toBe(true);
    const shadow = loadShadowFile(result!.projectId);
    expect(shadow!["repo"]).toBe("org/my-app");

    // Global config should have the project registered
    const gc = loadGlobalConfig();
    expect(gc!.projects[result!.projectId]).toBeDefined();

    // Messages should include registration info
    expect(result!.messages.some((m) => m.text.includes("Registered"))).toBe(true);
  });

  it("syncs shadow for already-registered hybrid project", () => {
    const projectDir = join(testDir, "existing-app");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/existing", defaultBranch: "main", agent: "aider" }),
    );

    // Register the project first
    setupGlobalConfig({ ea: { name: "Existing App", path: projectDir } });

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("ea");

    // Shadow should be synced with local config values
    const shadow = loadShadowFile("ea");
    expect(shadow!["agent"]).toBe("aider");
  });

  it("returns config for already-registered global-only project", () => {
    const projectDir = join(testDir, "global-only");
    mkdirSync(projectDir, { recursive: true });
    // No local config — global-only mode

    setupGlobalConfig({ go: { name: "Global Only", path: projectDir } });

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("go");
  });

  it("handles ID collision with auto-suffix", () => {
    const dir1 = join(testDir, "app");
    const dir2 = join(testDir, "other-app");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, "agent-orchestrator.yaml"), stringifyYaml({ repo: "org/other-app", defaultBranch: "main" }));

    // Register first project with the abbreviated ID that dir2 would derive.
    // basename of dir2 is "other-app" → generateSessionPrefix → "oa"
    // "oa" is pre-occupied by dir1 (different path), so dir2 should get "oa2".
    setupGlobalConfig({ oa: { name: "First", path: dir1 } });

    const result = resolveMultiProjectStart(dir2);
    expect(result).not.toBeNull();
    expect(result!.projectId).not.toBe("oa");
    expect(result!.messages.some((m) => m.text.includes("taken"))).toBe(true);
  });

  it("finds local config from subdirectory", () => {
    const projectDir = join(testDir, "sub-test");
    const subDir = join(projectDir, "src", "lib");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/sub-test", defaultBranch: "main" }),
    );

    setupGlobalConfig({});

    const result = resolveMultiProjectStart(subDir);
    expect(result).not.toBeNull();
    // Should register with the project root, not the subdirectory
    const project = result!.config.projects[result!.projectId];
    expect(project.path).toBe(projectDir);
  });

  it("registerNewProject is pure — returns pendingShadow without writing to disk", () => {
    const projectDir = join(testDir, "pure-test");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/pure-test", defaultBranch: "main", agent: "aider" }),
    );

    const globalConfig = scaffoldGlobalConfig();

    const reg = registerNewProject(globalConfig, projectDir);

    // Must return a projectId and pendingShadow
    expect(reg.projectId).toBeTruthy();
    expect(reg.pendingShadow).toBeDefined();
    expect(reg.pendingShadow["repo"]).toBe("org/pure-test");
    expect(reg.pendingShadow["agent"]).toBe("aider");

    // Must NOT have written any shadow file to disk
    const shadowFilePath = getShadowFilePath(reg.projectId);
    expect(existsSync(shadowFilePath)).toBe(false);

    // Must NOT have persisted the updated global config — the on-disk config
    // should still have 0 projects (scaffoldGlobalConfig saves empty config,
    // registerNewProject must not overwrite it with the new project entry)
    const savedGc = loadGlobalConfig();
    expect(Object.keys(savedGc?.projects ?? {})).toHaveLength(0);
  });

  it("auto-suffixed ID stores explicit sessionPrefix in pendingShadow to prevent collision", () => {
    const dir1 = join(testDir, "myapp");
    const dir2 = join(testDir, "other", "myapp"); // same basename → same derived prefix
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, "agent-orchestrator.yaml"), stringifyYaml({ repo: "org/myapp2" }));

    // Pre-occupy the ID that dir2 would naturally derive
    const globalConfig = scaffoldGlobalConfig();
    const reg1 = registerNewProject(globalConfig, dir1);

    // Now register dir2 — should get a suffixed ID
    const reg2 = registerNewProject(reg1.updatedGlobalConfig, dir2);

    expect(reg2.projectId).not.toBe(reg1.projectId);
    // The suffixed project must have an explicit sessionPrefix in its shadow
    // so applyProjectDefaults doesn't re-derive the same prefix from basename
    expect(reg2.pendingShadow["sessionPrefix"]).toBeDefined();
    expect(reg2.pendingShadow["sessionPrefix"]).not.toBe(reg1.pendingShadow["sessionPrefix"] ?? "");
  });

  it("excludes secret-like fields from shadow", () => {
    setupGlobalConfig({});
    const projectDir = join(testDir, "secret-proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/secret", defaultBranch: "main", apiToken: "secret123" }),
    );

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();

    const shadow = loadShadowFile(result!.projectId);
    expect(shadow!["apiToken"]).toBeUndefined();
    expect(result!.messages.some((m) => m.text.includes("secret"))).toBe(true);
  });
});
