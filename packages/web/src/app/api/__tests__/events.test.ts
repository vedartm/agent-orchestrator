import { beforeEach, describe, expect, it, vi } from "vitest";

const mockList = vi.fn();
const mockGetServices = vi.fn();
const mockRecordOperation = vi.fn();
const mockSetHealth = vi.fn();

vi.mock("@/lib/services", () => ({
  getServices: (...args: unknown[]) => mockGetServices(...args),
}));

vi.mock("@composio/ao-core", () => ({
  createCorrelationId: () => "test-correlation-id",
  createProjectObserver: () => ({
    recordOperation: mockRecordOperation,
    setHealth: mockSetHealth,
    destroy: vi.fn(),
  }),
}));

vi.mock("@/lib/serialize", () => ({
  sessionToDashboard: vi.fn(
    (session: {
      id: string;
      projectId?: string;
      status?: string;
      activity?: string;
      lastActivityAt?: string | null;
    }) => ({
      id: session.id,
      projectId: session.projectId ?? "test-project",
      status: session.status ?? "working",
      activity: session.activity ?? "active",
      lastActivityAt: session.lastActivityAt ?? null,
    }),
  ),
}));

vi.mock("@/lib/types", () => ({
  getAttentionLevel: vi.fn(() => "normal"),
}));

vi.mock("@/lib/project-utils", () => ({
  filterWorkerSessions: vi.fn((sessions: unknown[]) => sessions),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServices.mockResolvedValue({
    config: {
      configPath: "/test/config.yaml",
      projects: {
        "test-project": {
          name: "Test Project",
          path: "/test/project",
          sessionPrefix: "tp",
        },
      },
    },
    sessionManager: {
      list: mockList,
    },
  });
  mockList.mockResolvedValue([
    {
      id: "tp-1",
      projectId: "test-project",
      status: "working",
      activity: "active",
      lastActivityAt: null,
    },
  ]);
});

async function collectSSEEvents(response: Response, maxEvents = 5): Promise<unknown[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];

  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = "";
  const timeout = setTimeout(() => void reader.cancel(), 500);

  try {
    while (events.length < maxEvents) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const dataMatch = chunk.match(/^data: (.+)$/m);
        if (dataMatch) {
          events.push(JSON.parse(dataMatch[1]));
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
  }

  return events;
}

describe("GET /api/events", () => {
  it("sends snapshot event with projectId for each session", async () => {
    const { GET } = await import("../events/route.js");
    const request = new Request("http://localhost/api/events");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const events = await collectSSEEvents(response);
    const snapshot = events.find(
      (event): event is { type: string; sessions: Array<{ projectId: string }> } =>
        typeof event === "object" && event !== null && "type" in event && event.type === "snapshot",
    );

    expect(snapshot).toBeDefined();
    expect(snapshot?.sessions).toBeDefined();
    expect(snapshot?.sessions[0]?.projectId).toBe("test-project");
  });
});
