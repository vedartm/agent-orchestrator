import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: mockSpawn,
  };
});

import { runAttachCommand } from "../../src/lib/attach.js";

function makeChild(exitCode = 0): EventEmitter {
  const child = new EventEmitter() as EventEmitter & { stdio?: unknown };
  queueMicrotask(() => {
    child.emit("exit", exitCode);
  });
  return child;
}

beforeEach(() => {
  mockSpawn.mockReset();
  process.env["SHELL"] = "/bin/zsh";
});

describe("runAttachCommand", () => {
  it("uses structured attach info when program/args are provided", async () => {
    mockSpawn.mockReturnValue(makeChild());

    await runAttachCommand(
      {
        type: "docker",
        target: "container-1",
        program: "docker",
        args: ["exec", "-it", "container-1", "tmux", "attach", "-t", "tmux-1"],
      },
      { program: "tmux", args: ["attach", "-t", "fallback"] },
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      "docker",
      ["exec", "-it", "container-1", "tmux", "attach", "-t", "tmux-1"],
      { stdio: "inherit" },
    );
  });

  it("uses shell -c when only a command string is available", async () => {
    mockSpawn.mockReturnValue(makeChild());

    await runAttachCommand(
      {
        type: "docker",
        target: "container-1",
        command: "docker exec -it container-1 tmux attach -t tmux-1",
      },
      { program: "tmux", args: ["attach", "-t", "fallback"] },
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-c", "docker exec -it container-1 tmux attach -t tmux-1"],
      { stdio: "inherit" },
    );
  });
});
