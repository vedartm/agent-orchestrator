import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/PullRequestsPage", () => ({
  PullRequestsPage: (props: Record<string, unknown>) => (
    <div data-testid="pull-requests-page">{JSON.stringify(props)}</div>
  ),
}));

vi.mock("@/lib/dashboard-page-data", () => ({
  getDashboardPageData: vi.fn(async () => ({
    sessions: [],
    selectedProjectId: "test-project",
    projectName: "Test",
    projects: [],
    orchestrators: [],
  })),
  getDashboardProjectName: vi.fn(() => "Test"),
  resolveDashboardProjectFilter: vi.fn((p?: string) => p ?? "all"),
}));

describe("PullRequests page", () => {
  it("renders PullRequestsPage via dynamic import", async () => {
    const { default: PullRequestsRoute } = await import("./page");
    const element = await PullRequestsRoute({
      searchParams: Promise.resolve({}),
    });

    render(element);

    await waitFor(() => {
      expect(screen.getByTestId("pull-requests-page")).toBeInTheDocument();
    });
  });

  it("generates metadata with project name", async () => {
    const { generateMetadata } = await import("./page");
    const metadata = await generateMetadata({
      searchParams: Promise.resolve({ project: "my-app" }),
    });

    expect(metadata.title).toEqual({ absolute: "ao | Test PRs" });
  });
});
