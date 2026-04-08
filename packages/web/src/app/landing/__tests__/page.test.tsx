import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockObserve = vi.fn();
beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    vi.fn(() => ({
      observe: mockObserve,
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    })),
  );
});

import LandingPage from "../page";

describe("LandingPage", () => {
  it("renders the full landing page", () => {
    render(<LandingPage />);
    expect(screen.getByText("Agent Orchestrator")).toBeInTheDocument();
    expect(screen.getByText(/Run 30 AI agents in parallel/)).toBeInTheDocument();
    expect(
      screen.getByText("MIT Licensed · Open Source · Built by ComposioHQ"),
    ).toBeInTheDocument();
  });
});
