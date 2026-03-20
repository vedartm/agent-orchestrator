"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import type { ProjectInfo } from "@/lib/project-name";
import type { DashboardSession } from "@/lib/types";
import { getAttentionLevel, type AttentionLevel } from "@/lib/types";
import { isOrchestratorSession } from "@composio/ao-core/types";

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  sessions: DashboardSession[];
  activeProjectId: string | undefined;
  activeSessionId: string | undefined;
}

type ProjectHealth = "red" | "yellow" | "green" | "gray";

function computeProjectHealth(sessions: DashboardSession[]): ProjectHealth {
  const workers = sessions.filter((s) => !isOrchestratorSession(s));
  if (workers.length === 0) return "gray";
  for (const s of workers) {
    if (getAttentionLevel(s) === "respond") return "red";
  }
  for (const s of workers) {
    const lvl = getAttentionLevel(s);
    if (lvl === "review" || lvl === "pending") return "yellow";
  }
  return "green";
}

const healthDotColor: Record<ProjectHealth, string> = {
  red: "var(--color-status-error)",
  yellow: "var(--color-status-attention)",
  green: "var(--color-status-ready)",
  gray: "var(--color-text-tertiary)",
};

const sessionDotColor: Record<AttentionLevel, string> = {
  merge: "var(--color-status-ready)",
  respond: "var(--color-status-error)",
  review: "var(--color-accent-orange)",
  pending: "var(--color-status-attention)",
  working: "var(--color-status-working)",
  done: "var(--color-text-tertiary)",
};

function SessionDot({ level }: { level: AttentionLevel }) {
  return (
    <div
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        level === "respond" && "animate-[activity-pulse_2s_ease-in-out_infinite]",
      )}
      style={{ background: sessionDotColor[level] }}
    />
  );
}

export function ProjectSidebar({
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
}: ProjectSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(activeProjectId && activeProjectId !== "all" ? [activeProjectId] : []),
  );

  useEffect(() => {
    if (activeProjectId && activeProjectId !== "all") {
      setExpandedProjects((prev) => new Set([...prev, activeProjectId]));
    }
  }, [activeProjectId]);

  const toggleExpand = (projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      next.has(projectId) ? next.delete(projectId) : next.add(projectId);
      return next;
    });
  };

  const handleProjectHeaderClick = (projectId: string) => {
    toggleExpand(projectId);
    router.push(pathname + `?project=${encodeURIComponent(projectId)}`);
  };

  if (projects.length <= 1) {
    return null;
  }

  return (
    <aside className="flex h-full w-[180px] flex-col border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
      <div className="border-b border-[var(--color-border-subtle)] px-3 py-3">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
          Projects
        </h2>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        <button
          onClick={() => router.push(pathname + "?project=all")}
          className={cn(
            "w-full px-3 py-2 text-left text-[13px] transition-colors",
            activeProjectId === undefined || activeProjectId === "all"
              ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
              : "text-[var(--color-text-secondary)] hover:bg-[rgba(255,255,255,0.03)] hover:text-[var(--color-text-primary)]",
          )}
        >
          All Projects
        </button>
        {projects.map((project) => {
          const projectSessions = sessions.filter((s) => s.projectId === project.id);
          const workerSessions = projectSessions.filter((s) => !isOrchestratorSession(s));
          const health = computeProjectHealth(projectSessions);
          const isExpanded = expandedProjects.has(project.id);
          const isActive = activeProjectId === project.id;

          return (
            <div key={project.id}>
              <button
                onClick={() => handleProjectHeaderClick(project.id)}
                className={cn(
                  "flex w-full items-center gap-1.5 px-3 py-2 text-left text-[13px] transition-colors",
                  isActive
                    ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
                    : "text-[var(--color-text-secondary)] hover:bg-[rgba(255,255,255,0.03)] hover:text-[var(--color-text-primary)]",
                )}
              >
                <svg
                  className={cn(
                    "h-3 w-3 shrink-0 transition-transform",
                    isExpanded && "rotate-90",
                  )}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
                <div
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    health === "red" && "animate-[activity-pulse_2s_ease-in-out_infinite]",
                  )}
                  style={{ background: healthDotColor[health] }}
                />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {workerSessions.length > 0 && (
                  <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
                    {workerSessions.length}
                  </span>
                )}
              </button>
              {isExpanded &&
                workerSessions.map((session) => {
                  const level = getAttentionLevel(session);
                  const isSessionActive = activeSessionId === session.id;
                  return (
                    <div
                      key={session.id}
                      role="button"
                      tabIndex={0}
                      onClick={() =>
                        router.push(
                          `${pathname}?project=${encodeURIComponent(project.id)}&session=${encodeURIComponent(session.id)}`,
                        )
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          router.push(
                            `${pathname}?project=${encodeURIComponent(project.id)}&session=${encodeURIComponent(session.id)}`,
                          );
                        }
                      }}
                      className={cn(
                        "relative flex w-full cursor-pointer items-center gap-1.5 py-1.5 pl-6 pr-3 transition-colors",
                        isSessionActive
                          ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
                          : "text-[var(--color-text-tertiary)] hover:bg-[rgba(255,255,255,0.03)] hover:text-[var(--color-text-secondary)]",
                      )}
                    >
                      <SessionDot level={level} />
                      <a
                        href={`/sessions/${encodeURIComponent(session.id)}`}
                        onClick={(e) => e.stopPropagation()}
                        className="relative z-10 min-w-0 flex-1 truncate font-mono text-[11px] hover:underline"
                      >
                        {session.id}
                      </a>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
