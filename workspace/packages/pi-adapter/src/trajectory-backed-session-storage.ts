import {
  uuidv7,
  type SessionMetadata,
  type SessionStorage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
  brandId,
  type AgenticEvent,
  type EventId,
  type EventKind,
} from "@workspace/agentic-protocol";

export interface TrajectorySessionMetadata extends SessionMetadata {
  trajectoryId: string;
  branchId: string;
}

export interface TrajectoryBackedSessionStorageOptions {
  trajectoryId: string;
  branchId: string;
  entries: SessionTreeEntry[];
  appendEvent?: (event: AgenticEvent, entry: SessionTreeEntry) => Promise<void>;
}

export class UnmappedEntryError extends Error {
  constructor(readonly entryType: string) {
    super(`No trajectory bridge is declared for Pi SessionTreeEntry type: ${entryType}`);
    this.name = "UnmappedEntryError";
  }
}

type InterceptorBridge = { storage: "interceptor"; eventKind: EventKind };

export const PI_ENTRY_TRAJECTORY_BRIDGES = {
  message: { storage: "interceptor", eventKind: "system.event" },
  model_change: { storage: "interceptor", eventKind: "system.event" },
  thinking_level_change: { storage: "interceptor", eventKind: "system.event" },
  active_tools_change: { storage: "interceptor", eventKind: "system.event" },
  compaction: { storage: "interceptor", eventKind: "system.event" },
  branch_summary: { storage: "interceptor", eventKind: "system.event" },
  custom: { storage: "interceptor", eventKind: "system.event" },
  custom_message: { storage: "interceptor", eventKind: "system.event" },
  label: { storage: "interceptor", eventKind: "system.event" },
  session_info: { storage: "interceptor", eventKind: "system.event" },
  leaf: { storage: "interceptor", eventKind: "system.event" },
} satisfies Record<SessionTreeEntry["type"], InterceptorBridge>;

export class TrajectoryBackedSessionStorage implements SessionStorage<TrajectorySessionMetadata> {
  private readonly entries = new Map<string, SessionTreeEntry>();
  private leafId: string | null;
  private readonly metadata: TrajectorySessionMetadata;

  constructor(private readonly opts: TrajectoryBackedSessionStorageOptions) {
    this.metadata = {
      id: opts.branchId,
      createdAt: new Date().toISOString(),
      trajectoryId: opts.trajectoryId,
      branchId: opts.branchId,
    };
    for (const entry of opts.entries) this.entries.set(entry.id, entry);
    this.leafId = opts.entries[opts.entries.length - 1]?.id ?? null;
  }

  async getMetadata(): Promise<TrajectorySessionMetadata> {
    return this.metadata;
  }

  async getLeafId(): Promise<string | null> {
    return this.leafId;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.entries.has(leafId)) {
      throw new Error(`Cannot set Pi leaf to unknown entry ${leafId}`);
    }
    this.leafId = leafId;
  }

  async createEntryId(): Promise<string> {
    return uuidv7();
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    this.entries.set(entry.id, entry);
    if (entry.type !== "leaf") this.leafId = entry.id;
    await this.opts.appendEvent?.(sessionEntryToAgenticEvent(entry), entry);
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    return this.entries.get(id);
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    return [...this.entries.values()].filter(
      (entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type
    );
  }

  async getLabel(id: string): Promise<string | undefined> {
    const labels = await this.findEntries("label");
    for (let i = labels.length - 1; i >= 0; i -= 1) {
      const label = labels[i];
      if (label?.targetId === id) return label.label;
    }
    return undefined;
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    const path: SessionTreeEntry[] = [];
    let cursor = leafId ?? this.leafId;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`Cycle in Pi session tree at ${cursor}`);
      seen.add(cursor);
      const entry = this.entries.get(cursor);
      if (!entry) throw new Error(`Missing Pi session entry ${cursor}`);
      path.push(entry);
      cursor = entry.parentId;
    }
    return path.reverse();
  }

  async getEntries(): Promise<SessionTreeEntry[]> {
    return this.getPathToRoot(null);
  }
}

function bridgeForEntry(entry: SessionTreeEntry): InterceptorBridge {
  const bridge = PI_ENTRY_TRAJECTORY_BRIDGES[entry.type];
  if (!bridge) throw new UnmappedEntryError(entry.type);
  return bridge;
}

export function sessionEntryToAgenticEvent(entry: SessionTreeEntry): AgenticEvent {
  const bridge = bridgeForEntry(entry);
  return entryToAgenticEvent(entry, bridge.eventKind);
}

function entryToAgenticEvent(entry: SessionTreeEntry, kind: EventKind): AgenticEvent {
  if (kind === "system.event") {
    return systemEvent(entry, kind, { kind: "pi.session_entry", entry });
  }
  switch (entry.type) {
    case "compaction":
      return {
        kind: "system.compaction_recorded",
        actor: { kind: "agent", id: "pi" },
        payload: {
          protocol: "agentic.trajectory.v1",
          summary: entry.summary,
          rangeStart: brandId<EventId>(entry.id),
          rangeEnd: brandId<EventId>(entry.firstKeptEntryId),
          replacement: {
            tokensBefore: entry.tokensBefore,
            details: entry.details,
            fromHook: entry.fromHook,
          },
        },
        createdAt: entry.timestamp,
      };
    case "message":
    case "leaf":
    case "model_change":
    case "thinking_level_change":
    case "active_tools_change":
    case "branch_summary":
    case "custom":
    case "custom_message":
    case "label":
    case "session_info":
      throw new Error(`${entry.type} entries should use the exact pi.session_entry bridge`);
    default:
      assertNever(entry);
  }
}

function systemEvent(entry: SessionTreeEntry, kind: EventKind, details: unknown): AgenticEvent {
  if (kind !== "system.event") throw new Error(`Expected system.event bridge for ${entry.type}`);
  return {
    kind,
    actor: { kind: "agent", id: "pi" },
    payload: { protocol: "agentic.trajectory.v1", kind: entry.type, details },
    createdAt: entry.timestamp,
  };
}

function assertNever(value: never): never {
  throw new UnmappedEntryError((value as { type?: string }).type ?? "unknown");
}
