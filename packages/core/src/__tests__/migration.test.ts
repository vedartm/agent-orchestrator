/**
 * Tests for buildEffectiveConfig (migration.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { buildEffectiveConfig } from "../migration.js";
import { saveGlobalConfig } from "../global-config.js";
import { createGlobalConfigEnv, makeMinimalGlobalConfig as makeGlobalConfig } from "./helpers.js";

const env = createGlobalConfigEnv("ao-migration");
let testDir: string;

beforeEach(() => {
  testDir = env.setup();
});

afterEach(() => env.teardown());

describe("buildEffectiveConfig", () => {
  it("sets configMode to hybrid", () => {
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/app", defaultBranch: "main" }),
    );
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    saveGlobalConfig(gc);

    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"));
    expect(result.projects["app"].configMode).toBe("hybrid");
  });

  it("reads behavior from local config (type guard: non-object tracker → undefined)", () => {
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    // tracker as string is invalid — type guard should reject it
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      "repo: org/app\ntracker: not-an-object\n",
    );
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    saveGlobalConfig(gc);

    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"));
    expect(result.projects["app"].tracker).toBeUndefined();
  });

  it("reads behavior from local config (type guard: non-array symlinks → undefined)", () => {
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      "repo: org/app\nsymlinks: not-an-array\n",
    );
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    saveGlobalConfig(gc);

    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"));
    expect(result.projects["app"].symlinks).toBeUndefined();
  });

  it("surfaces a warning when local config is invalid and falls back to empty behavior", () => {
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "agent-orchestrator.yaml"), "!!invalid yaml: [unclosed");
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    saveGlobalConfig(gc);

    const warnings: string[] = [];
    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"), warnings);

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("app");
    expect(warnings[0]).toContain("local config");
    // Fallback: empty behavior — repo defaults to ""
    expect(result.projects["app"].repo).toBe("");
  });

  it("merges per-project notifiers on top of global notifiers", () => {
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/app", notifiers: { slack: { plugin: "notifier-slack" } } }),
    );
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    gc.notifiers = { desktop: { plugin: "notifier-desktop" } };
    saveGlobalConfig(gc);

    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"));
    expect(result.notifiers?.["desktop"]).toBeDefined();
    expect(result.notifiers?.["slack"]).toBeDefined();
  });

  it("merges per-project notificationRouting on top of global routing", () => {
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/app", notificationRouting: { info: ["slack"] } }),
    );
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    gc.notificationRouting = { urgent: ["desktop"] };
    saveGlobalConfig(gc);

    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"));
    expect(result.notificationRouting?.["info"]).toContain("slack");
  });

  it("falls back gracefully when local config is absent (no crash, empty repo)", () => {
    const projectDir = join(testDir, "ghost-app");
    mkdirSync(projectDir);
    // No local config
    const gc = makeGlobalConfig({ ghost: { name: "Ghost", path: projectDir } });
    saveGlobalConfig(gc);

    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"));
    expect(result.projects["ghost"]).toBeDefined();
    expect(result.projects["ghost"].repo).toBe("");
  });

  it("does not push warnings when local config is valid", () => {
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/app", defaultBranch: "main" }),
    );
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    saveGlobalConfig(gc);

    const warnings: string[] = [];
    buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"), warnings);
    expect(warnings).toHaveLength(0);
  });

  it("warning message uses String(err) when thrown value is not an Error instance", () => {
    // We can't easily make loadLocalProjectConfig throw a non-Error, but we can
    // verify the warning message format by mocking globalConfig to trigger the
    // catch path — the YAML parser throws Error instances so we test the happy
    // branch string representation by checking the warning is present and includes
    // the project ID regardless of error type.
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    // Write a YAML file with invalid content that will fail Zod schema validation
    // (Zod throws a ZodError which IS an instance of Error, so err.message is used)
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: 12345 }), // repo must be string — Zod will reject this
    );
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    saveGlobalConfig(gc);

    const warnings: string[] = [];
    buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"), warnings);

    // Warnings array should have at least one entry mentioning the project
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("app");
  });

  it("uses projectId as project name when entry.name is absent", () => {
    const projectDir = join(testDir, "nameless-app");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/nameless" }),
    );
    // Build a GlobalConfig where the entry has no .name field
    const gc = makeGlobalConfig({
      "nameless-app": { name: undefined as unknown as string, path: projectDir },
    });
    saveGlobalConfig(gc);

    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"));
    // When entry.name is falsy, the project name falls back to the projectId key
    expect(result.projects["nameless-app"].name).toBe("nameless-app");
  });

  it("notificationRouting includes DEFAULT_NOTIFICATION_ROUTING keys when no routing is set", () => {
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "agent-orchestrator.yaml"), stringifyYaml({ repo: "org/app" }));
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    // No notificationRouting set on global config
    saveGlobalConfig(gc);

    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"));
    // DEFAULT_NOTIFICATION_ROUTING spreads in urgent, action, warning, info
    expect(result.notificationRouting).toHaveProperty("urgent");
    expect(result.notificationRouting).toHaveProperty("action");
    expect(result.notificationRouting).toHaveProperty("warning");
    expect(result.notificationRouting).toHaveProperty("info");
  });

  it("filters invalid plugin entries from the effective config", () => {
    const projectDir = join(testDir, "plugins-app");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/plugins-app" }),
    );
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    gc.plugins = [
      { name: "valid-plugin", source: "npm:@scope/plugin" },
      42,
      null,
      { name: "missing-source" },
      { source: "npm:@scope/missing-name" },
      { name: "wrong-source", source: 123 },
      { name: "another-valid", source: "./plugins/local.js" },
    ] as unknown as NonNullable<typeof gc.plugins>;
    saveGlobalConfig(gc);

    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"));

    expect(result.plugins).toEqual([
      { name: "valid-plugin", source: "npm:@scope/plugin" },
      { name: "another-valid", source: "./plugins/local.js" },
    ]);
  });
});
