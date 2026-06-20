import { describe, expect, it } from "vitest";
import { ChannelClient } from "./channel-client.js";

interface Captured {
  event?: { payload?: { tier?: unknown; role?: unknown } };
}

/** A ChannelClient backed by a stub RpcCaller that captures the published event. */
function makeClient(captured: Captured): ChannelClient {
  const rpc = {
    call: async (_target: string, method: string, args: unknown[]) => {
      if (method === "workers.resolveService") {
        return { kind: "durable-object", targetId: "chan-do" };
      }
      if (method === "publish") {
        captured.event = args[2] as Captured["event"];
        return { id: 1 };
      }
      return undefined;
    },
  };
  return new ChannelClient(rpc as never, "chan-1");
}

describe("ChannelClient.send tier", () => {
  it("defaults a deliberate agent send (e.g. the say tool) to the primary tier", async () => {
    const captured: Captured = {};
    await makeClient(captured).send("agent:1", "m1", "hello there", {
      senderMetadata: { type: "agent" },
    });
    expect(captured.event?.payload?.role).toBe("assistant");
    expect(captured.event?.payload?.tier).toBe("primary");
  });

  it("honors an explicit secondary tier for a deliberately slight send", async () => {
    const captured: Captured = {};
    await makeClient(captured).send("agent:1", "m2", "working on it…", {
      senderMetadata: { type: "agent" },
      tier: "secondary",
    });
    expect(captured.event?.payload?.tier).toBe("secondary");
  });
});
