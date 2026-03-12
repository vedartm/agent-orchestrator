"use client";

import { useEffect, useReducer, useState } from "react";
import type { DashboardSession, SSESnapshotEvent } from "@/lib/types";

type Action =
  | { type: "reset"; sessions: DashboardSession[] }
  | { type: "snapshot"; patches: SSESnapshotEvent["sessions"] };

function reducer(state: DashboardSession[], action: Action): DashboardSession[] {
  switch (action.type) {
    case "reset":
      return action.sessions;
    case "snapshot": {
      const patchMap = new Map(action.patches.map((p) => [p.id, p]));
      let changed = false;
      const next = state.map((s) => {
        const patch = patchMap.get(s.id);
        if (!patch) return s;
        if (
          s.status === patch.status &&
          s.activity === patch.activity &&
          s.lastActivityAt === patch.lastActivityAt
        ) {
          return s;
        }
        changed = true;
        return {
          ...s,
          status: patch.status,
          activity: patch.activity,
          lastActivityAt: patch.lastActivityAt,
        };
      });
      return changed ? next : state;
    }
  }
}

export interface SessionEventStreamState {
  sessions: DashboardSession[];
  connectionState: "connecting" | "connected" | "error";
  lastEventAt: string | null;
  lastCorrelationId: string | null;
  lastError: string | null;
}

export function useSessionEvents(initialSessions: DashboardSession[]): SessionEventStreamState {
  const [sessions, dispatch] = useReducer(reducer, initialSessions);
  const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "error">(
    "connecting",
  );
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [lastCorrelationId, setLastCorrelationId] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  // Reset state when server-rendered props change (e.g. full page refresh)
  useEffect(() => {
    dispatch({ type: "reset", sessions: initialSessions });
  }, [initialSessions]);

  useEffect(() => {
    const es = new EventSource("/api/events");
    setConnectionState("connecting");

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { type: string };
        if (data.type === "snapshot") {
          const snapshot = data as SSESnapshotEvent;
          dispatch({ type: "snapshot", patches: snapshot.sessions });
          setConnectionState("connected");
          setLastEventAt(snapshot.emittedAt ?? new Date().toISOString());
          setLastCorrelationId(snapshot.correlationId ?? null);
          setLastError(null);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    es.onerror = () => {
      setConnectionState("error");
      setLastError("Event stream reconnecting");
    };

    return () => {
      es.close();
    };
  }, []);

  return {
    sessions,
    connectionState,
    lastEventAt,
    lastCorrelationId,
    lastError,
  };
}
