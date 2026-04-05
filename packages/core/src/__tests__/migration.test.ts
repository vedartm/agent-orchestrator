/**
 * Tests for buildEffectiveConfig (migration.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { buildEffectiveConfig } from "../migration.js";
import { saveGlobalConfig, saveShadowFile } from "../global-config.js";
import { createGlobalConfigEnv, makeMinimalGlobalConfig as makeGlobalConfig } from "./helpers.js";

const env = createGlobalConfigEnv("ao-migration");
let testDir: string;

beforeEach(() => {
  testDir = env.setup();
});

afterEach(() => env.teardown());

describe("buildEffectiveConfig", () => {
  it("sets configMode to global-only when no local config exists", () => {
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    saveGlobalConfig(gc);
    saveShadowFile("app", { repo: "org/app" });

    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"));
    expect(result.projects["app"].configMode).toBe("global-only");
  });

  it("sets configMode to hybrid when local config exists", () => {
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

  it("gracefully handles non-object tracker field from shadow (type guard)", () => {
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    saveGlobalConfig(gc);
    // Corrupt shadow: tracker is a string instead of an object
    saveShadowFile("app", { repo: "org/app", tracker: "not-an-object" });

    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"));
    // Should be undefined (type guard rejects non-objects) rather than a wrong-type value
    expect(result.projects["app"].tracker).toBeUndefined();
  });

  it("gracefully handles non-array symlinks field from shadow (type guard)", () => {
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    saveGlobalConfig(gc);
    saveShadowFile("app", { repo: "org/app", symlinks: "not-an-array" });

    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"));
    expect(result.projects["app"].symlinks).toBeUndefined();
  });

  it("gracefully handles non-string runtime field from shadow (type guard)", () => {
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    saveGlobalConfig(gc);
    saveShadowFile("app", { repo: "org/app", runtime: 42 });

    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"));
    expect(result.projects["app"].runtime).toBeUndefined();
  });

  it("surfaces a warning when hybrid local config is invalid", () => {
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    // Write a broken YAML file (valid YAML but invalid project config)
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      "!!invalid yaml: [unclosed",
    );
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    saveGlobalConfig(gc);
    saveShadowFile("app", { repo: "org/app-shadow" });

    const warnings: string[] = [];
    const result = buildEffectiveConfig(gc, join(testDir, ".ao", "config.yaml"), warnings);

    // Should fall back to shadow and warn
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("app");
    expect(warnings[0]).toContain("local config");
    // Fallback shadow is used
    expect(result.projects["app"].repo).toBe("org/app-shadow");
  });

  it("uses pendingShadow instead of reading from disk (validate-first invariant)", () => {
    // This is the core of the validate-first pattern: buildEffectiveConfig must use
    // pendingShadow content for a project that hasn't been written to disk yet.
    // Without this, validation would run against an empty shadow and derive a
    // wrong sessionPrefix, potentially allowing a collision to slip through.
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    saveGlobalConfig(gc);
    // Intentionally NO saveShadowFile call — the shadow doesn't exist on disk yet

    const pendingShadow = {
      repo: "org/pending-app",
      defaultBranch: "develop",
      agent: "codex",
      sessionPrefix: "pending-prefix",
    };

    const result = buildEffectiveConfig(
      gc,
      join(testDir, ".ao", "config.yaml"),
      undefined,
      { app: pendingShadow },
    );

    expect(result.projects["app"].repo).toBe("org/pending-app");
    expect(result.projects["app"].defaultBranch).toBe("develop");
    expect(result.projects["app"].agent).toBe("codex");
    // sessionPrefix from pendingShadow must be used directly — if it were read from disk
    // (which is empty), applyProjectDefaults would re-derive it from basename instead
    expect(result.projects["app"].sessionPrefix).toBe("pending-prefix");
  });

  it("pendingShadow takes precedence over existing shadow file on disk", () => {
    // Even if a shadow file already exists (e.g. from a previous partial run),
    // pendingShadow must win — the caller computed it from the current state.
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir);
    const gc = makeGlobalConfig({ app: { name: "App", path: projectDir } });
    saveGlobalConfig(gc);
    saveShadowFile("app", { repo: "org/stale-on-disk", defaultBranch: "main" });

    const pendingShadow = { repo: "org/fresh-pending", defaultBranch: "develop" };

    const result = buildEffectiveConfig(
      gc,
      join(testDir, ".ao", "config.yaml"),
      undefined,
      { app: pendingShadow },
    );

    expect(result.projects["app"].repo).toBe("org/fresh-pending");
    expect(result.projects["app"].defaultBranch).toBe("develop");
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
});
