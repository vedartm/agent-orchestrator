import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import type { DashboardSession } from "@/lib/types";

const mockPush = vi.fn();
const mockPathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@composio/ao-core/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@composio/ao-core/types")>();
  return {
    ...actual,
    isOrchestratorSession: (s: { id: string; metadata?: Record<string, string> }) =>
      s.metadata?.["role"] === "orchestrator" || s.id.endsWith("-orchestrator"),
  };
});

function makeSession(overrides: Partial<DashboardSession> & { id: string; projectId: string }): DashboardSession {
  return {
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: null,
    summary: null,
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
    ...overrides,
  };
}

describe("ProjectSidebar", () => {
  const projects = [
    { id: "project-1", name: "Project One" },
    { id: "project-2", name: "Project Two" },
    { id: "project-3", name: "Project Three" },
  ];

  beforeEach(() => {
    mockPush.mockClear();
  });

  it("renders nothing when there is only one project", () => {
    const { container } = render(
      <ProjectSidebar
        projects={[projects[0]]}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there are no projects", () => {
    const { container } = render(
      <ProjectSidebar
        projects={[]}
        sessions={[]}
        activeProjectId={undefined}
        activeSessionId={undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders sidebar with all projects when there are multiple", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("All Projects")).toBeInTheDocument();
    expect(screen.getByText("Project One")).toBeInTheDocument();
    expect(screen.getByText("Project Two")).toBeInTheDocument();
    expect(screen.getByText("Project Three")).toBeInTheDocument();
  });

  it("highlights active project", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-2"
        activeSessionId={undefined}
      />,
    );
    const projectTwoButton = screen.getByRole("button", { name: /Project Two/ });
    expect(projectTwoButton.className).toContain("accent");
  });

  it("highlights 'All Projects' when no project is active", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId={undefined}
        activeSessionId={undefined}
      />,
    );
    const allProjectsButton = screen.getByRole("button", { name: "All Projects" });
    expect(allProjectsButton.className).toContain("accent");
  });

  it("navigates to project query param when clicking a project", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Project Two/ }));
    expect(mockPush).toHaveBeenCalledWith("/?project=project-2");
  });

  it("navigates to 'all' when clicking 'All Projects'", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "All Projects" }));
    expect(mockPush).toHaveBeenCalledWith("/?project=all");
  });

  it("encodes project ID in URL", () => {
    const projectsWithSpecialChars = [
      { id: "my-app", name: "My App" },
      { id: "other-project", name: "Other Project" },
    ];
    render(
      <ProjectSidebar
        projects={projectsWithSpecialChars}
        sessions={[]}
        activeProjectId="my-app"
        activeSessionId={undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Other Project/ }));
    expect(mockPush).toHaveBeenCalledWith("/?project=other-project");
  });

  // ── Health dot tests ───────────────────────────────────────────────

  it("health dot is red for respond-level session", () => {
    const sessions = [makeSession({ id: "s1", projectId: "project-1", status: "needs_input" })];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    // Health dot is the second div child of the button — find by color style
    const btn = screen.getByRole("button", { name: /Project One/ });
    const healthDot = btn.querySelector(`[style*="var(--color-status-error)"]`);
    expect(healthDot).toBeInTheDocument();
  });

  it("health dot is yellow for review-level session", () => {
    const sessions = [makeSession({ id: "s1", projectId: "project-1", status: "ci_failed" })];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    const btn = screen.getByRole("button", { name: /Project One/ });
    const healthDot = btn.querySelector(`[style*="var(--color-status-attention)"]`);
    expect(healthDot).toBeInTheDocument();
  });

  it("health dot is green when all sessions are working", () => {
    const sessions = [
      makeSession({ id: "s1", projectId: "project-1", status: "working", activity: "active" }),
    ];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    const btn = screen.getByRole("button", { name: /Project One/ });
    const healthDot = btn.querySelector(`[style*="var(--color-status-ready)"]`);
    expect(healthDot).toBeInTheDocument();
  });

  it("health dot is gray with no sessions", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    const btn = screen.getByRole("button", { name: /Project One/ });
    const healthDot = btn.querySelector(`[style*="var(--color-text-tertiary)"]`);
    expect(healthDot).toBeInTheDocument();
  });

  it("orchestrators are excluded from health computation", () => {
    const sessions = [
      makeSession({
        id: "p1-orchestrator",
        projectId: "project-1",
        status: "working",
        activity: "active",
      }),
    ];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    // With only an orchestrator session, health should be gray (no workers)
    const btn = screen.getByRole("button", { name: /Project One/ });
    const healthDot = btn.querySelector(`[style*="var(--color-text-tertiary)"]`);
    expect(healthDot).toBeInTheDocument();
  });

  // ── Expand/collapse tests ──────────────────────────────────────────

  it("active project is expanded by default", () => {
    const sessions = [makeSession({ id: "s1", projectId: "project-1" })];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    expect(screen.getByRole("link", { name: "s1" })).toBeInTheDocument();
  });

  it("clicking project header expands sessions", () => {
    const sessions = [makeSession({ id: "s1", projectId: "project-1" })];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-2"
        activeSessionId={undefined}
      />,
    );
    expect(screen.queryByRole("link", { name: "s1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Project One/ }));
    expect(screen.getByRole("link", { name: "s1" })).toBeInTheDocument();
  });

  it("clicking project header twice collapses sessions", () => {
    const sessions = [makeSession({ id: "s1", projectId: "project-1" })];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-2"
        activeSessionId={undefined}
      />,
    );
    const btn = screen.getByRole("button", { name: /Project One/ });
    // project-1 starts collapsed; first click expands it
    fireEvent.click(btn);
    expect(screen.getByRole("link", { name: "s1" })).toBeInTheDocument();
    // second click collapses it again
    fireEvent.click(btn);
    expect(screen.queryByRole("link", { name: "s1" })).toBeNull();
  });

  // ── Session count tests ────────────────────────────────────────────

  it("shows session count badge in project header", () => {
    const sessions = [
      makeSession({ id: "s1", projectId: "project-1" }),
      makeSession({ id: "s2", projectId: "project-1" }),
    ];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("orchestrators are excluded from session count", () => {
    const sessions = [
      makeSession({ id: "s1", projectId: "project-1" }),
      makeSession({ id: "project-1-orchestrator", projectId: "project-1" }),
    ];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  // ── Session row tests ──────────────────────────────────────────────

  it("session row has link to session detail", () => {
    const sessions = [makeSession({ id: "s1", projectId: "project-1" })];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    const link = screen.getByRole("link", { name: "s1" });
    expect(link).toHaveAttribute("href", "/sessions/s1");
  });

  it("clicking session row (not link) pushes ?project=&session= param", () => {
    const sessions = [makeSession({ id: "s1", projectId: "project-1" })];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    const row = screen.getByRole("button", { name: /s1/ });
    fireEvent.click(row);
    expect(mockPush).toHaveBeenCalledWith("/?project=project-1&session=s1");
  });

  it("clicking session link does NOT trigger router.push", () => {
    const sessions = [makeSession({ id: "s1", projectId: "project-1" })];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    const link = screen.getByRole("link", { name: "s1" });
    fireEvent.click(link);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("active session row has accent class", () => {
    const sessions = [makeSession({ id: "s1", projectId: "project-1" })];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId="s1"
      />,
    );
    const row = screen.getByRole("button", { name: /s1/ });
    expect(row.className).toContain("accent");
  });

  it("orchestrator sessions are not shown as sub-rows", () => {
    const sessions = [
      makeSession({ id: "s1", projectId: "project-1" }),
      makeSession({ id: "project-1-orchestrator", projectId: "project-1" }),
    ];
    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );
    expect(screen.getByRole("link", { name: "s1" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "project-1-orchestrator" })).toBeNull();
  });
});
