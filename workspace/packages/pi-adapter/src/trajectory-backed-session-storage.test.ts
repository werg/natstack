import { describe, expect, it, vi } from "vitest";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { TrajectoryBackedSessionStorage } from "./trajectory-backed-session-storage.js";
import { materializeSessionTree } from "./materialize-session-tree.js";

const timestamp = "2026-05-20T12:00:00.000Z";

describe("TrajectoryBackedSessionStorage", () => {
  it("materializes path entries and keeps writes in memory", async () => {
    const first: SessionTreeEntry = {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp,
      message: { role: "user", content: "hello", timestamp: 1 } as never,
    };
    const storage = new TrajectoryBackedSessionStorage({
      trajectoryId: "traj-1",
      branchId: "main",
      entries: [first],
    });
    expect(await storage.getLeafId()).toBe("entry-1");
    expect(await storage.getEntries()).toEqual([first]);
  });

  it("persists exact Pi session tree entries into private trajectory events", async () => {
    const appendEvent = vi.fn();
    const storage = new TrajectoryBackedSessionStorage({
      trajectoryId: "traj-1",
      branchId: "main",
      entries: [],
      appendEvent,
    });
    await storage.appendEntry({
      type: "model_change",
      id: "entry-1",
      parentId: null,
      timestamp,
      provider: "anthropic",
      modelId: "claude",
    });
    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "system.event",
      payload: expect.objectContaining({
        details: expect.objectContaining({
          kind: "pi.session_entry",
          entry: expect.objectContaining({ type: "model_change", modelId: "claude" }),
        }),
      }),
    }));
  });

  it("persists message entries exactly for LLM cache/session restore", async () => {
    const appendEvent = vi.fn();
    const storage = new TrajectoryBackedSessionStorage({
      trajectoryId: "traj-1",
      branchId: "main",
      entries: [],
      appendEvent,
    });
    await storage.appendEntry({
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp,
      message: { role: "assistant", content: "hi", timestamp: 1 } as never,
    });
    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "system.event",
      payload: expect.objectContaining({
        details: expect.objectContaining({
          kind: "pi.session_entry",
          entry: expect.objectContaining({
            type: "message",
            message: expect.objectContaining({ role: "assistant", content: "hi" }),
          }),
        }),
      }),
    }));
  });

  it("materializes exact Pi entries ahead of lossy message projection", () => {
    const first: SessionTreeEntry = {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "cached" },
          { type: "toolCall", id: "call-1", name: "read", input: { path: "a.ts" } },
        ],
        timestamp: 1,
        stopReason: "tool_calls",
      } as never,
    };
    const leaf: SessionTreeEntry = {
      type: "leaf",
      id: "leaf-1",
      parentId: "entry-1",
      timestamp,
      targetId: "entry-1",
    };

    const state = {
      systemEvents: [first, leaf].map((entry, seq) => ({
        kind: "system.event",
        actor: { kind: "agent", id: "agent-1" },
        payload: {
          protocol: "agentic.trajectory.v1",
          kind: entry.type,
          details: { kind: "pi.session_entry", entry },
        },
        createdAt: entry.timestamp,
        eventId: `event-${seq}`,
        trajectoryId: "traj-1",
        branchId: "main",
        seq,
        prevEventHash: "0",
        eventHash: `${seq}`,
      })),
      messages: {
        "entry-1": {
          messageId: "entry-1",
          actor: { kind: "agent", id: "agent-1" },
          role: "assistant",
          content: "lossy",
          status: "completed",
        },
      },
    } as never;

    expect(materializeSessionTree(state)).toEqual([first]);
  });
});
