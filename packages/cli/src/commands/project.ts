/**
 * `ao project` — manage projects in the global config registry.
 *
 * Subcommands:
 *   ao project list           List all registered projects
 *   ao project ls             Alias for list
 *   ao project add <path>     Register a directory as a project
 *   ao project remove <id>    Unregister a project (does NOT delete files)
 *   ao project set-default    Set the default project
 */

import chalk from "chalk";
import { resolve } from "node:path";
import type { Command } from "commander";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  scaffoldGlobalConfig,
  unregisterProject,
  deleteShadowFile,
  findProjectByPath,
  findGlobalConfigPath,
  loadConfig,
  registerNewProject,
  validateAndCommitRegistration,
  expandHome,
  loadPreferences,
  savePreferences,
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
  // ao project list (+ ls alias)
  // -------------------------------------------------------------------------
  const listAction = () => {
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

    const prefs = loadPreferences();

    console.log(chalk.bold(`\nRegistered projects (${ids.length})\n`));
    for (const id of ids) {
      const entry = globalConfig.projects[id];
      const isDefault = prefs.defaultProjectId === id;
      const def = isDefault ? chalk.cyan(" (default)") : "";
      console.log(`  ${chalk.green(id.padEnd(16))} ${entry.name ?? id}${def}`);
      console.log(chalk.dim(`  ${"".padEnd(16)} ${entry.path}`));
    }
    console.log();
  };

  projectCmd
    .command("list")
    .description("List all registered projects")
    .action(listAction);

  projectCmd
    .command("ls")
    .description("List all registered projects (alias for list)")
    .action(listAction);

  // -------------------------------------------------------------------------
  // ao project add <path>
  // -------------------------------------------------------------------------
  projectCmd
    .command("add <path>")
    .description("Register a directory as a project in the global config")
    .option("--id <id>", "Override the derived project ID")
    .option("--name <name>", "Human-readable project name")
    .option("-k, --key <key>", "Config project key (for multi-project configs)")
    .action(async (rawPath: string, opts: { id?: string; name?: string; key?: string }) => {
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

        // Prepare registration — pure, no disk writes yet.
        const reg = registerNewProject(globalConfig, projectPath, {
          explicitId: opts.id ?? opts.key,
          name: opts.name,
        });
        for (const msg of reg.messages) {
          if (msg.level === "warn") console.log(chalk.yellow(`  ⚠ ${msg.text}`));
          else if (msg.level === "success") console.log(chalk.dim(`  ✓ ${msg.text}`));
        }
        // Validate and commit atomically — throws on validation failure,
        // writes nothing until validation passes.
        validateAndCommitRegistration(reg, findGlobalConfigPath());

        console.log(chalk.green(`✓ Registered "${reg.projectId}" (${reg.configMode})`));
        console.log(chalk.dim(`  Path: ${projectPath}`));
        console.log(chalk.dim(`  Name: ${reg.updatedGlobalConfig.projects[reg.projectId]?.name ?? reg.projectId}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // ao project remove <id> (+ rm alias)
  // -------------------------------------------------------------------------
  const removeAction = async (projectId: string, opts: { force?: boolean }) => {
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

      // Remove from global config, then clean up shadow file
      const updated = unregisterProject(globalConfig, projectId);
      saveGlobalConfig(updated);
      deleteShadowFile(projectId);
      const prefs = loadPreferences();
      if (prefs.defaultProjectId === projectId) {
        delete prefs.defaultProjectId;
        savePreferences(prefs);
      }

      console.log(chalk.green(`✓ Removed "${projectId}" from global config`));
      console.log(chalk.dim("  Local config (if any) was NOT deleted."));
      console.log(chalk.dim("  Session data was NOT deleted."));

      // Warn if a daemon is running
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
  };

  projectCmd
    .command("remove <id>")
    .description("Remove a project from the global config registry")
    .option("--force", "Skip confirmation prompts")
    .action(removeAction);

  projectCmd
    .command("rm <id>")
    .description("Remove a project (alias for remove)")
    .option("--force", "Skip confirmation prompts")
    .action(removeAction);

  // -------------------------------------------------------------------------
  // ao project set-default <id>
  // -------------------------------------------------------------------------
  projectCmd
    .command("set-default <id>")
    .description("Set the default project")
    .action((id: string) => {
      const globalConfig = loadGlobalConfig();
      if (!globalConfig) {
        console.error(chalk.red("No global config found."));
        process.exit(1);
      }

      if (!globalConfig.projects[id]) {
        console.error(chalk.red(`Project "${id}" not found in global config`));
        process.exit(1);
      }

      const prefs = loadPreferences();
      prefs.defaultProjectId = id;
      savePreferences(prefs);
      console.log(chalk.green(`Set default project to "${id}"`));
    });
}
