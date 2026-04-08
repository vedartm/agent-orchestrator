import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectTerminal } from "../DirectTerminal";

const replaceMock = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/test-direct",
  useSearchParams: () => searchParams,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

class MockTerminal {
  options: Record<string, unknown>;
  parser = {
    registerCsiHandler: vi.fn(),
    registerOscHandler: vi.fn(),
  };
  cols = 80;
  rows = 24;

  constructor(options: Record<string, unknown>) {
    this.options = options;
  }

  loadAddon() {}
  open() {}
  write() {}
  refresh() {}
  dispose() {}
  hasSelection() {
    return false;
  }
  getSelection() {
    return "";
  }
  clearSelection() {}
  onSelectionChange() {
    return { dispose() {} };
  }
  attachCustomKeyEventHandler() {}
  onData() {
    return { dispose() {} };
  }
}

class MockFitAddon {
  fit() {}
}

function MockWebLinksAddon() {
  return undefined;
}

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send() {}
  close() {}
}

vi.mock("xterm", () => ({
  Terminal: MockTerminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: MockFitAddon,
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: MockWebLinksAddon,
}));

class MockSearchAddon {
  findNext() {
    return false;
  }
  findPrevious() {
    return false;
  }
  clearDecorations() {}
}

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: MockSearchAddon,
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: function MockWebglAddon() {
    throw new Error("WebGL not available in test");
  },
}));

describe("DirectTerminal render", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams();
    replaceMock.mockReset();
    MockWebSocket.instances = [];
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          proxyWsPath: "/ao-terminal-ws",
        }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the shared accent chrome for orchestrator terminals", async () => {
    render(<DirectTerminal sessionId="ao-orchestrator" variant="orchestrator" />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/runtime/terminal", expect.any(Object)));
    await waitFor(() =>
      expect(screen.getByText("CONNECTED")).toBeInTheDocument(),
    );

    expect(screen.getByText("ao-orchestrator")).toHaveStyle({ color: "var(--color-accent)" });
    expect(screen.getByText("XDA")).toHaveStyle({ color: "var(--color-accent)" });
    expect(MockWebSocket.instances[0]?.url).toContain("/ao-terminal-ws?session=ao-orchestrator");
  });

  it("renders search, settings, and fullscreen buttons in the top bar", async () => {
    render(<DirectTerminal sessionId="test-session" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    expect(screen.getByTitle("Search terminal (Ctrl+F)")).toBeInTheDocument();
    expect(screen.getByTitle("Terminal settings")).toBeInTheDocument();
    expect(screen.getByTitle("Fullscreen")).toBeInTheDocument();
  });

  it("toggles search bar when search button is clicked", async () => {
    render(<DirectTerminal sessionId="test-session" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    // Search bar should not be visible initially
    expect(screen.queryByPlaceholderText("Search...")).toBeNull();

    // Click search button to open
    fireEvent.click(screen.getByTitle("Search terminal (Ctrl+F)"));

    await waitFor(() =>
      expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument(),
    );

    // Should have prev/next/close buttons
    expect(screen.getByTitle("Previous match")).toBeInTheDocument();
    expect(screen.getByTitle("Next match")).toBeInTheDocument();
    expect(screen.getByTitle("Close search")).toBeInTheDocument();

    // Click close to dismiss
    fireEvent.click(screen.getByTitle("Close search"));

    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search...")).toBeNull(),
    );
  });

  it("toggles settings panel when settings button is clicked", async () => {
    render(<DirectTerminal sessionId="test-session" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    // Settings panel should not be visible initially
    expect(screen.queryByText("Font Size")).toBeNull();

    // Click settings button to open
    fireEvent.click(screen.getByTitle("Terminal settings"));

    await waitFor(() =>
      expect(screen.getByText("Font Size")).toBeInTheDocument(),
    );

    // Should show font size, cursor, and theme sections
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();
  });

  it("renders the status bar with font size and renderer label", async () => {
    render(<DirectTerminal sessionId="test-session" />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    expect(screen.getByText("14px")).toBeInTheDocument();
    // WebGL mock throws in tests, so falls back to Canvas
    expect(screen.getByText("Canvas")).toBeInTheDocument();
  });

  it("shows fullscreen exit button when startFullscreen is true", async () => {
    searchParams = new URLSearchParams("fullscreen=true");
    render(<DirectTerminal sessionId="test-session" startFullscreen />);

    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument());

    expect(screen.getByTitle("Exit fullscreen")).toBeInTheDocument();
  });
});
