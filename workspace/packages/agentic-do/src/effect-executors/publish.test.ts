import { describe, expect, it, vi } from "vitest";
import { publishExecutor } from "./index.js";
import type { ExecutorDeps } from "./types.js";
import type { PublishEnvelopeEffect } from "@workspace/agent-loop";

describe("publishExecutor", () => {
  it("forwards the descriptor idempotencyKey to channel.publish", async () => {
    const publish = vi.fn(
      async (_input: {
        channelId: string;
        payloadKind: string;
        payload: unknown;
        idempotencyKey?: string;
      }) => {}
    );
    const deps = { channel: { publish } } as unknown as ExecutorDeps;
    const descriptor: PublishEnvelopeEffect = {
      effectId: "read:src-1:turn-1",
      kind: "publish_envelope",
      channelId: "chan-1",
      idempotencyKey: "read:src-1:turn-1",
      payloadKind: "agentic.trajectory.v1/event",
      payload: { kind: "message.read" },
    };

    await publishExecutor.execute({
      descriptor,
      state: {} as never,
      signal: new AbortController().signal,
      deps,
      onEphemeral: () => {},
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({
      channelId: "chan-1",
      payloadKind: "agentic.trajectory.v1/event",
      idempotencyKey: "read:src-1:turn-1",
    });
  });
});
