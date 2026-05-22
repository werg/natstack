import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { GmailClient, GmailMessage, GmailThread } from "@workspace/gmail";
import { AGENTIC_EVENT_PAYLOAD_KIND } from "@workspace/agentic-protocol";

import { GmailAgentWorker } from "./gmail-agent-worker.js";

function message(
  id: string,
  threadId: string,
  headers: Record<string, string>,
  body = "hello",
  snippet = body,
  labelIds = ["INBOX", "UNREAD"],
): GmailMessage {
  return {
    id,
    threadId,
    labelIds,
    snippet,
    payload: {
      mimeType: "text/plain",
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: { data: Buffer.from(body, "utf8").toString("base64url") },
    },
  };
}

class TestGmailAgentWorker extends GmailAgentWorker {
  published: Array<{ participantId: string; event: { kind?: string; payload?: unknown }; opts?: unknown }> = [];
  replayEvents: Array<{ id: number; type: string; senderId: string; payload: unknown; messageId: string; ts: number }> = [];
  profile = vi.fn(async () => ({
    emailAddress: "me@example.com",
    messagesTotal: 1,
    threadsTotal: 1,
    historyId: "h1",
  }));
  sync = vi.fn(async () => ({
    historyId: "h2",
    rawHistory: { historyId: "h2", history: [] },
    threads: [{ threadId: "thr-1", messagesAdded: [], messagesDeleted: [], labelsAdded: [], labelsRemoved: [] }],
  }));
  fakeThread: GmailThread = {
    id: "thr-1",
    messages: [
      message("msg-1", "thr-1", {
        Subject: "Question",
        From: "a@example.com",
        To: "me@example.com",
        "Message-ID": "<msg-1@example.com>",
        Date: "Fri, 22 May 2026 10:00:00 +0000",
      }, "Private full email body", "Short snippet"),
    ],
  };
  sent = vi.fn(async (params: unknown) => ({ id: "sent-1", threadId: "thr-1", params }));
  draftBodies = vi.fn(async () => "Thanks for the context. I will follow up shortly.");

  protected override createGmailClient(): GmailClient {
    return {
      handle: vi.fn() as never,
      getProfile: this.profile as never,
      listLabels: vi.fn() as never,
      listMessages: vi.fn() as never,
      search: vi.fn() as never,
      listHistory: vi.fn() as never,
      syncSince: this.sync as never,
      getMessage: vi.fn() as never,
      getThread: vi.fn(async () => this.fakeThread),
      sendMessage: this.sent as never,
      createDraft: vi.fn() as never,
      sendDraft: vi.fn() as never,
      modifyLabels: vi.fn(async () => ({})) as never,
    };
  }

  protected override generateDraftReplyBody(): Promise<string> {
    return this.draftBodies();
  }

  protected override createChannelClient() {
    return {
      getReplayAfter: async (cursor: number) => ({
        mode: "after",
        logEvents: this.replayEvents.filter((event) => event.id > cursor),
        snapshots: [],
        ready: { totalCount: this.replayEvents.length, envelopeCount: this.replayEvents.length },
      }),
      publishAgenticEvent: async (participantId: string, event: { kind?: string; payload?: unknown }, opts?: unknown) => {
        this.published.push({ participantId, event, opts });
        return { id: this.published.length };
      },
    } as never;
  }

  seedSubscription(channelId = "ch-1", participantId = "agent-gmail") {
    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions (channel_id, context_id, subscribed_at, config, participant_id)
       VALUES (?, ?, ?, ?, ?)`,
      channelId,
      "ctx-1",
      Date.now(),
      JSON.stringify({ handle: "gmail" }),
      participantId,
    );
  }

  respondPolicy(channelId: string) {
    return this.getRespondPolicy(channelId);
  }

  prompt(channelId: string) {
    return this.getRunnerPromptConfig(channelId);
  }

  participant() {
    return this.getParticipantInfo("ch-1");
  }
}

describe("GmailAgentWorker", () => {
  it("advertises the gmail participant and strict mention policy", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;

    expect(worker.respondPolicy("ch-1")).toBe("mentioned-strict");
    expect(worker.participant()).toMatchObject({
      handle: "gmail",
      name: "Gmail",
      type: "agent",
    });
    expect(worker.participant().methods?.map((method) => method.name)).toContain("checkNow");
    expect(worker.prompt("ch-1").systemPrompt).toContain("Gmail agent");
  });

  it("fetches sanitized thread contents for renderer expansion", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;

    const result = await worker.onMethodCall("ch-1", "call-1", "getThread", { threadId: "thr-1" });

    expect(result.isError).toBeUndefined();
    expect(result.result).toMatchObject({
      threadId: "thr-1",
      messages: [
        {
          id: "msg-1",
          from: "a@example.com",
          subject: "Question",
          bodyText: "Private full email body",
        },
      ],
    });
  });

  it("sends Gmail messages without requiring a channel custom message id", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;

    const result = await worker.onMethodCall("ch-1", "call-1", "send", {
      to: "b@example.com",
      subject: "Re: Question",
      body: "Done",
    });

    expect(result.result).toEqual({ sent: true, id: "sent-1" });
    expect(worker.sent).toHaveBeenCalledWith({
      to: "b@example.com",
      subject: "Re: Question",
      body: "Done",
    });
  });

  it("resolves inline thread replies from the source thread", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;

    const result = await worker.onMethodCall("ch-1", "call-1", "send", {
      threadId: "thr-1",
      body: "Inline reply",
    });

    expect(result.result).toEqual({ sent: true, id: "sent-1" });
    expect(worker.sent).toHaveBeenCalledWith({
      to: "a@example.com",
      subject: "Re: Question",
      body: "Inline reply",
      threadId: "thr-1",
      inReplyTo: "<msg-1@example.com>",
      references: "<msg-1@example.com>",
    });
  });

  it("uses a one-shot draft generator for reply compose cards", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    const result = await worker.onMethodCall("ch-1", "call-1", "draftReply", { threadId: "thr-1" });

    expect(result.isError).toBeUndefined();
    expect(worker.draftBodies).toHaveBeenCalledOnce();
    expect(result.result).toMatchObject({
      body: "Thanks for the context. I will follow up shortly.",
    });
    expect(worker.published[worker.published.length - 1]?.event.payload).toMatchObject({
      typeId: "gmail.compose",
      initialState: {
        to: "a@example.com",
        subject: "Re: Question",
        body: "Thanks for the context. I will follow up shortly.",
        threadId: "thr-1",
        status: "draft",
      },
    });
  });

  it("syncs Gmail state into custom messages without durably publishing message bodies", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    await expect(worker.onMethodCall("ch-1", "call-1", "checkNow", {})).resolves.toMatchObject({
      result: { ok: true, historyId: "h1", threadsUpdated: 0 },
    });
    expect(worker.published.map((entry) => entry.event.kind)).toEqual(["custom.started"]);
    expect(worker.published[0]!.event.payload).toMatchObject({ typeId: "gmail.inbox" });

    await expect(worker.onMethodCall("ch-1", "call-2", "checkNow", {})).resolves.toMatchObject({
      result: { ok: true, historyId: "h2", threadsUpdated: 1 },
    });
    expect(worker.published.map((entry) => (entry.event.payload as { typeId?: string }).typeId).filter(Boolean))
      .toContain("gmail.thread");

    const beforeCategorize = worker.published.length;
    await expect(worker.onMethodCall("ch-1", "call-3", "categorize", {
      threadId: "thr-1",
      category: "urgent",
    })).resolves.toMatchObject({ result: { threadId: "thr-1", category: "urgent" } });
    const afterCategorize = worker.published.slice(beforeCategorize);
    expect(afterCategorize.some((entry) => (entry.event.payload as { typeId?: string }).typeId === "gmail.category")).toBe(true);

    expect(JSON.stringify(worker.published)).not.toContain("Private full email body");
  });

  it("limits actionable threads to unread primary messages addressed to the user", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    await worker.onMethodCall("ch-1", "call-1", "checkNow", {});
    await worker.onMethodCall("ch-1", "call-2", "checkNow", {});
    await expect(worker.onMethodCall("ch-1", "call-3", "listActionableThreads", {})).resolves.toMatchObject({
      result: [expect.objectContaining({ threadId: "thr-1", actionable: true })],
    });

    worker.fakeThread = {
      id: "thr-1",
      messages: [
        message("msg-2", "thr-1", {
          Subject: "Promo",
          From: "a@example.com",
          To: "me@example.com",
          Date: "Fri, 22 May 2026 10:05:00 +0000",
        }, "Sale", "Sale", ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]),
      ],
    };
    await worker.onMethodCall("ch-1", "call-4", "checkNow", {});
    await expect(worker.onMethodCall("ch-1", "call-5", "listActionableThreads", {})).resolves.toMatchObject({
      result: [],
    });

    worker.fakeThread = {
      id: "thr-1",
      messages: [
        message("msg-3", "thr-1", {
          Subject: "Sent by me",
          From: "me@example.com",
          To: "a@example.com",
          Date: "Fri, 22 May 2026 10:10:00 +0000",
        }, "I replied", "I replied"),
      ],
    };
    await worker.onMethodCall("ch-1", "call-6", "checkNow", {});
    await expect(worker.onMethodCall("ch-1", "call-7", "listActionableThreads", {})).resolves.toMatchObject({
      result: [],
    });
  });

  it("recovers actionable thread state from durable custom messages on first use", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.replayEvents = [{
      id: 1,
      messageId: "custom-start",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      senderId: "agent-gmail",
      payload: {
        kind: "custom.started",
        actor: { kind: "agent", id: "agent-gmail" },
        payload: {
          protocol: "agentic.trajectory.v1",
          typeId: "gmail.thread",
          messageId: "thread-card-1",
          initialState: {
            threadId: "thr-recovered",
            subject: "Recovered",
            participants: ["a@example.com"],
            lastSnippet: "Needs reply",
            unreadCount: 1,
            hasDraft: false,
            status: "unread",
          },
        },
        createdAt: new Date().toISOString(),
      },
      ts: Date.now(),
    }];

    const result = await worker.onMethodCall("ch-1", "call-1", "listActionableThreads", { limit: 3 });

    expect(result.isError).toBeUndefined();
    expect(result.result).toEqual([
      expect.objectContaining({
        threadId: "thr-recovered",
        subject: "Recovered",
        lastSnippet: "Needs reply",
        unreadCount: 1,
        status: "unread",
      }),
    ]);
  });
});
