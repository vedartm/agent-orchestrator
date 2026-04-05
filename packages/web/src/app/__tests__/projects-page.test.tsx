import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedirect = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/projects/ao",
  useSearchParams: () => new URLSearchParams(),
  redirect: (url: string) => { mockRedirect(url); throw new Error("NEXT_REDIRECT"); },
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockGetAllProjects = vi.fn();
const mockLoadProjectPageData = vi.fn();
const mockLoadPortfolioPageData = vi.fn();
const mockGetDefaultCloneLocation = vi.fn().mockReturnValue("/tmp/clones");

vi.mock("@/lib/project-name", () => ({
  getAllProjects: () => mockGetAllProjects(),
}));

vi.mock("@/lib/project-page-data", () => ({
  loadProjectPageData: (...args: unknown[]) => mockLoadProjectPageData(...args),
}));

vi.mock("@/lib/portfolio-page-data", () => ({
  loadPortfolioPageData: () => mockLoadPortfolioPageData(),
}));

vi.mock("@/lib/default-location", () => ({
  getDefaultCloneLocation: () => mockGetDefaultCloneLocation(),
}));

vi.mock("@/components/Dashboard", () => ({
  Dashboard: ({ projectId }: { projectId: string }) => (
    <div data-testid="dashboard">{projectId}</div>
  ),
}));

vi.mock("@/components/DashboardShell", () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dashboard-shell">{children}</div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockReset();
});

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const loadPage = () => import("../projects/[projectId]/page.js").then((m) => m.default);

describe("ProjectPage", () => {
  it("renders Dashboard for a known project", async () => {
    mockGetAllProjects.mockReturnValue([{ id: "ao", name: "AO" }]);
    mockLoadProjectPageData.mockResolvedValue({
      sessions: [],
      selectedProjectId: "ao",
      projectName: "AO",
      projects: [{ id: "ao", name: "AO" }],
      globalPause: null,
      orchestrators: [],
    });
    mockLoadPortfolioPageData.mockResolvedValue({
      projectSummaries: [{ id: "ao", name: "AO" }],
      sessions: [],
    });

    const ProjectPage = await loadPage();
    const el = await ProjectPage({ params: Promise.resolve({ projectId: "ao" }) });
    render(el as React.ReactElement);

    expect(screen.getByTestId("dashboard-shell")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard")).toBeInTheDocument();
    expect(screen.getByText("ao")).toBeInTheDocument();
  });

  it("redirects for an unknown project ID", async () => {
    mockGetAllProjects.mockReturnValue([{ id: "ao", name: "AO" }]);

    const ProjectPage = await loadPage();
    await expect(ProjectPage({ params: Promise.resolve({ projectId: "unknown" }) })).rejects.toThrow();

    expect(mockRedirect).toHaveBeenCalledWith("/");
  });
});
