import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { connect } from "./client.js";

const MockWebSocket = vi.fn() as unknown as typeof WebSocket & ReturnType<typeof vi.fn>;
(MockWebSocket as unknown as { OPEN: number }).OPEN = 1;
vi.stubGlobal("WebSocket", MockWebSocket);

function createWsHarness(options?: { autoAckPublishes?: boolean }) {
  let onmessage: ((event: { data: string }) => void) | null = null;
  let capturedUrl: string | null = null;
  let nextMessageId = 1;
  const mockSend = vi.fn((data: string) => {
    if (!options?.autoAckPublishes) return;
    const parsed = JSON.parse(data) as { action?: string; type?: string; payload?: unknown; persist?: boolean; ref?: number };
    if (parsed.action !== "publish" || !onmessage || parsed.ref === undefined) return;
    onmessage({
      data: JSON.stringify({
        kind: parsed.persist === false ? "ephemeral" : "persisted",
        id: parsed.persist === false ? undefined : nextMessageId++,
        ref: parsed.ref,
        type: parsed.type,
        payload: parsed.payload,
        senderId: "me",
        ts: Date.now(),
      }),
    });
  });

  MockWebSocket.mockImplementation((url: string) => {
    capturedUrl = url;
    const ws = {
      readyState: 1,
      onopen: null,
      _onmessage: null as ((event: { data: string }) => void) | null,
      onerror: null,
      onclose: null,
      close: vi.fn(),
      send: mockSend,
    };
    Object.defineProperty(ws, "onmessage", {
      get: () => ws._onmessage,
      set: (handler: (event: { data: string }) => void) => {
        ws._onmessage = handler;
        onmessage = handler;
      },
    });
    return ws;
  });

  return {
    get capturedUrl() {
      return capturedUrl;
    },
    get onmessage() {
      return onmessage;
    },
    mockSend,
  };
}

describe("@natstack/agentic-messaging", () => {
  beforeEach(() => {
    MockWebSocket.mockReset();
  });

  it("callTool() publishes tool-call and resolves on tool-result", async () => {
    const ws = createWsHarness();

    const client = connect("ws://127.0.0.1:1234", "token", {
      channel: "test",
      metadata: { name: "Me", type: "agent" },
    });

    ws.onmessage!({ data: JSON.stringify({ kind: "ready" }) });

    ws.onmessage!({
      data: JSON.stringify({
        kind: "roster",
        participants: {
          providerA: {
            id: "providerA",
            metadata: {
              name: "Provider A",
              type: "worker",
              tools: [
                {
                  name: "search",
                  description: "Search",
                  parameters: { type: "object", properties: { q: { type: "string" } } },
                  streaming: false,
                },
              ],
            },
          },
        },
        ts: Date.now(),
      }),
    });

    await client.ready();

    const result = client.callTool("providerA", "search", { q: "hello" });

    const sent = JSON.parse(ws.mockSend.mock.calls.at(-1)![0] as string) as {
      action: string;
      type: string;
      payload: { callId: string; toolName: string; providerId: string; args: unknown };
      persist: boolean;
      ref: number;
    };
    expect(sent.action).toBe("publish");
    expect(sent.type).toBe("tool-call");
    expect(sent.persist).toBe(true);
    expect(sent.payload.providerId).toBe("providerA");
    expect(sent.payload.toolName).toBe("search");
    expect(sent.payload.args).toEqual({ q: "hello" });
    expect(sent.payload.callId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    const chunks: unknown[] = [];
    const streamTask = (async () => {
      for await (const chunk of result.stream) {
        chunks.push(chunk);
        if (chunk.complete) break;
      }
    })();

    ws.onmessage!({
      data: JSON.stringify({
        kind: "persisted",
        id: 10,
        type: "tool-result",
        payload: { callId: sent.payload.callId, content: { ok: true }, complete: true },
        senderId: "providerA",
        ts: Date.now(),
      }),
    });

    await expect(result.result).resolves.toEqual({ content: { ok: true }, attachment: undefined, contentType: undefined });
    await streamTask;
    expect(chunks.length).toBe(1);
    expect((chunks[0] as { complete: boolean }).complete).toBe(true);
  });

  it("auto-executes provided tools and publishes streaming tool-results", async () => {
    const ws = createWsHarness({ autoAckPublishes: true });

    const client = connect("ws://127.0.0.1:1234", "token", {
      channel: "test",
      metadata: { name: "Provider", type: "worker" },
      tools: {
        greet: {
          description: "Greet someone",
          parameters: z.object({ name: z.string() }),
          streaming: true,
          async execute(args, ctx) {
            await ctx.stream({ partial: `hello ${args.name}` });
            return { final: `hello ${args.name}!` };
          },
        },
      },
    });

    const metaParam = new URL(ws.capturedUrl!).searchParams.get("metadata");
    expect(metaParam).not.toBeNull();
    const selfMetadata = JSON.parse(metaParam!) as Record<string, unknown>;

    ws.onmessage!({ data: JSON.stringify({ kind: "ready" }) });
    ws.onmessage!({
      data: JSON.stringify({
        kind: "roster",
        participants: {
          me: { id: "me", metadata: selfMetadata },
          caller: { id: "caller", metadata: { name: "Caller", type: "agent" } },
        },
        ts: Date.now(),
      }),
    });

    await client.ready();

    const callId = crypto.randomUUID();
    ws.onmessage!({
      data: JSON.stringify({
        kind: "persisted",
        id: 1,
        type: "tool-call",
        payload: { callId, toolName: "greet", providerId: "me", args: { name: "Bob" } },
        senderId: "caller",
        ts: Date.now(),
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    const toolResultPublishes = ws.mockSend.mock.calls
      .map((c) => JSON.parse(c[0] as string) as { action: string; type: string; payload: any })
      .filter((m) => m.action === "publish" && m.type === "tool-result" && m.payload.callId === callId);

    expect(toolResultPublishes.length).toBe(2);
    expect(toolResultPublishes[0]!.payload.complete).toBe(false);
    expect(toolResultPublishes[1]!.payload.complete).toBe(true);
  });

  it("tools in connect options are advertised in initial metadata", async () => {
    const ws = createWsHarness();

    connect("ws://127.0.0.1:1234", "token", {
      channel: "test",
      metadata: { name: "Provider", type: "worker" },
      tools: {
        ping: {
          description: "Ping",
          parameters: z.object({ value: z.string() }),
          async execute(args) {
            return { pong: args.value };
          },
        },
      },
    });

    // Metadata is passed via URL params (not a send() call)
    const url = new URL(ws.capturedUrl!);
    const metadata = JSON.parse(url.searchParams.get("metadata")!) as {
      name: string;
      type: string;
      tools: Array<{ name: string; description: string }>;
    };
    expect(metadata.name).toBe("Provider");
    expect(Array.isArray(metadata.tools)).toBe(true);
    expect(metadata.tools[0]!.name).toBe("ping");
    expect(metadata.tools[0]!.description).toBe("Ping");
  });
});
