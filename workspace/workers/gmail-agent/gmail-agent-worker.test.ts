import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GmailApiError, type GmailClient, type GmailMessage, type GmailThread } from "@workspace/gmail";
import { AGENTIC_EVENT_PAYLOAD_KIND } from "@workspace/agentic-protocol";
import { AgentWorkerBase } from "@workspace/agentic-do";

import { GmailAgentWorker } from "./gmail-agent-worker.js";
import { GMAIL_MESSAGE_TYPES } from "./cards/cards.js";

function message(
  id: string,
  threadId: string,
  headers: Record<string, string>,
  body = "hello",
  snippet = body,
  labelIds = ["INBOX", "UNREAD"]
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
  published: Array<{
    participantId: string;
    event: { kind?: string; payload?: unknown };
    opts?: unknown;
  }> = [];
  signals: Array<{ participantId: string; content: string; type?: string }> = [];
  agentInitiatedTurns: Array<{ channelId: string; content: string }> = [];
  replayEvents: Array<{
    id: number;
    type: string;
    senderId: string;
    payload: unknown;
    messageId: string;
    ts: number;
  }> = [];
  profile = vi.fn(async () => ({
    emailAddress: "me@example.com",
    messagesTotal: 1,
    threadsTotal: 1,
    historyId: "h1",
  }));
  sync = vi.fn(async () => ({
    historyId: "h2",
    rawHistory: { historyId: "h2", history: [] },
    threads: [
      {
        threadId: "thr-1",
        messagesAdded: [],
        messagesDeleted: [],
        labelsAdded: [],
        labelsRemoved: [],
      },
    ],
  }));
  listMessages = vi.fn(async () => ({
    messages: [
      message(
        "msg-1",
        "thr-1",
        {
          Subject: "Question",
          From: "a@example.com",
          To: "me@example.com",
          "Message-ID": "<msg-1@example.com>",
          Date: "Fri, 22 May 2026 10:00:00 +0000",
        },
        "Private full email body",
        "Short snippet"
      ),
    ],
  }));
  fakeThread: GmailThread = {
    id: "thr-1",
    messages: [
      message(
        "msg-1",
        "thr-1",
        {
          Subject: "Question",
          From: "a@example.com",
          To: "me@example.com",
          "Message-ID": "<msg-1@example.com>",
          Date: "Fri, 22 May 2026 10:00:00 +0000",
        },
        "Private full email body",
        "Short snippet"
      ),
    ],
  };
  sent = vi.fn(async (params: unknown) => ({ id: "sent-1", threadId: "thr-1", params }));
  searchContacts = vi.fn(async (_query: string, _opts?: unknown) => [
    { email: "zelda@hyrule.example", displayName: "Zelda Hyrule" },
  ]);
  searchOtherContacts = vi.fn(
    async (_query: string, _opts?: unknown) => [] as Array<{ email: string }>
  );
  createDraft = vi.fn(async () => ({ id: "draft-1", message: { id: "m", threadId: "t" } }));
  draftBodies = vi.fn(async () => "Thanks for the context. I will follow up shortly.");
  useBaseDraftGeneration = false;
  rpcCall = vi.fn(async (_target: string, method: string): Promise<unknown> => {
    if (method === "runtime.resolveContext") return "ctx-1";
    if (method === "workers.resolveService") {
      return { kind: "durable-object", targetId: "do:channel:test" };
    }
    if (method === "subscribe") {
      return { ok: true, participantId: "agent-gmail", channelConfig: {} };
    }
    return { id: "cred-1" };
  });

  protected override get rpc(): never {
    return {
      call: this.rpcCall,
      callDeferred: async (...args: unknown[]) => ({
        status: "completed" as const,
        result: await (this.rpcCall as (...rpcArgs: unknown[]) => Promise<unknown>)(...args),
      }),
    } as never;
  }

  protected override createGmailClient(): GmailClient {
    return {
      handle: vi.fn() as never,
      getProfile: this.profile as never,
      listLabels: vi.fn() as never,
      listMessages: this.listMessages as never,
      search: vi.fn() as never,
      listHistory: vi.fn() as never,
      syncSince: this.sync as never,
      getMessage: vi.fn() as never,
      getThread: vi.fn(async () => this.fakeThread),
      sendMessage: this.sent as never,
      createDraft: this.createDraft as never,
      sendDraft: vi.fn() as never,
      modifyLabels: vi.fn(async () => ({})) as never,
      searchContacts: this.searchContacts as never,
      searchOtherContacts: this.searchOtherContacts as never,
    };
  }

  protected override generateDraftReplyBody(
    channelId: string,
    thread: GmailThread
  ): Promise<string> {
    if (this.useBaseDraftGeneration) {
      return super.generateDraftReplyBody(channelId, thread);
    }
    return this.draftBodies();
  }

  protected override async submitAgentInitiatedTurn(
    channelId: string,
    input: { content?: string }
  ): Promise<void> {
    this.agentInitiatedTurns.push({ channelId, content: input.content ?? "" });
  }

  protected override createChannelClient() {
    return {
      getReplayAfter: async (cursor: number) => ({
        mode: "after",
        logEvents: this.replayEvents.filter((event) => event.id > cursor),
        snapshots: [],
        ready: { totalCount: this.replayEvents.length, envelopeCount: this.replayEvents.length },
      }),
      publishAgenticEvent: async (
        participantId: string,
        event: { kind?: string; payload?: unknown },
        opts?: unknown
      ) => {
        this.published.push({ participantId, event, opts });
        return { id: this.published.length };
      },
      sendSignal: async (participantId: string, content: string, type?: string) => {
        this.signals.push({ participantId, content, type });
      },
      getMessageType: async (typeId: string) => {
        const spec = GMAIL_MESSAGE_TYPES.find((entry) => entry.typeId === typeId);
        if (!spec) return null;
        return {
          typeId: spec.typeId,
          displayMode: spec.displayMode,
          stateSchema: spec.stateSchema,
          ...(spec.updateSchema ? { updateSchema: spec.updateSchema } : {}),
        };
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
      participantId
    );
  }

  updateSubscriptionConfig(channelId: string, config: Record<string, unknown>) {
    this.sql.exec(
      `UPDATE subscriptions SET config = ? WHERE channel_id = ?`,
      JSON.stringify(config),
      channelId
    );
  }

  seedRepliedSender(channelId = "ch-1", email = "a@example.com") {
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_replied_senders
       (channel_id, email, display, first_replied_at, last_replied_at, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
      channelId,
      email,
      email,
      Date.now(),
      Date.now(),
      "test"
    );
  }

  respondPolicy(channelId: string) {
    return this.getRespondPolicy(channelId);
  }

  prompt(channelId: string) {
    return this.getRunnerPromptConfig(channelId);
  }

  runnerTools(channelId = "ch-1") {
    return this.getRunnerTools(channelId)?.map((tool) => tool.name) ?? [];
  }

  runnerTool(name: string, channelId = "ch-1") {
    return this.getRunnerTools(channelId)?.find((tool) => tool.name === name);
  }

  participant() {
    return this.getParticipantInfo("ch-1");
  }

  model(channelId = "ch-1") {
    return this.getModel(channelId);
  }

  runnerToolFilter() {
    return this.getRunnerToolFilter("ch-1");
  }

  async debug(channelId = "ch-1") {
    return this.getDebugState(channelId);
  }

  drainWake(now = Date.now()) {
    return this.processWakeQueues(now);
  }

  channelStateRow(channelId = "ch-1") {
    return this.sql
      .exec(`SELECT * FROM gmail_channel_state WHERE channel_id = ?`, channelId)
      .toArray()[0];
  }
}

describe("GmailAgentWorker", () => {
  it("bumps the base vessel schema version so base + gmail migrations run", () => {
    expect(GmailAgentWorker.schemaVersion).toBeGreaterThan(AgentWorkerBase.schemaVersion);
  });

  it("advertises Gmail and standard agent methods with mention-or-followup policy", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;

    expect(worker.respondPolicy("ch-1")).toBe("mentioned-or-followup");
    expect(worker.participant()).toMatchObject({
      handle: "gmail",
      name: "Gmail",
      type: "agent",
    });
    expect(worker.participant().methods?.map((method) => method.name)).toContain("checkNow");
    expect(worker.participant().methods?.map((method) => method.name)).toContain(
      "connectModelCredential"
    );
    expect(worker.participant().methods?.map((method) => method.name)).toContain(
      "getAgentSettings"
    );
    expect(worker.prompt("ch-1").systemPrompt).toContain("Gmail agent");
  });

  it("inherits model credential methods and honors configured model overrides", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.updateSubscriptionConfig("ch-1", {
      handle: "gmail",
      model: "anthropic:claude-sonnet-4-6",
    });

    expect(worker.model()).toBe("anthropic:claude-sonnet-4-6");
    worker.updateSubscriptionConfig("ch-1", {
      handle: "gmail",
      model: "openai-codex:gpt-5.5",
    });
    await expect(
      worker.onMethodCall("ch-1", "call-1", "connectModelCredential", {
        providerId: "openai-codex",
        browserOpenMode: "external",
      })
    ).resolves.toMatchObject({ result: { id: "cred-1" } });
    expect(worker.rpcCall).toHaveBeenCalledWith("main", "credentials.connect", [
      expect.objectContaining({
        flow: expect.objectContaining({ type: "oauth2-auth-code-pkce" }),
      }),
    ]);
  });

  it("does not filter the runner tool roster", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;

    expect(worker.runnerToolFilter()).toBeNull();
    expect(worker.runnerTools()).not.toContain("gmail_upsertAttentionRule");
    expect(worker.runnerTools().filter((name) => name.includes("Attention"))).toEqual([]);
  });

  it("advertises strict Gmail runner tool schemas", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;

    expect(worker.runnerTool("gmail_search")?.parameters).toMatchObject({
      type: "object",
      required: ["q"],
      additionalProperties: false,
      properties: {
        q: { type: "string", minLength: 1 },
      },
    });
    expect(worker.runnerTool("gmail_checkInbox")?.parameters).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("persists the Google credential pin from subscription config", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker, {
      WORKERD_SESSION_ID: "test-session",
      WORKERD_BOOT_GENERATION: "1",
    });
    const worker = instance as TestGmailAgentWorker;

    await worker.subscribeChannel({
      channelId: "ch-1",
      contextId: "ctx-1",
      replay: false,
      config: { handle: "gmail", googleCredentialId: "google-cred-2" },
    });

    expect(worker.channelStateRow("ch-1")).toMatchObject({
      channel_id: "ch-1",
      credential_id: "google-cred-2",
    });
  });

  it("starts first-run setup when subscribed in an unconfigured state", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker, {
      WORKERD_SESSION_ID: "test-session",
      WORKERD_BOOT_GENERATION: "1",
    });
    const worker = instance as TestGmailAgentWorker;

    await expect(
      worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1", replay: false })
    ).resolves.toMatchObject({ ok: true });

    expect(worker.published.map((entry) => entry.event.kind)).toEqual([
      "messageType.registered",
      "messageType.registered",
      "messageType.registered",
      "messageType.registered",
      "ui.action_bar.updated",
      "custom.started",
    ]);
    expect(
      worker.published.map((entry) => (entry.event.payload as { typeId?: string }).typeId)
    ).toEqual(["gmail.setup", "gmail.inbox", "gmail.thread", "gmail.compose", undefined, "gmail.setup"]);
    expect(worker.published[0]?.event.payload).toMatchObject({
      stateSchema: { type: "object" },
    });
    expect(worker.published[0]?.event.payload).toMatchObject({
      imports: {
        react: "latest",
        "react/jsx-runtime": "latest",
        "@radix-ui/themes": "npm:^3.2.1",
        "@radix-ui/react-icons": "npm:^1.3.2",
      },
    });
    expect(worker.published[4]?.event.payload).toMatchObject({
      uiType: "action_bar",
      source: { type: "file", path: "skills/gmail/action-bar.tsx" },
      imports: {
        react: "latest",
        "react/jsx-runtime": "latest",
        "@radix-ui/themes": "npm:^3.2.1",
        "@radix-ui/react-icons": "npm:^1.3.2",
      },
      maxHeight: 180,
    });
    expect(worker.agentInitiatedTurns).toEqual([
      {
        channelId: "ch-1",
        content: expect.stringContaining("Ask the user what kinds of incoming email"),
      },
    ]);

    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1", replay: false });
    expect(worker.agentInitiatedTurns).toHaveLength(1);
  });

  it("batches attention hits into one debounced digest turn with per-message dedup", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker, {
      WORKERD_SESSION_ID: "test-session",
      WORKERD_BOOT_GENERATION: "1",
    });
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    await worker.onMethodCall("ch-1", "call-1", "checkNow", {});
    await worker.drainWake(Date.now() + 91_000);
    expect(worker.agentInitiatedTurns).toEqual([]);

    worker.seedRepliedSender("ch-1", "a@example.com");
    await worker.onMethodCall("ch-1", "call-2", "checkNow", {});
    // The hit is queued, not turned into an immediate per-message turn.
    expect(worker.agentInitiatedTurns).toEqual([]);
    await worker.drainWake(Date.now());
    expect(worker.agentInitiatedTurns).toEqual([]); // debounce window still open
    await worker.drainWake(Date.now() + 91_000);
    expect(worker.agentInitiatedTurns).toHaveLength(1);
    expect(worker.agentInitiatedTurns[0]?.content).toContain("matched your attention rules");
    expect(worker.agentInitiatedTurns[0]?.content).toContain(
      "senders you have replied to before"
    );
    expect(worker.agentInitiatedTurns[0]?.content).toContain("single concise digest");

    // The same message does not re-enqueue (gmail_attention_turns dedup).
    await worker.onMethodCall("ch-1", "call-3", "checkNow", {});
    await worker.drainWake(Date.now() + 200_000);
    expect(worker.agentInitiatedTurns).toHaveLength(1);
  });

  it("lets the agent mark Gmail setup configured", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    await expect(
      worker.onMethodCall("ch-1", "call-1", "markConfigured", {
        summary: "Watching invoices and scheduling mail.",
      })
    ).resolves.toMatchObject({
      result: {
        configured: true,
        summary: "Watching invoices and scheduling mail.",
      },
    });

    const setup = worker.published.find(
      (entry) => (entry.event.payload as { typeId?: string }).typeId === "gmail.setup"
    );
    expect(setup?.event.payload).toMatchObject({
      initialState: {
        status: "configured",
        setupSummary: "Watching invoices and scheduling mail.",
        auth: { status: "unknown" },
      },
    });
    const inbox = worker.published.find(
      (entry) => (entry.event.payload as { typeId?: string }).typeId === "gmail.inbox"
    );
    expect(JSON.stringify(inbox?.event.payload ?? {})).not.toContain("setupStatus");
  });

  it("emits a connect-only credential card for one-shot draft generation without entering external wait", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.useBaseDraftGeneration = true;
    worker.rpcCall.mockImplementation(async (...args: unknown[]) => {
      const method = args[1];
      if (method === "credentials.resolveCredential") return null;
      return { id: "cred-1" };
    });

    const result = await worker.onMethodCall("ch-1", "call-1", "draftReply", { threadId: "thr-1" });

    expect(result).toMatchObject({
      isError: true,
      result: {
        error: "No URL-bound model credential is configured for model provider: openai-codex",
      },
    });
    const inlineUi = worker.published.find((entry) => entry.event.kind === "ui.inline_rendered");
    expect(inlineUi?.event.payload).toMatchObject({
      uiType: "inline",
      props: expect.objectContaining({
        providerId: "openai-codex",
        resumeAfterConnect: false,
      }),
    });
    expect(
      ((await worker.debug())["persisted"] as { suspensions?: unknown[] }).suspensions
    ).toEqual([]);
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
        // Agent-generated drafts always land in review; only the user sends.
        status: "review",
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
    // Routine syncs only publish/update cards in place — no chat messages.
    expect(worker.published.map((entry) => entry.event.kind)).toEqual([
      "custom.started",
      "custom.started",
    ]);
    expect(worker.published[0]!.event.payload).toMatchObject({
      typeId: "gmail.inbox",
      initialState: {
        unread: 1,
        inbox: 1,
        actionable: [expect.objectContaining({ threadId: "thr-1" })],
      },
    });

    await expect(worker.onMethodCall("ch-1", "call-2", "checkNow", {})).resolves.toMatchObject({
      result: { ok: true, historyId: "h2", threadsUpdated: 1 },
    });
    expect(
      worker.published
        .map((entry) => (entry.event.payload as { typeId?: string }).typeId)
        .filter(Boolean)
    ).toEqual(["gmail.inbox", "gmail.setup"]);

    const beforeCategorize = worker.published.length;
    await expect(
      worker.onMethodCall("ch-1", "call-3", "categorize", {
        threadId: "thr-1",
        category: "urgent",
      })
    ).resolves.toMatchObject({ result: { threadId: "thr-1", category: "urgent" } });
    const afterCategorize = worker.published.slice(beforeCategorize);
    expect(afterCategorize.map((entry) => entry.event.kind)).toContain("custom.updated");

    expect(JSON.stringify(worker.published)).not.toContain("Private full email body");
  });

  it("limits actionable threads to unread primary messages addressed to the user", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    await worker.onMethodCall("ch-1", "call-1", "checkNow", {});
    await worker.onMethodCall("ch-1", "call-2", "checkNow", {});
    await expect(
      worker.onMethodCall("ch-1", "call-3", "listActionableThreads", {})
    ).resolves.toMatchObject({
      result: [expect.objectContaining({ threadId: "thr-1", actionable: true })],
    });

    worker.fakeThread = {
      id: "thr-1",
      messages: [
        message(
          "msg-2",
          "thr-1",
          {
            Subject: "Promo",
            From: "a@example.com",
            To: "me@example.com",
            Date: "Fri, 22 May 2026 10:05:00 +0000",
          },
          "Sale",
          "Sale",
          ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]
        ),
      ],
    };
    await worker.onMethodCall("ch-1", "call-4", "checkNow", {});
    await expect(
      worker.onMethodCall("ch-1", "call-5", "listActionableThreads", {})
    ).resolves.toMatchObject({
      result: [],
    });

    worker.fakeThread = {
      id: "thr-1",
      messages: [
        message(
          "msg-3",
          "thr-1",
          {
            Subject: "Sent by me",
            From: "me@example.com",
            To: "a@example.com",
            Date: "Fri, 22 May 2026 10:10:00 +0000",
          },
          "I replied",
          "I replied"
        ),
      ],
    };
    await worker.onMethodCall("ch-1", "call-6", "checkNow", {});
    await expect(
      worker.onMethodCall("ch-1", "call-7", "listActionableThreads", {})
    ).resolves.toMatchObject({
      result: [],
    });
  });

  it("exposes a structured attention-rule API over direct Durable Object RPC", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    await expect(worker.listAttentionRules("other-channel")).rejects.toThrow(
      "not subscribed"
    );

    await expect(worker.listAttentionRules("ch-1")).resolves.toMatchObject({
      channelId: "ch-1",
      rules: [
        expect.objectContaining({
          id: "prior-replies",
          match: {
            all: expect.arrayContaining([
              expect.objectContaining({ field: "priorReplyToSender" }),
            ]),
          },
        }),
      ],
      capabilities: expect.objectContaining({
        fields: expect.arrayContaining(["fromDomain", "priorReplyToSender", "wakeAll"]),
      }),
      rpc: {
        source: "workers/gmail-agent",
        className: "GmailAgentWorker",
        objectKey: "gmail-ch-1",
        resolveMethod: "workers.resolveDurableObject",
      },
    });

    await expect(
      worker.upsertAttentionRule("ch-1", {
        rule: {
          id: "vip-domain",
          name: "VIP domain",
          enabled: true,
          scope: "snippet",
          priority: 200,
          match: { any: [{ field: "fromDomain", op: "equals", value: "vip.example" }] },
          actions: ["surface", "summarize"],
        },
      })
    ).resolves.toMatchObject({
      saved: true,
      rule: { id: "vip-domain", actions: ["surface", "summarize"] },
    });

    (worker as unknown as { _currentVerifiedCaller: { callerId: string; callerKind: string } | null })
      ._currentVerifiedCaller = { callerId: "do:other", callerKind: "do" };
    await expect(
      worker.upsertAttentionRule("ch-1", {
        rule: {
          id: "blocked-do-write",
          name: "Blocked DO write",
          enabled: true,
          scope: "snippet",
          priority: 100,
          match: { any: [{ field: "wakeAll", op: "present" }] },
          actions: ["surface"],
        },
      })
    ).rejects.toThrow("user-facing panel");
    (worker as unknown as { _currentVerifiedCaller: { callerId: string; callerKind: string } | null })
      ._currentVerifiedCaller = null;

    await expect(
      worker.setAttentionRuleEnabled("ch-1", { id: "vip-domain", enabled: false })
    ).resolves.toMatchObject({
      saved: true,
      rule: { id: "vip-domain", enabled: false },
    });

    await expect(worker.deleteAttentionRule("ch-1", { id: "vip-domain" })).resolves.toMatchObject({
      deleted: true,
      id: "vip-domain",
    });

    await expect(worker.clearAttentionRules("ch-1")).resolves.toMatchObject({
      cleared: true,
      rules: [],
    });

    await expect(worker.resetAttentionRules("ch-1")).resolves.toMatchObject({
      reset: true,
      rules: [expect.objectContaining({ id: "prior-replies" })],
    });
  });

  it("uses installed attention rules to wake on messages outside default heuristics", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.fakeThread = {
      id: "thr-1",
      messages: [
        message(
          "msg-promo",
          "thr-1",
          {
            Subject: "Launch update",
            From: "founder@investor.example",
            To: "me@example.com",
            Date: "Fri, 22 May 2026 10:15:00 +0000",
          },
          "Fundraising details",
          "Fundraising details",
          ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]
        ),
      ],
    };

    await expect(
      worker.upsertAttentionRule("ch-1", {
        rule: {
          id: "investor-domain",
          name: "Investor domain",
          enabled: true,
          scope: "snippet",
          priority: 100,
          match: {
            any: [{ field: "fromDomain", op: "equals", value: "investor.example" }],
          },
          actions: ["surface"],
        },
      })
    ).resolves.toMatchObject({ saved: true });

    await worker.onMethodCall("ch-1", "call-2", "checkNow", {});

    await expect(
      worker.onMethodCall("ch-1", "call-3", "listActionableThreads", {})
    ).resolves.toMatchObject({
      result: [
        expect.objectContaining({
          threadId: "thr-1",
          attention: expect.objectContaining({
            directiveId: "investor-domain",
            directiveName: "Investor domain",
          }),
        }),
      ],
    });
  });

  it("harvests synced senders into the people store and resolves them from history", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.fakeThread = {
      id: "thr-1",
      messages: [
        message("msg-1", "thr-1", {
          Subject: "Hi",
          From: "Alice Smith <alice@example.com>",
          To: "me@example.com",
          Date: "Fri, 22 May 2026 10:00:00 +0000",
        }),
      ],
    };

    await worker.onMethodCall("ch-1", "call-1", "checkNow", {});
    await worker.onMethodCall("ch-1", "call-2", "checkNow", {});

    const resolved = await worker.onMethodCall("ch-1", "call-3", "resolveContact", {
      name: "alice",
    });
    expect(resolved.result).toMatchObject({
      query: "alice",
      candidates: [
        expect.objectContaining({
          email: "alice@example.com",
          displayName: "Alice Smith",
          source: "history",
        }),
      ],
    });
    expect(worker.searchContacts).not.toHaveBeenCalled();

    const suggested = await worker.onMethodCall("ch-1", "call-4", "contactSuggest", {
      prefix: "ali",
    });
    expect(suggested.result).toMatchObject({
      candidates: [expect.objectContaining({ email: "alice@example.com" })],
    });
  });

  it("falls back to the Google People API when history has no candidates", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    const result = await worker.onMethodCall("ch-1", "call-1", "resolveContact", {
      name: "zelda",
    });
    expect(worker.searchContacts).toHaveBeenCalledWith("zelda", { pageSize: 5 });
    expect(result.result).toMatchObject({
      candidates: [
        {
          email: "zelda@hyrule.example",
          displayName: "Zelda Hyrule",
          source: "google-contacts",
          sentTo: 0,
          receivedFrom: 0,
          youReplied: false,
          score: 0,
        },
      ],
    });
    expect(worker.channelStateRow("ch-1")).toMatchObject({ people_api_status: "ok" });
  });

  it("degrades gracefully when the People API is forbidden (missing scopes)", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.searchContacts.mockRejectedValue(
      new GmailApiError("missing scope", "forbidden", { status: 403 })
    );

    const result = await worker.onMethodCall("ch-1", "call-1", "resolveContact", {
      name: "zelda",
    });
    expect(result.isError).toBeUndefined();
    expect(result.result).toMatchObject({ query: "zelda", candidates: [] });
    expect(worker.channelStateRow("ch-1")).toMatchObject({ people_api_status: "unavailable" });

    // Subsequent resolves skip the API entirely.
    await worker.onMethodCall("ch-1", "call-2", "resolveContact", { name: "zelda" });
    expect(worker.searchContacts).toHaveBeenCalledTimes(1);

    const setup = [...worker.published]
      .reverse()
      .find((entry) => JSON.stringify(entry.event.payload ?? {}).includes("addressBook"));
    expect(JSON.stringify(setup?.event.payload)).toContain('"googleContacts":"unavailable"');
  });

  it("parks recipient-less saveDraft on a drafting compose card instead of erroring", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();

    const result = await worker.onMethodCall("ch-1", "call-1", "saveDraft", {
      subject: "Quarterly numbers",
      body: "Draft body",
      toCandidates: [{ email: "alice@example.com", displayName: "Alice" }],
    });

    expect(result.isError).toBeUndefined();
    expect(result.result).toMatchObject({
      ok: true,
      cardCreated: true,
      note: expect.stringContaining("gmail_resolveContact"),
    });
    expect(worker.createDraft).not.toHaveBeenCalled();
    const compose = worker.published.find(
      (entry) => (entry.event.payload as { typeId?: string }).typeId === "gmail.compose"
    );
    expect(compose?.event.payload).toMatchObject({
      initialState: {
        status: "drafting",
        subject: "Quarterly numbers",
        body: "Draft body",
        toCandidates: [expect.objectContaining({ email: "alice@example.com" })],
      },
    });

    // A complete draft still saves to Gmail.
    const saved = await worker.onMethodCall("ch-1", "call-2", "saveDraft", {
      to: "alice@example.com",
      subject: "Quarterly numbers",
      body: "Draft body",
    });
    expect(saved.result).toMatchObject({ saved: true, draftId: "draft-1" });
  });

  it("includes parsed fromEmail alongside the display from in query results", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.fakeThread = {
      id: "thr-1",
      messages: [
        message("msg-1", "thr-1", {
          Subject: "Hello",
          From: "Alice Smith <alice@example.com>",
          To: "me@example.com",
          Date: "Fri, 22 May 2026 10:00:00 +0000",
        }),
      ],
    };
    await worker.onMethodCall("ch-1", "call-1", "checkNow", {});
    await worker.onMethodCall("ch-1", "call-2", "checkNow", {});

    const result = await worker.onMethodCall("ch-1", "call-3", "gmail_query", { q: "Hello" });
    expect(result.result).toMatchObject({
      source: "cache",
      results: [
        expect.objectContaining({
          from: "Alice Smith <alice@example.com>",
          fromEmail: "alice@example.com",
        }),
      ],
    });
  });

  it("recovers actionable thread state from durable custom messages on first use", async () => {
    const { instance } = await createTestDO(TestGmailAgentWorker);
    const worker = instance as TestGmailAgentWorker;
    worker.seedSubscription();
    worker.replayEvents = [
      {
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
      },
    ];

    const result = await worker.onMethodCall("ch-1", "call-1", "listActionableThreads", {
      limit: 3,
    });

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
