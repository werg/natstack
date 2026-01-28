/**
 * Hook to track child chat sessions.
 */

import { useState, useCallback } from "react";
import { rpc } from "@natstack/runtime";
import type { ChildSessionInfo } from "../types";

export function useChildSessions() {
  const [sessions, setSessions] = useState<ChildSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Get child panels via RPC (slim projection by default - no stateArgs)
      const children = await rpc.call<ChildSessionInfo[]>("main", "bridge.getChildPanels");

      // Filter to chat panels
      const chatSessions = children.filter((p) => p.source === "panels/chat");
      setSessions(chatSessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  return { sessions, loadSessions, loading, error };
}
