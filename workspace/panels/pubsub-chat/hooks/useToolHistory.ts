import { useCallback, useRef } from "react";
import type { IncomingToolResult } from "@natstack/agentic-messaging";
import type { ToolHistoryEntry } from "../components/ToolHistoryItem";
import type { ChatMessage } from "../types";

// Re-export for backwards compatibility
export type { ChatMessage };

/** Maximum number of tool history entries to retain */
const MAX_TOOL_HISTORY_SIZE = 10000;

interface UseToolHistoryOptions {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  clientId: string;
}

export function useToolHistory({ setMessages, clientId }: UseToolHistoryOptions) {
  const toolHistoryRef = useRef(new Map<string, ToolHistoryEntry>());

  /**
   * Prune oldest completed entries if we exceed the limit.
   * Only removes entries that are complete (success/error), keeping pending ones.
   */
  const pruneIfNeeded = useCallback(() => {
    const map = toolHistoryRef.current;
    if (map.size <= MAX_TOOL_HISTORY_SIZE) return;

    // Find completed entries sorted by startedAt (oldest first)
    const completedEntries = Array.from(map.entries())
      .filter(([, entry]) => entry.status === "success" || entry.status === "error")
      .sort((a, b) => (a[1].startedAt ?? 0) - (b[1].startedAt ?? 0));

    const toRemove = map.size - MAX_TOOL_HISTORY_SIZE;
    const idsToRemove = completedEntries.slice(0, toRemove).map(([id]) => id);

    for (const id of idsToRemove) {
      map.delete(id);
    }

    // Also remove corresponding messages
    if (idsToRemove.length > 0) {
      const removeSet = new Set(idsToRemove);
      setMessages((prev) => prev.filter((msg) => !(msg.kind === "tool" && msg.tool && removeSet.has(msg.tool.callId))));
    }
  }, [setMessages]);

  const addToolHistoryEntry = useCallback(
    (entry: ToolHistoryEntry) => {
      const existing = toolHistoryRef.current.get(entry.callId);
      if (existing) {
        const merged = { ...existing, ...entry };
        toolHistoryRef.current.set(entry.callId, merged);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.kind === "tool" && msg.tool?.callId === entry.callId ? { ...msg, tool: merged } : msg
          )
        );
        return;
      }
      toolHistoryRef.current.set(entry.callId, entry);
      setMessages((prev) => [
        ...prev,
        {
          id: `tool-${entry.callId}`,
          senderId: clientId,
          content: "",
          kind: "tool",
          tool: entry,
          complete: true,
        },
      ]);

      // Prune after adding new entry
      pruneIfNeeded();
    },
    [setMessages, clientId, pruneIfNeeded]
  );

  const updateToolHistoryEntry = useCallback(
    (callId: string, updates: Partial<ToolHistoryEntry>) => {
      const current = toolHistoryRef.current.get(callId);
      if (current) {
        toolHistoryRef.current.set(callId, { ...current, ...updates });
      }
      setMessages((prev) =>
        prev.map((msg) =>
          msg.kind === "tool" && msg.tool?.callId === callId
            ? { ...msg, tool: { ...msg.tool, ...updates } }
            : msg
        )
      );
    },
    [setMessages]
  );

  const appendToolConsoleOutput = useCallback(
    (callId: string, line: string) => {
      const current = toolHistoryRef.current.get(callId);
      const next = current?.consoleOutput ? `${current.consoleOutput}\n${line}` : line;
      updateToolHistoryEntry(callId, { consoleOutput: next });
    },
    [updateToolHistoryEntry]
  );

  const handleToolResult = useCallback(
    (result: IncomingToolResult) => {
      const entry = toolHistoryRef.current.get(result.callId);
      if (!entry) return;

      if (result.progress !== undefined) {
        updateToolHistoryEntry(result.callId, { progress: result.progress });
      }

      const content = result.content as Record<string, unknown> | undefined;
      const isConsoleChunk =
        !!content && content["type"] === "console" && typeof content["content"] === "string";

      if (isConsoleChunk) {
        if (!entry.handledLocally || !entry.consoleOutput) {
          appendToolConsoleOutput(result.callId, content["content"] as string);
        }
        return;
      }

      if (!result.complete) return;

      if (result.isError) {
        let errorMessage = "Tool execution failed";
        if (typeof result.content === "string") {
          errorMessage = result.content;
        } else if (content && typeof content["error"] === "string") {
          errorMessage = content["error"] as string;
        }
        updateToolHistoryEntry(result.callId, {
          status: "error",
          error: errorMessage,
          completedAt: Date.now(),
        });
        return;
      }

      updateToolHistoryEntry(result.callId, {
        status: "success",
        result: result.content,
        completedAt: Date.now(),
      });
    },
    [appendToolConsoleOutput, updateToolHistoryEntry]
  );

  const clearToolHistory = useCallback(() => {
    toolHistoryRef.current.clear();
  }, []);

  return {
    toolHistoryRef,
    addToolHistoryEntry,
    updateToolHistoryEntry,
    appendToolConsoleOutput,
    handleToolResult,
    clearToolHistory,
  };
}
