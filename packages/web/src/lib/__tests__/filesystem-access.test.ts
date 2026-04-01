import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWorkspacePathAllowed,
  getAllowedWorkspaceRoots,
  isWorkspacePathAllowed,
} from "@/lib/filesystem-access";

describe("filesystem-access", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to home directory and current working directory", () => {
    const roots = getAllowedWorkspaceRoots();
    expect(roots).toContain(originalCwd);
    expect(roots.length).toBeGreaterThan(0);
  });

  it("allows paths under configured workspace roots", () => {
    vi.stubEnv("AO_ALLOWED_WORKSPACE_ROOTS", "/tmp/workspaces:/Users/test/code");

    expect(isWorkspacePathAllowed("/tmp/workspaces/demo")).toBe(true);
    expect(isWorkspacePathAllowed("/Users/test/code/project")).toBe(true);
    expect(isWorkspacePathAllowed("/etc")).toBe(false);
  });

  it("throws for paths outside the allowed roots", () => {
    vi.stubEnv("AO_ALLOWED_WORKSPACE_ROOTS", "/tmp/workspaces");

    expect(() => assertWorkspacePathAllowed("/etc", "Project path")).toThrow(
      "Access denied: Project path must be inside an allowed workspace root",
    );
  });
});
