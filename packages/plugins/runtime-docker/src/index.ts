import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type {
  AttachInfo,
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);
const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const LONG_MESSAGE_THRESHOLD = 200;

export const manifest = {
  name: "docker",
  slot: "runtime" as const,
  description: "Runtime plugin: Docker containers with tmux-backed interactive sessions",
  version: "0.1.0",
};

interface DockerRuntimeConfig {
  image?: string;
  shell?: string;
  user?: string;
  network?: string;
  readOnlyRoot?: boolean;
  capDrop?: string[];
  tmpfs?: string[];
  limits?: {
    cpus?: number | string;
    memory?: string;
    gpus?: string;
  };
}

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDockerRuntimeConfig(config?: Record<string, unknown>): DockerRuntimeConfig {
  return isPlainObject(config) ? (config as DockerRuntimeConfig) : {};
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    timeout: DOCKER_COMMAND_TIMEOUT_MS,
  });
  return stdout.trimEnd();
}

async function dockerExec(containerName: string, args: string[]): Promise<string> {
  return docker(["exec", containerName, ...args]);
}

async function dockerTmux(containerName: string, args: string[]): Promise<string> {
  return dockerExec(containerName, ["tmux", ...args]);
}

function getDefaultDockerUser(): string | undefined {
  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    return `${process.getuid()}:${process.getgid()}`;
  }
  return undefined;
}

function getContainerName(handle: RuntimeHandle): string {
  const containerName = handle.data["containerName"];
  return typeof containerName === "string" && containerName.length > 0 ? containerName : handle.id;
}

function getTmuxSessionName(handle: RuntimeHandle): string {
  const tmuxSessionName = handle.data["tmuxSessionName"];
  return typeof tmuxSessionName === "string" && tmuxSessionName.length > 0
    ? tmuxSessionName
    : handle.id;
}

function parseCpuPercent(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/%$/, "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMemoryMb(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const usage = value.split("/")[0]?.trim();
  if (!usage) return undefined;

  const match = usage.match(/^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)$/);
  if (!match) return undefined;

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return undefined;

  const unit = match[2];
  const multipliers: Record<string, number> = {
    B: 1 / 1_000_000,
    kB: 1 / 1_000,
    KB: 1 / 1_000,
    KiB: 1 / 1024,
    MB: 1,
    MiB: 1,
    GB: 1_000,
    GiB: 1024,
    TB: 1_000_000,
    TiB: 1_048_576,
  };

  const multiplier = multipliers[unit];
  if (multiplier === undefined) return undefined;
  return Number.parseFloat((amount * multiplier).toFixed(2));
}

async function getDockerStats(
  containerName: string,
): Promise<Pick<RuntimeMetrics, "cpuPercent" | "memoryMb">> {
  try {
    const output = await docker(["stats", "--no-stream", "--format", "{{json .}}", containerName]);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return {
      cpuPercent: parseCpuPercent(parsed["CPUPerc"]),
      memoryMb: parseMemoryMb(parsed["MemUsage"]),
    };
  } catch {
    return {};
  }
}

async function removeContainer(containerName: string): Promise<void> {
  try {
    await docker(["rm", "-f", containerName]);
  } catch {
    // Best-effort cleanup
  }
}

async function sendTextToTmux(
  containerName: string,
  tmuxSessionName: string,
  text: string,
  clearInput = true,
): Promise<void> {
  if (clearInput) {
    await dockerTmux(containerName, ["send-keys", "-t", tmuxSessionName, "C-u"]);
    await sleep(200);
  }

  if (text.includes("\n") || text.length > LONG_MESSAGE_THRESHOLD) {
    const bufferName = `ao-${randomUUID()}`;
    const tmpName = `/tmp/ao-${randomUUID()}.txt`;
    const hostTmpPath = join(tmpdir(), `ao-docker-${randomUUID()}.txt`);
    writeFileSync(hostTmpPath, text, { encoding: "utf-8", mode: 0o600 });
    try {
      await docker(["cp", hostTmpPath, `${containerName}:${tmpName}`]);
      await dockerTmux(containerName, ["load-buffer", "-b", bufferName, tmpName]);
      await dockerTmux(containerName, [
        "paste-buffer",
        "-b",
        bufferName,
        "-t",
        tmuxSessionName,
        "-d",
      ]);
    } finally {
      try {
        unlinkSync(hostTmpPath);
      } catch {
        // ignore cleanup failure
      }
      await dockerExec(containerName, ["rm", "-f", tmpName]).catch(() => undefined);
      await dockerTmux(containerName, ["delete-buffer", "-b", bufferName]).catch(() => undefined);
    }
  } else {
    await dockerTmux(containerName, ["send-keys", "-t", tmuxSessionName, "-l", text]);
  }

  await sleep(300);
  await dockerTmux(containerName, ["send-keys", "-t", tmuxSessionName, "Enter"]);
}

export function create(): Runtime {
  return {
    name: "docker",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);

      const runtimeConfig = parseDockerRuntimeConfig(config.runtimeConfig);
      if (!runtimeConfig.image) {
        throw new Error("Docker runtime requires runtimeConfig.image");
      }

      const containerName = config.sessionId;
      const tmuxSessionName = config.sessionId;
      const shell = runtimeConfig.shell ?? "/bin/sh";

      const runArgs = [
        "run",
        "-d",
        "--name",
        containerName,
        "--workdir",
        config.workspacePath,
        "--volume",
        `${config.workspacePath}:${config.workspacePath}`,
      ];

      const dockerUser = runtimeConfig.user ?? getDefaultDockerUser();
      if (dockerUser) {
        runArgs.push("--user", dockerUser);
      }
      if (runtimeConfig.network) {
        runArgs.push("--network", runtimeConfig.network);
      }
      if (runtimeConfig.readOnlyRoot) {
        runArgs.push("--read-only");
      }
      for (const cap of runtimeConfig.capDrop ?? []) {
        runArgs.push("--cap-drop", cap);
      }
      for (const mount of runtimeConfig.tmpfs ?? []) {
        runArgs.push("--tmpfs", mount);
      }
      if (runtimeConfig.limits?.cpus !== undefined) {
        runArgs.push("--cpus", String(runtimeConfig.limits.cpus));
      }
      if (runtimeConfig.limits?.memory) {
        runArgs.push("--memory", runtimeConfig.limits.memory);
      }
      if (runtimeConfig.limits?.gpus) {
        runArgs.push("--gpus", runtimeConfig.limits.gpus);
      }

      runArgs.push(
        runtimeConfig.image,
        shell,
        "-lc",
        "trap 'exit 0' TERM INT; while :; do sleep 3600; done",
      );

      try {
        await docker(runArgs);
        const envArgs: string[] = [];
        for (const [key, value] of Object.entries(config.environment ?? {})) {
          envArgs.push("-e", `${key}=${value}`);
        }
        await dockerTmux(containerName, [
          "new-session",
          "-d",
          "-s",
          tmuxSessionName,
          "-c",
          config.workspacePath,
          ...envArgs,
        ]);
        await sendTextToTmux(containerName, tmuxSessionName, config.launchCommand, false);
      } catch (err) {
        await removeContainer(containerName);
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to create docker runtime for session "${config.sessionId}": ${msg}`,
          {
            cause: err,
          },
        );
      }

      return {
        id: containerName,
        runtimeName: "docker",
        data: {
          containerName,
          tmuxSessionName,
          workspacePath: config.workspacePath,
          createdAt: Date.now(),
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      await removeContainer(getContainerName(handle));
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      await sendTextToTmux(getContainerName(handle), getTmuxSessionName(handle), message, true);
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await dockerTmux(getContainerName(handle), [
          "capture-pane",
          "-t",
          getTmuxSessionName(handle),
          "-p",
          "-S",
          `-${lines}`,
        ]);
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        const output = await docker([
          "inspect",
          "-f",
          "{{.State.Running}}",
          getContainerName(handle),
        ]);
        return output.trim() === "true";
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data["createdAt"] as number) ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
        ...(await getDockerStats(getContainerName(handle))),
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      const containerName = getContainerName(handle);
      const tmuxSessionName = getTmuxSessionName(handle);
      return {
        type: "docker",
        target: containerName,
        command: `docker exec -it ${containerName} tmux attach -t ${tmuxSessionName}`,
        program: "docker",
        args: ["exec", "-it", containerName, "tmux", "attach", "-t", tmuxSessionName],
        requiresPty: true,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
