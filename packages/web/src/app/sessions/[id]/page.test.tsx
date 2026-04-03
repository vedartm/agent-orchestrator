import { describe, expect, it, vi, beforeEach } from "vitest";

// sessions/[id]/page.tsx is now a redirect-only server component.
// It redirects to /projects/:projectId/sessions/:id based on portfolio lookup.

const { mockRedirect, mockGetPortfolioServices, mockGetCachedPortfolioSessions } = vi.hoisted(
  () => ({
    mockRedirect: vi.fn((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    }),
    mockGetPortfolioServices: vi.fn(),
    mockGetCachedPortfolioSessions: vi.fn(),
  }),
);

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mockRedirect(url),
}));

vi.mock("@/lib/portfolio-services", () => ({
  getPortfolioServices: () => mockGetPortfolioServices(),
  getCachedPortfolioSessions: () => mockGetCachedPortfolioSessions(),
}));

beforeEach(() => {
  vi.resetModules();
  mockRedirect.mockClear();
  mockGetPortfolioServices.mockReset();
  mockGetCachedPortfolioSessions.mockReset();
  // Restore the redirect throw behavior after clear
  mockRedirect.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
});

describe("LegacySessionPage redirects", () => {
  it("redirects to /projects/:projectId/sessions/:id when session is found in portfolio", async () => {
    mockGetPortfolioServices.mockReturnValue({ portfolio: [] });
    mockGetCachedPortfolioSessions.mockResolvedValue([
      {
        session: { id: "worker-1" },
        project: { id: "my-app" },
      },
    ]);

    const { default: LegacySessionPage } = await import("./page");

    await expect(
      LegacySessionPage({ params: Promise.resolve({ id: "worker-1" }) }),
    ).rejects.toThrow("REDIRECT:/projects/my-app/sessions/worker-1");
  });

  it("redirects using session prefix when session is not in cached list", async () => {
    mockGetPortfolioServices.mockReturnValue({
      portfolio: [{ id: "my-app", sessionPrefix: "worker" }],
    });
    mockGetCachedPortfolioSessions.mockResolvedValue([]);

    const { default: LegacySessionPage } = await import("./page");

    await expect(
      LegacySessionPage({ params: Promise.resolve({ id: "worker-5" }) }),
    ).rejects.toThrow("REDIRECT:/projects/my-app/sessions/worker-5");
  });

  it("redirects to / when nothing matches", async () => {
    mockGetPortfolioServices.mockReturnValue({ portfolio: [] });
    mockGetCachedPortfolioSessions.mockResolvedValue([]);

    const { default: LegacySessionPage } = await import("./page");

    await expect(
      LegacySessionPage({ params: Promise.resolve({ id: "unknown-99" }) }),
    ).rejects.toThrow("REDIRECT:/");
  });
});
