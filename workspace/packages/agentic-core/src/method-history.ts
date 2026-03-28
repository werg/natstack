/**
 * Method History Tracker — tracks method call lifecycle with auto-pruning.
 *
 * Tracks method call lifecycle (pending → success/error), with
 * auto-pruning of completed entries to bound memory usage.
 */

import type { IncomingMethodResult } from "@natstack/pubsub";
import type { MethodHistoryEntry, ChatMessage } from "./types.js";

/** Maximum number of method history entries to retain */
const MAX_METHOD_HISTORY_SIZE = 2000;
/** Prune threshold - start pruning at 80% capacity */
const PRUNE_THRESHOLD = Math.floor(MAX_METHOD_HISTORY_SIZE * 0.8);
/** Target size after pruning - 70% of max */
const PRUNE_TARGET = Math.floor(MAX_METHOD_HISTORY_SIZE * 0.7);

export type MethodHistoryChangeHandler = (entries: ReadonlyMap<string, MethodHistoryEntry>) => void;
export type MessagesUpdater = (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;

export class MethodHistoryTracker {
  private entries = new Map<string, MethodHistoryEntry>();
  private clientId: string;
  private setMessages: MessagesUpdater;
  private onChange: MethodHistoryChangeHandler;

  constructor(opts: {
    clientId: string;
    setMessages: MessagesUpdater;
    onChange: MethodHistoryChangeHandler;
  }) {
    this.clientId = opts.clientId;
    this.setMessages = opts.setMessages;
    this.onChange = opts.onChange;
  }

  get current(): ReadonlyMap<string, MethodHistoryEntry> {
    return this.entries;
  }

  addEntry(entry: MethodHistoryEntry): void {
    const existing = this.entries.get(entry.callId);
    if (existing) {
      const merged = { ...existing, ...entry };
      this.entries.set(entry.callId, merged);
      this.notifyChange();
      return;
    }
    this.entries.set(entry.callId, entry);
    this.notifyChange();

    // Add a placeholder message for timeline position
    this.setMessages((prev) => [
      ...prev,
      {
        id: `method-${entry.callId}`,
        senderId: this.clientId,
        content: "",
        kind: "method",
        method: entry,
        complete: true,
      },
    ]);

    this.pruneIfNeeded();
  }

  updateEntry(callId: string, updates: Partial<MethodHistoryEntry>): void {
    const current = this.entries.get(callId);
    if (current) {
      this.entries.set(callId, { ...current, ...updates });
    }
    this.notifyChange();
  }

  appendConsoleOutput(callId: string, line: string): void {
    const current = this.entries.get(callId);
    const next = current?.consoleOutput ? `${current.consoleOutput}\n${line}` : line;
    this.updateEntry(callId, { consoleOutput: next });
  }

  handleMethodResult(result: IncomingMethodResult): void {
    const entry = this.entries.get(result.callId);
    if (!entry) return;

    if (result.progress !== undefined) {
      this.updateEntry(result.callId, { progress: result.progress });
    }

    const content = result.content as Record<string, unknown> | undefined;
    const isConsoleChunk =
      !!content && content["type"] === "console" && typeof content["content"] === "string";

    if (isConsoleChunk) {
      if (!entry.handledLocally || !entry.consoleOutput) {
        this.appendConsoleOutput(result.callId, content["content"] as string);
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
      this.updateEntry(result.callId, {
        status: "error",
        error: errorMessage,
        completedAt: Date.now(),
      });
      return;
    }

    this.updateEntry(result.callId, {
      status: "success",
      result: result.content,
      completedAt: Date.now(),
    });
  }

  clear(): void {
    this.entries.clear();
    this.notifyChange();
  }

  private notifyChange(): void {
    this.onChange(this.entries);
  }

  private pruneIfNeeded(): void {
    if (this.entries.size <= PRUNE_THRESHOLD) return;

    const completedEntries = Array.from(this.entries.entries())
      .filter(([, entry]) => entry.status === "success" || entry.status === "error")
      .sort((a, b) => (a[1].startedAt ?? 0) - (b[1].startedAt ?? 0));

    const toRemove = this.entries.size - PRUNE_TARGET;
    const idsToRemove = completedEntries.slice(0, Math.max(0, toRemove)).map(([id]) => id);

    for (const id of idsToRemove) {
      this.entries.delete(id);
    }

    if (idsToRemove.length > 0) {
      const removeSet = new Set(idsToRemove);
      this.setMessages((prev) =>
        prev.filter((msg) => !(msg.kind === "method" && msg.method && removeSet.has(msg.method.callId)))
      );
      this.notifyChange();
    }
  }
}
