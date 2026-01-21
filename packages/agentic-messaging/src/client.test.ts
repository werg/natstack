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

  it("callMethod() publishes method-call and resolves on method-result", async () => {
    const ws = createWsHarness();

    const clientPromise = connect({
      serverUrl: "ws://127.0.0.1:1234",
      token: "token",
      channel: "test",
      handle: "me",
      name: "Me",
      type: "agent",
    });

    // Metadata is sent via update-metadata action, not URL params
    // Wait a tick for the updateMetadata call to be made
    await new Promise((r) => setTimeout(r, 0));
    const updateMetadataCall = ws.mockSend.mock.calls.find((c) => {
      const parsed = JSON.parse(c[0] as string) as { action?: string };
      return parsed.action === "update-metadata";
    });
    expect(updateMetadataCall).toBeDefined();
    const selfMetadata = (JSON.parse(updateMetadataCall![0] as string) as { payload: Record<string, unknown> }).payload;

    ws.onmessage!({ data: JSON.stringify({ kind: "ready" }) });
    ws.onmessage!({
      data: JSON.stringify({
        kind: "persisted",
        id: 1,
        type: "presence",
        payload: { action: "join", metadata: selfMetadata },
        senderId: "me",
        ts: Date.now(),
      }),
    });
    ws.onmessage!({
      data: JSON.stringify({
        kind: "persisted",
        id: 2,
        type: "presence",
        payload: {
          action: "join",
          metadata: {
            name: "Provider A",
            type: "worker",
            methods: [
              {
                name: "search",
                description: "Search",
                parameters: { type: "object", properties: { q: { type: "string" } } },
                streaming: false,
              },
            ],
          },
        },
        senderId: "providerA",
        ts: Date.now(),
      }),
    });

    const client = await clientPromise;

    const result = client.callMethod("providerA", "search", { q: "hello" });

    const calls = ws.mockSend.mock.calls;
    const sent = JSON.parse(calls[calls.length - 1]![0] as string) as {
      action: string;
      type: string;
      payload: { callId: string; methodName: string; providerId: string; args: unknown };
      persist: boolean;
      ref: number;
    };
    expect(sent.action).toBe("publish");
    expect(sent.type).toBe("method-call");
    expect(sent.persist).toBe(true);
    expect(sent.payload.providerId).toBe("providerA");
    expect(sent.payload.methodName).toBe("search");
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
        type: "method-result",
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

  it("auto-executes provided methods and publishes streaming method-results", async () => {
    const ws = createWsHarness({ autoAckPublishes: true });

    const clientPromise = connect({
      serverUrl: "ws://127.0.0.1:1234",
      token: "token",
      channel: "test",
      handle: "me",
      name: "Provider",
      type: "worker",
      methods: {
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

    // Metadata is sent via update-metadata action, not URL params
    // Wait a tick for the updateMetadata call to be made
    await new Promise((r) => setTimeout(r, 0));
    const updateMetadataCall = ws.mockSend.mock.calls.find((c) => {
      const parsed = JSON.parse(c[0] as string) as { action?: string };
      return parsed.action === "update-metadata";
    });
    expect(updateMetadataCall).toBeDefined();
    const selfMetadata = (JSON.parse(updateMetadataCall![0] as string) as { payload: Record<string, unknown> }).payload;

    ws.onmessage!({ data: JSON.stringify({ kind: "ready" }) });
    ws.onmessage!({
      data: JSON.stringify({
        kind: "persisted",
        id: 1,
        type: "presence",
        payload: { action: "join", metadata: selfMetadata },
        senderId: "me",
        ts: Date.now(),
      }),
    });
    ws.onmessage!({
      data: JSON.stringify({
        kind: "persisted",
        id: 2,
        type: "presence",
        payload: {
          action: "join",
          metadata: { name: "Caller", type: "agent", handle: "caller" },
        },
        senderId: "caller",
        ts: Date.now(),
      }),
    });

    const client = await clientPromise;

    const callId = crypto.randomUUID();
    ws.onmessage!({
      data: JSON.stringify({
        kind: "persisted",
        id: 1,
        type: "method-call",
        payload: { callId, methodName: "greet", providerId: "me", args: { name: "Bob" } },
        senderId: "caller",
        ts: Date.now(),
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    const methodResultPublishes = ws.mockSend.mock.calls
      .map((c) => JSON.parse(c[0] as string) as { action: string; type: string; payload: any })
      .filter((m) => m.action === "publish" && m.type === "method-result" && m.payload.callId === callId);

    expect(methodResultPublishes.length).toBe(2);
    expect(methodResultPublishes[0]!.payload.complete).toBe(false);
    expect(methodResultPublishes[1]!.payload.complete).toBe(true);
  });

  it("methods in connect options are advertised in initial metadata", async () => {
    const ws = createWsHarness();

    const clientPromise = connect({
      serverUrl: "ws://127.0.0.1:1234",
      token: "token",
      channel: "test",
      handle: "provider",
      name: "Provider",
      type: "worker",
      methods: {
        ping: {
          description: "Ping",
          parameters: z.object({ value: z.string() }),
          async execute(args) {
            return { pong: args.value };
          },
        },
      },
    });

    // Metadata is sent via update-metadata action after connection, not URL params
    // Wait a tick for the updateMetadata call to be made
    await new Promise((r) => setTimeout(r, 0));

    // First update-metadata call is for initial metadata (without methods)
    // After connection ready + self-presence, methods are advertised via second update
    ws.onmessage!({ data: JSON.stringify({ kind: "ready" }) });

    // Simulate self join presence so client resolves
    const initialUpdateCall = ws.mockSend.mock.calls.find((c) => {
      const parsed = JSON.parse(c[0] as string) as { action?: string };
      return parsed.action === "update-metadata";
    });
    const initialMeta = initialUpdateCall
      ? (JSON.parse(initialUpdateCall[0] as string) as { payload: Record<string, unknown> }).payload
      : { name: "Provider", type: "worker", handle: "provider" };

    ws.onmessage!({
      data: JSON.stringify({
        kind: "persisted",
        id: 1,
        type: "presence",
        payload: { action: "join", metadata: initialMeta },
        senderId: "provider",
        ts: Date.now(),
      }),
    });

    const client = await clientPromise;

    // After connection, methods are advertised via a second updateMetadata call
    await new Promise((r) => setTimeout(r, 0));

    const updateCalls = ws.mockSend.mock.calls.filter((c) => {
      const parsed = JSON.parse(c[0] as string) as { action?: string };
      return parsed.action === "update-metadata";
    });

    // Find the update call that contains methods
    const methodsUpdateCall = updateCalls.find((c) => {
      const parsed = JSON.parse(c[0] as string) as { payload: { methods?: unknown[] } };
      return Array.isArray(parsed.payload?.methods);
    });

    expect(methodsUpdateCall).toBeDefined();
    const metadata = (JSON.parse(methodsUpdateCall![0] as string) as {
      payload: {
        name: string;
        type: string;
        methods: Array<{ name: string; description: string }>;
      };
    }).payload;

    expect(metadata.name).toBe("Provider");
    expect(Array.isArray(metadata.methods)).toBe(true);
    expect(metadata.methods[0]!.name).toBe("ping");
    expect(metadata.methods[0]!.description).toBe("Ping");

    await client.close();
  });
});
