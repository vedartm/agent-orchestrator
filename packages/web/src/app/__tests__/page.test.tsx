import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  notFound: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockGetAllProjects = vi.fn();
const mockLoadPortfolioPageData = vi.fn();
const mockGetDashboardProjectName = vi.fn();
const mockResolveDashboardProjectFilter = vi.fn();
const mockGetDefaultCloneLocation = vi.fn().mockReturnValue("/tmp/clones");

vi.mock("@/lib/project-name", () => ({
  getAllProjects: () => mockGetAllProjects(),
}));

vi.mock("@/lib/portfolio-page-data", () => ({
  loadPortfolioPageData: () => mockLoadPortfolioPageData(),
}));

vi.mock("@/lib/dashboard-page-data", () => ({
  getDashboardProjectName: (...args: unknown[]) => mockGetDashboardProjectName(...args),
  resolveDashboardProjectFilter: (...args: unknown[]) => mockResolveDashboardProjectFilter(...args),
}));

vi.mock("@/lib/default-location", () => ({
  getDefaultCloneLocation: () => mockGetDefaultCloneLocation(),
}));

vi.mock("@/components/PortfolioPage", () => ({
  PortfolioPage: ({ projectSummaries }: { projectSummaries: { id: string; name: string }[] }) => (
    <div data-testid="portfolio-page">
      {projectSummaries.map((p) => p.name).join(",")}
    </div>
  ),
}));

vi.mock("@/components/DashboardShell", () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dashboard-shell">{children}</div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  global.EventSource = Object.assign(vi.fn(() => ({ onmessage: null, onerror: null, close: vi.fn() })), {
    CONNECTING: 0, OPEN: 1, CLOSED: 2,
  }) as unknown as typeof EventSource;
});

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const loadPage = () => import("../page.js").then((m) => m.default);

describe("Home page", () => {
  it("renders PortfolioPage with project summaries", async () => {
    mockLoadPortfolioPageData.mockResolvedValue({
      projectSummaries: [
        { id: "ao", name: "Agent Orchestrator" },
        { id: "ds", name: "Docs Server" },
      ],
      sessions: [],
      orphanedSessionCount: 0,
    });

    const Home = await loadPage();
    const el = await Home({});
    render(el as React.ReactElement);

    expect(screen.getByTestId("dashboard-shell")).toBeInTheDocument();
    expect(screen.getByTestId("portfolio-page")).toBeInTheDocument();
    expect(screen.getByText(/Agent Orchestrator/)).toBeInTheDocument();
  });

  it("renders PortfolioPage when zero projects", async () => {
    mockLoadPortfolioPageData.mockResolvedValue({
      projectSummaries: [],
      sessions: [],
      orphanedSessionCount: 0,
    });

    const Home = await loadPage();
    const el = await Home({});
    render(el as React.ReactElement);

    expect(screen.getByTestId("portfolio-page")).toBeInTheDocument();
  });

  it("renders DashboardShell wrapper", async () => {
    mockLoadPortfolioPageData.mockResolvedValue({
      projectSummaries: [{ id: "ao", name: "AO" }],
      sessions: [],
      orphanedSessionCount: 0,
    });

    const Home = await loadPage();
    const el = await Home({});
    render(el as React.ReactElement);

    expect(screen.getByTestId("dashboard-shell")).toBeInTheDocument();
    expect(screen.getByTestId("portfolio-page")).toBeInTheDocument();
  });

  it("passes orphaned session count to PortfolioPage", async () => {
    mockLoadPortfolioPageData.mockResolvedValue({
      projectSummaries: [{ id: "ao", name: "AO" }],
      sessions: [],
      orphanedSessionCount: 3,
    });

    const Home = await loadPage();
    const el = await Home({});
    render(el as React.ReactElement);

    expect(screen.getByTestId("portfolio-page")).toBeInTheDocument();
  });
});
