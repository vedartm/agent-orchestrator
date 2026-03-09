"use client";

import { useEffect, useReducer } from "react";
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

export function useSessionEvents(
  initialSessions: DashboardSession[],
  project?: string,
): DashboardSession[] {
  const [sessions, dispatch] = useReducer(reducer, initialSessions);

  useEffect(() => {
    dispatch({ type: "reset", sessions: initialSessions });
  }, [initialSessions]);

  useEffect(() => {
    const url = project ? `/api/events?project=${encodeURIComponent(project)}` : "/api/events";
    const es = new EventSource(url);

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { type: string };
        if (data.type === "snapshot") {
          const snapshot = data as SSESnapshotEvent;
          dispatch({ type: "snapshot", patches: snapshot.sessions });
        }
      } catch {}
    };

    es.onerror = () => {};

    return () => {
      es.close();
    };
  }, [project]);

  return sessions;
}
