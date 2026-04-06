/**
 * `ao project` — manage projects in the global config registry.
 *
 * Subcommands:
 *   ao project list           List all registered projects
 *   ao project add <path>     Register a directory as a project
 *   ao project remove <id>    Unregister a project (does NOT delete files)
 */

import chalk from "chalk";
import { resolve } from "node:path";
import type { Command } from "commander";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  scaffoldGlobalConfig,
  unregisterProject,
  findProjectByPath,
  findGlobalConfigPath,
  loadConfig,
  expandHome,
  registerNewProject,
  validateAndCommitRegistration,
} from "@composio/ao-core";
import { getSessionManager } from "../lib/create-session-manager.js";
import { getRunning } from "../lib/running-state.js";
import { promptConfirm } from "../lib/prompts.js";
import { isHumanCaller } from "../lib/caller-context.js";

export function registerProjectCommand(program: Command): void {
  const projectCmd = program
    .command("project")
    .description("Manage projects in the global config registry");

  // -------------------------------------------------------------------------
  // ao project list
  // -------------------------------------------------------------------------
  projectCmd
    .command("list")
    .description("List all registered projects")
    .action(() => {
      const globalConfig = loadGlobalConfig();
      if (!globalConfig) {
        console.log(chalk.dim("No global config found. Run `ao project add <path>` to register a project."));
        return;
      }

      const ids = Object.keys(globalConfig.projects);
      if (ids.length === 0) {
        console.log(chalk.dim("No projects registered."));
        return;
      }

      console.log(chalk.bold(`\nRegistered projects (${ids.length})\n`));
      for (const id of ids) {
        const entry = globalConfig.projects[id];
        console.log(`  ${chalk.green(id.padEnd(16))} ${entry.name ?? id}`);
        // Strip control characters from path before echoing to terminal
        // eslint-disable-next-line no-control-regex
        const safePath = entry.path.replace(/[\u0000-\u001F\u007F]/g, "");
        console.log(chalk.dim(`  ${"".padEnd(16)} ${safePath}`));
      }
      console.log();
    });

  // -------------------------------------------------------------------------
  // ao project add <path>
  // -------------------------------------------------------------------------
  projectCmd
    .command("add <path>")
    .description("Register a directory as a project in the global config")
    .option("--id <id>", "Override the derived project ID")
    .option("--name <name>", "Human-readable project name")
    .action(async (rawPath: string, opts: { id?: string; name?: string }) => {
      try {
        const projectPath = resolve(expandHome(rawPath));

        // Load or scaffold global config
        const globalConfig = loadGlobalConfig() ?? scaffoldGlobalConfig();

        // Check if already registered (exact path match)
        const existing = findProjectByPath(globalConfig, projectPath);
        if (existing) {
          const { id: existingId, entry } = existing;
          console.log(chalk.yellow(`Project already registered as "${existingId}" (${entry.name ?? existingId})`));
          console.log(chalk.dim(`  Path: ${entry.path}`));
          return;
        }

        const globalPath = findGlobalConfigPath();
        const warnings: string[] = [];

        // Build registration (pure — no disk writes)
        const reg = registerNewProject(globalConfig, projectPath, {
          explicitId: opts.id,
          name: opts.name,
        });

        for (const msg of reg.messages) {
          if (msg.level === "warn") {
            console.log(chalk.yellow(`  ${msg.text}`));
          }
        }

        // Validate and commit — throws on session prefix collision
        validateAndCommitRegistration(reg, globalPath, warnings);

        for (const w of warnings) {
          console.log(chalk.yellow(`  ${w}`));
        }

        console.log(chalk.green(`✓ Registered "${reg.projectId}"`));
        console.log(chalk.dim(`  Path: ${projectPath}`));
        console.log(chalk.dim(`  Name: ${reg.updatedGlobalConfig.projects[reg.projectId]?.name ?? reg.projectId}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // ao project remove <id>
  // -------------------------------------------------------------------------
  projectCmd
    .command("remove <id>")
    .description("Remove a project from the global config registry")
    .option("--force", "Skip confirmation prompts")
    .action(async (projectId: string, opts: { force?: boolean }) => {
      try {
        const globalConfig = loadGlobalConfig();
        if (!globalConfig) {
          console.error(chalk.red("No global config found. Nothing to remove."));
          process.exit(1);
        }

        const entry = globalConfig.projects[projectId];
        if (!entry) {
          console.error(chalk.red(`Project "${projectId}" not found in global config.`));
          console.error(chalk.dim(`Available: ${Object.keys(globalConfig.projects).join(", ")}`));
          process.exit(1);
        }

        // Check for active sessions
        let activeSessions: string[] = [];
        try {
          const config = loadConfig();
          const sm = await getSessionManager(config);
          const sessions = await sm.list(projectId);
          activeSessions = sessions.map((s) => s.id);
        } catch {
          // Session manager not available — proceed
        }

        // Show what will happen
        console.log(chalk.bold(`\nRemoving project "${entry.name ?? projectId}"\n`));
        console.log(chalk.dim(`  Path: ${entry.path}`));
        if (activeSessions.length > 0) {
          console.log(chalk.yellow(`  Active sessions: ${activeSessions.join(", ")}`));
        }
        console.log();

        // Confirm
        if (!opts.force && isHumanCaller()) {
          const confirmed = await promptConfirm(
            `Remove "${projectId}" from global config?${activeSessions.length > 0 ? " (active sessions will be orphaned)" : ""}`,
            false,
          );
          if (!confirmed) {
            console.log(chalk.dim("Cancelled."));
            return;
          }
        }

        const updated = unregisterProject(globalConfig, projectId);
        saveGlobalConfig(updated);

        console.log(chalk.green(`✓ Removed "${projectId}" from global config`));
        console.log(chalk.dim("  Local config (if any) was NOT deleted."));
        console.log(chalk.dim("  Session data was NOT deleted."));

        // Warn if a daemon is running — the lifecycle manager lives in the
        // `ao start` process and cannot be stopped cross-process. The project
        // has been removed from config so no new sessions will be created, but
        // existing polls will continue until the daemon is restarted.
        try {
          const running = await getRunning();
          if (running) {
            console.log(chalk.yellow(`\n  ⚠ ao start is running (PID ${running.pid}). Restart it to stop lifecycle polling for "${projectId}".`));
            console.log(chalk.dim(`    Run: ao stop && ao start`));
          }
        } catch {
          // Not critical — running.json may not exist
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
