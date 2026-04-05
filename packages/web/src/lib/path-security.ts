import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export function isWithinDirectory(parentPath: string, childPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function getHomePath(): Promise<string> {
  return realpath(homedir()).catch(() => resolve(homedir()));
}

/**
 * Resolve a path by following symlinks via realpath. When the full path does
 * not exist yet (common for clone/init targets), walk up to find the deepest
 * existing ancestor, resolve it with realpath, and re-append the remaining
 * segments. This prevents a symlink in a parent directory from bypassing the
 * home-directory guard.
 */
async function resolveWithAncestorCheck(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath);
  } catch {
    // Walk up to find the deepest existing ancestor
    let current = targetPath;
    const pending: string[] = [];

    while (current !== dirname(current)) {
      pending.unshift(basename(current));
      current = dirname(current);
      try {
        const realAncestor = await realpath(current);
        return join(realAncestor, ...pending);
      } catch {
        // This ancestor doesn't exist either — keep walking up
      }
    }

    // Reached filesystem root without resolving — fall back to resolve()
    return resolve(targetPath);
  }
}

export async function resolveHomeScopedPath(rawPath?: string | null): Promise<{
  homePath: string;
  resolvedPath: string;
}> {
  const homePath = await getHomePath();
  const requestedPath = rawPath
    ? isAbsolute(rawPath)
      ? rawPath
      : join(homePath, rawPath)
    : homePath;

  const resolvedPath = await resolveWithAncestorCheck(resolve(requestedPath));
  return { homePath, resolvedPath };
}

export async function assertPathWithinHome(rawPath?: string | null): Promise<string> {
  const { homePath, resolvedPath } = await resolveHomeScopedPath(rawPath);
  if (!isWithinDirectory(homePath, resolvedPath)) {
    throw new Error(`Path is outside the allowed directory: ${homePath}`);
  }
  return resolvedPath;
}
