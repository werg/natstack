/**
 * Tests for the `GadSessionStorage` adapter. The gad RPC surface is mocked;
 * we exercise the entry mapping, leaf walk, CAS retry, and shape-error
 * surfacing.
 */

import { describe, it, expect, vi } from "vitest";
import type {
  SessionTreeEntry,
  MessageEntry,
  LabelEntry,
  CompactionEntry,
} from "@earendil-works/pi-agent-core";
import { Session } from "@earendil-works/pi-agent-core";

import {
  GadSessionStorage,
  TranscriptShapeError,
  rowToSessionEntry,
  sessionEntryToSpec,
  type GadRpcCaller,
} from "./gad-session-storage.js";
import type {
  GadAppendTrajectoryBatchInput,
  GadAppendTrajectoryBatchResult,
  GadBranchHead,
  GadEntryRow,
  GadTrajectoryItemSpec,
} from "./gad-types.js";

// ─── Test doubles ────────────────────────────────────────────────────────────

interface FakeBranchState {
  head: GadBranchHead;
  rows: GadEntryRow[];
  appendCalls: GadAppendTrajectoryBatchInput[];
  setHeadCalls: Array<{ entryId: string | null }>;
  /** When > 0, the next N append calls fail with a CAS conflict. */
  conflictsRemaining: number;
}

function createFakeGad(branchId = "branch:test"): {
  rpc: GadRpcCaller;
  state: FakeBranchState;
} {
  const state: FakeBranchState = {
    head: {
      workspaceId: "default",
      branchId,
      headTrajectoryId: null,
      headTrajectoryHash: null,
      headEntryId: null,
      headStateHash: "state:empty",
      dirty: false,
    },
    rows: [],
    appendCalls: [],
    setHeadCalls: [],
    conflictsRemaining: 0,
  };

  let nextTrajectoryId = 1;

  const append = (input: GadAppendTrajectoryBatchInput): GadAppendTrajectoryBatchResult => {
    state.appendCalls.push(input);
    if (state.conflictsRemaining > 0) {
      state.conflictsRemaining--;
      throw new Error("gad head conflict");
    }
    const created: GadAppendTrajectoryBatchResult["items"] = [];
    for (const spec of input.items) {
      const trajectoryId = nextTrajectoryId++;
      const trajectoryHash = `traj:${trajectoryId}`;
      const row: GadEntryRow = {
        trajectoryId,
        trajectoryHash,
        entryId: spec.entryId,
        parentEntryId: spec.parentEntryId,
        entryType: spec.entryType,
        actor: spec.actor ?? null,
        payload: spec.payload,
        metadata: spec.metadata ?? null,
        createdAt: new Date().toISOString(),
      };
      state.rows.push(row);
      state.head = {
        ...state.head,
        headTrajectoryId: trajectoryId,
        headTrajectoryHash: trajectoryHash,
        headEntryId: spec.entryId,
      };
      created.push({
        id: trajectoryId,
        hash: trajectoryHash,
        entryId: spec.entryId,
        parentEntryId: spec.parentEntryId,
      });
    }
    return {
      workspaceId: state.head.workspaceId,
      branchId: state.head.branchId,
      headTrajectoryId: state.head.headTrajectoryId,
      headTrajectoryHash: state.head.headTrajectoryHash,
      headEntryId: state.head.headEntryId,
      headStateHash: state.head.headStateHash,
      items: created,
    };
  };

  const callImpl = async (target: string, method: string, ...args: unknown[]): Promise<unknown> => {
      void target;
      switch (method) {
        case "gad.ensureGadBranch":
        case "gad.getGadBranchHead":
          return state.head;
        case "gad.appendGadTrajectoryBatch":
          return append(args[0] as GadAppendTrajectoryBatchInput);
        case "gad.setBranchHead": {
          const { entryId } = args[0] as { entryId: string | null };
          state.setHeadCalls.push({ entryId });
          const row = state.rows.find((r) => r.entryId === entryId);
          state.head = {
            ...state.head,
            headEntryId: entryId,
            headTrajectoryId: row?.trajectoryId ?? null,
            headTrajectoryHash: row?.trajectoryHash ?? null,
          };
          return state.head;
        }
        case "gad.getEntryById": {
          const { entryId } = args[0] as { entryId: string };
          return state.rows.find((r) => r.entryId === entryId) ?? null;
        }
        case "gad.getBranchPath": {
          const { throughEntryId } = args[0] as { throughEntryId?: string | null };
          if (throughEntryId == null) return [...state.rows];
          const cutoff = state.rows.findIndex((r) => r.entryId === throughEntryId);
          return cutoff < 0 ? [] : state.rows.slice(0, cutoff + 1);
        }
        case "gad.findBranchEntriesByType": {
          const { entryType } = args[0] as { entryType: string };
          return state.rows.filter((r) => r.entryType === entryType);
        }
        default:
          throw new Error(`unmocked rpc.call ${method}`);
      }
    };
  const callSpy = vi.fn(callImpl);
  const rpc: GadRpcCaller = {
    call: callSpy as unknown as GadRpcCaller["call"],
  };
  return { rpc, state };
}

// ─── Mapping (pure) ──────────────────────────────────────────────────────────

describe("sessionEntryToSpec ↔ rowToSessionEntry", () => {
  function roundtrip(entry: SessionTreeEntry): SessionTreeEntry {
    const spec = sessionEntryToSpec(entry);
    const row: GadEntryRow = {
      trajectoryId: 1,
      trajectoryHash: "traj:1",
      entryId: spec.entryId,
      parentEntryId: spec.parentEntryId,
      entryType: spec.entryType,
      actor: spec.actor ?? null,
      payload: spec.payload,
      metadata: spec.metadata ?? null,
      createdAt: new Date().toISOString(),
    };
    return rowToSessionEntry(row);
  }

  it("preserves a message entry", () => {
    const entry: MessageEntry = {
      id: "01900000-0000-7000-8000-000000000001",
      parentId: null,
      timestamp: "2026-05-17T12:00:00.000Z",
      type: "message",
      message: { role: "user", content: "hi", timestamp: 1 } as never,
    };
    expect(roundtrip(entry)).toEqual(entry);
  });

  it("preserves a label entry", () => {
    const entry: LabelEntry = {
      id: "01900000-0000-7000-8000-000000000002",
      parentId: "01900000-0000-7000-8000-000000000001",
      timestamp: "2026-05-17T12:01:00.000Z",
      type: "label",
      targetId: "01900000-0000-7000-8000-000000000001",
      label: "main",
    };
    expect(roundtrip(entry)).toEqual(entry);
  });

  it("preserves a label entry with undefined label", () => {
    const entry: LabelEntry = {
      id: "01900000-0000-7000-8000-000000000003",
      parentId: null,
      timestamp: "2026-05-17T12:02:00.000Z",
      type: "label",
      targetId: "01900000-0000-7000-8000-000000000001",
      label: undefined,
    };
    expect(roundtrip(entry)).toEqual(entry);
  });

  it("preserves a compaction entry with details", () => {
    const entry: CompactionEntry<{ source: string }> = {
      id: "01900000-0000-7000-8000-000000000004",
      parentId: null,
      timestamp: "2026-05-17T12:03:00.000Z",
      type: "compaction",
      summary: "summary text",
      firstKeptEntryId: "01900000-0000-7000-8000-000000000001",
      tokensBefore: 12000,
      details: { source: "auto" },
      fromHook: false,
    };
    expect(roundtrip(entry)).toEqual(entry);
  });

  it("preserves a model_change entry", () => {
    const entry: SessionTreeEntry = {
      id: "01900000-0000-7000-8000-000000000005",
      parentId: null,
      timestamp: "2026-05-17T12:04:00.000Z",
      type: "model_change",
      provider: "anthropic",
      modelId: "claude-opus-4-7",
    };
    expect(roundtrip(entry)).toEqual(entry);
  });

  it("preserves a leaf entry", () => {
    const entry: SessionTreeEntry = {
      id: "01900000-0000-7000-8000-000000000006",
      parentId: null,
      timestamp: "2026-05-17T12:05:00.000Z",
      type: "leaf",
      targetId: "01900000-0000-7000-8000-000000000001",
    };
    expect(roundtrip(entry)).toEqual(entry);
  });

  it("throws TranscriptShapeError-equivalent when payload is malformed", () => {
    const row: GadEntryRow = {
      trajectoryId: 1,
      trajectoryHash: "traj:1",
      entryId: "01900000-0000-7000-8000-000000000007",
      parentEntryId: null,
      entryType: "message",
      actor: null,
      payload: {},
      metadata: null,
      createdAt: new Date().toISOString(),
    };
    expect(() => rowToSessionEntry(row)).toThrow(/payload\.message/);
  });
});

// ─── Storage behaviour ────────────────────────────────────────────────────────

describe("GadSessionStorage", () => {
  it("appendEntry writes one envelope item via appendGadTrajectoryBatch", async () => {
    const { rpc, state } = createFakeGad();
    const storage = new GadSessionStorage({ rpc, branchId: "branch:test" });
    const entry: MessageEntry = {
      id: await storage.createEntryId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
      message: { role: "user", content: "hi", timestamp: 1 } as never,
    };
    await storage.appendEntry(entry);
    expect(state.appendCalls).toHaveLength(1);
    expect(state.appendCalls[0]!.items).toHaveLength(1);
    expect(state.appendCalls[0]!.items[0]!.entryType).toBe("message");
    expect(state.appendCalls[0]!.items[0]!.entryId).toBe(entry.id);
  });

  it("getLeafId returns the branch headEntryId", async () => {
    const { rpc, state } = createFakeGad();
    state.head = { ...state.head, headEntryId: "01900000-0000-7000-8000-000000000099" };
    const storage = new GadSessionStorage({ rpc, branchId: "branch:test" });
    expect(await storage.getLeafId()).toBe("01900000-0000-7000-8000-000000000099");
  });

  it("setLeafId routes to gad.setBranchHead", async () => {
    const { rpc, state } = createFakeGad();
    const storage = new GadSessionStorage({ rpc, branchId: "branch:test" });
    await storage.setLeafId("01900000-0000-7000-8000-000000000088");
    expect(state.setHeadCalls).toEqual([{ entryId: "01900000-0000-7000-8000-000000000088" }]);
    await storage.setLeafId(null);
    expect(state.setHeadCalls).toEqual([
      { entryId: "01900000-0000-7000-8000-000000000088" },
      { entryId: null },
    ]);
  });

  it("retries on CAS conflict and succeeds within MAX_CAS_RETRIES", async () => {
    const { rpc, state } = createFakeGad();
    state.conflictsRemaining = 2;
    const storage = new GadSessionStorage({ rpc, branchId: "branch:test" });
    const entry: MessageEntry = {
      id: await storage.createEntryId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
      message: { role: "user", content: "retry me", timestamp: 1 } as never,
    };
    await storage.appendEntry(entry);
    expect(state.appendCalls).toHaveLength(3); // two conflicts + success
  });

  it("throws after MAX_CAS_RETRIES exhausted conflicts", async () => {
    const { rpc, state } = createFakeGad();
    state.conflictsRemaining = 5;
    const storage = new GadSessionStorage({ rpc, branchId: "branch:test" });
    const entry: MessageEntry = {
      id: await storage.createEntryId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
      message: { role: "user", content: "no", timestamp: 1 } as never,
    };
    await expect(storage.appendEntry(entry)).rejects.toThrow(/gad head conflict/);
  });

  it("findEntries filters by entry type", async () => {
    const { rpc, state } = createFakeGad();
    const storage = new GadSessionStorage({ rpc, branchId: "branch:test" });
    const m1: MessageEntry = {
      id: await storage.createEntryId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
      message: { role: "user", content: "a", timestamp: 1 } as never,
    };
    await storage.appendEntry(m1);
    const m2: MessageEntry = {
      id: await storage.createEntryId(),
      parentId: m1.id,
      timestamp: new Date().toISOString(),
      type: "message",
      message: { role: "assistant", content: "b", timestamp: 2 } as never,
    };
    await storage.appendEntry(m2);
    const found = await storage.findEntries("message");
    expect(found.map((e) => e.id)).toEqual([m1.id, m2.id]);
    void state;
  });

  it("getLabel returns the latest label for a target along the chain", async () => {
    const { rpc } = createFakeGad();
    const storage = new GadSessionStorage({ rpc, branchId: "branch:test" });
    const targetId = "01900000-0000-7000-8000-000000001111";
    await storage.appendEntry({
      id: await storage.createEntryId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "label",
      targetId,
      label: "first",
    });
    await storage.appendEntry({
      id: await storage.createEntryId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "label",
      targetId,
      label: "second",
    });
    expect(await storage.getLabel(targetId)).toBe("second");
  });

  it("surfaces a TranscriptShapeError when payload mapping fails", async () => {
    const { rpc, state } = createFakeGad();
    const observer = vi.fn();
    const storage = new GadSessionStorage({
      rpc,
      branchId: "branch:test",
      onTranscriptShapeError: observer,
    });
    state.rows.push({
      trajectoryId: 99,
      trajectoryHash: "traj:99",
      entryId: "01900000-0000-7000-8000-000000007777",
      parentEntryId: null,
      entryType: "message",
      actor: null,
      payload: {}, // missing payload.message — invalid
      metadata: null,
      createdAt: new Date().toISOString(),
    });
    await expect(
      storage.getEntry("01900000-0000-7000-8000-000000007777"),
    ).rejects.toBeInstanceOf(TranscriptShapeError);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("integrates with upstream Session.buildContext", async () => {
    const { rpc } = createFakeGad();
    const storage = new GadSessionStorage({ rpc, branchId: "branch:test" });
    const session = new Session(storage);
    await session.appendMessage({ role: "user", content: "hello", timestamp: 1 } as never);
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi back" }],
      api: "anthropic" as never,
      provider: "anthropic" as never,
      model: "claude-opus-4-7",
      usage: { inputTokens: 0, outputTokens: 0 } as never,
      stopReason: "stop",
      timestamp: 2,
    } as never);
    const context = await session.buildContext();
    expect(context.messages).toHaveLength(2);
    expect(context.messages[0]!.role).toBe("user");
    expect(context.messages[1]!.role).toBe("assistant");
  });
});
