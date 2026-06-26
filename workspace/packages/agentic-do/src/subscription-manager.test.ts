import { describe, expect, it, vi } from "vitest";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelClient } from "./channel-client.js";
import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";

async function makeManager(channel: Partial<ChannelClient>) {
  const sql = (await createInMemorySql()) as unknown as SqlStorage;
  const identity = new DOIdentity(sql);
  identity.createTables();
  identity.bootstrap(
    { source: "workers/test-agent", className: "TestAgentWorker", objectKey: "agent-1" },
    "session-1"
  );
  const manager = new SubscriptionManager(sql, () => channel as ChannelClient, identity);
  manager.createTables();
  return { manager, sql };
}

describe("SubscriptionManager", () => {
  it("does not leave a local subscription row when remote subscribe fails", async () => {
    const channel = {
      subscribe: vi.fn(async () => {
        throw new Error("duplicate participant");
      }),
    };
    const { manager } = await makeManager(channel);

    await expect(
      manager.subscribe({
        channelId: "ch-1",
        contextId: "ctx-1",
        descriptor: { name: "Test", type: "agent", handle: "test" },
      })
    ).rejects.toThrow("duplicate participant");

    expect(manager.count()).toBe(0);
    expect(manager.listAll()).toEqual([]);
  });

  it("rename re-keys the channel and (optionally) re-homes the context", async () => {
    const channel = {
      // The manager only stores the row + reads channelConfig/envelope opaquely;
      // a minimal stub cast to the full return type is enough here.
      subscribe: vi.fn(
        async () => ({ ok: true }) as Awaited<ReturnType<ChannelClient["subscribe"]>>
      ),
    };
    const { manager } = await makeManager(channel);
    await manager.subscribe({
      channelId: "ch-1",
      contextId: "ctx-src",
      descriptor: { name: "Test", type: "agent", handle: "test" },
    });

    // Same-context re-key: channel changes, context preserved.
    manager.rename("ch-1", "ch-2");
    expect(manager.getContextId("ch-2")).toBe("ctx-src");

    // True context fork: channel + context both move.
    manager.rename("ch-2", "ch-3", "ctx-fork");
    expect(manager.getContextId("ch-3")).toBe("ctx-fork");
  });
});
