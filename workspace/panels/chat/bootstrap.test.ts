import { describe, expect, it } from "vitest";
import {
  appendPendingAgent,
  rehydratePendingAgent,
  resolveChatContextId,
  type PendingAgentRecord,
} from "./bootstrap.js";

describe("resolveChatContextId", () => {
  it("prefers the state-args context when present", () => {
    expect(resolveChatContextId("ctx-from-state", "ctx-from-runtime")).toBe("ctx-from-state");
  });

  it("falls back to the runtime context", () => {
    expect(resolveChatContextId(undefined, "ctx-from-runtime")).toBe("ctx-from-runtime");
  });

  it("returns null when no usable context is available", () => {
    expect(resolveChatContextId(undefined, undefined)).toBeUndefined();
    expect(resolveChatContextId("", "   ")).toBeUndefined();
  });
});

describe("appendPendingAgent", () => {
  const sample: PendingAgentRecord = {
    agentId: "AiChatWorker",
    handle: "ai-chat-abcd",
    key: "ai-chat-abcd-12345678",
    source: "workers/agent-worker",
    className: "AiChatWorker",
  };

  it("creates a new array when existing is undefined", () => {
    const next = appendPendingAgent(undefined, sample);
    expect(next).toEqual([sample]);
  });

  it("appends to an existing array without mutating it", () => {
    const existing: PendingAgentRecord[] = [
      { agentId: "A", handle: "a", key: "a-1", source: "src", className: "A" },
    ];
    const next = appendPendingAgent(existing, sample);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(existing[0]);
    expect(next[1]).toEqual(sample);
    // Source array must not be mutated.
    expect(existing).toHaveLength(1);
  });

  it("preserves all persisted fields needed by bootstrap rehydration", () => {
    const next = appendPendingAgent(undefined, sample);
    const persisted = next[0]!;
    // These exact fields are read by the rehydration block in index.tsx
    expect(persisted.agentId).toBe(sample.agentId);
    expect(persisted.handle).toBe(sample.handle);
    expect(persisted.key).toBe(sample.key);
    expect(persisted.source).toBe(sample.source);
    expect(persisted.className).toBe(sample.className);
  });
});

describe("rehydratePendingAgent (regression: key is NOT regenerated on rehydration)", () => {
  const defaults = {
    workerSource: "workers/agent-worker",
    fallbackClass: "AiChatWorker",
    randomSuffix: () => "00000000", // deterministic; should not be consulted when key exists
  };

  it("preserves the persisted key verbatim when all fields are present", () => {
    const agent: PendingAgentRecord = {
      agentId: "AiChatWorker",
      handle: "ai-chat-abcd",
      key: "agent-k-1",
      source: "workers/agent-worker",
      className: "AiChatWorker",
    };
    const { record, mutated } = rehydratePendingAgent(agent, defaults);
    expect(record.key).toBe("agent-k-1");
    expect(mutated).toBe(false);
    // Identity round-trips unchanged.
    expect(record).toEqual(agent);
  });

  it("does NOT regenerate the key even if mutation is otherwise required (source/className missing)", () => {
    const agent = {
      agentId: "AiChatWorker",
      handle: "ai-chat-abcd",
      key: "agent-k-1",
      // source and className intentionally missing — simulates an older build
    } as Partial<PendingAgentRecord> & { agentId: string; handle: string };
    const { record, mutated } = rehydratePendingAgent(agent, defaults);
    expect(record.key).toBe("agent-k-1");
    expect(mutated).toBe(true);
    expect(record.source).toBe("workers/agent-worker");
    expect(record.className).toBe("AiChatWorker");
  });

  it("only mints a new key (with deterministic suffix) when key is absent", () => {
    const agent = {
      agentId: "AiChatWorker",
      handle: "ai-chat-abcd",
      // key intentionally missing — pre-key persistence
    } as Partial<PendingAgentRecord> & { agentId: string; handle: string };
    const { record, mutated } = rehydratePendingAgent(agent, defaults);
    expect(record.key).toBe("ai-chat-abcd-00000000");
    expect(mutated).toBe(true);
  });
});
