import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock IntersectionObserver for ScrollRevealProvider
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();
beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    vi.fn(() => ({
      observe: mockObserve,
      unobserve: vi.fn(),
      disconnect: mockDisconnect,
    })),
  );
});

import { LandingNav } from "../LandingNav";
import { LandingHero } from "../LandingHero";
import { LandingAbout } from "../LandingAbout";
import { LandingAgentsBar } from "../LandingAgentsBar";
import { LandingStats } from "../LandingStats";
import { LandingVideo } from "../LandingVideo";
import { LandingFeatures } from "../LandingFeatures";
import { LandingTestimonials } from "../LandingTestimonials";
import { LandingHowItWorks } from "../LandingHowItWorks";
import { LandingQuickStart } from "../LandingQuickStart";
import { LandingCTA } from "../LandingCTA";
import { LandingDifferentiators } from "../LandingDifferentiators";
import { ScrollRevealProvider } from "../ScrollRevealProvider";

describe("LandingNav", () => {
  it("renders logo and navigation links", () => {
    render(<LandingNav />);
    expect(screen.getByText("Agent Orchestrator")).toBeInTheDocument();
    expect(screen.getByText("Features")).toBeInTheDocument();
    expect(screen.getByText("How It Works")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("links GitHub button to the repo", () => {
    render(<LandingNav />);
    const link = screen.getByText("GitHub");
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/ComposioHQ/agent-orchestrator",
    );
  });
});

describe("LandingHero", () => {
  it("renders heading and subtext", () => {
    render(<LandingHero />);
    expect(screen.getByText(/Run 30 AI agents in parallel/)).toBeInTheDocument();
    expect(screen.getByText(/Agent Orchestrator spawns/)).toBeInTheDocument();
  });

  it("renders the install command", () => {
    render(<LandingHero />);
    expect(screen.getByText(/npx @composio\/ao start/)).toBeInTheDocument();
  });

  it("renders terminal preview with ao output", () => {
    render(<LandingHero />);
    expect(screen.getByText("ao batch-spawn 42 43 44 45 46")).toBeInTheDocument();
  });
});

describe("LandingAbout", () => {
  it("renders the problem statement and description", () => {
    render(<LandingAbout />);
    expect(screen.getByText(/running AI agents in 10 browser tabs/)).toBeInTheDocument();
    expect(screen.getByText(/single command/)).toBeInTheDocument();
  });
});

describe("LandingDifferentiators", () => {
  it("renders comparison table", () => {
    render(<LandingDifferentiators />);
    expect(screen.getByText("Web-based dashboard")).toBeInTheDocument();
    expect(screen.getByText("Open source (MIT)")).toBeInTheDocument();
    expect(screen.getByText(/Multi-agent/)).toBeInTheDocument();
  });

  it("renders section heading", () => {
    render(<LandingDifferentiators />);
    expect(screen.getByText(/open-source, web-based/)).toBeInTheDocument();
  });
});

describe("LandingAgentsBar", () => {
  it("renders all four agent names", () => {
    render(<LandingAgentsBar />);
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Aider")).toBeInTheDocument();
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
  });

  it("renders agent logo images", () => {
    render(<LandingAgentsBar />);
    const images = screen.getAllByRole("img");
    expect(images.length).toBe(4);
  });
});

describe("LandingStats", () => {
  it("renders stat numbers", () => {
    render(<LandingStats />);
    expect(screen.getByText("212")).toBeInTheDocument();
    expect(screen.getByText("75")).toBeInTheDocument();
    expect(screen.getByText("814")).toBeInTheDocument();
    expect(screen.getByText("19")).toBeInTheDocument();
  });

  it("renders dogfood badge", () => {
    render(<LandingStats />);
    expect(screen.getByText(/Built with itself/)).toBeInTheDocument();
  });

  it("renders GitHub stars link", () => {
    render(<LandingStats />);
    expect(screen.getByText("5.9k")).toBeInTheDocument();
    expect(screen.getByText(/stars on GitHub/)).toBeInTheDocument();
  });
});

describe("LandingVideo", () => {
  it("renders YouTube iframe", () => {
    const { container } = render(<LandingVideo />);
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toContain("youtube.com/embed");
  });

  it("renders section label", () => {
    render(<LandingVideo />);
    expect(screen.getByText("See it in action")).toBeInTheDocument();
  });
});

describe("LandingFeatures", () => {
  it("renders all four feature titles", () => {
    render(<LandingFeatures />);
    expect(screen.getByText("Parallel Execution")).toBeInTheDocument();
    expect(screen.getByText("Autonomous Recovery")).toBeInTheDocument();
    expect(screen.getByText("Plugin Architecture")).toBeInTheDocument();
    expect(screen.getByText("Live Dashboard")).toBeInTheDocument();
  });

  it("renders section heading", () => {
    render(<LandingFeatures />);
    expect(screen.getByText(/orchestrate/)).toBeInTheDocument();
  });
});

describe("LandingTestimonials", () => {
  it("renders all three testimonials", () => {
    render(<LandingTestimonials />);
    expect(screen.getByText(/8 PRs were merged/)).toBeInTheDocument();
    expect(screen.getByText(/auto CI recovery/)).toBeInTheDocument();
    expect(screen.getByText(/3 PRs\/day to 15 PRs\/day/)).toBeInTheDocument();
  });

  it("renders author names", () => {
    render(<LandingTestimonials />);
    expect(screen.getByText("Sarah K.")).toBeInTheDocument();
    expect(screen.getByText("Marcus R.")).toBeInTheDocument();
    expect(screen.getByText("Jia P.")).toBeInTheDocument();
  });
});

describe("LandingHowItWorks", () => {
  it("renders three step numbers", () => {
    render(<LandingHowItWorks />);
    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText("02")).toBeInTheDocument();
    expect(screen.getByText("03")).toBeInTheDocument();
  });

  it("renders the batch-spawn command", () => {
    render(<LandingHowItWorks />);
    expect(
      screen.getByText("ao batch-spawn 42 43 44 45 46"),
    ).toBeInTheDocument();
  });

  it("renders merged PR badges", () => {
    render(<LandingHowItWorks />);
    const badges = screen.getAllByText(/✓ Merged/);
    expect(badges.length).toBe(4);
  });
});

describe("LandingQuickStart", () => {
  it("renders three step cards", () => {
    render(<LandingQuickStart />);
    expect(screen.getByText("Install")).toBeInTheDocument();
    expect(screen.getByText("Configure")).toBeInTheDocument();
    expect(screen.getByText("Launch")).toBeInTheDocument();
  });

  it("renders CLI commands", () => {
    render(<LandingQuickStart />);
    expect(screen.getByText(/npm i -g @composio\/ao/)).toBeInTheDocument();
    expect(screen.getByText(/ao setup/)).toBeInTheDocument();
    expect(screen.getByText(/ao batch-spawn 1 2 3/)).toBeInTheDocument();
  });
});

describe("LandingCTA", () => {
  it("renders CTA heading", () => {
    render(<LandingCTA />);
    expect(screen.getByText("Stop babysitting.")).toBeInTheDocument();
  });

  it("renders GitHub link", () => {
    render(<LandingCTA />);
    const link = screen.getByText("View on GitHub");
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/ComposioHQ/agent-orchestrator",
    );
  });
});

describe("ScrollRevealProvider", () => {
  it("renders children", () => {
    render(
      <ScrollRevealProvider>
        <div>Test child</div>
      </ScrollRevealProvider>,
    );
    expect(screen.getByText("Test child")).toBeInTheDocument();
  });

  it("sets up IntersectionObserver", () => {
    render(
      <ScrollRevealProvider>
        <div className="landing-reveal">Reveal me</div>
      </ScrollRevealProvider>,
    );
    expect(IntersectionObserver).toHaveBeenCalled();
  });
});
