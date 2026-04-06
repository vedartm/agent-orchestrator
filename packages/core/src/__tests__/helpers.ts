/**
 * Shared test helpers for multi-project core tests.
 *
 * Centralises the temp-dir + AO_GLOBAL_CONFIG_PATH fixture used by
 * config-multiproject, global-config, migration, and multi-project-start tests.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { saveGlobalConfig, type GlobalConfig } from "../global-config.js";

// ---------------------------------------------------------------------------
// Temp dir + env var fixture
// ---------------------------------------------------------------------------

/**
 * Create a per-test temp directory and set AO_GLOBAL_CONFIG_PATH to a path
 * inside it. Returns setup / teardown functions for use in beforeEach / afterEach.
 *
 * Usage:
 *   const env = createGlobalConfigEnv("ao-my-test");
 *   let testDir: string;
 *   beforeEach(() => { testDir = env.setup(); });
 *   afterEach(() => env.teardown());
 */
export function createGlobalConfigEnv(prefix = "ao") {
  let testDir = "";
  let originalEnv: string | undefined;

  function setup(): string {
    testDir = join(tmpdir(), `${prefix}-${randomBytes(6).toString("hex")}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = process.env["AO_GLOBAL_CONFIG_PATH"];
    process.env["AO_GLOBAL_CONFIG_PATH"] = join(testDir, ".ao", "config.yaml");
    return testDir;
  }

  function teardown(): void {
    if (originalEnv !== undefined) {
      process.env["AO_GLOBAL_CONFIG_PATH"] = originalEnv;
    } else {
      delete process.env["AO_GLOBAL_CONFIG_PATH"];
    }
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  }

  return { setup, teardown };
}

// ---------------------------------------------------------------------------
// GlobalConfig factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal GlobalConfig with sensible defaults.
 * Pass project entries as `{ [id]: { name, path } }`.
 */
export function makeMinimalGlobalConfig(
  projects: Record<string, { name: string; path: string }> = {},
): GlobalConfig {
  return {
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects,
  };
}

/**
 * Save a minimal GlobalConfig and return it. Convenience wrapper for test setup.
 */
export function setupGlobalConfig(
  projects: Record<string, { name: string; path: string }> = {},
): GlobalConfig {
  const config = makeMinimalGlobalConfig(projects);
  saveGlobalConfig(config);
  return config;
}
