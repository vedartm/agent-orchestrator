import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionDetail } from "../SessionDetail";
import { makeSession } from "../../__tests__/helpers";

// Default matchMedia in setup.ts returns matches: false (desktop viewport)

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../DirectTerminal", () => ({
  DirectTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="direct-terminal">{sessionId}</div>
  ),
}));

describe("SessionDetail desktop orchestrator header", () => {
  it("renders the header immediately even when orchestratorZones is undefined", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          metadata: { role: "orchestrator" },
          summary: "Orchestrator session",
          branch: null,
          createdAt: new Date().toISOString(),
        })}
        isOrchestrator
        orchestratorZones={undefined}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    // Header text should render immediately (not gated by zone data)
    // Headline appears in both breadcrumb and h1
    expect(screen.getAllByText("Orchestrator session").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("agents")).toBeInTheDocument();

    // Terminal section label should be present
    expect(screen.getByText("Live Terminal")).toBeInTheDocument();
  });

  it("shows skeleton placeholders for zone counts when zones are loading", () => {
    const { container } = render(
      <SessionDetail
        session={makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          metadata: { role: "orchestrator" },
          summary: "Loading zones test",
          branch: null,
          createdAt: new Date().toISOString(),
        })}
        isOrchestrator
        orchestratorZones={undefined}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    // Should have animated skeleton bones in the header side area
    const headerSide = container.querySelector(".session-page-header__side");
    expect(headerSide).toBeInTheDocument();
    const bones = headerSide!.querySelectorAll(".animate-pulse");
    expect(bones.length).toBeGreaterThanOrEqual(2);
  });

  it("fills in zone counts when data arrives", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          metadata: { role: "orchestrator" },
          summary: "Zones loaded test",
          branch: null,
          createdAt: new Date().toISOString(),
        })}
        isOrchestrator
        orchestratorZones={{ merge: 1, respond: 0, review: 2, pending: 0, working: 3, done: 0 }}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    // Total agent count should be visible
    expect(screen.getByText("6")).toBeInTheDocument();
    expect(screen.getByText("agents")).toBeInTheDocument();

    // Zone pills should render
    expect(screen.getByText("merge-ready")).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
  });
});
