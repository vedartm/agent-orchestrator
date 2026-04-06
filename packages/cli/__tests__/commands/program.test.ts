/**
 * Tests for the deprecated lifecycle-worker stub in program.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks for all commands registered by createProgram
// ---------------------------------------------------------------------------

const {
  mockRegisterInit,
  mockRegisterStart,
  mockRegisterStop,
  mockRegisterStatus,
  mockRegisterSpawn,
  mockRegisterBatchSpawn,
  mockRegisterSession,
  mockRegisterSend,
  mockRegisterReviewCheck,
  mockRegisterDashboard,
  mockRegisterOpen,
  mockRegisterProjectCommand,
  mockRegisterVerify,
  mockRegisterDoctor,
  mockRegisterUpdate,
  mockRegisterSetup,
  mockRegisterPlugin,
  mockGetConfigInstruction,
  mockGetCliVersion,
} = vi.hoisted(() => ({
  mockRegisterInit: vi.fn(),
  mockRegisterStart: vi.fn(),
  mockRegisterStop: vi.fn(),
  mockRegisterStatus: vi.fn(),
  mockRegisterSpawn: vi.fn(),
  mockRegisterBatchSpawn: vi.fn(),
  mockRegisterSession: vi.fn(),
  mockRegisterSend: vi.fn(),
  mockRegisterReviewCheck: vi.fn(),
  mockRegisterDashboard: vi.fn(),
  mockRegisterOpen: vi.fn(),
  mockRegisterProjectCommand: vi.fn(),
  mockRegisterVerify: vi.fn(),
  mockRegisterDoctor: vi.fn(),
  mockRegisterUpdate: vi.fn(),
  mockRegisterSetup: vi.fn(),
  mockRegisterPlugin: vi.fn(),
  mockGetConfigInstruction: vi.fn().mockReturnValue("config help text"),
  mockGetCliVersion: vi.fn().mockReturnValue("0.0.0-test"),
}));

vi.mock("../../src/commands/init.js", () => ({ registerInit: mockRegisterInit }));
vi.mock("../../src/commands/start.js", () => ({
  registerStart: mockRegisterStart,
  registerStop: mockRegisterStop,
}));
vi.mock("../../src/commands/status.js", () => ({ registerStatus: mockRegisterStatus }));
vi.mock("../../src/commands/spawn.js", () => ({
  registerSpawn: mockRegisterSpawn,
  registerBatchSpawn: mockRegisterBatchSpawn,
}));
vi.mock("../../src/commands/session.js", () => ({ registerSession: mockRegisterSession }));
vi.mock("../../src/commands/send.js", () => ({ registerSend: mockRegisterSend }));
vi.mock("../../src/commands/review-check.js", () => ({ registerReviewCheck: mockRegisterReviewCheck }));
vi.mock("../../src/commands/dashboard.js", () => ({ registerDashboard: mockRegisterDashboard }));
vi.mock("../../src/commands/open.js", () => ({ registerOpen: mockRegisterOpen }));
vi.mock("../../src/commands/project.js", () => ({ registerProjectCommand: mockRegisterProjectCommand }));
vi.mock("../../src/commands/verify.js", () => ({ registerVerify: mockRegisterVerify }));
vi.mock("../../src/commands/doctor.js", () => ({ registerDoctor: mockRegisterDoctor }));
vi.mock("../../src/commands/update.js", () => ({ registerUpdate: mockRegisterUpdate }));
vi.mock("../../src/commands/setup.js", () => ({ registerSetup: mockRegisterSetup }));
vi.mock("../../src/commands/plugin.js", () => ({ registerPlugin: mockRegisterPlugin }));
vi.mock("../../src/lib/config-instruction.js", () => ({
  getConfigInstruction: mockGetConfigInstruction,
}));
vi.mock("../../src/options/version.js", () => ({ getCliVersion: mockGetCliVersion }));

import { createProgram } from "../../src/program.js";

describe("createProgram — lifecycle-worker stub", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleErrorSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processExitSpy: any;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    processExitSpy = vi.spyOn(process, "exit").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((_code?: any) => { throw new Error(`process.exit(${_code})`); }) as never,
    );
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it("lifecycle-worker command calls console.error with deprecation message and exits with code 1", async () => {
    const program = createProgram();
    program.exitOverride(); // Prevent commander from calling process.exit itself

    await expect(
      program.parseAsync(["node", "ao", "lifecycle-worker"]),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("deprecated"),
    );
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
