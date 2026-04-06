import { readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

export interface RunningState {
  pid: number;
  /**
   * PIDs of secondary `ao start` processes that attached to this running instance
   * to provide lifecycle coverage for projects the original daemon doesn't cover.
   * `ao stop` kills these alongside `pid` so none become orphaned.
   */
  secondaryPids?: number[];
  configPath: string;
  port: number;
  startedAt: string;
  projects: string[];
}

const STATE_DIR = join(homedir(), ".agent-orchestrator");
const STATE_FILE = join(STATE_DIR, "running.json");
const LOCK_FILE = join(STATE_DIR, "running.lock");

function ensureDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Try to create the lockfile atomically. Returns a release function on success, null on failure. */
function tryAcquire(): (() => void) | null {
  try {
    const fd = openSync(LOCK_FILE, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    closeSync(fd);
    return () => {
      try { unlinkSync(LOCK_FILE); } catch { /* best effort */ }
    };
  } catch {
    return null;
  }
}

/**
 * Advisory lockfile using O_EXCL for atomic creation.
 * Retries with jittered backoff. After timeout, assumes the lock is stale
 * (holder crashed) and force-removes it before one final atomic attempt.
 */
async function acquireLock(timeoutMs = 5000): Promise<() => void> {
  ensureDir();

  const start = Date.now();
  let attempt = 0;

  while (true) {
    const release = tryAcquire();
    if (release) return release;

    if (Date.now() - start > timeoutMs) {
      // Likely stale — remove and make one final atomic attempt.
      try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
      const finalRelease = tryAcquire();
      if (finalRelease) return finalRelease;
      throw new Error("Could not acquire running.json lock");
    }

    // Jittered backoff: 30-70ms base, growing with attempts (capped at 200ms)
    const baseMs = Math.min(50 + attempt * 20, 200);
    const jitter = Math.floor(Math.random() * 40) - 20;
    await sleep(baseMs + jitter);
    attempt++;
  }
}

function readState(): RunningState | null {
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw) as RunningState;
    if (!state || typeof state.pid !== "number") return null;
    return state;
  } catch {
    return null;
  }
}

function writeState(state: RunningState | null): void {
  ensureDir();
  if (state === null) {
    try { unlinkSync(STATE_FILE); } catch { /* file may not exist */ }
  } else {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  }
}

/**
 * Register the current AO instance as running.
 * Uses a lockfile to prevent concurrent registration.
 */
export async function register(entry: RunningState): Promise<void> {
  const release = await acquireLock();
  try {
    writeState(entry);
  } finally {
    release();
  }
}

/**
 * Add a project and this process's PID to the existing running instance.
 *
 * Used when `ao start` attaches to a running daemon and pins its own lifecycle
 * worker for a project the daemon doesn't cover. Records both the project ID
 * (so the dashboard knows it exists) and `process.pid` in `secondaryPids` (so
 * `ao stop` can SIGTERM this process alongside the original daemon).
 *
 * No-ops if there is no active running instance.
 */
export async function addProjectToRunning(projectId: string): Promise<void> {
  const release = await acquireLock();
  try {
    const state = readState();
    if (!state || !isProcessAlive(state.pid)) return;
    const projects = state.projects.includes(projectId)
      ? state.projects
      : [...state.projects, projectId];
    const existing = state.secondaryPids ?? [];
    const secondaryPids = existing.includes(process.pid)
      ? existing
      : [...existing, process.pid];
    writeState({ ...state, projects, secondaryPids });
  } finally {
    release();
  }
}

/**
 * Send SIGTERM (and SIGKILL fallback) to all PIDs associated with a running
 * instance — the main daemon PID and any secondary PIDs registered by attached
 * `ao start` processes. Callers should call `unregister()` afterwards.
 *
 * @param signal - Signal to send. Defaults to "SIGTERM".
 */
export function killRunningInstance(state: RunningState, signal: NodeJS.Signals = "SIGTERM"): void {
  const pids = [state.pid, ...(state.secondaryPids ?? [])];
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch { /* already dead */ }
  }
}

/**
 * Unregister the running AO instance.
 */
export async function unregister(): Promise<void> {
  const release = await acquireLock();
  try {
    writeState(null);
  } finally {
    release();
  }
}

/**
 * Get the currently running AO instance, if any.
 * Auto-prunes stale entries (dead PIDs).
 */
export async function getRunning(): Promise<RunningState | null> {
  const release = await acquireLock();
  try {
    const state = readState();
    if (!state) return null;

    if (!isProcessAlive(state.pid)) {
      // Stale entry — process is dead, clean up
      writeState(null);
      return null;
    }

    return state;
  } finally {
    release();
  }
}

/**
 * Check if AO is already running.
 * Returns the running state if alive, null otherwise.
 */
export async function isAlreadyRunning(): Promise<RunningState | null> {
  return getRunning();
}

/**
 * Wait for a process to exit, polling isProcessAlive.
 * Returns true if the process exited, false if timeout reached.
 */
export async function waitForExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessAlive(pid);
}
