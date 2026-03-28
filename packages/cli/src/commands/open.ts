import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "@composio/ao-core";
import { exec } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { formatAttachCommand } from "../lib/attach.js";

async function openInTerminal(sessionName: string, newWindow?: boolean): Promise<boolean> {
  try {
    const args = newWindow ? ["--new-window", sessionName] : [sessionName];
    await exec("open-iterm-tab", args);
    return true;
  } catch {
    // Fall back to tmux attach hint
    return false;
  }
}

export function registerOpen(program: Command): void {
  program
    .command("open")
    .description("Open session(s) in terminal tabs")
    .argument("[target]", 'Session name, project ID, or "all" to open everything')
    .option("-w, --new-window", "Open in a new terminal window")
    .action(async (target: string | undefined, opts: { newWindow?: boolean }) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);
      const allSessions = await sm.list();

      let sessionsToOpen = allSessions;

      if (!target || target === "all") {
        sessionsToOpen = allSessions;
      } else if (config.projects[target]) {
        sessionsToOpen = allSessions.filter((session) => session.projectId === target);
      } else if (allSessions.some((session) => session.id === target)) {
        sessionsToOpen = allSessions.filter((session) => session.id === target);
      } else {
        console.error(
          chalk.red(`Unknown target: ${target}\nSpecify a session name, project ID, or "all".`),
        );
        process.exit(1);
      }

      if (sessionsToOpen.length === 0) {
        console.log(chalk.dim("No sessions to open."));
        return;
      }

      console.log(
        chalk.bold(
          `Opening ${sessionsToOpen.length} session${sessionsToOpen.length !== 1 ? "s" : ""}...\n`,
        ),
      );

      for (const session of [...sessionsToOpen].sort((a, b) => a.id.localeCompare(b.id))) {
        const runtimeName = session.runtimeHandle?.runtimeName ?? config.defaults.runtime;
        const targetName = session.runtimeHandle?.id ?? session.id;
        const attachInfo = await sm.getAttachInfo(session.id).catch(() => null);
        const attachCommand = formatAttachCommand(attachInfo, `tmux attach -t ${targetName}`);
        const opened =
          runtimeName === "tmux" ? await openInTerminal(targetName, opts.newWindow) : false;
        if (opened) {
          console.log(chalk.green(`  Opened: ${session.id}`));
        } else {
          console.log(
            `  ${chalk.yellow(session.id)} — attach with: ${chalk.dim(attachCommand)}`,
          );
        }
      }
      console.log();
    });
}
