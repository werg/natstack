import { describe, it, expect, vi } from "vitest";
import { HeadlessSession } from "./headless-session.js";
import type { ChatMessage, ConnectionConfig } from "@workspace/agentic-core";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  brandId,
  type TurnId,
} from "@workspace/agentic-protocol";
import type { MethodDefinition } from "@workspace/pubsub";

function createConfig(): ConnectionConfig {
  return {
    clientId: "headless-test",
    rpc: {
      selfId: "headless-test",
      call: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
  };
}

describe("HeadlessSession", () => {
  it("constructs without connecting", () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });

    expect(session.connected).toBe(false);
    expect(session.channelId).toBe(null);
    expect(session.messages).toEqual([]);
  });

  it("snapshot returns initial state for an unconnected session", () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });

    const snap = session.snapshot();
    expect(snap.connected).toBe(false);
    expect(snap.messages).toEqual([]);
    expect(snap.invocations).toEqual([]);
    expect(snap.cleanupErrors).toEqual([]);
    expect(snap.participants).toEqual({});
  });

  it("snapshot exposes transcript messages, invocation diagnostics, debug events, and participants", () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    const invocationMessage: ChatMessage = {
      id: "invocation:call-1",
      senderId: "agent-1",
      content: "",
      kind: "message",
      contentType: "invocation",
      complete: true,
      invocation: {
        id: "call-1",
        name: "read_file",
        arguments: { path: "README.md" },
        execution: {
          status: "complete",
          description: "",
          result: "contents",
          consoleOutput: "read README.md",
          isError: false,
        },
      },
    };
    (session as any)._chatMessages = new Map([[invocationMessage.id, invocationMessage]]);
    (session as any)._chatMessageOrder = [invocationMessage.id];
    (session as any)._participants = {
      "agent-1": {
        id: "agent-1",
        metadata: { name: "Agent", type: "agent", handle: "agent" },
      },
    };
    (session as any)._debugEvents = [
      {
        debugType: "log",
        agentId: "agent-1",
        handle: "agent",
        level: "info",
        message: "started",
        ts: 1,
      },
    ];

    const snap = session.snapshot();
    expect(snap.messages).toEqual([invocationMessage]);
    expect(snap.invocations).toEqual([
      {
        id: "call-1",
        name: "read_file",
        status: "complete",
        args: { path: "README.md" },
        result: "contents",
        consoleOutput: "read README.md",
        error: undefined,
      },
    ]);
    expect(snap.participants).toEqual({
      "agent-1": { name: "Agent", type: "agent", handle: "agent", connected: true },
    });
    expect(snap.debugEvents).toEqual([
      {
        debugType: "log",
        agentId: "agent-1",
        handle: "agent",
        level: "info",
        message: "started",
        ts: 1,
      },
    ]);
  });

  it("set_title records the report title without touching the channel config", async () => {
    // A headless client is a `do` caller; the channel's updateConfig is
    // panel/server-only, so set_title must NOT route through the channel
    // (that path fails with `caller kind "do" is not permitted`). Instead it
    // stores the title on the session/report and best-effort publishes it via
    // the `do`-permitted runtime.setTitle.
    const config = createConfig();
    const session = HeadlessSession.create({ config });
    const updateChannelConfig = vi.fn(async () => undefined);
    (session as any)._client = { updateChannelConfig };

    const methods = (session as any).buildDefaultMethods() as Record<
      string,
      { execute: (args: unknown) => Promise<unknown> }
    >;
    const result = await methods["set_title"]!.execute({ title: "Filesystem Report" });

    expect(result).toEqual({ ok: true });
    expect(session.title).toBe("Filesystem Report");
    expect(session.snapshot().title).toBe("Filesystem Report");
    // The channel config (and thus the panel/server-gated updateConfig) is never touched.
    expect(updateChannelConfig).not.toHaveBeenCalled();
    // It DOES publish the entity title via the do-permitted runtime.setTitle.
    expect(config.rpc.call).toHaveBeenCalledWith("main", "runtime.setTitle", [
      "Filesystem Report",
      { explicit: true },
    ]);
  });

  it("set_title surfaces a runtime.setTitle failure as a non-fatal warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = createConfig();
    (config.rpc.call as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("registry down"));
    const session = HeadlessSession.create({ config });
    (session as any)._client = { updateChannelConfig: vi.fn() };

    const methods = (session as any).buildDefaultMethods() as Record<
      string,
      { execute: (args: unknown) => Promise<unknown> }
    >;
    const result = await methods["set_title"]!.execute({ title: "Network Report" });

    // The report title is still recorded; only the registry publish failed.
    expect(result).toEqual({ ok: true, warnings: ["registry down"] });
    expect(session.title).toBe("Network Report");
    warn.mockRestore();
  });

  it("dispose is idempotent", () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });

    expect(() => {
      session.dispose();
      session.dispose();
    }).not.toThrow();
  });

  it("unsubscribes the agent DO before retiring its runtime entity", async () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    const calls: Array<{ target: string; method: string; args: unknown[] }> = [];
    (session as any)._agentEntityId = "do:workers/agent-worker:AiChatWorker:obj-1";
    (session as any)._agentTargetId = "do:workers/agent-worker:AiChatWorker:obj-1";
    (session as any)._channelId = "ch-1";
    (session as any)._agentRpcCall = vi.fn(async (target: string, method: string, args: unknown[]) => {
      calls.push({ target, method, args });
      return undefined;
    });

    await session.close();

    expect(calls).toEqual([
      {
        target: "do:workers/agent-worker:AiChatWorker:obj-1",
        method: "unsubscribeChannel",
        args: ["ch-1"],
      },
      {
        target: "main",
        method: "runtime.retireEntity",
        args: [{ id: "do:workers/agent-worker:AiChatWorker:obj-1" }],
      },
    ]);
  });

  it("can detach local session state while remote cleanup continues", async () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    const calls: Array<{ target: string; method: string; args: unknown[] }> = [];
    let releaseUnsubscribe: (() => void) | undefined;
    (session as any)._agentEntityId = "do:workers/agent-worker:AiChatWorker:obj-1";
    (session as any)._agentTargetId = "do:workers/agent-worker:AiChatWorker:obj-1";
    (session as any)._channelId = "ch-1";
    (session as any)._agentRpcCall = vi.fn(async (target: string, method: string, args: unknown[]) => {
      calls.push({ target, method, args });
      if (method === "unsubscribeChannel") {
        await new Promise<void>((resolve) => {
          releaseUnsubscribe = resolve;
        });
      }
      return undefined;
    });

    await expect(session.close({ waitForRemoteCleanup: false })).resolves.toBeUndefined();

    expect(session.channelId).toBe(null);
    expect(calls).toEqual([
      {
        target: "do:workers/agent-worker:AiChatWorker:obj-1",
        method: "unsubscribeChannel",
        args: ["ch-1"],
      },
    ]);

    releaseUnsubscribe?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([
      {
        target: "do:workers/agent-worker:AiChatWorker:obj-1",
        method: "unsubscribeChannel",
        args: ["ch-1"],
      },
      {
        target: "main",
        method: "runtime.retireEntity",
        args: [{ id: "do:workers/agent-worker:AiChatWorker:obj-1" }],
      },
    ]);
  });

  it("records cleanup errors from headless agent teardown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    (session as any)._agentEntityId = "entity-1";
    (session as any)._agentTargetId = "agent-target";
    (session as any)._channelId = "ch-1";
    (session as any)._agentRpcCall = vi.fn(async (_target: string, method: string) => {
      if (method === "unsubscribeChannel") throw new Error("unsubscribe failed");
      if (method === "runtime.retireEntity") throw new Error("retire failed");
      return undefined;
    });

    await session.close();

    expect(session.snapshot().cleanupErrors).toEqual([
      expect.objectContaining({ phase: "unsubscribeHeadlessAgent", message: "unsubscribe failed" }),
      expect.objectContaining({ phase: "retireHeadlessAgent", message: "retire failed" }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[HeadlessSession] unsubscribeHeadlessAgent failed:",
      expect.any(Error)
    );
    expect(warn).toHaveBeenCalledWith(
      "[HeadlessSession] retireHeadlessAgent failed:",
      expect.any(Error)
    );
    warn.mockRestore();
  });

  it("connects the headless client methods before subscribing the agent", async () => {
    const order: string[] = [];
    const originalConnect = HeadlessSession.prototype.connect;
    const connect = vi
      .spyOn(HeadlessSession.prototype, "connect")
      .mockImplementation(async function (
        this: HeadlessSession,
        channelId: string,
        options?: Parameters<HeadlessSession["connect"]>[1]
      ) {
        order.push(`connect:${channelId}:${Object.keys(options?.methods ?? {}).sort().join(",")}`);
        (this as unknown as { _channelId: string; _client: unknown })._channelId = channelId;
        (this as unknown as { _client: unknown })._client = { close: vi.fn() };
      });
    const rpcCall = vi.fn(async (target: string, method: string) => {
      order.push(`rpc:${target}:${method}`);
      if (target === "main" && method === "runtime.createEntity") {
        return { id: "entity-1", targetId: "agent-target", contextId: "ctx-1" };
      }
      if (target === "agent-target" && method === "subscribeChannel") {
        return { ok: true, participantId: "do:agent" };
      }
      throw new Error(`unexpected RPC ${target}.${method}`);
    });

    try {
      await HeadlessSession.createWithAgent({
        config: createConfig(),
        rpcCall,
        source: "workers/agent-worker",
        className: "AiChatWorker",
        objectKey: "agent-1",
        contextId: "ctx-1",
        channelId: "headless-1",
      });
    } finally {
      connect.mockRestore();
      HeadlessSession.prototype.connect = originalConnect;
    }

    expect(order).toEqual([
      "connect:headless-1:set_title",
      "rpc:main:runtime.createEntity",
      "rpc:agent-target:subscribeChannel",
    ]);
  });

  it("can opt into synthetic panel UI methods that publish typed UI events", async () => {
    let registeredMethods: Record<string, MethodDefinition> = {};
    const publish = vi.fn(async () => 1);
    const originalConnect = HeadlessSession.prototype.connect;
    const connect = vi
      .spyOn(HeadlessSession.prototype, "connect")
      .mockImplementation(async function (
        this: HeadlessSession,
        channelId: string,
        options?: Parameters<HeadlessSession["connect"]>[1]
      ) {
        registeredMethods = options?.methods ?? {};
        (this as unknown as { _channelId: string; _client: unknown })._channelId = channelId;
        (this as unknown as { _client: unknown })._client = {
          clientId: "headless-panel",
          publish,
        };
      });
    const rpcCall = vi.fn(async (target: string, method: string) => {
      if (target === "main" && method === "runtime.createEntity") {
        return { id: "entity-1", targetId: "agent-target", contextId: "ctx-1" };
      }
      if (target === "agent-target" && method === "subscribeChannel") {
        return { ok: true, participantId: "do:agent" };
      }
      throw new Error(`unexpected RPC ${target}.${method}`);
    });

    try {
      await HeadlessSession.createWithAgent({
        config: createConfig(),
        rpcCall,
        source: "workers/agent-worker",
        className: "AiChatWorker",
        objectKey: "agent-1",
        contextId: "ctx-1",
        channelId: "headless-1",
        includeSyntheticPanelUiMethods: true,
      });

      expect(Object.keys(registeredMethods).sort()).toEqual([
        "inline_ui",
        "load_action_bar",
        "set_title",
      ]);

      await registeredMethods["inline_ui"]!.execute(
        {
          code: "export default function App() { return null; }",
        },
        {} as never
      );
      await registeredMethods["load_action_bar"]!.execute(
        {
          path: "skills/test/ActionBar.tsx",
        },
        {} as never
      );
      await registeredMethods["load_action_bar"]!.execute({ clear: true }, {} as never);
    } finally {
      connect.mockRestore();
      HeadlessSession.prototype.connect = originalConnect;
    }

    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls[0]).toEqual([
      AGENTIC_EVENT_PAYLOAD_KIND,
      expect.objectContaining({
        kind: "ui.inline_rendered",
        payload: expect.objectContaining({
          uiType: "inline",
          source: { type: "code", code: "export default function App() { return null; }" },
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("synthetic-ui:inline:"),
      }),
    ]);
    expect(publish.mock.calls[1]).toEqual([
      AGENTIC_EVENT_PAYLOAD_KIND,
      expect.objectContaining({
        kind: "ui.action_bar.updated",
        payload: expect.objectContaining({
          uiType: "action_bar",
          source: { type: "file", path: "skills/test/ActionBar.tsx" },
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("synthetic-ui:action-bar:"),
      }),
    ]);
    expect(publish.mock.calls[2]).toEqual([
      AGENTIC_EVENT_PAYLOAD_KIND,
      expect.objectContaining({
        kind: "ui.action_bar.updated",
        payload: expect.objectContaining({
          uiType: "action_bar",
          cleared: true,
          result: { ok: true },
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("synthetic-ui:action-bar:clear:"),
      }),
    ]);
  });

  it("can create an agent in a runtime-minted isolated context", async () => {
    const originalConnect = HeadlessSession.prototype.connect;
    const order: string[] = [];
    const connect = vi
      .spyOn(HeadlessSession.prototype, "connect")
      .mockImplementation(async function (
        this: HeadlessSession,
        channelId: string,
        options?: { contextId?: string; methods?: Record<string, unknown> },
      ) {
        order.push(`connect:${channelId}:${options?.contextId ?? "minted"}`);
        (this as unknown as { _channelId: string; _client: unknown })._channelId = channelId;
        (this as unknown as { _client: unknown })._client = { close: vi.fn() };
      });
    const rpcCall = vi.fn(async (target: string, method: string, args: unknown[]) => {
      order.push(`rpc:${target}:${method}`);
      if (target === "main" && method === "runtime.createEntity") {
        expect(args[0]).not.toHaveProperty("contextId");
        return { id: "entity-1", targetId: "agent-target", contextId: "ctx-minted" };
      }
      if (target === "agent-target" && method === "subscribeChannel") {
        expect(args[0]).toMatchObject({ channelId: "headless-1", contextId: "ctx-minted" });
        return { ok: true, participantId: "do:agent" };
      }
      throw new Error(`unexpected RPC ${target}.${method}`);
    });

    try {
      await HeadlessSession.createWithAgent({
        config: createConfig(),
        rpcCall,
        source: "workers/agent-worker",
        className: "AiChatWorker",
        objectKey: "agent-1",
        channelId: "headless-1",
      });
    } finally {
      connect.mockRestore();
      HeadlessSession.prototype.connect = originalConnect;
    }

    expect(order).toEqual([
      "connect:headless-1:minted",
      "rpc:main:runtime.createEntity",
      "rpc:agent-target:subscribeChannel",
    ]);
  });

  it("callMethod returns the provider payload and callMethodResult returns the full envelope", async () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    const envelope = {
      content: { ok: true },
      contentType: "application/json",
    };
    (session as any)._client = {
      callMethod: vi.fn(() => ({ result: Promise.resolve(envelope) })),
    };

    await expect(session.callMethod("agent-1", "work", {})).resolves.toEqual({ ok: true });
    await expect(session.callMethodResult("agent-1", "work", {})).resolves.toEqual(envelope);
  });

  it("sendAndWait starts waiting before publishing the prompt", async () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    }) as HeadlessSession & {
      waitForIdle: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
    const idleMessage = {
      id: "agent-message",
      senderId: "agent-1",
      content: "done",
      kind: "message" as const,
      complete: true,
    } satisfies ChatMessage;
    const order: string[] = [];
    session.waitForIdle = vi.fn(() => {
      order.push("wait");
      return Promise.resolve(idleMessage);
    });
    session.send = vi.fn(async () => {
      order.push("send");
      return "message-user";
    });

    await expect(session.sendAndWait("hello")).resolves.toBe(idleMessage);
    expect(order).toEqual(["wait", "send"]);
  });

  it("waitForIdle waits until the durable agent turn is closed", async () => {
    vi.useFakeTimers();
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    const turnId = brandId<TurnId>("turn-open");
    const idleMessage = {
      id: "agent-message",
      senderId: "agent-1",
      content: "done",
      kind: "message" as const,
      complete: true,
    } satisfies ChatMessage;
    (session as any)._channelId = "ch-1";
    (session as any)._channelView = {
      ...(session as any)._channelView,
      turns: {
        [turnId]: {
          turnId,
          actor: { kind: "agent", id: "agent-1" },
          status: "open",
          openedAt: "2026-05-27T00:00:00.000Z",
        },
      },
    };

    const wait = session.waitForIdle({ debounce: 5, timeoutMs: 1000 });
    (session as any)._chatMessages = new Map([[idleMessage.id, idleMessage]]);
    (session as any)._chatMessageOrder = [idleMessage.id];
    (session as any).notifyListeners();
    await vi.advanceTimersByTimeAsync(20);

    let resolved = false;
    void wait.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    (session as any)._channelView = {
      ...(session as any)._channelView,
      turns: {
        [turnId]: {
          ...(session as any)._channelView.turns[turnId],
          status: "closed",
          closedAt: "2026-05-27T00:00:01.000Z",
        },
      },
    };
    (session as any).notifyListeners();
    await vi.advanceTimersByTimeAsync(5);

    await expect(wait).resolves.toBe(idleMessage);
    vi.useRealTimers();
  });

  it("waitForIdle rejects promptly on agent failure diagnostics even while a turn is open", async () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    const turnId = brandId<TurnId>("turn-open-failed");
    const failureMessage = {
      id: "diagnostic:failed-message",
      senderId: "agent-1",
      content: "Codex error: server_error",
      contentType: "diagnostic",
      kind: "system" as const,
      complete: true,
      error: "Codex error: server_error",
    } satisfies ChatMessage;
    (session as any)._channelId = "ch-1";
    (session as any)._channelView = {
      ...(session as any)._channelView,
      turns: {
        [turnId]: {
          turnId,
          actor: { kind: "agent", id: "agent-1" },
          status: "open",
          openedAt: "2026-05-27T00:00:00.000Z",
        },
      },
    };

    const wait = session.waitForIdle({ debounce: 5, timeoutMs: 1000 });
    (session as any)._chatMessages = new Map([[failureMessage.id, failureMessage]]);
    (session as any)._chatMessageOrder = [failureMessage.id];
    (session as any).notifyListeners();

    await expect(wait).rejects.toThrow("Agent failed: Codex error: server_error");
  });
});
