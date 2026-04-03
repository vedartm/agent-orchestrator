import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/Dashboard", () => ({
  Dashboard: (props: Record<string, unknown>) => (
    <div data-testid="dashboard">{JSON.stringify(props)}</div>
  ),
}));

vi.mock("@/lib/dashboard-page-data", () => ({
  getDashboardPageData: vi.fn(async () => ({
    sessions: [],
    selectedProjectId: "test-project",
    projectName: "Test",
    projects: [],
    globalPause: null,
    orchestrators: [],
  })),
  getDashboardProjectName: vi.fn(() => "Test"),
  resolveDashboardProjectFilter: vi.fn((p?: string) => p ?? "all"),
}));

describe("Home page", () => {
  it("renders Dashboard via dynamic import", async () => {
    const { default: Home } = await import("./page");
    const element = await Home({ searchParams: Promise.resolve({}) });

    render(element);

    await waitFor(() => {
      expect(screen.getByTestId("dashboard")).toBeInTheDocument();
    });
  });

  it("generates metadata with project name", async () => {
    const { generateMetadata } = await import("./page");
    const metadata = await generateMetadata({
      searchParams: Promise.resolve({ project: "my-app" }),
    });

    expect(metadata.title).toEqual({ absolute: "ao | Test" });
  });
});
