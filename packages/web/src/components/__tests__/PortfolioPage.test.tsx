import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PortfolioPage } from "../PortfolioPage";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

beforeEach(() => {
  const eventSourceMock = {
    onmessage: null,
    onerror: null,
    close: vi.fn(),
  };
  const eventSourceConstructor = vi.fn(() => eventSourceMock as unknown as EventSource);
  global.EventSource = Object.assign(eventSourceConstructor, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSED: 2,
  }) as unknown as typeof EventSource;
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ sessions: [] }),
  });
});

describe("PortfolioPage", () => {
  it("renders empty state when no projects", () => {
    render(<PortfolioPage projects={[]} initialCards={[]} />);
    expect(screen.getByText(/No projects registered/i)).toBeTruthy();
  });

  it("renders project cards", () => {
    const projects = [
      { id: "ao", name: "Agent Orchestrator" },
      { id: "ds", name: "Docs Server" },
    ];
    const cards = [
      {
        id: "ao",
        name: "Agent Orchestrator",
        sessionCounts: { total: 3, working: 1, pending: 1, review: 1, respond: 0, ready: 0 },
      },
      {
        id: "ds",
        name: "Docs Server",
        sessionCounts: { total: 0, working: 0, pending: 0, review: 0, respond: 0, ready: 0 },
      },
    ];
    render(<PortfolioPage projects={projects} initialCards={cards} />);
    expect(screen.getAllByText("Agent Orchestrator").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Docs Server").length).toBeGreaterThan(0);
    expect(screen.getByText("3 sessions")).toBeTruthy();
    expect(screen.getByText("0 sessions")).toBeTruthy();
  });

  it("renders session count badges", () => {
    const projects = [{ id: "ao", name: "AO" }];
    const cards = [
      {
        id: "ao",
        name: "AO",
        sessionCounts: { total: 5, working: 2, pending: 1, review: 1, respond: 1, ready: 0 },
      },
    ];
    render(<PortfolioPage projects={projects} initialCards={cards} />);
    expect(screen.getByText("2 Working")).toBeTruthy();
    expect(screen.getByText("1 Pending")).toBeTruthy();
    expect(screen.getByText("1 Review")).toBeTruthy();
    expect(screen.getByText("1 Respond")).toBeTruthy();
  });

  it("renders All Projects header", () => {
    render(<PortfolioPage projects={[{ id: "ao", name: "AO" }]} initialCards={[]} />);
    expect(screen.getByText("All Projects")).toBeTruthy();
  });

  it("links project cards to /projects/[id]", () => {
    const projects = [{ id: "ao", name: "AO" }];
    const cards = [
      {
        id: "ao",
        name: "AO",
        sessionCounts: { total: 0, working: 0, pending: 0, review: 0, respond: 0, ready: 0 },
      },
    ];
    render(<PortfolioPage projects={projects} initialCards={cards} />);
    const link = screen.getByRole("link", { name: /AO/i });
    expect(link.getAttribute("href")).toBe("/projects/ao");
  });

  it("does not render zero-count badges", () => {
    const projects = [{ id: "ao", name: "AO" }];
    const cards = [
      {
        id: "ao",
        name: "AO",
        sessionCounts: { total: 1, working: 1, pending: 0, review: 0, respond: 0, ready: 0 },
      },
    ];
    render(<PortfolioPage projects={projects} initialCards={cards} />);
    expect(screen.getByText("1 Working")).toBeTruthy();
    expect(screen.queryByText(/Pending/)).toBeNull();
    expect(screen.queryByText(/Review/)).toBeNull();
  });

  it("updates cards from polling when sessions are returned", async () => {
    vi.useFakeTimers();
    const projects = [{ id: "ao", name: "AO" }];
    const initialCards = [
      {
        id: "ao",
        name: "AO",
        sessionCounts: { total: 0, working: 0, pending: 0, review: 0, respond: 0, ready: 0 },
      },
    ];

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          sessions: [
            { id: "s1", projectId: "ao", status: "working" },
            { id: "s2", projectId: "ao", status: "review_pending" },
            { id: "s3", projectId: "ao", status: "merged" }, // done — excluded
          ],
        }),
    });

    const { act } = await import("@testing-library/react");
    render(<PortfolioPage projects={projects} initialCards={initialCards} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("2 sessions")).toBeTruthy();
    expect(screen.getByText("1 Working")).toBeTruthy();
    expect(screen.getByText("1 Review")).toBeTruthy();
    vi.useRealTimers();
  });

  it("classifies sessions into respond, ready, and pending buckets", async () => {
    vi.useFakeTimers();
    const projects = [{ id: "ao", name: "AO" }];
    const initialCards = [
      {
        id: "ao",
        name: "AO",
        sessionCounts: { total: 0, working: 0, pending: 0, review: 0, respond: 0, ready: 0 },
      },
    ];

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          sessions: [
            { id: "s1", projectId: "ao", status: "needs_input" },
            { id: "s2", projectId: "ao", status: "mergeable" },
            { id: "s3", projectId: "ao", status: "pr_open" },
          ],
        }),
    });

    const { act } = await import("@testing-library/react");
    render(<PortfolioPage projects={projects} initialCards={initialCards} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("1 Respond")).toBeTruthy();
    expect(screen.getByText("1 Ready")).toBeTruthy();
    expect(screen.getByText("1 Pending")).toBeTruthy();

    vi.useRealTimers();
  });

  it("ignores sessions for unknown projects", async () => {
    const projects = [{ id: "ao", name: "AO" }];
    const initialCards = [
      {
        id: "ao",
        name: "AO",
        sessionCounts: { total: 0, working: 0, pending: 0, review: 0, respond: 0, ready: 0 },
      },
    ];

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          sessions: [{ id: "s1", projectId: "unknown-project", status: "working" }],
        }),
    });

    const { act } = await import("@testing-library/react");
    render(<PortfolioPage projects={projects} initialCards={initialCards} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("0 sessions")).toBeTruthy();
  });

  it("handles fetch errors gracefully", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));

    const { act } = await import("@testing-library/react");
    render(
      <PortfolioPage
        projects={[{ id: "ao", name: "AO" }]}
        initialCards={[
          {
            id: "ao",
            name: "AO",
            sessionCounts: { total: 0, working: 0, pending: 0, review: 0, respond: 0, ready: 0 },
          },
        ]}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    // Should not crash — component still renders
    expect(screen.getByText("All Projects")).toBeTruthy();
  });
});
