import { useCallback, useRef } from "react";
import type { IncomingMethodResult } from "@natstack/agentic-messaging";
import type { MethodHistoryEntry } from "../components/MethodHistoryItem";
import type { ChatMessage } from "../types";

// Re-export for backwards compatibility
export type { ChatMessage };

/** Maximum number of method history entries to retain (reduced from 10K for memory efficiency) */
const MAX_METHOD_HISTORY_SIZE = 2000;
/** Prune threshold - start pruning at 80% capacity */
const PRUNE_THRESHOLD = Math.floor(MAX_METHOD_HISTORY_SIZE * 0.8);
/** Target size after pruning - 70% of max */
const PRUNE_TARGET = Math.floor(MAX_METHOD_HISTORY_SIZE * 0.7);

interface UseMethodHistoryOptions {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  clientId: string;
}

export function useMethodHistory({ setMessages, clientId }: UseMethodHistoryOptions) {
  const methodHistoryRef = useRef(new Map<string, MethodHistoryEntry>());

  /**
   * Prune oldest completed entries if we exceed the threshold.
   * Only removes entries that are complete (success/error), keeping pending ones.
   * Prunes more aggressively (to 70% of max) to avoid frequent pruning.
   */
  const pruneIfNeeded = useCallback(() => {
    const map = methodHistoryRef.current;
    if (map.size <= PRUNE_THRESHOLD) return;

    // Find completed entries sorted by startedAt (oldest first)
    const completedEntries = Array.from(map.entries())
      .filter(([, entry]) => entry.status === "success" || entry.status === "error")
      .sort((a, b) => (a[1].startedAt ?? 0) - (b[1].startedAt ?? 0));

    // Prune down to target size (70% of max)
    const toRemove = map.size - PRUNE_TARGET;
    const idsToRemove = completedEntries.slice(0, Math.max(0, toRemove)).map(([id]) => id);

    for (const id of idsToRemove) {
      map.delete(id);
    }

    // Also remove corresponding messages
    if (idsToRemove.length > 0) {
      const removeSet = new Set(idsToRemove);
      setMessages((prev) => prev.filter((msg) => !(msg.kind === "method" && msg.method && removeSet.has(msg.method.callId))));
    }
  }, [setMessages]);

  const addMethodHistoryEntry = useCallback(
    (entry: MethodHistoryEntry) => {
      const existing = methodHistoryRef.current.get(entry.callId);
      if (existing) {
        const merged = { ...existing, ...entry };
        methodHistoryRef.current.set(entry.callId, merged);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.kind === "method" && msg.method?.callId === entry.callId ? { ...msg, method: merged } : msg
          )
        );
        return;
      }
      methodHistoryRef.current.set(entry.callId, entry);
      setMessages((prev) => [
        ...prev,
        {
          id: `method-${entry.callId}`,
          senderId: clientId,
          content: "",
          kind: "method",
          method: entry,
          complete: true,
        },
      ]);

      // Prune after adding new entry
      pruneIfNeeded();
    },
    [setMessages, clientId, pruneIfNeeded]
  );

  const updateMethodHistoryEntry = useCallback(
    (callId: string, updates: Partial<MethodHistoryEntry>) => {
      const current = methodHistoryRef.current.get(callId);
      if (current) {
        methodHistoryRef.current.set(callId, { ...current, ...updates });
      }
      setMessages((prev) =>
        prev.map((msg) =>
          msg.kind === "method" && msg.method?.callId === callId
            ? { ...msg, method: { ...msg.method, ...updates } }
            : msg
        )
      );
    },
    [setMessages]
  );

  const appendMethodConsoleOutput = useCallback(
    (callId: string, line: string) => {
      const current = methodHistoryRef.current.get(callId);
      const next = current?.consoleOutput ? `${current.consoleOutput}\n${line}` : line;
      updateMethodHistoryEntry(callId, { consoleOutput: next });
    },
    [updateMethodHistoryEntry]
  );

  const handleMethodResult = useCallback(
    (result: IncomingMethodResult) => {
      // Process all results including replay - we want to show historical method results in the UI
      const entry = methodHistoryRef.current.get(result.callId);
      if (!entry) return;

      if (result.progress !== undefined) {
        updateMethodHistoryEntry(result.callId, { progress: result.progress });
      }

      const content = result.content as Record<string, unknown> | undefined;
      const isConsoleChunk =
        !!content && content["type"] === "console" && typeof content["content"] === "string";

      if (isConsoleChunk) {
        if (!entry.handledLocally || !entry.consoleOutput) {
          appendMethodConsoleOutput(result.callId, content["content"] as string);
        }
        return;
      }

      if (!result.complete) return;

      if (result.isError) {
        let errorMessage = "Method execution failed";
        if (typeof result.content === "string") {
          errorMessage = result.content;
        } else if (content && typeof content["error"] === "string") {
          errorMessage = content["error"] as string;
        }
        updateMethodHistoryEntry(result.callId, {
          status: "error",
          error: errorMessage,
          completedAt: Date.now(),
        });
        return;
      }

      updateMethodHistoryEntry(result.callId, {
        status: "success",
        result: result.content,
        completedAt: Date.now(),
      });
    },
    [appendMethodConsoleOutput, updateMethodHistoryEntry]
  );

  const clearMethodHistory = useCallback(() => {
    methodHistoryRef.current.clear();
  }, []);

  return {
    methodHistoryRef,
    addMethodHistoryEntry,
    updateMethodHistoryEntry,
    appendMethodConsoleOutput,
    handleMethodResult,
    clearMethodHistory,
  };
}
