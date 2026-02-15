import { useCallback, useRef, useState } from "react";
import type { IncomingMethodResult } from "@workspace/agentic-messaging";
import type { MethodHistoryEntry } from "../components/MethodHistoryItem";
import type { ChatMessage } from "../types";

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
  /** Live method data — components read from this Map instead of msg.method */
  const [methodEntries, setMethodEntries] = useState<Map<string, MethodHistoryEntry>>(new Map());

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

    // Also remove corresponding messages and methodEntries
    if (idsToRemove.length > 0) {
      const removeSet = new Set(idsToRemove);
      setMessages((prev) => prev.filter((msg) => !(msg.kind === "method" && msg.method && removeSet.has(msg.method.callId))));
      setMethodEntries((prev) => {
        const next = new Map(prev);
        for (const id of idsToRemove) {
          next.delete(id);
        }
        return next;
      });
    }
  }, [setMessages]);

  const addMethodHistoryEntry = useCallback(
    (entry: MethodHistoryEntry) => {
      const existing = methodHistoryRef.current.get(entry.callId);
      if (existing) {
        const merged = { ...existing, ...entry };
        methodHistoryRef.current.set(entry.callId, merged);
        // Update the live Map
        setMethodEntries((prev) => {
          const next = new Map(prev);
          next.set(entry.callId, merged);
          return next;
        });
        return;
      }
      methodHistoryRef.current.set(entry.callId, entry);
      // Add to live Map
      setMethodEntries((prev) => {
        const next = new Map(prev);
        next.set(entry.callId, entry);
        return next;
      });
      // Add a placeholder message for timeline position
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

  // Empty deps: methodHistoryRef is a ref (stable) and setMethodEntries is a
  // React state setter (stable). This callback intentionally does NOT touch
  // setMessages — that's the key perf win of the decoupled approach.
  const updateMethodHistoryEntry = useCallback(
    (callId: string, updates: Partial<MethodHistoryEntry>) => {
      const current = methodHistoryRef.current.get(callId);
      if (current) {
        methodHistoryRef.current.set(callId, { ...current, ...updates });
      }
      // Only update the live Map — no messages array scan needed
      setMethodEntries((prev) => {
        const existing = prev.get(callId);
        if (!existing) return prev;
        const next = new Map(prev);
        next.set(callId, { ...existing, ...updates });
        return next;
      });
    },
    []
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
    setMethodEntries(new Map());
  }, []);

  return {
    methodHistoryRef,
    methodEntries,
    addMethodHistoryEntry,
    updateMethodHistoryEntry,
    appendMethodConsoleOutput,
    handleMethodResult,
    clearMethodHistory,
  };
}
