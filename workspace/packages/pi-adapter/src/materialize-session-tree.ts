import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { TrajectoryState } from "@workspace/agentic-protocol";

export function materializeSessionTree(state: TrajectoryState): SessionTreeEntry[] {
  const exactEntries = exactPiSessionEntries(state);
  if (exactEntries.length > 0) return exactEntries;

  const messages = Object.values(state.messages)
    .filter((message) => message.status === "completed")
    .sort((a, b) => (a.completedAt ?? a.startedAt ?? "").localeCompare(b.completedAt ?? b.startedAt ?? ""));

  let parentId: string | null = null;
  const entries: SessionTreeEntry[] = [];
  for (const message of messages) {
    const entry: SessionTreeEntry = {
      type: "message",
      id: message.messageId,
      parentId,
      timestamp: message.completedAt ?? message.startedAt ?? new Date(0).toISOString(),
      message: {
        role: message.role,
        content: message.content,
        timestamp: Date.parse(message.completedAt ?? message.startedAt ?? new Date(0).toISOString()),
      } as AgentMessage,
    };
    entries.push(entry);
    parentId = entry.id;
  }
  return entries;
}

function exactPiSessionEntries(state: TrajectoryState): SessionTreeEntry[] {
  const entries = new Map<string, SessionTreeEntry>();
  const leafEntries: SessionTreeEntry[] = [];
  for (const event of state.systemEvents) {
    if (event.kind === "system.compaction_recorded") {
      const replacement = (event.payload as Record<string, unknown>)["replacement"];
      if (replacement && typeof replacement === "object" && !Array.isArray(replacement)) {
        const maybeEntry = (replacement as Record<string, unknown>)["entry"];
        if (isSessionTreeEntry(maybeEntry)) entries.set(maybeEntry.id, maybeEntry);
      }
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    const details = payload["details"];
    if (!details || typeof details !== "object" || Array.isArray(details)) continue;
    const record = details as Record<string, unknown>;
    if (record["kind"] !== "pi.session_entry") continue;
    const entry = record["entry"];
    if (!isSessionTreeEntry(entry)) continue;
    if (entry.type === "leaf") {
      leafEntries.push(entry);
    } else {
      entries.set(entry.id, entry);
    }
  }

  const latestLeaf = leafEntries[leafEntries.length - 1];
  if (latestLeaf?.type === "leaf") {
    return pathToRoot(entries, latestLeaf.targetId);
  }
  const ordered = [...entries.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const leaf = ordered[ordered.length - 1];
  return pathToRoot(entries, leaf?.id ?? null);
}

function pathToRoot(entries: Map<string, SessionTreeEntry>, leafId: string | null): SessionTreeEntry[] {
  const path: SessionTreeEntry[] = [];
  const seen = new Set<string>();
  let cursor = leafId;
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const entry = entries.get(cursor);
    if (!entry) break;
    path.push(entry);
    cursor = entry.parentId;
  }
  return path.reverse();
}

function isSessionTreeEntry(value: unknown): value is SessionTreeEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["type"] === "string" &&
    typeof record["id"] === "string" &&
    (typeof record["parentId"] === "string" || record["parentId"] === null) &&
    typeof record["timestamp"] === "string"
  );
}
