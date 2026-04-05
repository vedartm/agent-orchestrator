import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import {
  configToYaml,
  findConfigFile,
  generateConfigFromUrl,
  loadConfig,
  parseRepoUrl,
  sanitizeProjectId,
} from "@composio/ao-core";
import { CloneProjectSchema } from "@/lib/api-schemas";
import { extractFlatLocalConfig } from "@/lib/local-project-config";
import { migrateLegacyConfigForPortfolioRegistration } from "@/lib/legacy-config-migration";
import { assertPathWithinHome } from "@/lib/path-security";
import { registerAndResolveProject } from "@/lib/project-registration";

const execFileAsync = promisify(execFile);

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function ensureMissingOrEmptyDirectory(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new Error(`Target path exists and is not a directory: ${path}`);
    }
    throw new Error(`Target directory already exists: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = CloneProjectSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid clone request" },
        { status: 400 },
      );
    }

    const repo = parseRepoUrl(parsed.data.url);

    // Restrict clone URLs to known public SCM hosts to prevent SSRF
    const ALLOWED_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
    try {
      const parsedUrl = new URL(repo.cloneUrl);
      if (parsedUrl.protocol !== "https:" || !ALLOWED_HOSTS.has(parsedUrl.hostname)) {
        return NextResponse.json(
          { error: "Only HTTPS URLs from GitHub, GitLab, or Bitbucket are supported" },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json(
        { error: "Invalid clone URL" },
        { status: 400 },
      );
    }

    const cloneRoot = await assertPathWithinHome(parsed.data.location);
    const targetDir = resolve(cloneRoot, repo.repo);
    let projectKey = sanitizeProjectId(repo.repo);

    await ensureDirectory(cloneRoot);
    await ensureMissingOrEmptyDirectory(targetDir);

    await execFileAsync("git", ["clone", "--no-recurse-submodules", repo.cloneUrl, targetDir], {
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    // Check for a config file directly in the cloned directory (not walking up
    // the tree, which would find the global config and skip writing a local one).
    const localConfigPath = findConfigFile(targetDir);
    const hasLocalConfig =
      localConfigPath &&
      resolve(localConfigPath).startsWith(resolve(targetDir));

    if (!hasLocalConfig) {
      const config = generateConfigFromUrl({
        parsed: repo,
        repoPath: targetDir,
      });
      await writeFile(
        join(targetDir, "agent-orchestrator.yaml"),
        configToYaml(extractFlatLocalConfig(config, projectKey)),
        "utf-8",
      );
    } else {
      // Attempt legacy migration first — old-format configs are rejected by
      // loadLocalProjectConfig, so without migration the clone succeeds but
      // registration fails, leaving a dead-end directory.
      const migration = migrateLegacyConfigForPortfolioRegistration(targetDir, localConfigPath!);
      if (migration.migrated) {
        projectKey = migration.configProjectKey ?? projectKey;
      } else {
        const config = loadConfig(localConfigPath!);
        projectKey = Object.keys(config.projects)[0] ?? projectKey;
      }
    }

    const project = registerAndResolveProject(targetDir, {
      configProjectKey: projectKey,
    });

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        path: targetDir,
        repo: basename(targetDir),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to clone repository";
    // Return appropriate status codes for client-caused errors
    if (message.includes("already exists")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    if (message.includes("not a directory") || message.includes("outside the allowed")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
