import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { utimesSync } from "node:fs";
import { join } from "node:path";

import {
  createTestContext,
  cleanupTestContext,
  makeHandle,
  createSessionManager as createSessionManagerImport,
  writeMetadata,
  readMetadataRaw,
} from "./fixtures.js";

import type { SCM } from "../../types.js";

describe("claimPR", () => {
  let ctx: ReturnType<typeof createTestContext>;

  function makeSCM(overrides: Partial<SCM> = {}): SCM {
    return {
      name: "mock-scm",
      detectPR: vi.fn(),
      resolvePR: vi.fn().mockResolvedValue({
        number: 42,
        url: "https://github.com/org/my-app/pull/42",
        title: "Existing PR",
        owner: "org",
        repo: "my-app",
        branch: "feat/existing-pr",
        baseBranch: "main",
        isDraft: false,
      }),
      assignPRToCurrentUser: vi.fn().mockResolvedValue(undefined),
      checkoutPR: vi.fn().mockResolvedValue(true),
      getPRState: vi.fn().mockResolvedValue("open"),
      getPRSummary: vi.fn(),
      mergePR: vi.fn(),
      closePR: vi.fn(),
      getCIChecks: vi.fn(),
      getCISummary: vi.fn(),
      getReviews: vi.fn(),
      getReviewDecision: vi.fn(),
      getPendingComments: vi.fn(),
      getAutomatedComments: vi.fn(),
      getMergeability: vi.fn(),
      ...overrides,
    };
  }

  function registryWithSCM(mockSCM: SCM) {
    return {
      ...ctx.mockRegistry,
      get: vi.fn().mockImplementation((slot: string, _name: string) => {
        if (slot === "runtime") return ctx.mockRuntime;
        if (slot === "agent") return ctx.mockAgent;
        if (slot === "workspace") return ctx.mockWorkspace;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };
  }

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  it("claims an open PR and updates session metadata", async () => {
    const mockSCM = makeSCM();

    writeMetadata(ctx.sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/old-branch",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-2", "42");

    expect(result.pr.number).toBe(42);
    expect(result.branchChanged).toBe(true);

    expect(mockSCM.resolvePR).toHaveBeenCalledWith("42", ctx.config.projects["my-app"]);
    expect(mockSCM.checkoutPR).toHaveBeenCalledWith(result.pr, "/tmp/ws-app-2");

    const raw = readMetadataRaw(ctx.sessionsDir, "app-2");
    expect(raw).toMatchObject({
      branch: "feat/existing-pr",
      status: "pr_open",
      pr: "https://github.com/org/my-app/pull/42",
    });
    expect(raw!["prAutoDetect"]).toBeUndefined();
  });

  it("consolidates ownership by disabling PR auto-detect on previous session", async () => {
    const mockSCM = makeSCM();

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/ws-app-1",
      branch: "feat/existing-pr",
      status: "review_pending",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    writeMetadata(ctx.sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/other-work",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-2", "42");

    expect(result.takenOverFrom).toEqual(["app-1"]);

    const previous = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(previous!["pr"]).toBeUndefined();
    expect(previous!["prAutoDetect"]).toBe("off");
    expect(previous!["status"]).toBe("working");
  });

  it("ignores legacy orchestrator metadata when claiming a PR", async () => {
    const mockSCM = makeSCM();

    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: ctx.config.projects["my-app"]!.path,
      branch: "feat/existing-pr",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: JSON.stringify(makeHandle("rt-orch")),
    });

    writeMetadata(ctx.sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/other-work",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-2", "42");

    expect(result.takenOverFrom).toEqual([]);
    expect(readMetadataRaw(ctx.sessionsDir, "app-2")!["pr"]).toBe(
      "https://github.com/org/my-app/pull/42",
    );
  });

  it("repairs legacy orchestrator PR metadata and stale duplicate PR attachments on read", async () => {
    writeMetadata(ctx.sessionsDir, "app-orchestrator", {
      worktree: ctx.config.projects["my-app"]!.path,
      branch: "main",
      status: "merged",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: JSON.stringify(makeHandle("rt-orch")),
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/ws-app-1",
      branch: "feat/existing-pr",
      status: "review_pending",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    writeMetadata(ctx.sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/existing-pr",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });

    const staleTime = new Date("2026-01-01T00:00:00.000Z");
    const freshTime = new Date("2026-01-02T00:00:00.000Z");
    utimesSync(join(ctx.sessionsDir, "app-1"), staleTime, staleTime);
    utimesSync(join(ctx.sessionsDir, "app-2"), freshTime, freshTime);

    const sm = createSessionManagerImport({ config: ctx.config, registry: ctx.mockRegistry });
    const sessions = await sm.list();

    expect(sessions).toHaveLength(3);

    const orchestrator = readMetadataRaw(ctx.sessionsDir, "app-orchestrator");
    expect(orchestrator!["role"]).toBe("orchestrator");
    expect(orchestrator!["pr"]).toBeUndefined();
    expect(orchestrator!["prAutoDetect"]).toBe("off");
    expect(orchestrator!["status"]).toBe("working");

    const staleWorker = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(staleWorker!["pr"]).toBeUndefined();
    expect(staleWorker!["prAutoDetect"]).toBe("off");
    expect(staleWorker!["status"]).toBe("working");

    const activeWorker = readMetadataRaw(ctx.sessionsDir, "app-2");
    expect(activeWorker!["pr"]).toBe("https://github.com/org/my-app/pull/42");
    expect(activeWorker!["status"]).toBe("pr_open");
  });

  it("repairs stale duplicate PR attachments before claim conflict checks", async () => {
    const mockSCM = makeSCM();

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/ws-app-1",
      branch: "feat/existing-pr",
      status: "review_pending",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });
    writeMetadata(ctx.sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/existing-pr",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });
    writeMetadata(ctx.sessionsDir, "app-3", {
      worktree: "/tmp/ws-app-3",
      branch: "feat/other-work",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-3")),
    });

    const staleTime = new Date("2026-01-01T00:00:00.000Z");
    const freshTime = new Date("2026-01-02T00:00:00.000Z");
    utimesSync(join(ctx.sessionsDir, "app-1"), staleTime, staleTime);
    utimesSync(join(ctx.sessionsDir, "app-2"), freshTime, freshTime);

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-3", "42");

    expect(result.takenOverFrom).toEqual(["app-2"]);

    const staleWorker = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(staleWorker!["pr"]).toBeUndefined();
    expect(staleWorker!["prAutoDetect"]).toBe("off");

    const activeWorker = readMetadataRaw(ctx.sessionsDir, "app-2");
    expect(activeWorker!["pr"]).toBeUndefined();
    expect(activeWorker!["prAutoDetect"]).toBe("off");

    const claimant = readMetadataRaw(ctx.sessionsDir, "app-3");
    expect(claimant!["pr"]).toBe("https://github.com/org/my-app/pull/42");
  });

  it("automatically consolidates ownership when another session tracks PR", async () => {
    const mockSCM = makeSCM();

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/ws-app-1",
      branch: "feat/existing-pr",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    writeMetadata(ctx.sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/other-work",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-2", "42");

    expect(result.takenOverFrom).toContain("app-1");
    expect(result.pr.number).toBe(42);

    const app2 = readMetadataRaw(ctx.sessionsDir, "app-2");
    expect(app2!["pr"]).toBe("https://github.com/org/my-app/pull/42");
    expect(app2!["status"]).toBe("pr_open");

    const app1 = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(app1!["pr"] ?? "").toBe("");
    expect(app1!["status"]).toBe("working");
  });

  it("keeps AO metadata updated even if GitHub assignment fails", async () => {
    const mockSCM = makeSCM({
      assignPRToCurrentUser: vi.fn().mockRejectedValue(new Error("permission denied")),
    });

    writeMetadata(ctx.sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/old-branch",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-2", "42", { assignOnGithub: true });

    expect(result.githubAssigned).toBe(false);
    expect(result.githubAssignmentError).toContain("permission denied");

    const raw = readMetadataRaw(ctx.sessionsDir, "app-2");
    expect(raw!["pr"]).toBe("https://github.com/org/my-app/pull/42");
    expect(raw!["status"]).toBe("pr_open");
  });

  it("allows same session to claim different PRs sequentially without rejection", async () => {
    const mockSCM = makeSCM({
      resolvePR: vi
        .fn()
        .mockResolvedValueOnce({
          number: 42,
          url: "https://github.com/org/my-app/pull/42",
          title: "First PR",
          owner: "org",
          repo: "my-app",
          branch: "feat/first-pr",
          baseBranch: "main",
          isDraft: false,
        })
        .mockResolvedValueOnce({
          number: 99,
          url: "https://github.com/org/my-app/pull/99",
          title: "Second PR",
          owner: "org",
          repo: "my-app",
          branch: "feat/second-pr",
          baseBranch: "main",
          isDraft: false,
        }),
      checkoutPR: vi.fn().mockResolvedValue(true),
    });

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/ws-app-1",
      branch: "feat/initial",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSCM(mockSCM) });

    // Claim first PR
    const result1 = await sm.claimPR("app-1", "42");
    expect(result1.pr.number).toBe(42);
    expect(result1.takenOverFrom).toEqual([]);

    let raw = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(raw!["pr"]).toBe("https://github.com/org/my-app/pull/42");

    // Claim second PR (switches ownership, no rejection)
    const result2 = await sm.claimPR("app-1", "99");
    expect(result2.pr.number).toBe(99);
    expect(result2.takenOverFrom).toEqual([]);

    raw = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(raw!["pr"]).toBe("https://github.com/org/my-app/pull/99");
    expect(raw!["branch"]).toBe("feat/second-pr");
  });

  it("handles idempotent re-claim of same PR by same session", async () => {
    const mockSCM = makeSCM();

    writeMetadata(ctx.sessionsDir, "app-1", {
      worktree: "/tmp/ws-app-1",
      branch: "feat/existing-pr",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSCM(mockSCM) });

    // Re-claim same PR - should succeed without consolidation
    const result = await sm.claimPR("app-1", "42");
    expect(result.pr.number).toBe(42);
    expect(result.takenOverFrom).toEqual([]);

    const raw = readMetadataRaw(ctx.sessionsDir, "app-1");
    expect(raw!["pr"]).toBe("https://github.com/org/my-app/pull/42");
  });

  it("consolidates from stale/dead prior owner regardless of status", async () => {
    const mockSCM = makeSCM();

    // Prior owner in "spawning" state (stuck/dead)
    writeMetadata(ctx.sessionsDir, "app-stale", {
      worktree: "/tmp/ws-app-stale",
      branch: "feat/existing-pr",
      status: "spawning", // Stuck in spawning
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: JSON.stringify(makeHandle("rt-stale")),
    });

    writeMetadata(ctx.sessionsDir, "app-2", {
      worktree: "/tmp/ws-app-2",
      branch: "feat/other",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-2")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-2", "42");

    // Consolidation happens regardless of prior owner's status
    expect(result.takenOverFrom).toContain("app-stale");
    expect(result.pr.number).toBe(42);

    // Prior owner is displaced
    const staleRaw = readMetadataRaw(ctx.sessionsDir, "app-stale");
    expect(staleRaw!["pr"] ?? "").toBe("");
    expect(staleRaw!["status"]).toBe("spawning"); // Status unchanged (not a PR-tracking status)
  });

  it("ensures exclusive PR ownership (only one active owner per PR)", async () => {
    const mockSCM = makeSCM();

    // First session owns PR
    writeMetadata(ctx.sessionsDir, "app-owner", {
      worktree: "/tmp/ws-owner",
      branch: "feat/existing-pr",
      status: "pr_open",
      project: "my-app",
      pr: "https://github.com/org/my-app/pull/42",
      runtimeHandle: JSON.stringify(makeHandle("rt-owner")),
    });

    // Second session wants to claim same PR
    writeMetadata(ctx.sessionsDir, "app-new", {
      worktree: "/tmp/ws-new",
      branch: "feat/other",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-new")),
    });

    const sm = createSessionManagerImport({ config: ctx.config, registry: registryWithSCM(mockSCM) });
    const result = await sm.claimPR("app-new", "42");

    // New owner succeeds, old owner is displaced
    expect(result.takenOverFrom).toEqual(["app-owner"]);

    const newOwner = readMetadataRaw(ctx.sessionsDir, "app-new");
    expect(newOwner!["pr"]).toBe("https://github.com/org/my-app/pull/42");

    const oldOwner = readMetadataRaw(ctx.sessionsDir, "app-owner");
    expect(oldOwner!["pr"] ?? "").toBe("");
  });
});
