/**
 * Tests for the PubSub client.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { connect, type PubSubClient } from "./client.js";
import { PubSubError } from "./types.js";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import type { Server } from "http";
import { createServer } from "http";

// Mock WebSocket for browser environment
const MockWebSocket = vi.fn() as unknown as typeof WebSocket & ReturnType<typeof vi.fn>;
// Set WebSocket.OPEN constant
(MockWebSocket as unknown as { OPEN: number }).OPEN = 1;
vi.stubGlobal("WebSocket", MockWebSocket);

describe("PubSubClient", () => {
  let wss: WebSocketServer;
  let httpServer: Server;
  let port: number;

  beforeEach(async () => {
    // Create a mock server
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer });

    // Find an available port
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address() as { port: number };
        port = addr.port;
        resolve();
      });
    });

    // Reset mock
    MockWebSocket.mockReset();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      wss.close(() => {
        httpServer.close(() => resolve());
      });
    });
  });

  describe("connect", () => {
    it("builds correct URL with query parameters", () => {
      // Track the URL that would be passed to WebSocket
      let capturedUrl: string | null = null;

      MockWebSocket.mockImplementation((url: string) => {
        capturedUrl = url;
        return {
          readyState: 0,
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
        };
      });

      connect(`ws://127.0.0.1:${port}`, "test-token", { channel: "my-channel" });

      expect(capturedUrl).not.toBeNull();
      const url = new URL(capturedUrl!);
      expect(url.searchParams.get("token")).toBe("test-token");
      expect(url.searchParams.get("channel")).toBe("my-channel");
    });

    it("includes sinceId when provided", () => {
      let capturedUrl: string | null = null;

      MockWebSocket.mockImplementation((url: string) => {
        capturedUrl = url;
        return {
          readyState: 0,
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
        };
      });

      connect(`ws://127.0.0.1:${port}`, "test-token", {
        channel: "my-channel",
        sinceId: 42,
      });

      expect(capturedUrl).not.toBeNull();
      const url = new URL(capturedUrl!);
      expect(url.searchParams.get("sinceId")).toBe("42");
    });
  });

  describe("ready()", () => {
    it("resolves when ready message is received", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null,
          _onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
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

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      // Simulate server sending ready
      setTimeout(() => {
        onmessage!({ data: JSON.stringify({ kind: "ready" }) });
      }, 10);

      await expect(client.ready(1000)).resolves.toBeUndefined();
    });

    it("rejects on timeout", async () => {
      MockWebSocket.mockImplementation(() => ({
        readyState: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      }));

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      await expect(client.ready(50)).rejects.toThrow("ready timeout");
    });
  });

  describe("publish()", () => {
    it("sends message with ref for correlation", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;
      const mockSend = vi.fn();

      MockWebSocket.mockImplementation(() => {
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

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      // Send ready
      setTimeout(() => {
        onmessage!({ data: JSON.stringify({ kind: "ready" }) });
      }, 5);
      await client.ready();

      // Start publish
      const publishPromise = client.publish("test-type", { data: "hello" });

      // Verify send was called
      expect(mockSend).toHaveBeenCalled();
      const sentMsg = JSON.parse(mockSend.mock.calls[0]![0] as string) as {
        action: string;
        type: string;
        payload: object;
        persist: boolean;
        ref: number;
      };
      expect(sentMsg.action).toBe("publish");
      expect(sentMsg.type).toBe("test-type");
      expect(sentMsg.payload).toEqual({ data: "hello" });
      expect(sentMsg.persist).toBe(true);
      expect(sentMsg.ref).toBe(1);

      // Simulate response with ref
      onmessage!({
        data: JSON.stringify({
          kind: "persisted",
          id: 123,
          ref: 1,
          type: "test-type",
          payload: { data: "hello" },
          senderId: "me",
          ts: Date.now(),
        }),
      });

      const id = await publishPromise;
      expect(id).toBe(123);
    });

    it("rejects when not connected", async () => {
      MockWebSocket.mockImplementation(() => ({
        readyState: 0, // Not open
        OPEN: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      }));

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      await expect(client.publish("test", {})).rejects.toThrow("not connected");
    });
  });

  describe("updateMetadata()", () => {
    it("sends update-metadata and resolves on presence ack", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;
      const mockSend = vi.fn();

      MockWebSocket.mockImplementation(() => {
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

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        metadata: { name: "Alice" },
      });

      // Send ready
      setTimeout(() => {
        onmessage!({ data: JSON.stringify({ kind: "ready" }) });
      }, 5);
      await client.ready();

      const updatePromise = client.updateMetadata({ name: "Bob" });

      // Verify send was called
      expect(mockSend).toHaveBeenCalled();
      const calls = mockSend.mock.calls;
      const sentMsg = JSON.parse(calls[calls.length - 1]![0] as string) as {
        action: string;
        payload: object;
        ref: number;
      };
      expect(sentMsg.action).toBe("update-metadata");
      expect(sentMsg.payload).toEqual({ name: "Bob" });
      expect(sentMsg.ref).toBe(1);

      // Simulate presence update ack with ref
      onmessage!({
        data: JSON.stringify({
          kind: "persisted",
          id: 1,
          ref: 1,
          type: "presence",
          payload: { action: "update", metadata: { name: "Bob" } },
          senderId: "me",
          ts: Date.now(),
        }),
      });

      await expect(updatePromise).resolves.toBeUndefined();
    });
  });

  describe("onError()", () => {
    it("calls error handler on server error with PubSubError", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null,
          _onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
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

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      const errorHandler = vi.fn();
      client.onError(errorHandler);

      // Simulate server error
      onmessage!({
        data: JSON.stringify({ kind: "error", error: "test error" }),
      });

      expect(errorHandler).toHaveBeenCalledTimes(1);
      const error = errorHandler.mock.calls[0]![0] as PubSubError;
      expect(error).toBeInstanceOf(PubSubError);
      expect(error.message).toBe("test error");
      expect(error.code).toBe("server");
    });

    it("rejects pending publish when error has matching ref", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;
      const mockSend = vi.fn();

      MockWebSocket.mockImplementation(() => {
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

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      // Send ready
      setTimeout(() => {
        onmessage!({ data: JSON.stringify({ kind: "ready" }) });
      }, 5);
      await client.ready();

      // Start publish
      const publishPromise = client.publish("test-type", { data: "hello" });

      // Simulate server error with ref
      onmessage!({
        data: JSON.stringify({ kind: "error", error: "payload not serializable", ref: 1 }),
      });

      // Publish should reject with PubSubError
      await expect(publishPromise).rejects.toThrow(PubSubError);
      await expect(publishPromise).rejects.toThrow("payload not serializable");

      try {
        await publishPromise;
      } catch (e) {
        expect((e as PubSubError).code).toBe("validation");
      }
    });

    it("sets validation code for validation errors", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null,
          _onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
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

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      const errorHandler = vi.fn();
      client.onError(errorHandler);

      // Simulate validation error
      onmessage!({
        data: JSON.stringify({ kind: "error", error: "invalid message format" }),
      });

      expect(errorHandler).toHaveBeenCalledTimes(1);
      const error = errorHandler.mock.calls[0]![0] as PubSubError;
      expect(error.code).toBe("validation");
    });
  });

  describe("connected", () => {
    it("returns true when WebSocket is open", () => {
      MockWebSocket.mockImplementation(() => ({
        readyState: 1,
        OPEN: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      }));

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      expect(client.connected).toBe(true);
    });

    it("returns false when WebSocket is not open", () => {
      MockWebSocket.mockImplementation(() => ({
        readyState: 0,
        OPEN: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      }));

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      expect(client.connected).toBe(false);
    });
  });

  describe("reconnection", () => {
    it("attempts reconnection when reconnect option is enabled", async () => {
      vi.useFakeTimers();
      const wsInstances: Array<{
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: (() => void) | null;
        onclose: (() => void) | null;
        close: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      }> = [];

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null as (() => void) | null,
          onclose: null as (() => void) | null,
          close: vi.fn(),
          send: vi.fn(),
        };
        wsInstances.push(ws);
        return ws;
      });

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        reconnect: { delayMs: 100, maxDelayMs: 1000 },
      });

      expect(wsInstances.length).toBe(1);

      // Simulate disconnect
      wsInstances[0]!.onclose?.();

      expect(client.reconnecting).toBe(true);

      // Advance timer to trigger reconnect
      await vi.advanceTimersByTimeAsync(100);

      expect(wsInstances.length).toBe(2);
      vi.useRealTimers();
    });

    it("uses exponential backoff for reconnection attempts", async () => {
      vi.useFakeTimers();
      const wsInstances: Array<{
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: (() => void) | null;
        onclose: (() => void) | null;
        close: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      }> = [];

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 0, // Stays closed to force reconnection attempts
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null as (() => void) | null,
          onclose: null as (() => void) | null,
          close: vi.fn(),
          send: vi.fn(),
        };
        wsInstances.push(ws);
        return ws;
      });

      connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        reconnect: { delayMs: 100, maxDelayMs: 1000 },
      });

      // First disconnect
      wsInstances[0]!.onclose?.();

      // First reconnect after 100ms
      await vi.advanceTimersByTimeAsync(100);
      expect(wsInstances.length).toBe(2);

      // Second disconnect
      wsInstances[1]!.onclose?.();

      // Second reconnect should be 200ms (100 * 2^1)
      await vi.advanceTimersByTimeAsync(100);
      expect(wsInstances.length).toBe(2); // Not yet
      await vi.advanceTimersByTimeAsync(100);
      expect(wsInstances.length).toBe(3);

      vi.useRealTimers();
    });

    it("stops reconnecting after max attempts", async () => {
      vi.useFakeTimers();
      const wsInstances: Array<{
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: (() => void) | null;
        onclose: (() => void) | null;
        close: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      }> = [];

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 0,
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null as (() => void) | null,
          onclose: null as (() => void) | null,
          close: vi.fn(),
          send: vi.fn(),
        };
        wsInstances.push(ws);
        return ws;
      });

      const errorHandler = vi.fn();
      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        reconnect: { delayMs: 100, maxDelayMs: 1000, maxAttempts: 2 },
      });
      client.onError(errorHandler);

      // First disconnect -> attempt 1
      wsInstances[0]!.onclose?.();
      await vi.advanceTimersByTimeAsync(100);
      expect(wsInstances.length).toBe(2);

      // Second disconnect -> attempt 2
      wsInstances[1]!.onclose?.();
      await vi.advanceTimersByTimeAsync(200);
      expect(wsInstances.length).toBe(3);

      // Third disconnect -> exceeds max, should error
      wsInstances[2]!.onclose?.();

      expect(errorHandler).toHaveBeenCalledTimes(1);
      const error = errorHandler.mock.calls[0]![0] as PubSubError;
      expect(error.message).toBe("max reconnection attempts exceeded");
      expect(client.reconnecting).toBe(false);

      vi.useRealTimers();
    });

    it("calls onDisconnect and onReconnect handlers", async () => {
      vi.useFakeTimers();
      const wsInstances: Array<{
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: (() => void) | null;
        onclose: (() => void) | null;
        close: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      }> = [];

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null as (() => void) | null,
          onclose: null as (() => void) | null,
          close: vi.fn(),
          send: vi.fn(),
        };
        wsInstances.push(ws);
        return ws;
      });

      const disconnectHandler = vi.fn();
      const reconnectHandler = vi.fn();

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        reconnect: { delayMs: 100 },
      });
      client.onDisconnect(disconnectHandler);
      client.onReconnect(reconnectHandler);

      // Disconnect
      wsInstances[0]!.onclose?.();
      expect(disconnectHandler).toHaveBeenCalledTimes(1);

      // Reconnect
      await vi.advanceTimersByTimeAsync(100);
      wsInstances[1]!.onopen?.();

      expect(reconnectHandler).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("uses lastSeenId for reconnection", async () => {
      vi.useFakeTimers();
      const capturedUrls: string[] = [];
      const wsInstances: Array<{
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: (() => void) | null;
        onclose: (() => void) | null;
        close: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      }> = [];

      MockWebSocket.mockImplementation((url: string) => {
        capturedUrls.push(url);
        const ws = {
          readyState: 1,
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null as (() => void) | null,
          onclose: null as (() => void) | null,
          close: vi.fn(),
          send: vi.fn(),
        };
        wsInstances.push(ws);
        return ws;
      });

      connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        reconnect: { delayMs: 100 },
      });

      // Receive a message with ID
      wsInstances[0]!.onmessage!({
        data: JSON.stringify({
          kind: "persisted",
          id: 42,
          type: "test",
          payload: {},
          senderId: "other",
          ts: Date.now(),
        }),
      });

      // Disconnect and reconnect
      wsInstances[0]!.onclose?.();
      await vi.advanceTimersByTimeAsync(100);

      // Check reconnection URL includes lastSeenId
      expect(capturedUrls.length).toBe(2);
      const reconnectUrl = new URL(capturedUrls[1]!);
      expect(reconnectUrl.searchParams.get("sinceId")).toBe("42");

      vi.useRealTimers();
    });

    it("allows unsubscribing from handlers", () => {
      MockWebSocket.mockImplementation(() => ({
        readyState: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      }));

      const errorHandler = vi.fn();
      const disconnectHandler = vi.fn();
      const reconnectHandler = vi.fn();

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      const unsubError = client.onError(errorHandler);
      const unsubDisconnect = client.onDisconnect(disconnectHandler);
      const unsubReconnect = client.onReconnect(reconnectHandler);

      // Unsubscribe all
      unsubError();
      unsubDisconnect();
      unsubReconnect();

      // Verify they return functions (type check)
      expect(typeof unsubError).toBe("function");
      expect(typeof unsubDisconnect).toBe("function");
      expect(typeof unsubReconnect).toBe("function");
    });

    it("does not reconnect when close() is called explicitly", async () => {
      vi.useFakeTimers();
      const wsInstances: Array<{
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: (() => void) | null;
        onclose: (() => void) | null;
        close: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      }> = [];

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null as (() => void) | null,
          onclose: null as (() => void) | null,
          close: vi.fn(() => {
            // Simulate close event
            setTimeout(() => ws.onclose?.(), 0);
          }),
          send: vi.fn(),
        };
        wsInstances.push(ws);
        return ws;
      });

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        reconnect: { delayMs: 100 },
      });

      // Catch the ready promise rejection (expected since we're closing)
      client.ready().catch(() => {
        // Expected rejection - ignore
      });

      // Explicitly close
      client.close();
      await vi.advanceTimersByTimeAsync(0); // Process close event

      expect(client.reconnecting).toBe(false);

      // Wait for potential reconnect
      await vi.advanceTimersByTimeAsync(200);

      // Should not have created a new connection
      expect(wsInstances.length).toBe(1);

      vi.useRealTimers();
    });
  });

  describe("roster / presence", () => {
    it("calls onRoster handler when presence events received", () => {
      let onmessage: ((event: { data: string }) => void) | null = null;

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null,
          _onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
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

      const rosterHandler = vi.fn();
      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });
      client.onRoster(rosterHandler);

      onmessage!({
        data: JSON.stringify({
          kind: "persisted",
          id: 1,
          type: "presence",
          payload: { action: "join", metadata: { name: "Alice" } },
          senderId: "user-a",
          ts: 12345,
        }),
      });

      onmessage!({
        data: JSON.stringify({
          kind: "persisted",
          id: 2,
          type: "presence",
          payload: { action: "join", metadata: { name: "Bob" } },
          senderId: "user-b",
          ts: 12346,
        }),
      });

      expect(rosterHandler).toHaveBeenCalledTimes(2);
      expect(rosterHandler).toHaveBeenLastCalledWith({
        participants: {
          "user-a": { id: "user-a", metadata: { name: "Alice" } },
          "user-b": { id: "user-b", metadata: { name: "Bob" } },
        },
        ts: 12346,
        change: {
          type: "join",
          participantId: "user-b",
          metadata: { name: "Bob" },
        },
      });
    });

    it("updates roster property when presence events received", () => {
      let onmessage: ((event: { data: string }) => void) | null = null;

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null,
          _onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
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

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      // Initially empty
      expect(client.roster).toEqual({});

      onmessage!({
        data: JSON.stringify({
          kind: "persisted",
          id: 1,
          type: "presence",
          payload: { action: "join", metadata: { name: "Alice" } },
          senderId: "user-a",
          ts: 12345,
        }),
      });
      onmessage!({
        data: JSON.stringify({
          kind: "persisted",
          id: 2,
          type: "presence",
          payload: { action: "join", metadata: { name: "Bob" } },
          senderId: "user-b",
          ts: 12346,
        }),
      });

      expect(client.roster).toEqual({
        "user-a": { id: "user-a", metadata: { name: "Alice" } },
        "user-b": { id: "user-b", metadata: { name: "Bob" } },
      });

      // Roster property returns a copy
      const roster1 = client.roster;
      const roster2 = client.roster;
      expect(roster1).not.toBe(roster2);
      expect(roster1).toEqual(roster2);
    });

    it("allows unsubscribing from roster handler", () => {
      let onmessage: ((event: { data: string }) => void) | null = null;

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null,
          _onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
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

      const rosterHandler = vi.fn();
      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });
      const unsub = client.onRoster(rosterHandler);

      // First presence update
      onmessage!({
        data: JSON.stringify({
          kind: "persisted",
          id: 1,
          type: "presence",
          payload: { action: "join", metadata: {} },
          senderId: "user-a",
          ts: 12345,
        }),
      });
      expect(rosterHandler).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsub();

      // Second presence update - handler should not be called
      onmessage!({
        data: JSON.stringify({
          kind: "persisted",
          id: 2,
          type: "presence",
          payload: { action: "join", metadata: {} },
          senderId: "user-b",
          ts: 12346,
        }),
      });
      expect(rosterHandler).toHaveBeenCalledTimes(1);

      // But roster property should still be updated
      expect(client.roster).toEqual({
        "user-a": { id: "user-a", metadata: {} },
        "user-b": { id: "user-b", metadata: {} },
      });
    });

    it("immediately calls new onRoster handler with current roster if not empty", () => {
      let onmessage: ((event: { data: string }) => void) | null = null;

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          send: vi.fn(),
          close: vi.fn(),
          _onmessage: null as ((event: { data: string }) => void) | null,
          addEventListener: vi.fn((event: string, handler: (event: { data: string }) => void) => {
            if (event === "message") onmessage = handler;
          }),
          removeEventListener: vi.fn(),
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

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      // First, populate the roster via a presence event
      onmessage!({
        data: JSON.stringify({
          kind: "persisted",
          id: 1,
          type: "presence",
          payload: { action: "join", metadata: { name: "Alice" } },
          senderId: "user-a",
          ts: 12345,
        }),
      });

      // Now register a NEW handler - it should immediately receive current roster
      const lateHandler = vi.fn();
      client.onRoster(lateHandler);

      // The handler should have been called once immediately with current roster
      expect(lateHandler).toHaveBeenCalledTimes(1);
      expect(lateHandler).toHaveBeenCalledWith({
        participants: { "user-a": { id: "user-a", metadata: { name: "Alice" } } },
        ts: expect.any(Number),
      });
    });

    it("does not call new onRoster handler if roster is empty", () => {
      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          send: vi.fn(),
          close: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };
        return ws;
      });

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      // Register handler without any presence events
      const handler = vi.fn();
      client.onRoster(handler);

      // Handler should NOT have been called since roster is empty
      expect(handler).not.toHaveBeenCalled();
    });

    it("does not include metadata in URL when provided", () => {
      const metadata = { name: "Alice", status: "online" };
      connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        metadata,
      });

      expect(MockWebSocket).toHaveBeenCalledTimes(1);
      const url = new URL(MockWebSocket.mock.calls[0]![0] as string);
      expect(url.searchParams.get("metadata")).toBeNull();
    });
  });

  describe("agent API", () => {
    it("listAgents sends request and returns manifests", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;
      const mockSend = vi.fn();

      MockWebSocket.mockImplementation(() => {
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

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      // Send ready first
      setTimeout(() => {
        onmessage!({ data: JSON.stringify({ kind: "ready" }) });
      }, 5);
      await client.ready();

      // Start listAgents
      const listPromise = client.listAgents();

      // Verify send was called
      const calls = mockSend.mock.calls;
      const sentMsg = JSON.parse(calls[calls.length - 1]![0] as string);
      expect(sentMsg.action).toBe("list-agents");
      expect(sentMsg.ref).toBeDefined();

      // Simulate response
      onmessage!({
        data: JSON.stringify({
          kind: "list-agents-response",
          ref: sentMsg.ref,
          agents: [
            { id: "test-agent", name: "Test Agent", version: "1.0.0" },
          ],
        }),
      });

      const agents = await listPromise;
      expect(agents).toHaveLength(1);
      expect(agents[0]?.id).toBe("test-agent");
    });

    it("inviteAgent sends request and returns result", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;
      const mockSend = vi.fn();

      MockWebSocket.mockImplementation(() => {
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

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      setTimeout(() => {
        onmessage!({ data: JSON.stringify({ kind: "ready" }) });
      }, 5);
      await client.ready();

      const invitePromise = client.inviteAgent("claude", { handle: "ai" });

      const calls = mockSend.mock.calls;
      const sentMsg = JSON.parse(calls[calls.length - 1]![0] as string);
      expect(sentMsg.action).toBe("invite-agent");
      expect(sentMsg.agentId).toBe("claude");
      expect(sentMsg.handle).toBe("ai");

      onmessage!({
        data: JSON.stringify({
          kind: "invite-agent-response",
          ref: sentMsg.ref,
          success: true,
          instanceId: "inst-123",
        }),
      });

      const result = await invitePromise;
      expect(result.success).toBe(true);
      expect(result.instanceId).toBe("inst-123");
    });

    it("channelAgents returns active agents", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;
      const mockSend = vi.fn();

      MockWebSocket.mockImplementation(() => {
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

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      setTimeout(() => {
        onmessage!({ data: JSON.stringify({ kind: "ready" }) });
      }, 5);
      await client.ready();

      const channelPromise = client.channelAgents();

      const calls = mockSend.mock.calls;
      const sentMsg = JSON.parse(calls[calls.length - 1]![0] as string);
      expect(sentMsg.action).toBe("channel-agents");

      onmessage!({
        data: JSON.stringify({
          kind: "channel-agents-response",
          ref: sentMsg.ref,
          agents: [
            { instanceId: "i1", agentId: "claude", handle: "claude", startedAt: 1000 },
          ],
        }),
      });

      const agents = await channelPromise;
      expect(agents).toHaveLength(1);
      expect(agents[0]?.agentId).toBe("claude");
    });

    it("removeAgent returns success/failure", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;
      const mockSend = vi.fn();

      MockWebSocket.mockImplementation(() => {
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

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      setTimeout(() => {
        onmessage!({ data: JSON.stringify({ kind: "ready" }) });
      }, 5);
      await client.ready();

      const removePromise = client.removeAgent("inst-123");

      const calls = mockSend.mock.calls;
      const sentMsg = JSON.parse(calls[calls.length - 1]![0] as string);
      expect(sentMsg.action).toBe("remove-agent");
      expect(sentMsg.instanceId).toBe("inst-123");

      onmessage!({
        data: JSON.stringify({
          kind: "remove-agent-response",
          ref: sentMsg.ref,
          success: true,
        }),
      });

      const result = await removePromise;
      expect(result.success).toBe(true);
    });

    it("listAgents rejects on timeout", async () => {
      MockWebSocket.mockImplementation(() => ({
        readyState: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      }));

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      await expect(client.listAgents(50)).rejects.toThrow("timeout");
    });

    it("inviteAgent handles error response", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;
      const mockSend = vi.fn();

      MockWebSocket.mockImplementation(() => {
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

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      setTimeout(() => {
        onmessage!({ data: JSON.stringify({ kind: "ready" }) });
      }, 5);
      await client.ready();

      const invitePromise = client.inviteAgent("invalid-agent");

      const calls = mockSend.mock.calls;
      const sentMsg = JSON.parse(calls[calls.length - 1]![0] as string);

      onmessage!({
        data: JSON.stringify({
          kind: "invite-agent-response",
          ref: sentMsg.ref,
          success: false,
          error: "Agent not found",
        }),
      });

      const result = await invitePromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe("Agent not found");
    });
  });

  describe("attachment support", () => {
    it("sends message with attachment as binary frame", async () => {
      const mockSend = vi.fn();

      MockWebSocket.mockImplementation(() => ({
        readyState: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: mockSend,
      }));

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      // Publish with attachment (don't wait for response)
      // Note: No 'id' field - server assigns attachment IDs
      const attachment = new Uint8Array([1, 2, 3, 4, 5]);
      try {
        client.publish("image", { name: "test.png" }, { attachments: [{ data: attachment, mimeType: "image/png" }] }).catch(() => {
          // Ignore timeout or other errors in this test
        });
      } catch {
        // Ignore errors
      }

      // Give time for async operations
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 50);
      });

      // Find the binary send call (should have sent as ArrayBuffer)
      const binarySendCall = mockSend.mock.calls.find((call) => call[0] instanceof ArrayBuffer);
      expect(binarySendCall).toBeDefined();

      // Verify the buffer format is correct: 1 byte marker + 4 bytes length + metadata + attachment
      if (binarySendCall) {
        const buffer = binarySendCall[0] as ArrayBuffer;
        expect(buffer.byteLength).toBeGreaterThan(9); // At least 1 + 4 + some metadata + 5 byte attachment

        // Verify metadata contains payload
        const view = new DataView(buffer);
        const metadataLen = view.getUint32(1, true);
        const metadataBytes = new Uint8Array(buffer, 5, metadataLen);
        const metadataStr = new TextDecoder().decode(metadataBytes);
        const metadata = JSON.parse(metadataStr);
        expect(metadata.payload).toEqual({ name: "test.png" });
        // Note: No 'id' in outgoing attachmentMeta - server assigns IDs
        expect(metadata.attachmentMeta).toEqual([
          {
            mimeType: "image/png",
            size: attachment.length,
          },
        ]);
      }
    });

    it("parses attachment from server binary frame", () => {
      let onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null,
          _onmessage: null as ((event: { data: string | ArrayBuffer }) => void) | null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
        };
        Object.defineProperty(ws, "onmessage", {
          get: () => ws._onmessage,
          set: (handler: (event: { data: string | ArrayBuffer }) => void) => {
            ws._onmessage = handler;
            onmessage = handler;
          },
        });
        return ws;
      });

      const errorHandler = vi.fn();
      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });
      client.onError(errorHandler);

      // Create a message with attachment from server
      const attachment = new Uint8Array([255, 254, 253, 252]);
      const metadata = JSON.stringify({
        kind: "persisted",
        id: 50,
        type: "image",
        payload: { name: "photo.jpg", width: 800 },
        senderId: "other",
        ts: 12345,
        attachmentMeta: [
          {
            id: "img_1",
            mimeType: "image/png",
            size: attachment.length,
          },
        ],
      });
      const metadataBytes = Buffer.from(metadata, "utf-8");
      const serverBuffer = Buffer.allocUnsafe(1 + 4 + metadataBytes.length + attachment.length);
      serverBuffer.writeUInt8(0, 0);
      serverBuffer.writeUInt32LE(metadataBytes.length, 1);
      metadataBytes.copy(serverBuffer, 5);
      Buffer.from(attachment).copy(serverBuffer, 5 + metadataBytes.length);

      // Send binary message
      onmessage!({
        data: serverBuffer.buffer.slice(serverBuffer.byteOffset, serverBuffer.byteOffset + serverBuffer.length)
      });

      // Should not have errored
      expect(errorHandler).not.toHaveBeenCalled();
    });

    it("receives message with both payload and attachment", async () => {
      let onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null,
          _onmessage: null as ((event: { data: string | ArrayBuffer }) => void) | null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
        };
        Object.defineProperty(ws, "onmessage", {
          get: () => ws._onmessage,
          set: (handler: (event: { data: string | ArrayBuffer }) => void) => {
            ws._onmessage = handler;
            onmessage = handler;
          },
        });
        return ws;
      });

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      // Create a message with attachment from server
      const attachment = new Uint8Array([1, 2, 3]);
      const metadata = JSON.stringify({
        kind: "ephemeral",
        type: "data",
        payload: { filename: "data.bin" },
        senderId: "other",
        ts: Date.now(),
        attachmentMeta: [
          {
            id: "data_1",
            mimeType: "application/octet-stream",
            size: attachment.length,
          },
        ],
      });
      const metadataBytes = Buffer.from(metadata, "utf-8");
      const serverBuffer = Buffer.allocUnsafe(1 + 4 + metadataBytes.length + attachment.length);
      serverBuffer.writeUInt8(0, 0);
      serverBuffer.writeUInt32LE(metadataBytes.length, 1);
      metadataBytes.copy(serverBuffer, 5);
      Buffer.from(attachment).copy(serverBuffer, 5 + metadataBytes.length);

      // Send the binary message through onmessage
      onmessage!({
        data: serverBuffer.buffer.slice(serverBuffer.byteOffset, serverBuffer.byteOffset + serverBuffer.length)
      });

      // Get the message from the async iterator
      const iterator = client.messages();
      const { value: receivedMessage } = await iterator.next();

      // Verify both payload and attachments are present
      expect(receivedMessage.payload).toEqual({ filename: "data.bin" });
      expect(receivedMessage.attachments).toBeDefined();
      expect(receivedMessage.attachments).toHaveLength(1);
      expect(receivedMessage.attachments?.[0]?.id).toBe("data_1");
      expect(receivedMessage.attachments?.[0]?.mimeType).toBe("application/octet-stream");
      expect(Array.from(receivedMessage.attachments?.[0]?.data ?? [])).toEqual([1, 2, 3]);
    });
  });
});
