// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  brandId,
  type AgenticEvent,
  type MessageId,
} from "@workspace/agentic-protocol";
import type { PubSubClient } from "@workspace/pubsub";

import { useChannelMessages, type UseChannelMessagesResult } from "./useChannelMessages";

function messageCompleted(
  id: string,
  content: string,
  createdAt = "2026-05-21T08:00:00.000Z",
): AgenticEvent<"message.completed"> {
  return {
    kind: "message.completed",
    actor: { kind: "user", id: "panel:user" },
    causality: { messageId: brandId<MessageId>(id) },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      role: "user",
      content,
    },
    createdAt,
  };
}

function pubsubAgenticEvent(seq: number, payload: AgenticEvent) {
  return {
    type: AGENTIC_EVENT_PAYLOAD_KIND,
    delivery: "log",
    phase: "replay",
    senderId: payload.actor.id,
    pubsubId: seq,
    ts: Date.parse(payload.createdAt),
    senderMetadata: { name: "User", type: "panel", handle: "user" },
    payload,
  };
}

function rawReplayEvent(seq: number, payload: AgenticEvent) {
  return {
    id: seq,
    messageId: `env-${seq}`,
    type: AGENTIC_EVENT_PAYLOAD_KIND,
    senderId: payload.actor.id,
    ts: Date.parse(payload.createdAt),
    senderMetadata: { name: "User", type: "panel", handle: "user" },
    payload,
  };
}

function createClient(events: unknown[] = [], overrides: Partial<PubSubClient> = {}): PubSubClient {
  const client = {
    channelId: "channel-1",
    hasMoreBefore: false,
    events: vi.fn(async function* () {
      for (const event of events) yield event;
    }),
    getReplayAfter: vi.fn(async () => ({ logEvents: [], ready: { hasMoreBefore: false } })),
    getReplayBefore: vi.fn(async () => ({ logEvents: [], ready: { hasMoreBefore: false } })),
    ...overrides,
  };
  return client as unknown as PubSubClient;
}

function Probe({
  client,
  onValue,
}: {
  client: PubSubClient;
  onValue: (value: UseChannelMessagesResult) => void;
}) {
  const value = useChannelMessages(client);
  onValue(value);
  return null;
}

describe("useChannelMessages", () => {
  it("backfills a locally published envelope through replay instead of optimistic transcript state", async () => {
    let latest: UseChannelMessagesResult | undefined;
    const initialPrompt = messageCompleted("initial-prompt", "Read the docs first");
    const getReplayAfter = vi.fn(async (cursor: number) => {
      expect(cursor).toBe(0);
      return {
        mode: "after" as const,
        logEvents: [rawReplayEvent(1, initialPrompt)],
        snapshots: [],
        ready: { totalCount: 1, envelopeCount: 1, hasMoreBefore: false },
      };
    });
    const client = createClient([], { getReplayAfter });

    render(<Probe client={client} onValue={(value) => { latest = value; }} />);

    await act(async () => {
      await latest!.backfillAfterLocalPublish(1);
    });

    await waitFor(() => {
      expect(latest!.messages).toHaveLength(1);
      expect(latest!.messages[0]).toMatchObject({
        id: "initial-prompt",
        content: "Read the docs first",
        complete: true,
      });
    });
    expect(client.events).toHaveBeenCalledWith({ includeReplay: true, includeSignals: true });
  });

  it("loads earlier typed envelopes before the replay anchor and updates pagination metadata", async () => {
    let latest: UseChannelMessagesResult | undefined;
    const current = messageCompleted("current", "Current message", "2026-05-21T08:01:00.000Z");
    const older = messageCompleted("older", "Older message", "2026-05-21T08:00:00.000Z");
    const getReplayBefore = vi.fn(async (anchor: number, limit: number) => {
      expect(anchor).toBe(10);
      expect(limit).toBe(100);
      return {
        mode: "before" as const,
        logEvents: [rawReplayEvent(2, older)],
        snapshots: [],
        ready: { totalCount: 2, envelopeCount: 2, hasMoreBefore: false },
      };
    });
    const client = createClient(
      [pubsubAgenticEvent(10, current)],
      { hasMoreBefore: true, getReplayBefore },
    );

    render(<Probe client={client} onValue={(value) => { latest = value; }} />);

    await waitFor(() => {
      expect(latest!.messages.map((message) => message.id)).toEqual(["current"]);
      expect(latest!.hasMoreHistory).toBe(true);
    });

    await act(async () => {
      await latest!.loadEarlierMessages();
    });

    await waitFor(() => {
      expect(latest!.messages.map((message) => message.id)).toEqual(["older", "current"]);
      expect(latest!.hasMoreHistory).toBe(false);
    });
  });
});
